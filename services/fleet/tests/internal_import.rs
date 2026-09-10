//! Integration tests for `POST /internal/servers/import` (Phase 4 PR4): fleet-side
//! support for servers discovered on BattleMetrics before the tenant has wired them into
//! Cupboard.
//!
//! Fleet has no existing HTTP tests to mirror (`tests/rls.rs` and `tests/config_roundtrip.rs`
//! drive Postgres directly, since the crate used to be bin-only), so this drives the real
//! router with `tower::ServiceExt::oneshot`, exactly like `services/collector/tests/ingest.rs`.
//!
//! Requires the same test DB as `tests/rls.rs` (PG18 + `cupboard_app`):
//!   * `TEST_DATABASE_URL`: owner role (runs migrations, reads back rows)
//!   * `TEST_DATABASE_URL_APP`: `cupboard_app` role (unused here, but `AppState` needs a pool)
//!
//! Skips (passes) when `TEST_DATABASE_URL` is unset.

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use cupboard_auth_core::Keys;
use cupboard_fleet::config::Config;
use cupboard_fleet::http::router;
use cupboard_fleet::state::AppState;
use http_body_util::BodyExt as _;
use sqlx::PgPool;
use std::sync::Arc;
use tokio::sync::OnceCell;
use tower::ServiceExt as _;
use uuid::Uuid;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
static MIGRATED: OnceCell<()> = OnceCell::const_new();

const INTERNAL_TOKEN: &str = "test-internal-token";

// A throwaway Ed25519 public key for tests only (same fixture `cupboard_auth_core`'s own
// tests use). The import endpoint never checks a JWT, but `AppState` always carries a
// verifier.
const TEST_PUBLIC_PEM: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAyKMiwFH0hHn4HiPl8DTEq+aPzW9XyzG5v1ELTEVNsbY=\n-----END PUBLIC KEY-----\n";

/// Build real `AppState` against the test DB and boot the real router. `token` becomes
/// `Config::internal_api_token` (`None` reproduces the unconfigured/fail-closed case).
async fn setup(token: Option<&str>) -> Option<AppState> {
    let owner_url = std::env::var("TEST_DATABASE_URL").ok()?;
    let app_url = std::env::var("TEST_DATABASE_URL_APP").unwrap_or_else(|_| owner_url.clone());

    let owner: PgPool = cupboard_db::connect_scoped(&owner_url, 5, "fleet,public")
        .await
        .expect("connect owner");
    let app: PgPool = cupboard_db::connect_scoped(&app_url, 5, "fleet,public")
        .await
        .expect("connect app");

    MIGRATED
        .get_or_init(|| async {
            sqlx::query("CREATE SCHEMA IF NOT EXISTS fleet")
                .execute(&owner)
                .await
                .expect("ensure schema");
            MIGRATOR.run(&owner).await.expect("migrate");
        })
        .await;

    let config = Config {
        bind_addr: "0.0.0.0:0".into(),
        database_url: owner_url,
        database_url_app: String::new(),
        db_max_connections: 5,
        environment: "test".into(),
        otel_endpoint: None,
        jwt_public_key_pem: TEST_PUBLIC_PEM.into(),
        master_key: [7u8; 32],
        internal_api_token: token.map(String::from),
        allow_private_game_servers: false,
    };
    let keys = Keys::verifier_from_ed_pem(&config.jwt_public_key_pem).expect("test verifier key");

    Some(AppState {
        owner_pool: owner,
        app_pool: app,
        keys: Arc::new(keys),
        config: Arc::new(config),
    })
}

fn import_request(body: serde_json::Value, token: Option<&str>) -> Request<Body> {
    let mut req = Request::builder()
        .method("POST")
        .uri("/internal/servers/import")
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(t) = token {
        req = req.header("x-internal-token", t);
    }
    req.body(Body::from(body.to_string())).unwrap()
}

async fn body_json(res: axum::response::Response) -> serde_json::Value {
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

#[derive(sqlx::FromRow)]
struct ImportedRow {
    name: String,
    game: String,
    origin: String,
    enabled: bool,
    rcon_port: i32,
}

#[tokio::test]
async fn fails_closed_when_token_unconfigured() {
    // Mirrors `check_internal_token`'s existing behavior exactly: an unconfigured token
    // is "service unavailable", not "unauthorized", since the internal surface is
    // disabled, not merely guarded.
    let Some(state) = setup(None).await else {
        eprintln!("SKIP fails_closed_when_token_unconfigured: TEST_DATABASE_URL unset");
        return;
    };
    let app = router(state);

    let body = serde_json::json!({
        "tenant_id": Uuid::new_v4(),
        "external_id": "bm-unconfigured",
        "name": "Unconfigured Token Server",
        "rcon_host": "203.0.113.10",
    });
    let res = app
        .oneshot(import_request(body, Some(INTERNAL_TOKEN)))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn rejects_missing_and_wrong_token() {
    let Some(state) = setup(Some(INTERNAL_TOKEN)).await else {
        eprintln!("SKIP rejects_missing_and_wrong_token: TEST_DATABASE_URL unset");
        return;
    };
    let app = router(state);

    let body = || {
        serde_json::json!({
            "tenant_id": Uuid::new_v4(),
            "external_id": "bm-wrong-token",
            "name": "Wrong Token Server",
            "rcon_host": "203.0.113.11",
        })
    };

    let res = app
        .clone()
        .oneshot(import_request(body(), None))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED, "missing token");

    let res = app
        .oneshot(import_request(body(), Some("not-the-token")))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED, "wrong token");
}

