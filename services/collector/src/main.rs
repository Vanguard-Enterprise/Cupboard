//! Cupboard Collector — connection-heavy ingestion (Phase 2).
//!
//! Dials *out* to each enabled server's RCON (config pulled from fleet's internal API),
//! polls the roster on a cadence, and publishes snapshots to Redis Streams for Identity to
//! consume. Does no business logic — it ingests and publishes. This is the one service
//! designed to scale horizontally; Phase 2 runs a single replica.

mod a2s_task;
mod config;
mod fleet_client;
mod identity_client;
mod manager;
mod mapping;
mod rcon_task;

use std::net::SocketAddr;
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use config::Config;
use cupboard_bus::Bus;
use fleet_client::FleetClient;
use identity_client::IdentityClient;
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

    let _otel_guard =
        cupboard_telemetry::init("cupboard-collector", config.otel_endpoint.as_deref());
    tracing::info!(env = %config.environment, "starting cupboard-collector");

    // Bus connection for producers (XADD only) — cloned into each per-server task.
    let bus = Bus::connect(&config.redis_url).await?;

    let http = reqwest::Client::builder().build()?;
    let fleet = FleetClient::new(
        http.clone(),
        config.fleet_internal_url.clone(),
        config.internal_api_token.clone(),
    );
    let identity = IdentityClient::new(
        http,
        config.identity_internal_url.clone(),
        config.internal_api_token.clone(),
    );

    // Supervisor: reconciles per-server RCON connections against fleet's config feed.
    let manager = tokio::spawn(manager::run(
        fleet,
        identity,
        bus,
        Duration::from_secs(config.poll_interval_secs),
        Duration::from_secs(config.reconcile_interval_secs),
        Duration::from_secs(config.a2s_interval_secs),
    ));

    // Minimal health server for Kubernetes probes.
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
    tracing::info!(%addr, "collector health server listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    manager.abort();
    tracing::info!("collector stopped; flushing telemetry");
    Ok(())
}

async fn healthz(State(state): State<HealthState>) -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "service": "cupboard-collector",
        "environment": state.environment,
    }))
}

/// Readiness — the process booted, connected to Redis, and the supervisor is running. (A
/// bus outage after boot is handled by per-task retries, not surfaced here.)
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
