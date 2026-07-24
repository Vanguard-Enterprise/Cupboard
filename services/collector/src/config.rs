//! Runtime configuration, read from the environment.

use std::env;

#[derive(Clone)]
pub struct Config {
    /// Health-probe HTTP server bind address.
    pub bind_addr: String,
    pub environment: String,
    pub otel_endpoint: Option<String>,

    /// Redis Streams bus (e.g. `redis://cupboard-redis:6379`).
    pub redis_url: String,

    /// Base URL of the fleet service's cluster-internal API (config feed + status).
    pub fleet_internal_url: String,
    /// Base URL of the identity service's cluster-internal API (ban enforcement lookup).
    pub identity_internal_url: String,
    /// Shared secret presented to fleet's + identity's `/internal/*` endpoints.
    pub internal_api_token: String,

    /// How often to poll each server's roster (`playerlist`).
    pub poll_interval_secs: u64,
    /// How often to re-fetch the server list from fleet and reconcile connections.
    pub reconcile_interval_secs: u64,
    /// How often to query each server's A2S_INFO (servers with a `query_port` only).
    pub a2s_interval_secs: u64,

    /// `XADD MAXLEN ~` cap applied to push-ingested streams.
    pub push_stream_maxlen: usize,
    /// Per-server push request budget per minute (fixed window).
    pub push_rate_limit_per_min: u32,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        Ok(Self {
            bind_addr: env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into()),
            environment: env::var("ENVIRONMENT").unwrap_or_else(|_| "development".into()),
            otel_endpoint: env::var("OTEL_EXPORTER_OTLP_ENDPOINT").ok(),
            redis_url: env::var("REDIS_URL")
                .map_err(|_| anyhow::anyhow!("REDIS_URL is required"))?,
            fleet_internal_url: env::var("FLEET_INTERNAL_URL")
                .map_err(|_| anyhow::anyhow!("FLEET_INTERNAL_URL is required"))?,
            identity_internal_url: env::var("IDENTITY_INTERNAL_URL")
                .map_err(|_| anyhow::anyhow!("IDENTITY_INTERNAL_URL is required"))?,
            internal_api_token: env::var("INTERNAL_API_TOKEN")
                .map_err(|_| anyhow::anyhow!("INTERNAL_API_TOKEN is required"))?,
            poll_interval_secs: env::var("POLL_INTERVAL_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(30),
            reconcile_interval_secs: env::var("RECONCILE_INTERVAL_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(15),
            a2s_interval_secs: env::var("A2S_INTERVAL_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(60),
            push_stream_maxlen: env::var("PUSH_STREAM_MAXLEN")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(100_000),
            push_rate_limit_per_min: env::var("PUSH_RATE_LIMIT_PER_MIN")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(120),
        })
    }
}