#[tokio::test]
async fn upsert_is_idempotent_and_scoped_per_tenant() {
    let Some(state) = setup(Some(INTERNAL_TOKEN)).await else {
        eprintln!("SKIP upsert_is_idempotent_and_scoped_per_tenant: TEST_DATABASE_URL unset");
        return;
    };
    let owner = state.owner_pool.clone();
    let app = router(state);

    let tenant_a = Uuid::new_v4();
    let tenant_b = Uuid::new_v4();
    let external_id = format!("bm-{}", Uuid::new_v4());

    // First import: no rcon_port/game given, so the row must land with the Rust-default
    // port and game.
    let first = serde_json::json!({
        "tenant_id": tenant_a,
        "external_id": external_id,
        "name": "Rust Server One",
        "rcon_host": "8.8.8.8",
    });
    let res = app
        .clone()
        .oneshot(import_request(first, Some(INTERNAL_TOKEN)))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let id_a1 = Uuid::parse_str(body_json(res).await["id"].as_str().unwrap()).unwrap();

    // Re-import same (tenant, external_id) with a new name: same id, name updated.
    let second = serde_json::json!({
        "tenant_id": tenant_a,
        "external_id": external_id,
        "name": "Rust Server One (Renamed)",
        "rcon_host": "8.8.8.8",
    });
    let res = app
        .clone()
        .oneshot(import_request(second, Some(INTERNAL_TOKEN)))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let id_a2 = Uuid::parse_str(body_json(res).await["id"].as_str().unwrap()).unwrap();
    assert_eq!(
        id_a2, id_a1,
        "re-import of the same (tenant, external_id) must upsert, not insert"
    );

    let row: ImportedRow =
        sqlx::query_as("SELECT name, game, origin, enabled, rcon_port FROM servers WHERE id = $1")
            .bind(id_a1)
            .fetch_one(&owner)
            .await
            .expect("fetch imported row");
    assert_eq!(
        row.name, "Rust Server One (Renamed)",
        "re-import must update the name"
    );
    assert_eq!(row.game, "rust", "game defaults to rust when omitted");
    assert_eq!(row.origin, "bm");
    assert!(!row.enabled, "imported servers must land disabled");
    assert_eq!(
        row.rcon_port, 28016,
        "rcon_port defaults to Rust's convention when omitted"
    );

    // A different tenant importing the same external_id must not collide with tenant A's row.
    let third = serde_json::json!({
        "tenant_id": tenant_b,
        "external_id": external_id,
        "name": "Rust Server One",
        "rcon_host": "8.8.8.8",
    });
    let res = app
        .oneshot(import_request(third, Some(INTERNAL_TOKEN)))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let id_b = Uuid::parse_str(body_json(res).await["id"].as_str().unwrap()).unwrap();
    assert_ne!(
        id_b, id_a1,
        "the same external_id under a different tenant must be a different row"
    );
}

