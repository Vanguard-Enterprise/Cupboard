//! Integration tests for Phase 6 PR1 API keys: the no-escalation scope cap at
//! creation, the exchange's revocation/expiry and membership-lifecycle refusals, the
//! demotion-shrinks-the-intersection rule, and RLS isolation of the management surface.
//! Driven through the real router (tower `oneshot`), with orgs/roles seeded on the
//! owner pool exactly as org creation would materialize them.
//!
//! Requires `TEST_DATABASE_URL` (+ `TEST_DATABASE_URL_APP` for the RLS test to bite);
//! skips (passes) when unset.

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use cupboard_auth_core::{Claims, Keys};
use cupboard_domain::{OrgId, Permission, UserId};
use http_body_util::BodyExt;
use sqlx::PgPool;
use std::sync::Arc;
use tokio::sync::OnceCell;
use tower::util::ServiceExt;
use uuid::Uuid;

use cupboard_auth::config::Config;
use cupboard_auth::http;
use cupboard_auth::state::AppState;

// A throwaway Ed25519 keypair for signing/verifying operator tokens in this test only
// (openssl genpkey -algorithm ed25519).
const OP_PRIV: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEII8zWErrGLQRzYyEh7F35db4ICWItzbvYdtHgBNn4Xno\n-----END PRIVATE KEY-----\n";
const OP_PUB: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA18nW4fku7YaJR/+EY40xK+IKw9I6mV3/q9M5RO5ambs=\n-----END PUBLIC KEY-----\n";

const PEPPER: &str = "test-pepper-api-keys";
const INTERNAL_TOKEN: &str = "test-internal-token";

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
static MIGRATED: OnceCell<()> = OnceCell::const_new();

/// Connect the owner + app pools and migrate once. `None` = skip (no database).
async fn setup() -> Option<(PgPool, PgPool)> {
    let owner_url = std::env::var("TEST_DATABASE_URL").ok()?;
    let app_url = std::env::var("TEST_DATABASE_URL_APP").unwrap_or_else(|_| owner_url.clone());

    let owner = cupboard_db::connect_scoped(&owner_url, 5, "auth,public")
        .await
        .expect("connect owner");
    let app = cupboard_db::connect_scoped(&app_url, 5, "auth,public")
        .await
        .expect("connect app");

    MIGRATED
        .get_or_init(|| async {
            sqlx::query("CREATE SCHEMA IF NOT EXISTS auth")
                .execute(&owner)
                .await
                .expect("ensure schema");
            MIGRATOR.run(&owner).await.expect("migrate");
            // Boot-time catalog seeding (main.rs) does not run here; the role
            // permissions we grant below FK into permission_catalog.
            for p in Permission::ALL {
                sqlx::query(
                    "INSERT INTO permission_catalog (permission, area, description) \
                     VALUES ($1, $2, $3) ON CONFLICT (permission) DO NOTHING",
                )
                .bind(p.as_str())
                .bind(p.area())
                .bind(p.description())
                .execute(&owner)
                .await
                .expect("seed catalog");
            }
        })
        .await;
    Some((owner, app))
}

fn test_state(owner: PgPool, app: PgPool) -> AppState {
    let config = Config {
        bind_addr: "127.0.0.1:0".into(),
        database_url: String::new(),
        database_url_app: String::new(),
        db_max_connections: 5,
        environment: "test".into(),
        otel_endpoint: None,
        jwt_private_key_pem: OP_PRIV.into(),
        jwt_public_key_pem: OP_PUB.into(),
        access_token_ttl_secs: 900,
        refresh_token_ttl_secs: 3600,
        token_pepper: PEPPER.into(),
        internal_api_token: Some(INTERNAL_TOKEN.into()),
        public_base_url: "http://localhost:3000".into(),
        discord: None,
        cookie_signing_key: None,
        player: None,
        steam_web_api_key: None,
    };
    AppState {
        owner_pool: owner,
        app_pool: app,
        keys: Arc::new(Keys::from_ed_pem(OP_PRIV, OP_PUB).unwrap()),
        player_keys: None,
        config: Arc::new(config),
        http: reqwest::Client::new(),
        cookie_key: None,
    }
}

/// A seeded operator: a user with an active membership and one role carrying `perms`.
struct Operator {
    user_id: Uuid,
    org_id: Uuid,
    role_id: Uuid,
}

