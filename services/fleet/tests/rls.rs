//! Integration test for Fleet's tenant isolation: **tenant A cannot see tenant B's
//! servers**. Exercises Row-Level Security on `servers` through the non-owner
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

    let owner = cupboard_db::connect_scoped(&owner_url, 5, "fleet,public")
        .await
        .expect("connect owner");
    let app = cupboard_db::connect_scoped(&app_url, 5, "fleet,public")
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

    Some((owner, app))
}

/// Insert a server for `tenant` on the owner pool (RLS-exempt); return its id.
async fn seed_server(owner: &PgPool, tenant: Uuid, name: &str) -> Uuid {
    sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO servers \
         (tenant_id, name, rcon_host, rcon_port, rcon_password_enc, rcon_password_dek) \
         VALUES ($1, $2, '10.0.0.1', 28016, $3, $3) RETURNING id",
    )
    .bind(tenant)
    .bind(name)
    .bind(vec![0u8; 16]) // dummy ciphertext/dek; RLS test doesn't decrypt
    .fetch_one(owner)
    .await
    .expect("insert server")
}

/// Count servers with `id` visible on the app pool while scoped to `tenant`.
async fn count_as_tenant(app: &PgPool, tenant: Uuid, server_id: Uuid) -> i64 {
    let mut tx = cupboard_db::begin_tenant_tx(app, TenantId(tenant))
        .await
        .expect("begin tenant tx");
    let count = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM servers WHERE id = $1")
        .bind(server_id)
        .fetch_one(&mut *tx)
        .await
        .expect("count servers");
    tx.commit().await.expect("commit");
    count
}

#[tokio::test]
async fn rls_isolates_servers_across_tenants() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP rls_isolates_servers_across_tenants: TEST_DATABASE_URL unset");
        return;
    };

    let tenant_a = Uuid::new_v4();
    let tenant_b = Uuid::new_v4();
    let server_a = seed_server(&owner, tenant_a, "A-server").await;
    let server_b = seed_server(&owner, tenant_b, "B-server").await;

    // Scoped to A: A's server is visible, B's is not.
    assert_eq!(
        count_as_tenant(&app, tenant_a, server_a).await,
        1,
        "tenant A must see its own server"
    );
    assert_eq!(
        count_as_tenant(&app, tenant_a, server_b).await,
        0,
        "tenant A must NOT see tenant B's server"
    );
    // Symmetric.
    assert_eq!(count_as_tenant(&app, tenant_b, server_b).await, 1);
    assert_eq!(count_as_tenant(&app, tenant_b, server_a).await, 0);
}

#[tokio::test]
async fn rls_denies_servers_without_tenant() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP rls_denies_servers_without_tenant: TEST_DATABASE_URL unset");
        return;
    };
    let tenant = Uuid::new_v4();
    let server_id = seed_server(&owner, tenant, "C-server").await;

    // No `app.current_tenant` bound → policy predicate is NULL → row invisible.
    let visible: i64 = sqlx::query_scalar("SELECT count(*) FROM servers WHERE id = $1")
        .bind(server_id)
        .fetch_one(&app)
        .await
        .expect("count without tenant");
    assert_eq!(
        visible, 0,
        "app role must see no servers without a bound tenant"
    );
}
