//! End-to-end commerce tests against the in-process PayNow stub: connect (probe-before-
//! store), catalog sync (hash-diff idempotence, change detection, soft-delete sweep),
//! the public catalog read, lease fencing, and disconnect semantics.
//!
//! Requires a Postgres (PG18) with the `cupboard_app` role:
//!   * `TEST_DATABASE_URL`     - owner role
//!   * `TEST_DATABASE_URL_APP` - `cupboard_app` role
//!
//! Skips (passes) when `TEST_DATABASE_URL` is unset.

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use cupboard_auth_core::{Claims, Keys};
use cupboard_domain::{OrgId, TenantId, UserId};
use cupboard_tenant::cache::SiteCache;
use cupboard_tenant::config::Config;
use cupboard_tenant::domain::store;
use cupboard_tenant::http;
use cupboard_tenant::providers::stub::PayNowStub;
use cupboard_tenant::providers::{paynow::PayNowClient, StoreProvider};
use cupboard_tenant::state::AppState;
use http_body_util::BodyExt;
use sqlx::PgPool;
use std::sync::Arc;
use tokio::sync::OnceCell;
use tower::util::ServiceExt;
use uuid::Uuid;

// Test-only Ed25519 keypair (same throwaway pair as crates/auth-core's unit tests).
const TEST_PRIVATE_PEM: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIKfwTrhSm/f0QxY6e5mzQ+iTAvdyp3omCt4lyOjWItDm\n-----END PRIVATE KEY-----\n";
const TEST_PUBLIC_PEM: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAyKMiwFH0hHn4HiPl8DTEq+aPzW9XyzG5v1ELTEVNsbY=\n-----END PUBLIC KEY-----\n";

const MASTER_KEY: [u8; 32] = [7u8; 32];
const STUB_API_KEY: &str = "pnapi_v1_test_key";

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
static MIGRATED: OnceCell<()> = OnceCell::const_new();

async fn setup() -> Option<(PgPool, PgPool)> {
    let owner_url = std::env::var("TEST_DATABASE_URL").ok()?;
    let app_url = std::env::var("TEST_DATABASE_URL_APP").unwrap_or_else(|_| owner_url.clone());

    let owner = cupboard_db::connect_scoped(&owner_url, 5, "tenant,public")
        .await
        .expect("connect owner");
    let app = cupboard_db::connect_scoped(&app_url, 5, "tenant,public")
        .await
        .expect("connect app");

    MIGRATED
        .get_or_init(|| async {
            sqlx::query("CREATE SCHEMA IF NOT EXISTS tenant")
                .execute(&owner)
                .await
                .expect("ensure schema");
            MIGRATOR.run(&owner).await.expect("migrate");
        })
        .await;

    Some((owner, app))
}

fn test_state(owner: PgPool, app: PgPool, paynow_base: String) -> AppState {
    let config = Config {
        bind_addr: "127.0.0.1:0".into(),
        database_url: String::new(),
        database_url_app: String::new(),
        db_max_connections: 5,
        environment: "test".into(),
        otel_endpoint: None,
        jwt_public_key_pem: TEST_PUBLIC_PEM.into(),
        redis_url: None,
        sites_suffix: "sites.test".into(),
        tenant_master_key: Some(MASTER_KEY),
        consumer_name: "test-tenant".into(),
        paynow_api_base: paynow_base,
        tebex_headless_base: "http://tebex.test".into(),
        tebex_plugin_base: "http://tebex.test".into(),
        internal_api_token: None,
        player_jwt_public_key_pem: None,
        public_webhook_base: None,
        edge_hostname: None,
        cert_namespace: "cupboard-web".into(),
        cert_issuer: "letsencrypt-http01".into(),
        web_service_name: "cupboard-web".into(),
        web_service_port: 3000,
        ingress_class: "traefik-external".into(),
        stripe_secret_key: None,
        stripe_webhook_secret: None,
        stripe_price_team: None,
        stripe_price_enterprise: None,
        stripe_price_custom_design: None,
        stripe_api_base: "http://stripe.test".into(),
        auth_internal_url: "http://auth.test".into(),
        plan_write_token: None,
    };
    AppState {
        owner_pool: owner,
        app_pool: app,
        keys: Arc::new(Keys::verifier_from_ed_pem(TEST_PUBLIC_PEM).unwrap()),
        player_keys: None,
        cache: SiteCache::disabled(),
        site_miss_budget: Arc::new(Default::default()),
        catalog_miss_budget: Arc::new(Default::default()),
        http: reqwest::Client::new(),
        verified_prices: Arc::new(Default::default()),
        config: Arc::new(config),
    }
}

