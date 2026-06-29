//! Cupboard Gateway — the front door (Phase 0 walking skeleton).
//!
//! For now: boots telemetry, connects to Postgres, runs migrations, and serves
//! liveness/readiness probes. Auth, tenant routing, and the public API arrive in
//! Phase 1+.

mod config;

use axum::{extract::State, http::StatusCode, routing::get, Json, Router};
use config::Config;
use serde_json::json;
use sqlx::PgPool;
use std::net::SocketAddr;
use tower_http::trace::TraceLayer;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[derive(Clone)]
struct AppState {
    pool: PgPool,
    environment: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    cupboard_telemetry::init("cupboard-gateway");

    let config = Config::from_env()?;
    tracing::info!(env = %config.environment, "starting cupboard-gateway");

    let pool = cupboard_db::connect(&config.database_url, config.db_max_connections).await?;
    cupboard_db::run_migrations(&pool, &MIGRATOR).await?;

    let state = AppState {
        pool,
        environment: config.environment.clone(),
    };

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr: SocketAddr = config.bind_addr.parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "gateway listening");
    axum::serve(listener, app).await?;
    Ok(())
}

/// Liveness — process is up. Always 200 unless the process is dead.
async fn healthz(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "service": "cupboard-gateway",
        "environment": state.environment,
    }))
}

/// Readiness — dependencies reachable. 200 only if the database answers.
async fn readyz(State(state): State<AppState>) -> (StatusCode, Json<serde_json::Value>) {
    match sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.pool)
        .await
    {
        Ok(_) => (StatusCode::OK, Json(json!({"status": "ready"}))),
        Err(e) => {
            tracing::warn!(error = %e, "readiness check failed");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"status": "not_ready", "reason": "database"})),
            )
        }
    }
}
