//! Cupboard Collector binary — see the crate docs (`lib.rs`) for the architecture.

use std::net::SocketAddr;
use std::time::Duration;

use axum::extract::{DefaultBodyLimit, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use cupboard_bus::Bus;
use cupboard_collector::config::Config;
use cupboard_collector::fleet_client::FleetClient;
use cupboard_collector::identity_client::IdentityClient;
use cupboard_collector::ingest::{self, IngestState, RateLimiter};
use cupboard_collector::manager;
use cupboard_collector::registry::TokenRegistry;
use serde_json::json;

/// Push request bodies are capped hard; the plugin batches small and often.
const PUSH_BODY_LIMIT: usize = 1024 * 1024;

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

    // Bus connection for producers (XADD only) — cloned into each per-server task and
    // the push handlers.
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

    // The push-token registry is fed by the manager's config fetches and read by the
    // ingest handlers.
    let registry = TokenRegistry::default();

    // Supervisor: reconciles per-server RCON/A2S connections against fleet's config feed.
    let manager = tokio::spawn(manager::run(
        fleet,
        identity.clone(),
        bus.clone(),
        registry.clone(),
        Duration::from_secs(config.poll_interval_secs),
        Duration::from_secs(config.reconcile_interval_secs),
        Duration::from_secs(config.a2s_interval_secs),
        config.push_stream_maxlen,
    ));

    let ingest_state = IngestState {
        registry,
        bus,
        limiter: RateLimiter::new(config.push_rate_limit_per_min),
        stream_maxlen: config.push_stream_maxlen,
        identity,
    };

    // Health probes + the push-ingestion endpoint (reached via the gateway's /ingest
    // route; token-authenticated here).
    let health = Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .with_state(HealthState {
            environment: config.environment.clone(),
        });
    let app = health
        .merge(ingest::router(ingest_state).layer(DefaultBodyLimit::max(PUSH_BODY_LIMIT)))
        .route_layer(axum::middleware::from_fn(cupboard_telemetry::http::track))
        .layer(cupboard_telemetry::http::http_trace_layer());

    let addr: SocketAddr = config.bind_addr.parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "collector http server listening");
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
