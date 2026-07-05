//! Integration test for the tenant service's isolation: **tenant A cannot see tenant
//! B's site or audit rows**. Exercises Row-Level Security through the non-owner
//! `cupboard_app` role exactly as request handlers do (app pool + `set_tenant`).
//!
//! Requires a Postgres (PG18 for `uuidv7()`) with the `cupboard_app` role present:
//!   * `TEST_DATABASE_URL`     — owner role (runs migrations + seeds across tenants)
//!   * `TEST_DATABASE_URL_APP` — `cupboard_app` role (the RLS-enforced request path)
//!
//! Skips (passes) when `TEST_DATABASE_URL` is unset.

use sqlx::PgPool;
use tokio::sync::OnceCell;
use uuid::Uuid;

use cupboard_domain::TenantId;

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

/// Insert a site for `tenant` on the owner pool (RLS-exempt); return its id.
async fn seed_site(owner: &PgPool, tenant: Uuid, slug: &str) -> Uuid {
    sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO sites (tenant_id, slug) VALUES ($1, $2) RETURNING id",
    )
    .bind(tenant)
    .bind(slug)
    .fetch_one(owner)
    .await
    .expect("insert site")
}

/// Count sites with `id` visible on the app pool while scoped to `tenant`.
async fn count_as_tenant(app: &PgPool, tenant: Uuid, site_id: Uuid) -> i64 {
    let mut tx = cupboard_db::begin_tenant_tx(app, TenantId(tenant))
        .await
        .expect("begin tenant tx");
    let count = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM sites WHERE id = $1")
        .bind(site_id)
        .fetch_one(&mut *tx)
        .await
        .expect("count sites");
    tx.commit().await.expect("commit");
    count
}

fn unique_slug(prefix: &str) -> String {
    // Slugs are globally unique across test runs against a shared DB; suffix with a
    // random chunk (kept lowercase-alnum to satisfy the CHECK).
    format!("{prefix}-{}", &Uuid::new_v4().simple().to_string()[..12])
}

#[tokio::test]
async fn rls_isolates_sites_across_tenants() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP rls_isolates_sites_across_tenants: TEST_DATABASE_URL unset");
        return;
    };

    let tenant_a = Uuid::new_v4();
    let tenant_b = Uuid::new_v4();
    let site_a = seed_site(&owner, tenant_a, &unique_slug("rls-a")).await;
    let site_b = seed_site(&owner, tenant_b, &unique_slug("rls-b")).await;

    assert_eq!(
        count_as_tenant(&app, tenant_a, site_a).await,
        1,
        "tenant A must see its own site"
    );
    assert_eq!(
        count_as_tenant(&app, tenant_a, site_b).await,
        0,
        "tenant A must NOT see tenant B's site"
    );
    assert_eq!(count_as_tenant(&app, tenant_b, site_b).await, 1);
    assert_eq!(count_as_tenant(&app, tenant_b, site_a).await, 0);
}

#[tokio::test]
async fn rls_denies_sites_without_tenant() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP rls_denies_sites_without_tenant: TEST_DATABASE_URL unset");
        return;
    };
    let tenant = Uuid::new_v4();
    let site_id = seed_site(&owner, tenant, &unique_slug("rls-c")).await;

    // No `app.current_tenant` bound → policy predicate is NULL → row invisible.
    let visible: i64 = sqlx::query_scalar("SELECT count(*) FROM sites WHERE id = $1")
        .bind(site_id)
        .fetch_one(&app)
        .await
        .expect("count without tenant");
    assert_eq!(
        visible, 0,
        "app role must see no sites without a bound tenant"
    );
}

#[tokio::test]
async fn rls_isolates_audit_log() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP rls_isolates_audit_log: TEST_DATABASE_URL unset");
        return;
    };
    let tenant_a = Uuid::new_v4();
    let tenant_b = Uuid::new_v4();
    let row_id = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO audit_log (tenant_id, action) VALUES ($1, 'sites.create') RETURNING id",
    )
    .bind(tenant_a)
    .fetch_one(&owner)
    .await
    .expect("insert audit row");

    let mut tx = cupboard_db::begin_tenant_tx(&app, TenantId(tenant_b))
        .await
        .expect("begin tenant tx");
    let visible: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE id = $1")
        .bind(row_id)
        .fetch_one(&mut *tx)
        .await
        .expect("count audit");
    tx.commit().await.expect("commit");
    assert_eq!(visible, 0, "tenant B must not see tenant A's audit rows");
}
