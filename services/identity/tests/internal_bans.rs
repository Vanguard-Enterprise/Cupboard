//! Integration tests for the Phase 6 (PR3, decision C) cross-tenant ban reads the tenant
//! service calls to build the ban-appeal link:
//!   * `GET /internal/bans/{id}?tenant_id=<uuid>`
//!   * `POST /internal/bans/active` with body `{"tenant_id": "<uuid>", "steam_id": "<id>"}`
//!     (a POST so steam_id, PII, never lands in a URI the TraceLayer span records)
//!
//! Both are token-guarded (`x-internal-token`) and run on the owner pool with `tenant_id`
//! filtered explicitly in SQL (the `/internal/enforce` precedent). This drives the real
//! router with `tower::ServiceExt::oneshot`, like `services/fleet/tests/internal_import.rs`.
//!
//! Requires the same test DB as `tests/bm_rls.rs` (PG18 + `cupboard_app`):
//!   * `TEST_DATABASE_URL`: owner role (runs migrations, seeds + reads rows)
//!   * `TEST_DATABASE_URL_APP`: `cupboard_app` role (unused here, but `AppState` needs a pool)
//!
//! Skips (passes) when `TEST_DATABASE_URL` is unset.

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use cupboard_auth_core::Keys;
use cupboard_crypto::hmac_sha256;
use cupboard_identity::config::Config;
use cupboard_identity::http::router;
use cupboard_identity::state::AppState;
use http_body_util::BodyExt as _;
use sqlx::PgPool;
use std::sync::Arc;
use tokio::sync::OnceCell;
use tower::ServiceExt as _;
use uuid::Uuid;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
static MIGRATED: OnceCell<()> = OnceCell::const_new();

const INTERNAL_TOKEN: &str = "test-internal-token";
const TEST_PEPPER: &str = "internal-bans-test-pepper";

// A throwaway Ed25519 public key for tests only (the fixture `cupboard_auth_core`'s own
// tests use). These endpoints never check a JWT, but `AppState` always carries a verifier.
const TEST_PUBLIC_PEM: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAyKMiwFH0hHn4HiPl8DTEq+aPzW9XyzG5v1ELTEVNsbY=\n-----END PUBLIC KEY-----\n";

/// Build real `AppState` against the test DB and boot the real router. `token` becomes
/// `Config::internal_api_token` (`None` reproduces the unconfigured/fail-closed case).
async fn setup(token: Option<&str>) -> Option<AppState> {
    let owner_url = std::env::var("TEST_DATABASE_URL").ok()?;
    let app_url = std::env::var("TEST_DATABASE_URL_APP").unwrap_or_else(|_| owner_url.clone());

    let owner: PgPool = cupboard_db::connect_scoped(&owner_url, 5, "identity,public")
        .await
        .expect("connect owner");
    let app: PgPool = cupboard_db::connect_scoped(&app_url, 5, "identity,public")
        .await
        .expect("connect app");

    MIGRATED
        .get_or_init(|| async {
            sqlx::query("CREATE SCHEMA IF NOT EXISTS identity")
                .execute(&owner)
                .await
                .expect("ensure schema");
            MIGRATOR.run(&owner).await.expect("migrate");
        })
        .await;

    let config = Config {
        bind_addr: "0.0.0.0:0".into(),
        database_url: owner_url,
        database_url_app: app_url,
        db_max_connections: 5,
        environment: "test".into(),
        otel_endpoint: None,
        jwt_public_key_pem: TEST_PUBLIC_PEM.into(),
        value_pepper: TEST_PEPPER.into(),
        redis_url: String::new(),
        consumer_name: "identity-test".into(),
        internal_api_token: token.map(String::from),
        fleet_internal_url: None,
        identity_master_key: None,
        bm_api_base: String::new(),
    };
    let keys = Keys::verifier_from_ed_pem(&config.jwt_public_key_pem).expect("test verifier key");

    Some(AppState {
        owner_pool: owner,
        app_pool: app,
        keys: Arc::new(keys),
        config: Arc::new(config),
    })
}

/// Seed one ban directly on the owner pool (RLS-exempt; tenant_id set explicitly). The
/// `subject_hash` is `HMAC(hash_source, TEST_PEPPER)`, exactly what the endpoint recomputes
/// from a queried steam_id, so a seeded `hash_source == steam_id` is what the lookup matches.
#[allow(clippy::too_many_arguments)]
async fn seed_ban(
    owner: &PgPool,
    tenant: Uuid,
    subject_type: &str,
    hash_source: &str,
    reason: Option<&str>,
    status: &str,
    expires_at: Option<chrono::DateTime<chrono::Utc>>,
    revoked_at: Option<chrono::DateTime<chrono::Utc>>,
) -> Uuid {
    let subject_hash = hmac_sha256(hash_source.as_bytes(), TEST_PEPPER.as_bytes()).to_vec();
    sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO bans \
         (tenant_id, subject_type, subject_value, subject_hash, scope, reason, status, \
          expires_at, revoked_at) \
         VALUES ($1, $2, $3, $4, 'network', $5, $6, $7, $8) RETURNING id",
    )
    .bind(tenant)
    .bind(subject_type)
    .bind(hash_source)
    .bind(&subject_hash)
    .bind(reason)
    .bind(status)
    .bind(expires_at)
    .bind(revoked_at)
    .fetch_one(owner)
    .await
    .expect("seed ban")
}

