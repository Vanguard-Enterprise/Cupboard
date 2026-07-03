//! Tenant isolation for the Phase 4 BattleMetrics tables: **tenant A cannot see tenant
//! B's** connection, jobs, sync map, or ban lists through the non-owner `cupboard_app`
//! role (app pool + `set_tenant`), and nothing is visible without a bound tenant.
//!
//! Mirrors `services/fleet/tests/rls.rs`. Skips (passes) when `TEST_DATABASE_URL` is
//! unset.

use sqlx::PgPool;
use tokio::sync::OnceCell;
use uuid::Uuid;

use cupboard_domain::TenantId;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
static MIGRATED: OnceCell<()> = OnceCell::const_new();

async fn setup() -> Option<(PgPool, PgPool)> {
    let owner_url = std::env::var("TEST_DATABASE_URL").ok()?;
    let app_url = std::env::var("TEST_DATABASE_URL_APP").unwrap_or_else(|_| owner_url.clone());

    let owner = cupboard_db::connect_scoped(&owner_url, 5, "identity,public")
        .await
        .expect("connect owner");
    let app = cupboard_db::connect_scoped(&app_url, 5, "identity,public")
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

    Some((owner, app))
}

/// Seed one row in each BM table for `tenant` (owner pool, RLS-exempt); returns the
/// connection id the child rows hang off.
async fn seed_bm_rows(owner: &PgPool, tenant: Uuid) -> Uuid {
    let connection_id: Uuid = sqlx::query_scalar(
        "INSERT INTO bm_connections (tenant_id, bm_org_id, token_enc, token_dek) \
         VALUES ($1, '123', $2, $2) RETURNING id",
    )
    .bind(tenant)
    .bind(vec![0u8; 8])
    .fetch_one(owner)
    .await
    .expect("insert connection");

    sqlx::query("INSERT INTO bm_import_jobs (tenant_id, connection_id) VALUES ($1, $2)")
        .bind(tenant)
        .bind(connection_id)
        .execute(owner)
        .await
        .expect("insert job");

    sqlx::query(
        "INSERT INTO bm_sync_map (tenant_id, entity_type, external_id, local_id) \
         VALUES ($1, 'ban', 'ext-1', $2)",
    )
    .bind(tenant)
    .bind(Uuid::new_v4())
    .execute(owner)
    .await
    .expect("insert map row");

    sqlx::query("INSERT INTO bm_ban_lists (tenant_id, external_id, name) VALUES ($1, 'l1', 'L')")
        .bind(tenant)
        .execute(owner)
        .await
        .expect("insert ban list");

    connection_id
}

const BM_TABLES: [&str; 4] = [
    "bm_connections",
    "bm_import_jobs",
    "bm_sync_map",
    "bm_ban_lists",
];

/// Rows of `table` belonging to `owner_tenant` that are visible while scoped to
/// `viewer_tenant` on the app pool.
async fn visible_as(app: &PgPool, table: &str, viewer: Uuid, owner_tenant: Uuid) -> i64 {
    let mut tx = cupboard_db::begin_tenant_tx(app, TenantId(viewer))
        .await
        .expect("begin tenant tx");
    let count = sqlx::query_scalar::<_, i64>(&format!(
        "SELECT count(*) FROM {table} WHERE tenant_id = $1"
    ))
    .bind(owner_tenant)
    .fetch_one(&mut *tx)
    .await
    .expect("count");
    tx.commit().await.expect("commit");
    count
}

#[tokio::test]
async fn rls_isolates_bm_tables_across_tenants() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP rls_isolates_bm_tables_across_tenants: TEST_DATABASE_URL unset");
        return;
    };

    let tenant_a = Uuid::new_v4();
    let tenant_b = Uuid::new_v4();
    seed_bm_rows(&owner, tenant_a).await;
    seed_bm_rows(&owner, tenant_b).await;

    for table in BM_TABLES {
        assert_eq!(
            visible_as(&app, table, tenant_a, tenant_a).await,
            1,
            "{table}: tenant A must see its own row"
        );
        assert_eq!(
            visible_as(&app, table, tenant_a, tenant_b).await,
            0,
            "{table}: tenant A must NOT see tenant B's row"
        );
        assert_eq!(
            visible_as(&app, table, tenant_b, tenant_b).await,
            1,
            "{table}: tenant B must see its own row"
        );
    }
}

#[tokio::test]
async fn rls_denies_bm_tables_without_tenant() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP rls_denies_bm_tables_without_tenant: TEST_DATABASE_URL unset");
        return;
    };
    let tenant = Uuid::new_v4();
    seed_bm_rows(&owner, tenant).await;

    for table in BM_TABLES {
        let visible: i64 = sqlx::query_scalar(&format!(
            "SELECT count(*) FROM {table} WHERE tenant_id = $1"
        ))
        .bind(tenant)
        .fetch_one(&app)
        .await
        .expect("count without tenant");
        assert_eq!(
            visible, 0,
            "{table}: app role must see nothing without a bound tenant"
        );
    }
}
