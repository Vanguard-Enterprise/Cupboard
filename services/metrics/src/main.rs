//! Cupboard Metrics — the perf pipeline (Phase 3 PR6; ARCHITECTURE Decision 5).
//!
//! Consumes `cupboard:perf` samples from the bus and re-emits them as OTel metrics with
//! `tenant_id`/`server_id` attributes → alloy-receiver → **Mimir**, where they become
//! the perf dashboards' time series. The recommendation engine (PromQL over Mimir) and
//! the dashboard query proxy land in PR7 — this service is deliberately DB-free until
//! then.
//!
//! Cardinality discipline (ARCHITECTURE "Mimir cardinality"): attributes are bounded —
//! tenant × server for the server gauges, plus a top-N `plugin` label (the Collector
//! truncates hook lists to [`cupboard_domain::push::MAX_HOOK_TIMINGS`]) for hook time.

mod config;
mod recorder;

use std::net::SocketAddr;

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use config::Config;
use cupboard_bus::Bus;
use serde_json::json;
use tower_http::trace::{DefaultMakeSpan, TraceLayer};
use tracing::Level;

#[derive(Clone)]
struct HealthState {
    environment: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = Config::from_env()?;

    let _otel_guard = cupboard_telemetry::init("cupboard-metrics", config.otel_endpoint.as_deref());
    tracing::info!(env = %config.environment, "starting cupboard-metrics");
    if config.otel_endpoint.is_none() {
        tracing::warn!(
            "OTEL_EXPORTER_OTLP_ENDPOINT unset — perf samples will be consumed but the \
             OTel gauges are inert (no Mimir export)"
        );
    }

    let bus = Bus::connect(&config.redis_url).await?;
    let consumer = tokio::spawn(recorder::run(bus, config.consumer_name.clone()));

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route_layer(axum::middleware::from_fn(cupboard_telemetry::http::track))
        .layer(TraceLayer::new_for_http().make_span_with(DefaultMakeSpan::new().level(Level::INFO)))
        .with_state(HealthState {
            environment: config.environment.clone(),
        });

    let addr: SocketAddr = config.bind_addr.parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "metrics http server listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    consumer.abort();
    tracing::info!("metrics stopped; flushing telemetry");
    Ok(())
}

async fn healthz(State(state): State<HealthState>) -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "service": "cupboard-metrics",
        "environment": state.environment,
    }))
}

async fn readyz() -> (StatusCode, Json<serde_json::Value>) {
    (StatusCode::OK, Json(json!({"status": "ready"})))
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