fn get_req(id: &str, tenant_id: Option<&str>, token: Option<&str>) -> Request<Body> {
    let uri = match tenant_id {
        Some(t) => format!("/internal/bans/{id}?tenant_id={t}"),
        None => format!("/internal/bans/{id}"),
    };
    build_get(&uri, token)
}

/// POST body builder: `None` fields are omitted from the JSON, exercising the handler's
/// own missing-field 400s (serde defaults keep deserialization from rejecting first).
fn active_req(
    tenant_id: Option<&str>,
    steam_id: Option<&str>,
    token: Option<&str>,
) -> Request<Body> {
    let mut body = serde_json::Map::new();
    if let Some(t) = tenant_id {
        body.insert("tenant_id".into(), t.into());
    }
    if let Some(s) = steam_id {
        body.insert("steam_id".into(), s.into());
    }
    let mut req = Request::builder()
        .method("POST")
        .uri("/internal/bans/active")
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(t) = token {
        req = req.header("x-internal-token", t);
    }
    req.body(Body::from(serde_json::Value::Object(body).to_string()))
        .unwrap()
}

fn build_get(uri: &str, token: Option<&str>) -> Request<Body> {
    let mut req = Request::builder().method("GET").uri(uri);
    if let Some(t) = token {
        req = req.header("x-internal-token", t);
    }
    req.body(Body::empty()).unwrap()
}

async fn body_json(res: axum::response::Response) -> serde_json::Value {
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn rejects_missing_and_wrong_token() {
    let Some(state) = setup(Some(INTERNAL_TOKEN)).await else {
        eprintln!("SKIP rejects_missing_and_wrong_token: TEST_DATABASE_URL unset");
        return;
    };
    let app = router(state);
    let id = Uuid::new_v4().to_string();
    let tenant = Uuid::new_v4().to_string();

    // get-by-id: missing then wrong token.
    let res = app
        .clone()
        .oneshot(get_req(&id, Some(&tenant), None))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED, "get: missing token");
    let res = app
        .clone()
        .oneshot(get_req(&id, Some(&tenant), Some("not-the-token")))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED, "get: wrong token");

    // active: missing then wrong token.
    let res = app
        .clone()
        .oneshot(active_req(Some(&tenant), Some("76561198000000001"), None))
        .await
        .unwrap();
    assert_eq!(
        res.status(),
        StatusCode::UNAUTHORIZED,
        "active: missing token"
    );
    let res = app
        .oneshot(active_req(
            Some(&tenant),
            Some("76561198000000001"),
            Some("not-the-token"),
        ))
        .await
        .unwrap();
    assert_eq!(
        res.status(),
        StatusCode::UNAUTHORIZED,
        "active: wrong token"
    );
}