fn bearer(tenant: Uuid) -> String {
    let signer = Keys::from_ed_pem(TEST_PRIVATE_PEM, TEST_PUBLIC_PEM).unwrap();
    let claims = Claims::new(
        UserId(Uuid::new_v4()),
        Uuid::new_v4(),
        Some(OrgId(tenant)),
        vec!["store.manage".into(), "sites.edit".into()],
        300,
    );
    format!("Bearer {}", signer.encode(&claims).unwrap())
}

async fn send_json(
    state: &AppState,
    method: &str,
    path: &str,
    auth: Option<&str>,
    body: Option<serde_json::Value>,
) -> (StatusCode, serde_json::Value) {
    let mut req = Request::builder().method(method).uri(path);
    if let Some(auth) = auth {
        req = req.header(header::AUTHORIZATION, auth);
    }
    let req = match body {
        Some(json) => req
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(json.to_string()))
            .unwrap(),
        None => req.body(Body::empty()).unwrap(),
    };
    let resp = http::router(state.clone()).oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let value = if bytes.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
    };
    (status, value)
}

/// The catalog fixture; `vip_price_final` parameterizes the field the diff test mutates.
fn fixture_products(vip_price_final: i64) -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({
            "id": "500000000000000001", "slug": "vip-rank", "name": "VIP Rank",
            "price": 999, "currency": "USD",
            "allow_one_time_purchase": false, "allow_subscription": true,
            "subscription_interval_value": 1, "subscription_interval_scale": "month",
            "pricing": {"price_original": 999, "price_final": vip_price_final},
            "tags": [{"id": "700000000000000001", "slug": "ranks", "name": "Ranks"}],
            "stock": {"available_to_purchase": true}
        }),
        serde_json::json!({
            "id": "500000000000000002", "slug": "starter-kit", "name": "Starter Kit",
            "price": 499, "currency": "USD",
            "tags": [{"id": "700000000000000002", "slug": "currency", "name": "Currency"}],
            "stock": {"available_to_purchase": false}
        }),
        serde_json::json!({
            "id": "500000000000000003", "slug": "coins-1000", "name": "1000 Coins",
            "price": 299, "currency": "USD",
            "tags": [
                {"id": "700000000000000001", "slug": "ranks", "name": "Ranks"},
                {"id": "700000000000000002", "slug": "currency", "name": "Currency"}
            ],
            "stock": {"available_to_purchase": true}
        }),
    ]
}

/// Claim THIS test's connection directly (by tenant), so leftover connected rows from
/// prior test runs cannot crowd it out of the global `claim_ready` LIMIT batch. Sets the
/// same lease columns a real claim would, satisfying the runner's write fence.
async fn claim_own(owner: &PgPool, tenant: Uuid, claimer: &str) -> store::StoreConnection {
    // Claim the row, then reload via the domain loader so the returned struct stays in
    // sync with StoreConnection's columns (which grow across PRs).
    sqlx::query(
        "UPDATE store_connections SET claimed_by = $2, heartbeat_at = now() WHERE tenant_id = $1",
    )
    .bind(tenant)
    .bind(claimer)
    .execute(owner)
    .await
    .expect("claim own connection");
    let id: Uuid = sqlx::query_scalar("SELECT id FROM store_connections WHERE tenant_id = $1")
        .bind(tenant)
        .fetch_one(owner)
        .await
        .expect("connection id");
    store::load_fresh(owner, id)
        .await
        .expect("load")
        .expect("connection present")
}