#[tokio::test]
async fn reimport_does_not_clobber_enabled_or_rcon_credentials() {
    let Some(state) = setup(Some(INTERNAL_TOKEN)).await else {
        eprintln!(
            "SKIP reimport_does_not_clobber_enabled_or_rcon_credentials: TEST_DATABASE_URL unset"
        );
        return;
    };
    let owner = state.owner_pool.clone();
    let app = router(state);

    let tenant = Uuid::new_v4();
    let external_id = format!("bm-{}", Uuid::new_v4());

    let first = serde_json::json!({
        "tenant_id": tenant,
        "external_id": external_id,
        "name": "Before Tenant Configures",
        "rcon_host": "8.8.4.4",
    });
    let res = app
        .clone()
        .oneshot(import_request(first, Some(INTERNAL_TOKEN)))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let id = Uuid::parse_str(body_json(res).await["id"].as_str().unwrap()).unwrap();

    // Simulate the tenant configuring the server from the servers UI: real RCON
    // credentials, enabled, plus edits to the tenant-owned name and rcon_host (the UI often
    // points rcon_host at a private RCON address different from BM's public game IP), exactly
    // as `domain::servers::update` would leave the row.
    let fake_secret = vec![9u8; 16];
    sqlx::query(
        "UPDATE servers SET enabled = true, rcon_password_enc = $2, rcon_password_dek = $2, \
         name = 'Tenant Renamed', rcon_host = '10.9.9.9' WHERE id = $1",
    )
    .bind(id)
    .bind(&fake_secret)
    .execute(&owner)
    .await
    .expect("simulate tenant configuration");

    // Re-import with BM's (different) name and rcon_host: once the tenant adopted the row,
    // neither must be clobbered.
    let second = serde_json::json!({
        "tenant_id": tenant,
        "external_id": external_id,
        "name": "BM Name After Config",
        "rcon_host": "9.9.9.9",
    });
    let res = app
        .oneshot(import_request(second, Some(INTERNAL_TOKEN)))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    #[derive(sqlx::FromRow)]
    struct Row {
        name: String,
        rcon_host: String,
        enabled: bool,
        rcon_password_enc: Vec<u8>,
        rcon_password_dek: Vec<u8>,
    }
    let row: Row = sqlx::query_as(
        "SELECT name, rcon_host, enabled, rcon_password_enc, rcon_password_dek \
         FROM servers WHERE id = $1",
    )
    .bind(id)
    .fetch_one(&owner)
    .await
    .expect("fetch row after reimport");
    assert_eq!(
        row.name, "Tenant Renamed",
        "re-import must not clobber a name the tenant edited after adopting the server"
    );
    assert_eq!(
        row.rcon_host, "10.9.9.9",
        "re-import must not clobber an rcon_host the tenant edited after adopting the server"
    );
    assert!(
        row.enabled,
        "re-import must not clear enabled once the tenant turned it on"
    );
    assert_eq!(
        row.rcon_password_enc, fake_secret,
        "re-import must not touch RCON credentials"
    );
    assert_eq!(
        row.rcon_password_dek, fake_secret,
        "re-import must not touch RCON credentials"
    );
}

#[tokio::test]
async fn rejects_invalid_input() {
    let Some(state) = setup(Some(INTERNAL_TOKEN)).await else {
        eprintln!("SKIP rejects_invalid_input: TEST_DATABASE_URL unset");
        return;
    };
    let app = router(state);

    let cases = [
        serde_json::json!({
            "tenant_id": Uuid::new_v4(), "external_id": "", "name": "n", "rcon_host": "h",
        }),
        serde_json::json!({
            "tenant_id": Uuid::new_v4(), "external_id": "bm-x", "name": "", "rcon_host": "h",
        }),
        serde_json::json!({
            "tenant_id": Uuid::new_v4(), "external_id": "bm-x", "name": "n", "rcon_host": "",
        }),
        serde_json::json!({
            "tenant_id": Uuid::new_v4(), "external_id": "bm-x", "name": "n", "rcon_host": "h",
            "rcon_port": 0,
        }),
        serde_json::json!({
            "tenant_id": Uuid::new_v4(), "external_id": "bm-x", "name": "n", "rcon_host": "h",
            "rcon_port": 70000,
        }),
        serde_json::json!({
            "tenant_id": Uuid::new_v4(), "external_id": "bm-x", "name": "n", "rcon_host": "h",
            "query_port": 0,
        }),
        serde_json::json!({
            "tenant_id": Uuid::new_v4(),
            "external_id": "x".repeat(65),
            "name": "n", "rcon_host": "h",
        }),
        serde_json::json!({
            "tenant_id": Uuid::new_v4(), "external_id": "bm-x",
            "name": "x".repeat(129), "rcon_host": "h",
        }),
    ];
    for case in cases {
        let res = app
            .clone()
            .oneshot(import_request(case.clone(), Some(INTERNAL_TOKEN)))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST, "case: {case}");
    }
}

#[tokio::test]
async fn rejects_rcon_host_in_blocked_range() {
    // SSRF boundary: a tenant must not register a server whose rcon_host is a
    // cluster-internal literal (loopback / private / cloud metadata / CGNAT).
    let Some(state) = setup(Some(INTERNAL_TOKEN)).await else {
        eprintln!("SKIP rejects_rcon_host_in_blocked_range: TEST_DATABASE_URL unset");
        return;
    };
    let app = router(state);

    for host in ["127.0.0.1", "10.0.0.5", "169.254.169.254", "100.64.0.1"] {
        let body = serde_json::json!({
            "tenant_id": Uuid::new_v4(),
            "external_id": format!("bm-ssrf-{host}"),
            "name": "SSRF Attempt",
            "rcon_host": host,
        });
        let res = app
            .clone()
            .oneshot(import_request(body, Some(INTERNAL_TOKEN)))
            .await
            .unwrap();
        assert_eq!(
            res.status(),
            StatusCode::BAD_REQUEST,
            "blocked rcon_host {host} must be rejected"
        );
    }
}
