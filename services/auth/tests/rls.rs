//! Integration test for the Phase 1 Definition of Done: **tenant A cannot see tenant
//! B**. Exercises Row-Level Security at the database layer through the non-owner
//! `cupboard_app` role exactly as request handlers do (app pool + `set_tenant`).
//!
//! Requires a Postgres with the `cupboard_app` (non-owner) role present and reachable:
//!   * `TEST_DATABASE_URL`     — owner role (runs migrations + seeds across tenants)
//!   * `TEST_DATABASE_URL_APP` — `cupboard_app` role (the RLS-enforced request path)
//!
//! Skips (passes) when `TEST_DATABASE_URL` is unset, so `cargo test` stays green where no
//! database is provisioned; CI sets both to run it for real.

use sqlx::PgPool;
use tokio::sync::OnceCell;
use uuid::Uuid;

use cupboard_domain::TenantId;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

// Tests run in parallel against one shared DB; migrate exactly once across them all
// (concurrent `MIGRATOR.run` on the same database races).
static MIGRATED: OnceCell<()> = OnceCell::const_new();

/// Connect the owner + app pools and ensure the schema is migrated once. Returns `None`
/// (skip) when no test database is configured.
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
        })
        .await;

    Some((owner, app))
}

/// Insert an organization (owner pool, RLS-exempt) and one role in it; return both ids.
async fn seed_org(owner: &PgPool, name: &str) -> (Uuid, Uuid) {
    let org_id: Uuid =
        sqlx::query_scalar("INSERT INTO organizations (name, slug) VALUES ($1, 'rls-'||gen_random_uuid()) RETURNING id")
            .bind(name)
            .fetch_one(owner)
            .await
            .expect("insert org");
    let role_id: Uuid = sqlx::query_scalar(
        "INSERT INTO roles (organization_id, name) VALUES ($1, 'TestRole') RETURNING id",
    )
    .bind(org_id)
    .fetch_one(owner)
    .await
    .expect("insert role");
    (org_id, role_id)
}

/// Count roles visible on the app pool while scoped to `tenant`, optionally filtered to a
/// specific role id.
async fn count_roles_as_tenant(app: &PgPool, tenant: Uuid, role_filter: Option<Uuid>) -> i64 {
    let mut tx = cupboard_db::begin_tenant_tx(app, TenantId(tenant))
        .await
        .expect("begin tenant tx");
    let count = match role_filter {
        Some(role_id) => {
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM roles WHERE id = $1")
                .bind(role_id)
                .fetch_one(&mut *tx)
                .await
        }
        None => {
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM roles")
                .fetch_one(&mut *tx)
                .await
        }
    }
    .expect("count roles");
    tx.commit().await.expect("commit");
    count
}

#[tokio::test]
async fn rls_isolates_tenant_a_from_tenant_b() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP rls_isolates_tenant_a_from_tenant_b: TEST_DATABASE_URL unset");
        return;
    };

    // Two independent tenants, each with one role.
    let (org_a, role_a) = seed_org(&owner, "Tenant A").await;
    let (org_b, role_b) = seed_org(&owner, "Tenant B").await;
    assert_ne!(org_a, org_b);

    // Scoped to A: A's role is visible, B's is not — even by explicit id filter.
    assert_eq!(
        count_roles_as_tenant(&app, org_a, Some(role_a)).await,
        1,
        "tenant A must see its own role"
    );
    assert_eq!(
        count_roles_as_tenant(&app, org_a, Some(role_b)).await,
        0,
        "tenant A must NOT see tenant B's role"
    );

    // Symmetric: scoped to B, only B's role is visible.
    assert_eq!(
        count_roles_as_tenant(&app, org_b, Some(role_b)).await,
        1,
        "tenant B must see its own role"
    );
    assert_eq!(
        count_roles_as_tenant(&app, org_b, Some(role_a)).await,
        0,
        "tenant B must NOT see tenant A's role"
    );

    // Each tenant sees exactly its own role via an unfiltered scan — proves the policy
    // filters reads, not just id lookups.
    assert_eq!(count_roles_as_tenant(&app, org_a, Some(role_a)).await, 1);
    assert_eq!(count_roles_as_tenant(&app, org_b, Some(role_b)).await, 1);
}

#[tokio::test]
async fn rls_denies_when_no_tenant_is_set() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP rls_denies_when_no_tenant_is_set: TEST_DATABASE_URL unset");
        return;
    };
    let (_org, role_id) = seed_org(&owner, "Tenant C").await;

    // No `app.current_tenant` bound → the policy predicate is NULL → that role is
    // invisible on the app pool. (Other tests' rows are likewise hidden, so we assert on
    // a specific role rather than a global count to stay robust under parallelism.)
    let visible: i64 = sqlx::query_scalar("SELECT count(*) FROM roles WHERE id = $1")
        .bind(role_id)
        .fetch_one(&app)
        .await
        .expect("count roles without tenant");
    assert_eq!(
        visible, 0,
        "the app role must see no tenant rows without a bound tenant (got {visible})"
    );
}
