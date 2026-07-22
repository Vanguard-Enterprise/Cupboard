//! Full-loop commerce e2e: operator connects a store, then the REAL supervisor claims
//! the connection, spawns a runner, and the runner performs the catalog sync against
//! the in-process PayNow stub, with heartbeats and lease bookkeeping. This is the path
//! staging runs; the other e2e file drives sync mechanics synchronously.
//!
//! Lives in its own test binary: the supervisor claims every connected row it can see,
//! which would race the lease assertions in store_e2e.rs if they shared a process.
//!
//! Requires TEST_DATABASE_URL(_APP); skips (passes) when unset.

use cupboard_tenant::cache::SiteCache;
use cupboard_tenant::config::Config;
use cupboard_tenant::domain::store;
use cupboard_tenant::providers::stub::PayNowStub;
use cupboard_tenant::providers::{paynow::PayNowClient, StoreProvider};
use sqlx::PgPool;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::OnceCell;
use uuid::Uuid;

const MASTER_KEY: [u8; 32] = [9u8; 32];
const STUB_API_KEY: &str = "pnapi_v1_supervisor_test";

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
static MIGRATED: OnceCell<()> = OnceCell::const_new();

async fn setup() -> Option<PgPool> {
    let owner_url = std::env::var("TEST_DATABASE_URL").ok()?;
    let owner = cupboard_db::connect_scoped(&owner_url, 5, "tenant,public")
        .await
        .expect("connect owner");
    MIGRATED
        .get_or_init(|| async {
            sqlx::query("CREATE SCHEMA IF NOT EXISTS tenant")
                .execute(&owner)
                .await
                .expect("ensure schema");
            MIGRATOR.run(&owner).await.expect("migrate");
        })
        .await;
    Some(owner)
}

#[tokio::test]
async fn supervisor_claims_and_runner_syncs() {
    let Some(owner) = setup().await else {
        eprintln!("SKIP supervisor_claims_and_runner_syncs: TEST_DATABASE_URL unset");
        return;
    };
    let stub = PayNowStub::spawn(STUB_API_KEY).await;
    let tenant = Uuid::new_v4();

    // This test drives the GLOBAL supervisor (it claims ANY connected row), so leftover
    // connected rows from other tests/runs in the shared DB can crowd this test's store out
    // of the LIMIT-batched claim. Neutralize them up front (they belong to already-finished
    // tests) so the supervisor reliably reaches the store seeded below.
    sqlx::query(
        "UPDATE store_connections SET status = 'disconnected' \
         WHERE tenant_id <> $1 AND status = 'connected'",
    )
    .bind(tenant)
    .execute(&owner)
    .await
    .expect("clear leftover connected rows");

    // Seed a connected store the way the connect handler does (probe + sealed key), on
    // the owner pool for brevity (this test exercises the runner, not the HTTP layer).
    let mut probe_client = PayNowClient::new(stub.base_url(), STUB_API_KEY, None::<String>);
    let info = probe_client.probe().await.expect("probe stub");
    let sealed = cupboard_crypto::seal(&MASTER_KEY, STUB_API_KEY.as_bytes()).unwrap();
    sqlx::query(
        "INSERT INTO store_connections \
             (tenant_id, provider, status, api_key_enc, api_key_dek, store_external_id, \
              store_name, store_currency) \
         VALUES ($1, 'paynow', 'connected', $2, $3, $4, $5, $6)",
    )
    .bind(tenant)
    .bind(&sealed.ciphertext)
    .bind(&sealed.wrapped_dek)
    .bind(&info.external_id)
    .bind(&info.name)
    .bind(&info.currency)
    .execute(&owner)
    .await
    .expect("seed connection");

    let config = Config {
        bind_addr: "127.0.0.1:0".into(),
        database_url: String::new(),
        database_url_app: String::new(),
        db_max_connections: 5,
        environment: "test".into(),
        otel_endpoint: None,
        jwt_public_key_pem: String::new(),
        redis_url: None,
        sites_suffix: "sites.test".into(),
        tenant_master_key: Some(MASTER_KEY),
        consumer_name: "sup-e2e".into(),
        paynow_api_base: stub.base_url(),
        tebex_headless_base: "http://tebex.test".into(),
        tebex_plugin_base: "http://tebex.test".into(),
        internal_api_token: None,
        bot_api_token: None,
        privacy_token: None,
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
        identity_internal_url: "http://identity.test".into(),
        retention_tick_secs: 3600,
        retention_webhook_payload_days: 90,
        retention_audit_days: 730,
        retention_stream_days: 14,
    };
    let supervisor = tokio::spawn(cupboard_tenant::store::supervisor::run(
        owner.clone(),
        SiteCache::disabled(),
        Arc::new(config),
    ));

    // The supervisor's first tick claims immediately; the runner's first tick syncs
    // immediately (next_catalog_sync_at defaults to now()). Poll for the outcome.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    let synced = loop {
        if tokio::time::Instant::now() > deadline {
            break false;
        }
        let done: Option<(Option<chrono::DateTime<chrono::Utc>>, Option<String>)> = sqlx::query_as(
            "SELECT catalog_synced_at, claimed_by FROM store_connections \
                 WHERE tenant_id = $1",
        )
        .bind(tenant)
        .fetch_optional(&owner)
        .await
        .expect("poll connection");
        if let Some((Some(_), claimed_by)) = done {
            assert_eq!(
                claimed_by.as_deref(),
                Some("sup-e2e-store"),
                "the supervisor's claimer must hold the lease"
            );
            break true;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    supervisor.abort();
    assert!(synced, "supervisor + runner must complete a catalog sync");

    // The stub's default fixture carries 3 products; the sweep should have stored them.
    let catalog = store::public_catalog(&owner, tenant)
        .await
        .expect("public catalog")
        .expect("catalog present");
    assert_eq!(catalog.products.len(), 3);
    assert!(!catalog.categories.is_empty());
}
