//! Cupboard Identity & Moderation — the global identity graph + per-tenant moderation
//! (Phase 2). This slice: ingest roster snapshots from the bus into players / identifiers
//! / IP+owner signals / name history / sessions, and serve the dashboard's player list +
//! profiles. Bans, links, and evasion alerts land in later PRs.
//!
//! Boots telemetry, opens two Postgres pools (owner for migrations + the ingestion
//! consumer, `cupboard_app` for RLS-scoped reads), migrates the `identity` schema, spawns
//! the bus consumer, then serves the HTTP read API.

mod config;
mod consumer;
mod domain;
mod error;
mod http;
mod state;

use anyhow::Context as _;
use config::Config;
use cupboard_auth_core::Keys;
use cupboard_bus::Bus;
use state::AppState;
use std::net::SocketAddr;
use std::sync::Arc;

const SEARCH_PATH: &str = "identity,public";

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = Config::from_env()?;

    let _otel_guard =
        cupboard_telemetry::init("cupboard-identity", config.otel_endpoint.as_deref());
    tracing::info!(env = %config.environment, "starting cupboard-identity");

    // Owner pool: migrations + the ingestion consumer (writes global tables + explicit
    // tenant_id on sessions, RLS-exempt).
    let owner_pool =
        cupboard_db::connect_scoped(&config.database_url, config.db_max_connections, SEARCH_PATH)
            .await?;
    sqlx::query("CREATE SCHEMA IF NOT EXISTS identity")
        .execute(&owner_pool)
        .await
        .context("create identity schema")?;
    cupboard_db::run_migrations(&owner_pool, &MIGRATOR).await?;

    // App pool: request-scoped dashboard reads (RLS enforced via the non-owner role).
    let app_pool = cupboard_db::connect_scoped(
        &config.database_url_app,
        config.db_max_connections,
        SEARCH_PATH,
    )
    .await?;

    let keys = Keys::verifier_from_ed_pem(&config.jwt_public_key_pem)
        .context("load Ed25519 JWT verifier")?;

    // Spawn one ingestion consumer per stream, each on its own bus connection (a
    // blocking XREADGROUP occupies the whole connection).
    let pepper = config.value_pepper.as_bytes().to_vec();
    let consumers = vec![
        tokio::spawn(consumer::run_roster(
            Bus::connect(&config.redis_url).await?,
            owner_pool.clone(),
            pepper.clone(),
            config.consumer_name.clone(),
        )),
        tokio::spawn(consumer::run_sessions(
            Bus::connect(&config.redis_url).await?,
            owner_pool.clone(),
            pepper.clone(),
            config.consumer_name.clone(),
        )),
        tokio::spawn(consumer::run_chat(
            Bus::connect(&config.redis_url).await?,
            owner_pool.clone(),
            pepper,
            config.consumer_name.clone(),
        )),
    ];

    let state = AppState {
        owner_pool,
        app_pool,
        keys: Arc::new(keys),
        config: Arc::new(config.clone()),
    };

    let app = http::router(state);

    let addr: SocketAddr = config.bind_addr.parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "identity listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    for c in &consumers {
        c.abort();
    }
    tracing::info!("identity stopped; flushing telemetry");
    Ok(())
}

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