/// Seed an org + user + active membership + a role with `perms`, on the owner pool
/// (RLS-exempt system work, exactly like org creation).
async fn seed_operator(owner: &PgPool, perms: &[Permission]) -> Operator {
    let org_id: Uuid = sqlx::query_scalar(
        "INSERT INTO organizations (name, slug) VALUES ('Keys Test', 'ak-'||gen_random_uuid()) \
         RETURNING id",
    )
    .fetch_one(owner)
    .await
    .expect("insert org");
    let user_id: Uuid =
        sqlx::query_scalar("INSERT INTO users (display_name) VALUES ('Key Creator') RETURNING id")
            .fetch_one(owner)
            .await
            .expect("insert user");
    let membership_id: Uuid = sqlx::query_scalar(
        "INSERT INTO memberships (organization_id, user_id, status) \
         VALUES ($1, $2, 'active') RETURNING id",
    )
    .bind(org_id)
    .bind(user_id)
    .fetch_one(owner)
    .await
    .expect("insert membership");
    let role_id: Uuid = sqlx::query_scalar(
        "INSERT INTO roles (organization_id, name) VALUES ($1, 'KeyRole') RETURNING id",
    )
    .bind(org_id)
    .fetch_one(owner)
    .await
    .expect("insert role");
    for p in perms {
        sqlx::query(
            "INSERT INTO role_permissions (organization_id, role_id, permission) \
             VALUES ($1, $2, $3)",
        )
        .bind(org_id)
        .bind(role_id)
        .bind(p.as_str())
        .execute(owner)
        .await
        .expect("grant permission");
    }
    sqlx::query(
        "INSERT INTO membership_roles (organization_id, membership_id, role_id) \
         VALUES ($1, $2, $3)",
    )
    .bind(org_id)
    .bind(membership_id)
    .bind(role_id)
    .execute(owner)
    .await
    .expect("assign role");
    Operator {
        user_id,
        org_id,
        role_id,
    }
}

/// Mint an org-scoped operator access token for the seeded operator (what
/// POST /auth/token would produce for them).
fn operator_token(op: &Operator, perms: &[Permission]) -> String {
    let claims = Claims::new(
        UserId(op.user_id),
        Uuid::new_v4(),
        Some(OrgId(op.org_id)),
        perms.iter().map(|p| p.as_str().to_string()).collect(),
        900,
    );
    Keys::from_ed_pem(OP_PRIV, OP_PUB)
        .unwrap()
        .encode(&claims)
        .unwrap()
}

async fn send(
    state: &AppState,
    method: &str,
    path: &str,
    bearer: Option<&str>,
    internal_token: Option<&str>,
    body: Option<serde_json::Value>,
) -> (StatusCode, serde_json::Value) {
    let mut req = Request::builder().method(method).uri(path);
    if let Some(b) = bearer {
        req = req.header(header::AUTHORIZATION, format!("Bearer {b}"));
    }
    if let Some(t) = internal_token {
        req = req.header("x-internal-token", t);
    }
    let req = match body {
        Some(j) => req
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(j.to_string()))
            .unwrap(),
        None => req.body(Body::empty()).unwrap(),
    };
    let resp = http::router(state.clone()).oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let val = if bytes.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
    };
    (status, val)
}

