//! Runtime configuration, read from the environment.

use std::env;

#[derive(Debug, Clone)]
pub struct Config {
    /// Health-probe HTTP server bind address.
    pub bind_addr: String,
    pub environment: String,
    /// OTLP endpoint (alloy-receiver). Without it the consumer runs but exports nothing.
    pub otel_endpoint: Option<String>,
    /// Redis Streams bus (consumer side).
    pub redis_url: String,
    /// This consumer's name within the `metrics` group (unique per replica).
    pub consumer_name: String,
    /// Ed25519 public key (PEM) for verifying access tokens on the perf API.
    pub jwt_public_key_pem: String,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        Ok(Self {
            bind_addr: env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into()),
            environment: env::var("ENVIRONMENT").unwrap_or_else(|_| "development".into()),
            otel_endpoint: env::var("OTEL_EXPORTER_OTLP_ENDPOINT").ok(),
            redis_url: env::var("REDIS_URL")
                .map_err(|_| anyhow::anyhow!("REDIS_URL is required"))?,
            consumer_name: env::var("CONSUMER_NAME")
                .or_else(|_| env::var("HOSTNAME"))
                .unwrap_or_else(|_| "metrics-1".into()),
            jwt_public_key_pem: env::var("JWT_PUBLIC_KEY_PEM")
                .map_err(|_| anyhow::anyhow!("JWT_PUBLIC_KEY_PEM is required"))?,
        })
    }
}
