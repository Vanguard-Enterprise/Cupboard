//! Postgres access shared by Cupboard services: pooling, migrations, and the
//! row-level-security tenant helpers.
//!
//! ## Two connection roles
//!
//! Tenant isolation depends on connecting as a **non-owner** role, because a Postgres
//! table owner bypasses RLS unless the table is `FORCE`d (and even then policies must
//! exist). Services that serve tenant data therefore hold two pools:
//!
//!   * an **owner** pool (`cupboard`) — runs migrations and the few cross-tenant/system
//!     operations (login, "list my orgs"); RLS-exempt, so these queries must scope
//!     themselves explicitly (e.g. `WHERE user_id = $me`).
//!   * an **app** pool (`cupboard_app`, non-owner) — every request-scoped tenant read
//!     or write, always inside [`begin_tenant_tx`] so RLS filters on the bound tenant.
//!
//! Both are built with [`connect`]; they differ only in the `DATABASE_URL` role.

use cupboard_domain::TenantId;
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions};
use std::time::Duration;

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("database error: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("migration error: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),
}

/// Connect to Postgres (the CNPG PgBouncer rw pooler in-cluster) and return a pool.
pub async fn connect(database_url: &str, max_connections: u32) -> Result<PgPool, DbError> {
    let pool = PgPoolOptions::new()
        .max_connections(max_connections)
        .acquire_timeout(Duration::from_secs(10))
        .connect(database_url)
        .await?;
    tracing::info!(max_connections, "database pool established");
    Ok(pool)
}

/// Connect with a fixed `search_path` (libpq `-c search_path=…`), pinned on every
/// pooled connection. A service that owns its own Postgres schema uses this so its
/// tables — and its private `_sqlx_migrations` ledger — live in that schema, isolated
/// from other services sharing the database (e.g. auth uses `auth,public`). Keep
/// `public` last so shared extension types (`citext`, `pgcrypto`) still resolve.
pub async fn connect_scoped(
    database_url: &str,
    max_connections: u32,
    search_path: &str,
) -> Result<PgPool, DbError> {
    let opts: PgConnectOptions = database_url
        .parse()
        .map_err(|e: sqlx::Error| DbError::Sqlx(e))?;
    let opts = opts.options([("search_path", search_path)]);
    let pool = PgPoolOptions::new()
        .max_connections(max_connections)
        .acquire_timeout(Duration::from_secs(10))
        .connect_with(opts)
        .await?;
    tracing::info!(
        max_connections,
        search_path,
        "scoped database pool established"
    );
    Ok(pool)
}

/// Run embedded migrations from `services/<svc>/migrations` at startup.
pub async fn run_migrations(
    pool: &PgPool,
    migrator: &sqlx::migrate::Migrator,
) -> Result<(), DbError> {
    migrator.run(pool).await?;
    tracing::info!("migrations applied");
    Ok(())
}

/// Bind the current tenant for row-level security on this transaction.
///
/// Must run inside a transaction (`SET LOCAL` is transaction-scoped); RLS policies
/// read `current_setting('app.current_tenant')`. See `docs/identity-schema.md`.
pub async fn set_tenant<'c>(
    tx: &mut sqlx::Transaction<'c, sqlx::Postgres>,
    tenant: TenantId,
) -> Result<(), DbError> {
    sqlx::query("SELECT set_config('app.current_tenant', $1, true)")
        .bind(tenant.0.to_string())
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Begin a transaction on the **app** (non-owner) pool with `tenant` bound for RLS, so
/// every query in it is automatically scoped to that tenant. The caller runs their
/// queries on the returned transaction and `commit`s (or drops to roll back).
///
/// This is the standard entry point for request-scoped tenant data access — prefer it
/// over hand-rolling `begin` + [`set_tenant`].
pub async fn begin_tenant_tx(
    pool: &PgPool,
    tenant: TenantId,
) -> Result<sqlx::Transaction<'static, sqlx::Postgres>, DbError> {
    let mut tx = pool.begin().await?;
    set_tenant(&mut tx, tenant).await?;
    Ok(tx)
}
