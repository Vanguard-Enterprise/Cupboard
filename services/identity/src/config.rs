//! Runtime configuration, read from the environment.

use std::env;

#[derive(Debug, Clone)]
pub struct Config {
    pub bind_addr: String,
    /// Owner-role connection — migrations + the ingestion consumer's writes (RLS-exempt;
    /// writes global tables and sets tenant_id explicitly on per-tenant rows).
    pub database_url: String,
    /// `cupboard_app` (non-owner) connection — request-scoped dashboard reads (RLS applies).
    pub database_url_app: String,
    pub db_max_connections: u32,
    pub environment: String,
    pub otel_endpoint: Option<String>,

    /// Ed25519 public key (PEM) for verifying access tokens minted by auth.
    pub jwt_public_key_pem: String,

    /// The single global HMAC pepper for identifier/signal `value_hash` (and, later, ban
    /// `subject_hash`). Same across tenants so the global dedup + matching works.
    pub value_pepper: String,

    /// Redis Streams bus URL (consumer side).
    pub redis_url: String,
    /// This consumer's name within the `identity` group (unique per replica).
    pub consumer_name: String,

    /// Shared secret the Collector presents (`X-Internal-Token`) to `/internal/*` (the
    /// connect-time ban enforcement lookup). `None` disables those endpoints (fail closed).
    pub internal_api_token: Option<String>,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let database_url =
            env::var("DATABASE_URL").map_err(|_| anyhow::anyhow!("DATABASE_URL is required"))?;
        let database_url_app = match env::var("DATABASE_URL_APP") {
            Ok(url) => url,
            Err(_) => {
                tracing::warn!(
                    "DATABASE_URL_APP unset — falling back to the owner role; RLS will NOT \
                     isolate tenants on the app pool. Set the cupboard_app URL outside dev."
                );
                database_url.clone()
            }
        };

        Ok(Self {
            bind_addr: env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into()),
            database_url,
            database_url_app,
            db_max_connections: env::var("DB_MAX_CONNECTIONS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(10),
            environment: env::var("ENVIRONMENT").unwrap_or_else(|_| "development".into()),
            otel_endpoint: env::var("OTEL_EXPORTER_OTLP_ENDPOINT").ok(),
            jwt_public_key_pem: env::var("JWT_PUBLIC_KEY_PEM")
                .map_err(|_| anyhow::anyhow!("JWT_PUBLIC_KEY_PEM is required"))?,
            value_pepper: env::var("VALUE_PEPPER")
                .map_err(|_| anyhow::anyhow!("VALUE_PEPPER is required"))?,
            redis_url: env::var("REDIS_URL")
                .map_err(|_| anyhow::anyhow!("REDIS_URL is required"))?,
            consumer_name: env::var("CONSUMER_NAME")
                .or_else(|_| env::var("HOSTNAME"))
                .unwrap_or_else(|_| "identity-1".into()),
            internal_api_token: env::var("INTERNAL_API_TOKEN")
                .ok()
                .filter(|s| !s.is_empty()),
        })
    }
}
