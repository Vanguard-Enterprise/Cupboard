//! Postgres access shared by Cupboard services: pooling, migrations, and the
//! row-level-security tenant helper.

use cupboard_domain::TenantId;
use sqlx::postgres::{PgPool, PgPoolOptions};
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