/// Create a key through the router; returns (key id, raw token).
async fn create_key(state: &AppState, bearer: &str, scopes: &[&str]) -> (Uuid, String) {
    let (status, body) = send(
        state,
        "POST",
        "/auth/api-keys",
        Some(bearer),
        None,
        Some(serde_json::json!({ "name": "test key", "scopes": scopes })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "create key failed: {body}");
    let id: Uuid = body["key"]["id"].as_str().unwrap().parse().unwrap();
    let token = body["token"].as_str().unwrap().to_string();
    assert!(token.starts_with("cb_"), "raw token must be cb_-prefixed");
    assert_eq!(body["key"]["token_prefix"].as_str().unwrap(), &token[..8]);
    (id, token)
}

async fn exchange(state: &AppState, raw: &str) -> (StatusCode, serde_json::Value) {
    send(
        state,
        "POST",
        "/internal/api-keys/exchange",
        None,
        Some(INTERNAL_TOKEN),
        Some(serde_json::json!({ "token": raw })),
    )
    .await
}

#[tokio::test]
async fn creation_caps_scopes_to_the_creators_permissions() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP creation_caps_scopes_to_the_creators_permissions: TEST_DATABASE_URL unset");
        return;
    };
    let state = test_state(owner.clone(), app);
    let perms = [Permission::ApiManage, Permission::BansView];
    let op = seed_operator(&owner, &perms).await;
    let bearer = operator_token(&op, &perms);

    // A scope the creator does NOT hold is an escalation: 403.
    let (status, body) = send(
        &state,
        "POST",
        "/auth/api-keys",
        Some(&bearer),
        None,
        Some(serde_json::json!({ "name": "sneaky", "scopes": ["bans.create"] })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "escalation must 403: {body}");

    // An unknown permission string is a 400, not a silent grant.
    let (status, _) = send(
        &state,
        "POST",
        "/auth/api-keys",
        Some(&bearer),
        None,
        Some(serde_json::json!({ "name": "bogus", "scopes": ["nonsense.permission"] })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Without api.manage the surface is closed entirely.
    let weak_bearer = operator_token(&op, &[Permission::BansView]);
    let (status, _) = send(
        &state,
        "GET",
        "/auth/api-keys",
        Some(&weak_bearer),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // A subset of the creator's own permissions is accepted.
    let (_id, _token) = create_key(&state, &bearer, &["bans.view"]).await;
}

#[tokio::test]
async fn exchange_mints_scoped_jwt_and_refuses_revoked_keys() {
    let Some((owner, app)) = setup().await else {
        eprintln!(
            "SKIP exchange_mints_scoped_jwt_and_refuses_revoked_keys: TEST_DATABASE_URL unset"
        );
        return;
    };
    let state = test_state(owner.clone(), app);
    let perms = [Permission::ApiManage, Permission::BansView];
    let op = seed_operator(&owner, &perms).await;
    let bearer = operator_token(&op, &perms);
    let (key_id, raw) = create_key(&state, &bearer, &["bans.view"]).await;

    // Guard failures are 403, NOT 401: 401 is reserved for "this API key is invalid"
    // (which the gateway negative-caches per key); a broken/rotated internal channel
    // says nothing about the key and must map to 503 upstream, never be cached.
    let (status, _) = send(
        &state,
        "POST",
        "/internal/api-keys/exchange",
        None,
        None,
        Some(serde_json::json!({ "token": raw })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "missing internal token must 403 (fail closed, distinguishable from a bad key)"
    );
    let (status, _) = send(
        &state,
        "POST",
        "/internal/api-keys/exchange",
        None,
        Some("rotated-elsewhere"),
        Some(serde_json::json!({ "token": raw })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "mismatched internal token must 403, not a cacheable key 401"
    );
    let mut disabled_state = test_state(owner.clone(), state.app_pool.clone());
    Arc::get_mut(&mut disabled_state.config)
        .unwrap()
        .internal_api_token = None;
    let (status, _) = send(
        &disabled_state,
        "POST",
        "/internal/api-keys/exchange",
        None,
        Some(INTERNAL_TOKEN),
        Some(serde_json::json!({ "token": raw })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "INTERNAL_API_TOKEN unset must 403 (internal API disabled)"
    );

    // A valid key mints a short-lived operator JWT: sub/sid = key id, kind = api_key.
    let (status, body) = exchange(&state, &raw).await;
    assert_eq!(status, StatusCode::OK, "exchange failed: {body}");
    let jwt = body["token"].as_str().unwrap();
    let claims = Keys::verifier_from_ed_pem(OP_PUB)
        .unwrap()
        .decode(jwt)
        .unwrap();
    assert_eq!(claims.sub.0, key_id);
    assert_eq!(claims.sid, key_id);
    assert_eq!(claims.org, Some(OrgId(op.org_id)));
    assert_eq!(claims.perms, vec!["bans.view".to_string()]);
    assert_eq!(claims.kind.as_deref(), Some("api_key"));
    assert!(claims.plan.is_none(), "plan is absent (= free) in PR1");
    assert!(
        claims.exp - claims.iat <= 300,
        "exchange tokens are five-minute, not the config access TTL"
    );

    // Garbage tokens refuse with the same generic 401.
    let (status, _) = exchange(&state, "cb_not-a-real-token").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Revoke (idempotent), then the exchange refuses.
    let (status, _) = send(
        &state,
        "POST",
        &format!("/auth/api-keys/{key_id}/revoke"),
        Some(&bearer),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = send(
        &state,
        "POST",
        &format!("/auth/api-keys/{key_id}/revoke"),
        Some(&bearer),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "re-revoking is idempotent");
    let (status, _) = exchange(&state, &raw).await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "revoked key must not mint"
    );
}

#[tokio::test]
async fn exchange_refuses_when_the_creators_membership_is_gone() {
    let Some((owner, app)) = setup().await else {
        eprintln!(
            "SKIP exchange_refuses_when_the_creators_membership_is_gone: TEST_DATABASE_URL unset"
        );
        return;
    };
    let state = test_state(owner.clone(), app);
    let perms = [Permission::ApiManage, Permission::BansView];
    let op = seed_operator(&owner, &perms).await;
    let bearer = operator_token(&op, &perms);
    let (_key_id, raw) = create_key(&state, &bearer, &["bans.view"]).await;

    // Sanity: the key exchanges while the membership is active.
    let (status, _) = exchange(&state, &raw).await;
    assert_eq!(status, StatusCode::OK);

    // Remove the creator from the org: their keys die with them.
    sqlx::query("DELETE FROM memberships WHERE organization_id = $1 AND user_id = $2")
        .bind(op.org_id)
        .bind(op.user_id)
        .execute(&owner)
        .await
        .expect("remove membership");
    let (status, _) = exchange(&state, &raw).await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "a removed creator's key must not mint"
    );
}

#[tokio::test]
async fn demotion_shrinks_the_minted_permissions_to_the_intersection() {
    let Some((owner, app)) = setup().await else {
        eprintln!(
            "SKIP demotion_shrinks_the_minted_permissions_to_the_intersection: TEST_DATABASE_URL unset"
        );
        return;
    };
    let state = test_state(owner.clone(), app);
    let perms = [
        Permission::ApiManage,
        Permission::BansView,
        Permission::BansCreate,
    ];
    let op = seed_operator(&owner, &perms).await;
    let bearer = operator_token(&op, &perms);
    let (_key_id, raw) = create_key(&state, &bearer, &["bans.view", "bans.create"]).await;

    // Demote the creator: drop bans.create from their role.
    sqlx::query("DELETE FROM role_permissions WHERE role_id = $1 AND permission = 'bans.create'")
        .bind(op.role_id)
        .execute(&owner)
        .await
        .expect("demote creator");

    let (status, body) = exchange(&state, &raw).await;
    assert_eq!(status, StatusCode::OK, "demoted (not removed) still mints");
    let claims = Keys::verifier_from_ed_pem(OP_PUB)
        .unwrap()
        .decode(body["token"].as_str().unwrap())
        .unwrap();
    assert_eq!(
        claims.perms,
        vec!["bans.view".to_string()],
        "minted perms must shrink to the scopes-current intersection"
    );

    // Full demotion: an empty intersection still mints a zero-perm principal.
    sqlx::query("DELETE FROM role_permissions WHERE role_id = $1 AND permission = 'bans.view'")
        .bind(op.role_id)
        .execute(&owner)
        .await
        .expect("demote fully");
    let (status, body) = exchange(&state, &raw).await;
    assert_eq!(status, StatusCode::OK);
    let claims = Keys::verifier_from_ed_pem(OP_PUB)
        .unwrap()
        .decode(body["token"].as_str().unwrap())
        .unwrap();
    assert!(
        claims.perms.is_empty(),
        "zero-perm principal is still valid"
    );
}

#[tokio::test]
async fn rls_isolates_api_keys_between_orgs() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP rls_isolates_api_keys_between_orgs: TEST_DATABASE_URL unset");
        return;
    };
    let state = test_state(owner.clone(), app.clone());
    let perms = [Permission::ApiManage, Permission::BansView];
    let op_a = seed_operator(&owner, &perms).await;
    let op_b = seed_operator(&owner, &perms).await;
    let bearer_a = operator_token(&op_a, &perms);
    let bearer_b = operator_token(&op_b, &perms);
    let (key_a, _) = create_key(&state, &bearer_a, &["bans.view"]).await;
    let (key_b, _) = create_key(&state, &bearer_b, &["bans.view"]).await;

    // Each org lists exactly its own key through the app pool.
    let (status, body) = send(&state, "GET", "/auth/api-keys", Some(&bearer_a), None, None).await;
    assert_eq!(status, StatusCode::OK);
    let ids: Vec<&str> = body
        .as_array()
        .unwrap()
        .iter()
        .map(|k| k["id"].as_str().unwrap())
        .collect();
    assert!(ids.contains(&key_a.to_string().as_str()));
    assert!(
        !ids.contains(&key_b.to_string().as_str()),
        "org A must not see org B's keys"
    );

    // Org A cannot revoke org B's key: invisible under RLS, so 404.
    let (status, _) = send(
        &state,
        "POST",
        &format!("/auth/api-keys/{key_b}/revoke"),
        Some(&bearer_a),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Raw app-pool probe scoped to A: B's row is invisible even by explicit id.
    let mut tx = cupboard_db::begin_tenant_tx(&app, cupboard_domain::TenantId(op_a.org_id))
        .await
        .expect("begin tenant tx");
    let visible: i64 = sqlx::query_scalar("SELECT count(*) FROM api_keys WHERE id = $1")
        .bind(key_b)
        .fetch_one(&mut *tx)
        .await
        .expect("count");
    tx.commit().await.expect("commit");
    assert_eq!(visible, 0, "RLS must hide org B's key from org A's scope");
}
