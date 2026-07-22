//! End-to-end for the Phase 7 retention/purge loop (decision E, tenant slice): the
//! webhook-payload NULLing keeps the dedupe rows, the cutoff boundary is exact, a
//! second tick is a no-op, and the per-tick row cap bounds the work. Drives
//! `purge_once` directly (the loop wrapper only adds the ticker + panic absorption).
//!
//! Requires TEST_DATABASE_URL; skips (passes) when unset.

use chrono::{DateTime, Duration, Utc};
use cupboard_tenant::config::Config;
use cupboard_tenant::retention_loop::{self, PurgeCounts};
use sqlx::PgPool;
use tokio::sync::OnceCell;
use uuid::Uuid;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
static MIGRATED: OnceCell<()> = OnceCell::const_new();
/// The purge is global (cutoff-scoped, not tenant-scoped), so tests that assert exact
/// purged-row counts must not run concurrently with each other.
static PURGE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn setup() -> Option<PgPool> {
    let owner_url = std::env::var("TEST_DATABASE_URL").ok()?;
    let owner = cupboard_db::connect_scoped(&owner_url, 5, "tenant,public")
        .await
        .expect("owner");
    MIGRATED
        .get_or_init(|| async {
            sqlx::query("CREATE SCHEMA IF NOT EXISTS tenant")
                .execute(&owner)
                .await
                .expect("schema");
            MIGRATOR.run(&owner).await.expect("migrate");
        })
        .await;
    Some(owner)
}

/// The retention slice of Config with the plan's default windows; everything else is
/// inert for `purge_once` (no redis: the stream trim skips).
fn test_config() -> Config {
    Config {
        bind_addr: "127.0.0.1:0".into(),
        database_url: String::new(),
        database_url_app: String::new(),
        db_max_connections: 5,
        environment: "test".into(),
        otel_endpoint: None,
        jwt_public_key_pem: String::new(),
        redis_url: None,
        sites_suffix: "sites.test".into(),
        tenant_master_key: None,
        consumer_name: "retention-test".into(),
        paynow_api_base: "http://paynow.test".into(),
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
    }
}

/// Drain any expired backlog left by earlier tests/runs so count assertions are exact.
async fn drain(pool: &PgPool, config: &Config) {
    retention_loop::purge_once(pool, config, i64::MAX).await;
}

async fn seed_connection(pool: &PgPool, tenant: Uuid) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO store_connections (tenant_id, provider, store_external_id)
         VALUES ($1, 'paynow', $2) RETURNING id",
    )
    .bind(tenant)
    .bind(Uuid::new_v4().to_string())
    .fetch_one(pool)
    .await
    .expect("seed store connection")
}

async fn seed_store_event(
    pool: &PgPool,
    tenant: Uuid,
    connection: Uuid,
    received_at: DateTime<Utc>,
) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO store_webhook_events
             (tenant_id, connection_id, provider, event_id, payload, received_at)
         VALUES ($1, $2, 'paynow', $3, '{\"pii\": \"raw body\"}'::jsonb, $4)
         RETURNING id",
    )
    .bind(tenant)
    .bind(connection)
    .bind(Uuid::new_v4().to_string())
    .bind(received_at)
    .fetch_one(pool)
    .await
    .expect("seed store webhook event")
}

async fn seed_billing_event(pool: &PgPool, tenant: Uuid, received_at: DateTime<Utc>) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO billing_webhook_events (tenant_id, event_id, payload, received_at)
         VALUES ($1, $2, '{\"pii\": \"raw body\"}'::jsonb, $3) RETURNING id",
    )
    .bind(tenant)
    .bind(format!("evt_{}", Uuid::new_v4().simple()))
    .bind(received_at)
    .fetch_one(pool)
    .await
    .expect("seed billing webhook event")
}

async fn seed_audit_row(pool: &PgPool, tenant: Uuid, created_at: DateTime<Utc>) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO audit_log (tenant_id, action, created_at)
         VALUES ($1, 'retention.test', $2) RETURNING id",
    )
    .bind(tenant)
    .bind(created_at)
    .fetch_one(pool)
    .await
    .expect("seed audit row")
}

