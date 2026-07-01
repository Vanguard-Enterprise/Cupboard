//! Runtime configuration, read from the environment (Vault → ExternalSecret → env
//! in-cluster; a local `.env`/shell for development).

use anyhow::Context as _;
use base64::Engine as _;
use std::env;

#[derive(Clone)]
pub struct Config {
    pub bind_addr: String,
    /// Owner-role connection — migrations + the cross-tenant internal endpoint (RLS-exempt).
    pub database_url: String,
    /// `cupboard_app` (non-owner) connection — request-scoped tenant CRUD (RLS applies).
    /// Falls back to the owner URL in local dev (logged), where RLS then does not isolate.
    pub database_url_app: String,
    pub db_max_connections: u32,
    pub environment: String,
    pub otel_endpoint: Option<String>,

    /// Ed25519 public key (PEM) for verifying access tokens minted by auth. Required —
    /// Fleet's entire surface (bar health) is authenticated.
    pub jwt_public_key_pem: String,

    /// 32-byte envelope master key (from Vault), base64-encoded, that wraps per-server
    /// RCON-credential data keys. See `cupboard_crypto::envelope`.
    pub master_key: [u8; 32],

    /// Shared secret the Collector presents (`X-Internal-Token`) to the cross-tenant
    /// `/internal/*` endpoints. `None` disables those endpoints (fail closed).
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

        let jwt_public_key_pem = env::var("JWT_PUBLIC_KEY_PEM")
            .map_err(|_| anyhow::anyhow!("JWT_PUBLIC_KEY_PEM is required"))?;

        let master_key = decode_master_key(
            &env::var("FLEET_MASTER_KEY")
                .map_err(|_| anyhow::anyhow!("FLEET_MASTER_KEY is required"))?,
        )?;

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
            jwt_public_key_pem,
            master_key,
            internal_api_token: env::var("INTERNAL_API_TOKEN")
                .ok()
                .filter(|s| !s.is_empty()),
        })
    }
}

/// Decode a base64 master key and require exactly 32 bytes (AES-256).
fn decode_master_key(b64: &str) -> anyhow::Result<[u8; 32]> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .context("FLEET_MASTER_KEY must be valid base64")?;
    let key: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| anyhow::anyhow!("FLEET_MASTER_KEY must decode to exactly 32 bytes"))?;
    Ok(key)
}
