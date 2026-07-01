//! Cupboard Fleet — tenant-configured game-server connections (Phase 2).
//!
//! Phase 2 scope: RCON/A2S connections (zero-install). Boots telemetry, opens two
//! Postgres pools (owner for migrations + the cross-tenant Collector feed, `cupboard_app`
//! for RLS-scoped tenant CRUD), ensures and migrates the service-owned `fleet` schema,
//! then serves the HTTP API. Panel adapters (Pelican/Pterodactyl) follow later.

mod config;
mod domain;
mod error;
mod http;
mod state;

use anyhow::Context as _;
use config::Config;
use cupboard_auth_core::Keys;
use state::AppState;
use std::net::SocketAddr;
use std::sync::Arc;

/// Fleet owns the `fleet` Postgres schema; pinning the search path keeps its objects and
/// its `_sqlx_migrations` ledger isolated from other services in the shared database.
const SEARCH_PATH: &str = "fleet,public";

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = Config::from_env()?;

    let _otel_guard = cupboard_telemetry::init("cupboard-fleet", config.otel_endpoint.as_deref());
    tracing::info!(env = %config.environment, "starting cupboard-fleet");

    // Owner pool: migrations + the cross-tenant internal endpoint.
    let owner_pool =
        cupboard_db::connect_scoped(&config.database_url, config.db_max_connections, SEARCH_PATH)
            .await?;
    sqlx::query("CREATE SCHEMA IF NOT EXISTS fleet")
        .execute(&owner_pool)
        .await
        .context("create fleet schema")?;
    cupboard_db::run_migrations(&owner_pool, &MIGRATOR).await?;

    // App pool: request-scoped tenant CRUD (RLS enforced via the non-owner role).
    let app_pool = cupboard_db::connect_scoped(
        &config.database_url_app,
        config.db_max_connections,
        SEARCH_PATH,
    )
    .await?;

    let keys = Keys::verifier_from_ed_pem(&config.jwt_public_key_pem)
        .context("load Ed25519 JWT verifier")?;

    if config.internal_api_token.is_none() {
        tracing::warn!(
            "INTERNAL_API_TOKEN unset — the Collector config feed (/internal/servers) is \
             disabled and will return 503 until it is configured"
        );
    }

    let state = AppState {
        owner_pool,
        app_pool,
        keys: Arc::new(keys),
        config: Arc::new(config.clone()),
    };

    let app = http::router(state);

    let addr: SocketAddr = config.bind_addr.parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "fleet listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    tracing::info!("fleet stopped; flushing telemetry");
    Ok(())
}

/// Resolves on SIGTERM (Kubernetes) or Ctrl-C, letting in-flight requests drain.
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("install Ctrl-C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received");
}