async fn payload_present(pool: &PgPool, table: &str, id: Uuid) -> bool {
    sqlx::query_scalar(&format!(
        "SELECT payload IS NOT NULL FROM {table} WHERE id = $1"
    ))
    .bind(id)
    .fetch_one(pool)
    .await
    .expect("payload lookup")
}

async fn row_exists(pool: &PgPool, table: &str, id: Uuid) -> bool {
    sqlx::query_scalar(&format!(
        "SELECT EXISTS(SELECT 1 FROM {table} WHERE id = $1)"
    ))
    .bind(id)
    .fetch_one(pool)
    .await
    .expect("row lookup")
}

// ================================== Tests ==================================

/// A row one hour INSIDE the window survives untouched; one hour PAST it is purged.
/// Timestamps are constructed explicitly around each table's cutoff.
#[tokio::test]
async fn boundary_row_inside_window_survives_past_it_is_purged() {
    let Some(pool) = setup().await else {
        eprintln!("SKIP boundary_row_inside_window_survives_past_it_is_purged");
        return;
    };
    let _guard = PURGE_LOCK.lock().await;
    let config = test_config();
    drain(&pool, &config).await;

    let now = Utc::now();
    let payload_edge = now - Duration::days(config.retention_webhook_payload_days);
    let audit_edge = now - Duration::days(config.retention_audit_days);
    let tenant = Uuid::new_v4();
    let connection = seed_connection(&pool, tenant).await;

    let store_inside =
        seed_store_event(&pool, tenant, connection, payload_edge + Duration::hours(1)).await;
    let store_past =
        seed_store_event(&pool, tenant, connection, payload_edge - Duration::hours(1)).await;
    let billing_inside = seed_billing_event(&pool, tenant, payload_edge + Duration::hours(1)).await;
    let billing_past = seed_billing_event(&pool, tenant, payload_edge - Duration::hours(1)).await;
    let audit_inside = seed_audit_row(&pool, tenant, audit_edge + Duration::hours(1)).await;
    let audit_past = seed_audit_row(&pool, tenant, audit_edge - Duration::hours(1)).await;

    let counts = retention_loop::purge_once(&pool, &config, retention_loop::ROW_CAP).await;
    assert_eq!(counts.store_webhook_payloads, 1);
    assert_eq!(counts.billing_webhook_payloads, 1);
    assert_eq!(counts.audit_rows, 1);
    assert_eq!(counts.stream_entries, 0, "no redis configured");

    assert!(payload_present(&pool, "store_webhook_events", store_inside).await);
    assert!(!payload_present(&pool, "store_webhook_events", store_past).await);
    assert!(payload_present(&pool, "billing_webhook_events", billing_inside).await);
    assert!(!payload_present(&pool, "billing_webhook_events", billing_past).await);
    assert!(row_exists(&pool, "audit_log", audit_inside).await);
    assert!(!row_exists(&pool, "audit_log", audit_past).await);
}

