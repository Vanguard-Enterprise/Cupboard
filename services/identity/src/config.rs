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
    /// Reused as the token identity presents to fleet's `/internal/servers/import`:
    /// v-deployments sets the same value on both services (one cluster-internal token).
    pub internal_api_token: Option<String>,

    /// Fleet's cluster-internal base URL (`FLEET_INTERNAL_URL`, e.g.
    /// `http://cupboard-fleet:8080`), where the BM import registers discovered servers.
    /// `None` (or a missing `internal_api_token`) makes the import's servers phase skip
    /// with a counted reason rather than fail (degradation posture).
    pub fleet_internal_url: Option<String>,

    /// 32-byte envelope master key (base64 in `IDENTITY_MASTER_KEY`) wrapping per-tenant
    /// BattleMetrics token data keys (`cupboard_crypto::envelope`). `None` disables the
    /// BM integration endpoints and the import/sync supervisor (fail closed), so the
    /// service deploys cleanly before the OpenBao key exists.
    pub identity_master_key: Option<[u8; 32]>,
    /// BattleMetrics API base URL. Overridable (`BM_API_BASE`) for the local stub in
    /// tests/dev; the real default otherwise.
    pub bm_api_base: String,

    /// Retention/purge loop cadence (Phase 7 decision E). Hourly by default.
    pub retention_tick_secs: u64,
    /// Per-table retention windows in days (Phase 7 decision #3 defaults; all
    /// env-overridable). Raw session ip/name and raw signal values are NULLed past
    /// their window (hashes retained); chat/reports/name_history/audit rows are
    /// deleted; terminal BM import jobs get their cursor/phase_counts blobs cleared;
    /// the bus streams are time-trimmed to the stream horizon.
    pub retention_session_raw_days: i64,
    pub retention_signal_raw_days: i64,
    pub retention_chat_days: i64,
    pub retention_reports_days: i64,
    pub retention_name_history_days: i64,
    pub retention_audit_days: i64,
    pub retention_bm_job_blob_days: i64,
    pub retention_stream_days: i64,
}

/// Parse an env var, falling back to the code default when unset or unparseable.
fn env_parse<T: std::str::FromStr>(name: &str, default: T) -> T {
    env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
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
            fleet_internal_url: env::var("FLEET_INTERNAL_URL")
                .ok()
                .filter(|s| !s.is_empty()),
            identity_master_key: match env::var("IDENTITY_MASTER_KEY") {
                Ok(b64) if !b64.trim().is_empty() => Some(cupboard_crypto::decode_master_key(
                    &b64,
                    "IDENTITY_MASTER_KEY",
                )?),
                _ => {
                    tracing::warn!(
                        "IDENTITY_MASTER_KEY unset: BattleMetrics integration disabled \
                         (endpoints 503, supervisor not started)"
                    );
                    None
                }
            },
            bm_api_base: env::var("BM_API_BASE")
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| cupboard_bmapi::DEFAULT_BASE.to_string()),
            // .max(1): a zero interval would panic inside the loop task and kill it.
            retention_tick_secs: env_parse("RETENTION_TICK_SECS", 3600u64).max(1),
            retention_session_raw_days: env_parse("RETENTION_SESSION_RAW_DAYS", 90),
            retention_signal_raw_days: env_parse("RETENTION_SIGNAL_RAW_DAYS", 90),
            retention_chat_days: env_parse("RETENTION_CHAT_DAYS", 180),
            retention_reports_days: env_parse("RETENTION_REPORTS_DAYS", 365),
            retention_name_history_days: env_parse("RETENTION_NAME_HISTORY_DAYS", 730),
            retention_audit_days: env_parse("RETENTION_AUDIT_DAYS", 730),
            retention_bm_job_blob_days: env_parse("RETENTION_BM_JOB_BLOB_DAYS", 30),
            retention_stream_days: env_parse("RETENTION_STREAM_DAYS", 14),
        })
    }
}