/// Fetch + apply one catalog sync the way the runner does (without timers).
async fn sync_once(owner: &PgPool, stub_base: &str, tenant: Uuid, claimer: &str) -> (u64, u64) {
    let conn = claim_own(owner, tenant, claimer).await;
    let key_enc = conn.api_key_enc.clone().expect("key present");
    let client = PayNowClient::new(
        stub_base.to_string(),
        STUB_API_KEY,
        Some(conn.store_external_id.clone()),
    );
    let snapshot = client.fetch_catalog().await.expect("fetch catalog");
    store::apply_catalog(owner, &conn, claimer, &key_enc, &snapshot)
        .await
        .expect("apply catalog")
}

#[tokio::test]
async fn connect_sync_diff_sweep_and_public_catalog() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP connect_sync_diff_sweep_and_public_catalog: TEST_DATABASE_URL unset");
        return;
    };
    let stub = PayNowStub::spawn(STUB_API_KEY).await;
    let state = test_state(owner.clone(), app.clone(), stub.base_url());
    let tenant = Uuid::new_v4();
    let auth = bearer(tenant);

    // A site so the public catalog endpoint can resolve a host for this tenant.
    let slug = format!("st-{}", &Uuid::new_v4().simple().to_string()[..10]);
    sqlx::query("INSERT INTO sites (tenant_id, slug) VALUES ($1, $2)")
        .bind(tenant)
        .bind(&slug)
        .execute(&owner)
        .await
        .expect("seed site");
    let host = format!("{slug}.sites.test");

    // The test owns the fixture end to end (the stub's defaults are not load-bearing
    // here): 3 products + 2 tags, then targeted mutations below.
    stub.set_tags(vec![
        serde_json::json!({"id": "700000000000000001", "slug": "ranks", "name": "Ranks", "order": 1}),
        serde_json::json!({"id": "700000000000000002", "slug": "currency", "name": "Currency", "order": 2}),
    ]);
    let mut products = fixture_products(799);
    stub.set_products(products.clone());

    // Connect: probe-before-store against the stub.
    let (status, body) = send_json(
        &state,
        "POST",
        "/store/connection",
        Some(&auth),
        Some(serde_json::json!({"provider": "paynow", "api_key": STUB_API_KEY})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "connect failed: {body}");
    assert_eq!(body["connection"]["store_name"], "ACME Store");
    assert_eq!(body["connection"]["status"], "connected");
    // The key is write-only: no field of the view may contain it.
    assert!(!body.to_string().contains(STUB_API_KEY));

    // First sync writes all 3 products + 2 categories.
    let claimer = "e2e-claimer";
    let (written, deleted) = sync_once(&owner, &stub.base_url(), tenant, claimer).await;
    assert_eq!(written, 5, "3 products + 2 categories");
    assert_eq!(deleted, 0);

    // Idempotent: identical snapshot writes nothing (hash skip).
    let (written, deleted) = sync_once(&owner, &stub.base_url(), tenant, claimer).await;
    assert_eq!(
        (written, deleted),
        (0, 0),
        "unchanged snapshot must be a no-op"
    );

    // Public catalog serves from the cache tables.
    let (status, body) = send_json(
        &state,
        "GET",
        &format!("/public/store/catalog?host={host}"),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["products"].as_array().unwrap().len(), 3);
    assert_eq!(body["categories"].as_array().unwrap().len(), 2);
    assert_eq!(body["store_name"], "ACME Store");
    let vip = body["products"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["external_id"] == "500000000000000001")
        .expect("vip product present");
    assert_eq!(vip["price_final_minor"], 799);
    assert_eq!(vip["kind"], "subscription");

    // Change one product's sale price: exactly one row rewrites.
    products = fixture_products(899);
    stub.set_products(products.clone());
    let (written, deleted) = sync_once(&owner, &stub.base_url(), tenant, claimer).await;
    assert_eq!(written, 1, "only the re-priced product may rewrite");
    assert_eq!(deleted, 0);

    // Remove one product: soft-deleted, public catalog shrinks, row survives.
    products.pop();
    stub.set_products(products);
    let (written, deleted) = sync_once(&owner, &stub.base_url(), tenant, claimer).await;
    assert_eq!(written, 0);
    assert_eq!(deleted, 1);
    let (status, body) = send_json(
        &state,
        "GET",
        &format!("/public/store/catalog?host={host}"),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["products"].as_array().unwrap().len(), 2);
    let survives: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM store_products \
         WHERE tenant_id = $1 AND external_id = '500000000000000003' AND deleted_at IS NOT NULL",
    )
    .bind(tenant)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(
        survives, 1,
        "removed product must be soft-deleted, not dropped"
    );

    // Fence: a stale claimer's snapshot must not land.
    let conn = claim_own(&owner, tenant, claimer).await;
    let key_enc = conn.api_key_enc.clone().unwrap();
    let err = store::apply_catalog(&owner, &conn, "someone-else", &key_enc, &Default::default())
        .await
        .expect_err("stale claimer must not apply");
    assert!(matches!(err, cupboard_tenant::error::AppError::Conflict(_)));

    // Disconnect: credential shredded, catalog hidden immediately.
    let (status, _) = send_json(&state, "DELETE", "/store/connection", Some(&auth), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (enc_null, dek_null): (bool, bool) = sqlx::query_as(
        "SELECT api_key_enc IS NULL, api_key_dek IS NULL FROM store_connections \
         WHERE tenant_id = $1",
    )
    .bind(tenant)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert!(enc_null && dek_null, "disconnect must shred the credential");
    let (status, _) = send_json(
        &state,
        "GET",
        &format!("/public/store/catalog?host={host}"),
        None,
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "disconnected store must hide"
    );
}

