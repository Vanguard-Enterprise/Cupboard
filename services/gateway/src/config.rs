//! Runtime configuration, read from the environment (Vault → ExternalSecret → env
//! in-cluster; a local `.env`/shell for development).

use std::env;

#[derive(Debug, Clone)]
pub struct Config {
    pub bind_addr: String,
    pub database_url: String,
    pub db_max_connections: u32,
    pub environment: String,
    /// OTLP/gRPC endpoint for the cluster's alloy-receiver (e.g.
    /// `http://alloy-receiver…:4317`). When unset, telemetry stays logs-only.
    pub otel_endpoint: Option<String>,
    /// Ed25519 public key (PEM) for verifying access tokens minted by the auth service.
    /// Optional so the gateway can roll out before the auth Vault key exists: when
    /// absent, token-protected `/api/*` routes fail **closed** (503), while the `/auth/*`
    /// proxy and health probes keep working.
    pub jwt_public_key_pem: Option<String>,
    /// Base URL of the internal auth service, for reverse-proxying `/auth/*` (ClusterIP
    /// in-cluster; localhost in dev).
    pub auth_service_url: String,
    /// Base URL of the internal fleet service, for reverse-proxying `/fleet/*`.
    pub fleet_service_url: String,
    /// Base URL of the internal identity service, for reverse-proxying `/players/*`.
    pub identity_service_url: String,
    /// Base URL of the internal collector service, for reverse-proxying `/ingest/*`
    /// (plugin/perf-mod pushes; token-authenticated by the collector, not by JWT).
    pub collector_service_url: String,
    /// Base URL of the internal metrics service, for reverse-proxying `/perf/*`.
    pub metrics_service_url: String,
    /// Base URL of the internal tenant service, for reverse-proxying `/sites/*` +
    /// `/store/*` (operator, JWT-gated) and `/public/*` (storefront SSR reads, no JWT).
    pub tenant_service_url: String,
    /// Redis URL for the `/api/v1` rate limiter (Phase 6 decision N). Optional: when
    /// unset the limiter is disabled and `/api/v1` requests pass unlimited (fail
    /// **open** with a warning; availability over billing fairness).
    pub redis_url: Option<String>,
    /// Shared secret for auth's cluster-internal API-key exchange. Optional so the
    /// gateway can roll out before the secret is wired: when absent, `/api/v1` requests
    /// that need a fresh exchange fail **closed** (503), mirroring the
    /// `JWT_PUBLIC_KEY_PEM` precedent (cached keys keep working until they expire).
    pub internal_api_token: Option<String>,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        Ok(Self {
            bind_addr: env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into()),
            database_url: env::var("DATABASE_URL")
                .map_err(|_| anyhow::anyhow!("DATABASE_URL is required"))?,
            db_max_connections: env::var("DB_MAX_CONNECTIONS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(10),
            environment: env::var("ENVIRONMENT").unwrap_or_else(|_| "development".into()),
            otel_endpoint: env::var("OTEL_EXPORTER_OTLP_ENDPOINT").ok(),
            jwt_public_key_pem: env::var("JWT_PUBLIC_KEY_PEM")
                .ok()
                .filter(|s| !s.is_empty()),
            auth_service_url: env::var("AUTH_SERVICE_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:8081".into()),
            fleet_service_url: env::var("FLEET_SERVICE_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:8082".into()),
            identity_service_url: env::var("IDENTITY_SERVICE_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:8083".into()),
            collector_service_url: env::var("COLLECTOR_SERVICE_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:8084".into()),
            metrics_service_url: env::var("METRICS_SERVICE_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:8085".into()),
            tenant_service_url: env::var("TENANT_SERVICE_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:8086".into()),
            redis_url: env::var("REDIS_URL").ok().filter(|s| !s.is_empty()),
            internal_api_token: env::var("INTERNAL_API_TOKEN")
                .ok()
                .filter(|s| !s.is_empty()),
        })
    }
}
