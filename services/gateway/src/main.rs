//! Cupboard Gateway — the front door (Phase 0 walking skeleton).
//!
//! For now: boots telemetry, connects to Postgres, runs migrations, and serves
//! liveness/readiness probes. Auth, tenant routing, and the public API arrive in
//! Phase 1+.

mod config;
mod metrics;

use axum::{extract::State, http::StatusCode, routing::get, Json, Router};
use config::Config;
use serde_json::json;
use sqlx::PgPool;
use std::net::SocketAddr;
use tower_http::trace::{DefaultMakeSpan, TraceLayer};
use tracing::Level;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[derive(Clone)]
struct AppState {
    pool: PgPool,
    environment: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = Config::from_env()?;

    // Hold the guard for the whole process; it drops at the end of `main` (after
    // the server stops), flushing any buffered spans and metrics.
    let _otel_guard = cupboard_telemetry::init("cupboard-gateway", config.otel_endpoint.as_deref());
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
        // INFO-level spans so the default `info` filter keeps them and they
        // export as traces (DefaultMakeSpan is DEBUG, which the filter drops).
        .layer(TraceLayer::new_for_http().make_span_with(DefaultMakeSpan::new().level(Level::INFO)))
        .layer(axum::middleware::from_fn(metrics::track))
        .with_state(state);

    let addr: SocketAddr = config.bind_addr.parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "gateway listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    tracing::info!("gateway stopped; flushing telemetry");
    Ok(())
}

/// Resolves when the process receives SIGTERM (Kubernetes pod termination) or
/// Ctrl-C, letting in-flight requests drain and telemetry flush before exit.
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