#[tokio::test]
async fn get_by_id_honors_tenant_scoping() {
    let Some(state) = setup(Some(INTERNAL_TOKEN)).await else {
        eprintln!("SKIP get_by_id_honors_tenant_scoping: TEST_DATABASE_URL unset");
        return;
    };
    let owner = state.owner_pool.clone();
    let app = router(state);

    let tenant_a = Uuid::new_v4();
    let tenant_b = Uuid::new_v4();
    let ban_id = seed_ban(
        &owner,
        tenant_a,
        "steam",
        "76561198000000010",
        Some("cheating"),
        "active",
        None,
        None,
    )
    .await;
    let id = ban_id.to_string();

    // Right tenant: 200 with the exact contract shape.
    let res = app
        .clone()
        .oneshot(get_req(
            &id,
            Some(&tenant_a.to_string()),
            Some(INTERNAL_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let json = body_json(res).await;
    assert_eq!(json["id"], ban_id.to_string());
    assert_eq!(json["subject_type"], "steam");
    assert_eq!(json["subject_value"], "76561198000000010");
    assert_eq!(json["reason"], "cheating");
    assert_eq!(json["status"], "active");
    assert!(json.get("issued_at").is_some(), "issued_at present");
    assert!(
        json.get("expires_at").is_some(),
        "expires_at key present (null)"
    );
    assert!(
        json.get("revoked_at").is_some(),
        "revoked_at key present (null)"
    );
    // No PII/enforcement internals leak into the summary.
    assert!(
        json.get("subject_hash").is_none(),
        "subject_hash must not leak"
    );
    assert!(json.get("player_id").is_none(), "player_id must not leak");

    // Wrong tenant using tenant A's id: a 404, never a cross-tenant read.
    let res = app
        .clone()
        .oneshot(get_req(
            &id,
            Some(&tenant_b.to_string()),
            Some(INTERNAL_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(
        res.status(),
        StatusCode::NOT_FOUND,
        "tenant B must not see tenant A's ban"
    );
    assert_eq!(body_json(res).await["error"], "not_found");

    // Unknown id under the right tenant: 404.
    let res = app
        .oneshot(get_req(
            &Uuid::new_v4().to_string(),
            Some(&tenant_a.to_string()),
            Some(INTERNAL_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND, "unknown id is 404");
}

#[tokio::test]
async fn active_returns_only_active_steam_bans_for_the_right_id() {
    let Some(state) = setup(Some(INTERNAL_TOKEN)).await else {
        eprintln!(
            "SKIP active_returns_only_active_steam_bans_for_the_right_id: TEST_DATABASE_URL unset"
        );
        return;
    };
    let owner = state.owner_pool.clone();
    let app = router(state);

    let tenant_a = Uuid::new_v4();
    let tenant_b = Uuid::new_v4();
    let steam_id = "76561198000000020";
    let past = chrono::Utc::now() - chrono::Duration::hours(1);

    // All four share the SAME hash source (steam_id), so they collide on subject_hash;
    // only the active, unexpired, steam-typed one may surface. This is the correctness core:
    // never match on hash alone (an ip ban with the same hash source must be filtered out).
    seed_ban(
        &owner,
        tenant_a,
        "steam",
        steam_id,
        Some("expired"),
        "active",
        Some(past),
        None,
    )
    .await;
    seed_ban(
        &owner,
        tenant_a,
        "steam",
        steam_id,
        Some("revoked"),
        "revoked",
        None,
        Some(past),
    )
    .await;
    seed_ban(
        &owner,
        tenant_a,
        "ip",
        steam_id,
        Some("ip ban, same hash source"),
        "active",
        None,
        None,
    )
    .await;
    let active_id = seed_ban(
        &owner,
        tenant_a,
        "steam",
        steam_id,
        Some("current"),
        "active",
        None,
        None,
    )
    .await;

    // A ban for the SAME steam_id but a DIFFERENT tenant must not leak in.
    seed_ban(
        &owner,
        tenant_b,
        "steam",
        steam_id,
        Some("other tenant"),
        "active",
        None,
        None,
    )
    .await;

    let res = app
        .clone()
        .oneshot(active_req(
            Some(&tenant_a.to_string()),
            Some(steam_id),
            Some(INTERNAL_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let json = body_json(res).await;
    let bans = json["bans"].as_array().expect("bans array");
    assert_eq!(
        bans.len(),
        1,
        "only the active steam ban returns, got {json}"
    );
    assert_eq!(bans[0]["id"], active_id.to_string());
    assert_eq!(bans[0]["subject_type"], "steam");
    assert_eq!(bans[0]["reason"], "current");
    assert_eq!(bans[0]["status"], "active");

    // A different steam_id (different hash) returns nothing.
    let res = app
        .clone()
        .oneshot(active_req(
            Some(&tenant_a.to_string()),
            Some("76561198999999999"),
            Some(INTERNAL_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(body_json(res).await["bans"].as_array().unwrap().len(), 0);

    // Tenant B scoping: B queries its own steam_id ban and sees exactly its one row, not A's.
    let res = app
        .oneshot(active_req(
            Some(&tenant_b.to_string()),
            Some(steam_id),
            Some(INTERNAL_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(body_json(res).await["bans"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn rejects_missing_or_invalid_params() {
    let Some(state) = setup(Some(INTERNAL_TOKEN)).await else {
        eprintln!("SKIP rejects_missing_or_invalid_params: TEST_DATABASE_URL unset");
        return;
    };
    let app = router(state);
    let id = Uuid::new_v4().to_string();
    let tenant = Uuid::new_v4().to_string();

    // get-by-id: missing tenant_id, then a non-uuid tenant_id.
    let res = app
        .clone()
        .oneshot(get_req(&id, None, Some(INTERNAL_TOKEN)))
        .await
        .unwrap();
    assert_eq!(
        res.status(),
        StatusCode::BAD_REQUEST,
        "get: missing tenant_id"
    );
    assert_eq!(body_json(res).await["error"], "bad_request");

    let res = app
        .clone()
        .oneshot(get_req(&id, Some("not-a-uuid"), Some(INTERNAL_TOKEN)))
        .await
        .unwrap();
    assert_eq!(
        res.status(),
        StatusCode::BAD_REQUEST,
        "get: invalid tenant_id"
    );

    // active: missing tenant_id, missing steam_id, invalid tenant_id.
    let res = app
        .clone()
        .oneshot(active_req(
            None,
            Some("76561198000000001"),
            Some(INTERNAL_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(
        res.status(),
        StatusCode::BAD_REQUEST,
        "active: missing tenant_id"
    );

    let res = app
        .clone()
        .oneshot(active_req(Some(&tenant), None, Some(INTERNAL_TOKEN)))
        .await
        .unwrap();
    assert_eq!(
        res.status(),
        StatusCode::BAD_REQUEST,
        "active: missing steam_id"
    );

    let res = app
        .oneshot(active_req(
            Some("not-a-uuid"),
            Some("76561198000000001"),
            Some(INTERNAL_TOKEN),
        ))
        .await
        .unwrap();
    assert_eq!(
        res.status(),
        StatusCode::BAD_REQUEST,
        "active: invalid tenant_id"
    );
}