#[tokio::test]
async fn connect_probe_failure_modes() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP connect_probe_failure_modes: TEST_DATABASE_URL unset");
        return;
    };
    let stub = PayNowStub::spawn(STUB_API_KEY).await;
    let state = test_state(owner.clone(), app.clone(), stub.base_url());
    let tenant = Uuid::new_v4();
    let auth = bearer(tenant);

    // Wrong key: 400 with the provider's rejection surfaced; nothing persisted.
    let (status, body) = send_json(
        &state,
        "POST",
        "/store/connection",
        Some(&auth),
        Some(serde_json::json!({"provider": "paynow", "api_key": "wrong"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "auth failure: {body}");
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM store_connections WHERE tenant_id = $1")
            .bind(tenant)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(count, 0, "failed probe must persist nothing");

    // Provider down (fault 500): surfaced as 503, single attempt (no probe retries).
    let before = stub.requests().len();
    stub.push_fault(500, r#"{"status":500,"code":"Internal","message":"boom"}"#);
    let (status, _) = send_json(
        &state,
        "POST",
        "/store/connection",
        Some(&auth),
        Some(serde_json::json!({"provider": "paynow", "api_key": STUB_API_KEY})),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        stub.requests().len(),
        before + 1,
        "probe must be a single attempt"
    );

    // Multiple stores without an explicit id: operator must choose.
    stub.set_stores(vec![
        serde_json::json!({"id": "459276186938060800", "name": "ACME Store"}),
        serde_json::json!({"id": "459276186938060801", "name": "Other Store"}),
    ]);
    let (status, body) = send_json(
        &state,
        "POST",
        "/store/connection",
        Some(&auth),
        Some(serde_json::json!({"provider": "paynow", "api_key": STUB_API_KEY})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body["message"].as_str().unwrap_or("").contains("specify"),
        "multi-store must ask for a store id: {body}"
    );

    // Tebex: politely refused until PR6.
    let (status, _) = send_json(
        &state,
        "POST",
        "/store/connection",
        Some(&auth),
        Some(serde_json::json!({"provider": "tebex", "api_key": "sk"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // No token: 401.
    let (status, _) = send_json(&state, "GET", "/store", None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn rls_isolates_store_connections() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP rls_isolates_store_connections: TEST_DATABASE_URL unset");
        return;
    };
    let tenant_a = Uuid::new_v4();
    let tenant_b = Uuid::new_v4();
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO store_connections (tenant_id, provider, store_external_id) \
         VALUES ($1, 'paynow', '42') RETURNING id",
    )
    .bind(tenant_a)
    .fetch_one(&owner)
    .await
    .expect("seed connection");

    let mut tx = cupboard_db::begin_tenant_tx(&app, TenantId(tenant_b))
        .await
        .expect("tenant tx");
    let visible: i64 = sqlx::query_scalar("SELECT count(*) FROM store_connections WHERE id = $1")
        .bind(id)
        .fetch_one(&mut *tx)
        .await
        .expect("count");
    tx.commit().await.unwrap();
    assert_eq!(visible, 0, "tenant B must not see tenant A's connection");
}

/// The internal host-resolution endpoint auth uses during player login: token-guarded,
/// maps a default-subdomain host to its owning tenant, and 404s unknown hosts (which is
/// what makes the login-code handoff safe against attacker-supplied hosts).
#[tokio::test]
async fn internal_resolve_site_maps_host_and_guards_token() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP internal_resolve_site_maps_host_and_guards_token: TEST_DATABASE_URL unset");
        return;
    };
    let mut state = test_state(owner.clone(), app.clone(), "http://unused".into());
    // Enable the internal endpoint with a known token.
    let cfg = (*state.config).clone();
    state.config = Arc::new(Config {
        internal_api_token: Some("secret-token".into()),
        ..cfg
    });

    let tenant = Uuid::new_v4();
    let slug = format!("ir-{}", &Uuid::new_v4().simple().to_string()[..10]);
    sqlx::query("INSERT INTO sites (tenant_id, slug) VALUES ($1, $2)")
        .bind(tenant)
        .bind(&slug)
        .execute(&owner)
        .await
        .expect("seed site");
    let host = format!("{slug}.sites.test");

    let call = |token: Option<&str>, host: String| {
        let state = state.clone();
        let token = token.map(str::to_string);
        async move {
            let mut req = Request::builder()
                .method("GET")
                .uri(format!("/internal/sites/resolve?host={host}"));
            if let Some(t) = token {
                req = req.header("x-internal-token", t);
            }
            let resp = http::router(state)
                .oneshot(req.body(Body::empty()).unwrap())
                .await
                .unwrap();
            let status = resp.status();
            let bytes = resp.into_body().collect().await.unwrap().to_bytes();
            let val: serde_json::Value =
                serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
            (status, val)
        }
    };

    // No token -> 401.
    assert_eq!(call(None, host.clone()).await.0, StatusCode::UNAUTHORIZED);
    // Wrong token -> 401.
    assert_eq!(
        call(Some("nope"), host.clone()).await.0,
        StatusCode::UNAUTHORIZED
    );
    // Correct token, real host -> 200 with the owning tenant.
    let (status, body) = call(Some("secret-token"), host).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["tenant_id"].as_str().unwrap(), tenant.to_string());
    // Unknown host -> 404 (an attacker-supplied host resolves to nothing).
    assert_eq!(
        call(Some("secret-token"), "attacker.com".into()).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(Some("secret-token"), "nope.sites.test".into()).await.0,
        StatusCode::NOT_FOUND
    );
}

/// Saving a manual webhook secret must never touch a PayNow connection (PayNow's secret is
/// runner-managed; overwriting it would silently break PayNow webhook verification).
#[tokio::test]
async fn webhook_secret_is_tebex_only() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP webhook_secret_is_tebex_only: TEST_DATABASE_URL unset");
        return;
    };
    let tenant = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO store_connections (tenant_id, provider, store_external_id) \
         VALUES ($1, 'paynow', 's1')",
    )
    .bind(tenant)
    .execute(&owner)
    .await
    .unwrap();
    let applied = store::set_webhook_secret(&app, TenantId(tenant), b"enc", b"dek")
        .await
        .unwrap();
    assert!(
        !applied,
        "set_webhook_secret must not match a PayNow connection"
    );
}