/// Payload NULLing keeps the row: the replay-dedupe record (event id) must survive, so
/// the tenant's event row count is unchanged while the payload is gone.
#[tokio::test]
async fn dedupe_row_survives_payload_nulling() {
    let Some(pool) = setup().await else {
        eprintln!("SKIP dedupe_row_survives_payload_nulling");
        return;
    };
    let _guard = PURGE_LOCK.lock().await;
    let config = test_config();
    drain(&pool, &config).await;

    let old = Utc::now() - Duration::days(config.retention_webhook_payload_days + 30);
    let tenant = Uuid::new_v4();
    let connection = seed_connection(&pool, tenant).await;
    let store_id = seed_store_event(&pool, tenant, connection, old).await;
    let billing_id = seed_billing_event(&pool, tenant, old).await;

    let count_for = |table: &'static str| {
        let pool = pool.clone();
        async move {
            sqlx::query_scalar::<_, i64>(&format!(
                "SELECT count(*) FROM {table} WHERE tenant_id = $1"
            ))
            .bind(tenant)
            .fetch_one(&pool)
            .await
            .expect("count")
        }
    };
    assert_eq!(count_for("store_webhook_events").await, 1);
    assert_eq!(count_for("billing_webhook_events").await, 1);

    retention_loop::purge_once(&pool, &config, retention_loop::ROW_CAP).await;

    // Same rows, same event ids, payloads gone.
    assert_eq!(count_for("store_webhook_events").await, 1);
    assert_eq!(count_for("billing_webhook_events").await, 1);
    assert!(!payload_present(&pool, "store_webhook_events", store_id).await);
    assert!(!payload_present(&pool, "billing_webhook_events", billing_id).await);
    let event_id: Option<String> =
        sqlx::query_scalar("SELECT event_id FROM store_webhook_events WHERE id = $1")
            .bind(store_id)
            .fetch_one(&pool)
            .await
            .expect("event id");
    assert!(event_id.is_some_and(|e| !e.is_empty()));
}

/// Purging is idempotent: after one tick has consumed the backlog, the next tick finds
/// nothing (already-NULLed payloads are not re-counted, deleted rows are gone).
#[tokio::test]
async fn second_tick_is_a_noop() {
    let Some(pool) = setup().await else {
        eprintln!("SKIP second_tick_is_a_noop");
        return;
    };
    let _guard = PURGE_LOCK.lock().await;
    let config = test_config();
    drain(&pool, &config).await;

    let tenant = Uuid::new_v4();
    let connection = seed_connection(&pool, tenant).await;
    let old_payload = Utc::now() - Duration::days(config.retention_webhook_payload_days + 1);
    let old_audit = Utc::now() - Duration::days(config.retention_audit_days + 1);
    seed_store_event(&pool, tenant, connection, old_payload).await;
    seed_billing_event(&pool, tenant, old_payload).await;
    seed_audit_row(&pool, tenant, old_audit).await;

    let first = retention_loop::purge_once(&pool, &config, retention_loop::ROW_CAP).await;
    assert_eq!(first.store_webhook_payloads, 1);
    assert_eq!(first.billing_webhook_payloads, 1);
    assert_eq!(first.audit_rows, 1);

    let second = retention_loop::purge_once(&pool, &config, retention_loop::ROW_CAP).await;
    assert_eq!(second, PurgeCounts::default());
}

/// A tick touches at most `row_cap` rows per table; the remainder is left for later
/// ticks (and a big-cap tick then drains it).
#[tokio::test]
async fn row_cap_bounds_the_work_per_tick() {
    let Some(pool) = setup().await else {
        eprintln!("SKIP row_cap_bounds_the_work_per_tick");
        return;
    };
    let _guard = PURGE_LOCK.lock().await;
    let config = test_config();
    drain(&pool, &config).await;

    let tenant = Uuid::new_v4();
    let connection = seed_connection(&pool, tenant).await;
    let old_payload = Utc::now() - Duration::days(config.retention_webhook_payload_days + 1);
    let old_audit = Utc::now() - Duration::days(config.retention_audit_days + 1);
    for _ in 0..5 {
        seed_store_event(&pool, tenant, connection, old_payload).await;
        seed_billing_event(&pool, tenant, old_payload).await;
        seed_audit_row(&pool, tenant, old_audit).await;
    }

    let capped = retention_loop::purge_once(&pool, &config, 2).await;
    assert_eq!(capped.store_webhook_payloads, 2);
    assert_eq!(capped.billing_webhook_payloads, 2);
    assert_eq!(capped.audit_rows, 2);

    let rest = retention_loop::purge_once(&pool, &config, retention_loop::ROW_CAP).await;
    assert_eq!(rest.store_webhook_payloads, 3);
    assert_eq!(rest.billing_webhook_payloads, 3);
    assert_eq!(rest.audit_rows, 3);
}
