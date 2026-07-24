//! The retention/purge loop (Phase 7 decisions #3 and E): the `billing_loop` shape.
//! One hourly tick, per-table cutoffs from config, owner pool, bounded work per tick
//! (a per-table row cap, no vacuum storms), and "only rows the cutoff clearly covers"
//! (anchor timestamp IS NOT NULL AND < cutoff).
//!
//! Raw PII whose hash must keep enforcing is NULLed in place (session ip/name, signal
//! values); moderation context past its window is deleted outright (chat, reports,
//! name history, audit); terminal BM import jobs keep the row but lose their
//! cursor/phase_counts blobs. The bus streams are time-trimmed to the stream horizon
//! via `XTRIM MINID ~` (entry ids are ms-timestamp-prefixed; `MAXLEN` bounds length,
//! not time, and a quiet stream could otherwise hold an erased player's IP/chat for
//! months). Redis being down only skips the trim; the Postgres purges still run.

use crate::config::Config;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use cupboard_domain::{CHAT_STREAM, REPORT_STREAM, ROSTER_STREAM, SESSION_STREAM};
use opentelemetry::metrics::ObservableGauge;
use sqlx::PgPool;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tracing::Instrument as _;

/// Per-table per-tick row cap (decision E: bounded work). Anything left over is picked
/// up next tick. Tests drive [`purge_pg_once`] with a smaller cap.
pub const ROW_CAP: i64 = 10_000;

/// Per-table retention windows in days. Split from [`Config`] so tests can drive
/// [`purge_pg_once`] without a full service config.
#[derive(Debug, Clone)]
pub struct Windows {
    pub session_raw_days: i64,
    pub signal_raw_days: i64,
    pub chat_days: i64,
    pub reports_days: i64,
    pub name_history_days: i64,
    pub audit_days: i64,
    pub bm_job_blob_days: i64,
}

impl Windows {
    pub fn from_config(config: &Config) -> Self {
        Self {
            session_raw_days: config.retention_session_raw_days,
            signal_raw_days: config.retention_signal_raw_days,
            chat_days: config.retention_chat_days,
            reports_days: config.retention_reports_days,
            name_history_days: config.retention_name_history_days,
            audit_days: config.retention_audit_days,
            bm_job_blob_days: config.retention_bm_job_blob_days,
        }
    }
}

/// Per-table purged-row counts for one tick.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct PurgeCounts {
    pub session_raw: u64,
    pub signal_raw: u64,
    pub chat: u64,
    pub reports: u64,
    pub name_history: u64,
    pub audit: u64,
    pub bm_job_blobs: u64,
}

impl PurgeCounts {
    pub fn total(&self) -> u64 {
        self.session_raw
            + self.signal_raw
            + self.chat
            + self.reports
            + self.name_history
            + self.audit
            + self.bm_job_blobs
    }
}

/// Run until aborted. Always on: needs only the owner pool plus the redis url.
pub async fn run(owner_pool: PgPool, config: Arc<Config>) {
    tracing::info!(
        tick_secs = config.retention_tick_secs,
        "retention loop started"
    );
    let mut ticker = tokio::time::interval(Duration::from_secs(config.retention_tick_secs));
    loop {
        ticker.tick().await;
        // Each tick runs in its own task so a panic anywhere inside it is absorbed as a
        // JoinError and the loop keeps ticking (the billing_loop precedent). Errors
        // inside the tick log and continue, never propagate.
        let tick = {
            let pool = owner_pool.clone();
            let config = config.clone();
            tokio::spawn(async move {
                purge_tick(&pool, &config)
                    .instrument(tracing::info_span!("retention_purge"))
                    .await;
            })
        };
        // A tick that returns (no panic) is a completed purge pass; stamp the
        // last-success gauge so a stalled/dead loop is detectable (decision L).
        match tick.await {
            Ok(()) => record_retention_success(),
            Err(e) => tracing::error!(error = %e, "retention tick crashed; the loop continues"),
        }
    }
}

/// Stamp the last successful retention tick as unix seconds on an OTel observable
/// gauge (`cupboard_retention_last_success_seconds` in Mimir), so an alert can flag a
/// stalled/dead worker with `time() - <metric>`. Observable (not synchronous) so the
/// callback re-observes the stored value every export cycle and the series stays
/// present between the hourly ticks. Zero extra labels (decision L cardinality
/// budget): the OTLP `service.name` -> Mimir `job` label already distinguishes
/// auth/identity/tenant, exactly as `gateway_ratelimit_fail_open` is per-service. The
/// global meter is a no-op when telemetry is logs-only.
fn record_retention_success() {
    static LAST_SUCCESS: AtomicI64 = AtomicI64::new(0);
    static GAUGE: OnceLock<ObservableGauge<i64>> = OnceLock::new();
    GAUGE.get_or_init(|| {
        opentelemetry::global::meter("cupboard.identity")
            .i64_observable_gauge("cupboard.retention.last_success_seconds")
            .with_description("Unix time (s) of the last successful retention purge tick")
            .with_callback(|observer| {
                // Absent until the first successful tick (noData -> OK is fine).
                let last = LAST_SUCCESS.load(Ordering::Relaxed);
                if last > 0 {
                    observer.observe(last, &[]);
                }
            })
            .build()
    });
    LAST_SUCCESS.store(Utc::now().timestamp(), Ordering::Relaxed);
}

/// One full tick: the Postgres purges first, then the stream trim (an unavailable redis
/// must never block the purges, so the trim goes last and only logs).
async fn purge_tick(pool: &PgPool, config: &Config) {
    let counts = purge_pg_once(pool, &Windows::from_config(config), ROW_CAP).await;
    tracing::info!(
        session_raw = counts.session_raw,
        signal_raw = counts.signal_raw,
        chat = counts.chat,
        reports = counts.reports,
        name_history = counts.name_history,
        audit = counts.audit,
        bm_job_blobs = counts.bm_job_blobs,
        total = counts.total(),
        "retention purge tick done"
    );
    trim_streams_once(&config.redis_url, config.retention_stream_days).await;
}

/// Raw session ip/name past the window: NULL them, keep the row and ip_hash (playtime
/// and session history survive; the hashes are the enforcement side).
const PURGE_SESSION_RAW: &str = "WITH victims AS (\
     SELECT id FROM player_sessions \
     WHERE last_seen_at IS NOT NULL AND last_seen_at < $1 \
       AND (ip IS NOT NULL OR name IS NOT NULL) \
     LIMIT $2) \
 UPDATE player_sessions SET ip = NULL, name = NULL \
 WHERE id IN (SELECT id FROM victims)";

/// Raw signal values past the window: NULL them (value_hash stays for link detection).
const PURGE_SIGNAL_RAW: &str = "WITH victims AS (\
     SELECT id FROM identity_signals \
     WHERE last_seen_at IS NOT NULL AND last_seen_at < $1 AND value IS NOT NULL \
     LIMIT $2) \
 UPDATE identity_signals SET value = NULL \
 WHERE id IN (SELECT id FROM victims)";

const PURGE_CHAT: &str = "DELETE FROM chat_messages WHERE id IN (\
     SELECT id FROM chat_messages \
     WHERE sent_at IS NOT NULL AND sent_at < $1 LIMIT $2)";

const PURGE_REPORTS: &str = "DELETE FROM player_reports WHERE id IN (\
     SELECT id FROM player_reports \
     WHERE reported_at IS NOT NULL AND reported_at < $1 LIMIT $2)";

const PURGE_NAME_HISTORY: &str = "DELETE FROM name_history WHERE id IN (\
     SELECT id FROM name_history \
     WHERE last_seen_at IS NOT NULL AND last_seen_at < $1 LIMIT $2)";

const PURGE_AUDIT: &str = "DELETE FROM audit_log WHERE id IN (\
     SELECT id FROM audit_log \
     WHERE created_at IS NOT NULL AND created_at < $1 LIMIT $2)";

/// Terminal import jobs past the window: clear the cursor/phase_counts blobs (both
/// columns are NOT NULL DEFAULT '{}', so cleared means empty object), keep the row.
const PURGE_BM_JOB_BLOBS: &str = "WITH victims AS (\
     SELECT id FROM bm_import_jobs \
     WHERE status IN ('completed', 'failed', 'cancelled') \
       AND finished_at IS NOT NULL AND finished_at < $1 \
       AND (cursor <> '{}'::jsonb OR phase_counts <> '{}'::jsonb) \
     LIMIT $2) \
 UPDATE bm_import_jobs SET cursor = '{}'::jsonb, phase_counts = '{}'::jsonb \
 WHERE id IN (SELECT id FROM victims)";

/// One Postgres purge pass over every retained table. Public so tests drive it directly
/// with explicit windows and a small `row_cap`. Failures log per table and continue;
/// one broken purge must not starve the rest.
pub async fn purge_pg_once(pool: &PgPool, windows: &Windows, row_cap: i64) -> PurgeCounts {
    let now = Utc::now();
    let cutoff = |days: i64| now - ChronoDuration::days(days);
    PurgeCounts {
        session_raw: purge_one(
            pool,
            "player_sessions",
            PURGE_SESSION_RAW,
            cutoff(windows.session_raw_days),
            row_cap,
        )
        .await,
        signal_raw: purge_one(
            pool,
            "identity_signals",
            PURGE_SIGNAL_RAW,
            cutoff(windows.signal_raw_days),
            row_cap,
        )
        .await,
        chat: purge_one(
            pool,
            "chat_messages",
            PURGE_CHAT,
            cutoff(windows.chat_days),
            row_cap,
        )
        .await,
        reports: purge_one(
            pool,
            "player_reports",
            PURGE_REPORTS,
            cutoff(windows.reports_days),
            row_cap,
        )
        .await,
        name_history: purge_one(
            pool,
            "name_history",
            PURGE_NAME_HISTORY,
            cutoff(windows.name_history_days),
            row_cap,
        )
        .await,
        audit: purge_one(
            pool,
            "audit_log",
            PURGE_AUDIT,
            cutoff(windows.audit_days),
            row_cap,
        )
        .await,
        bm_job_blobs: purge_one(
            pool,
            "bm_import_jobs",
            PURGE_BM_JOB_BLOBS,
            cutoff(windows.bm_job_blob_days),
            row_cap,
        )
        .await,
    }
}

/// Execute one capped purge statement; log-and-continue on failure.
async fn purge_one(
    pool: &PgPool,
    table: &'static str,
    sql: &'static str,
    cutoff: DateTime<Utc>,
    row_cap: i64,
) -> u64 {
    match sqlx::query(sql)
        .bind(cutoff)
        .bind(row_cap)
        .execute(pool)
        .await
    {
        Ok(res) => res.rows_affected(),
        Err(e) => {
            tracing::warn!(table, error = ?e, "retention purge failed; continuing");
            0
        }
    }
}

/// Time-trim the four ingestion streams to the stream horizon. Entry ids are
/// `<ms>-<seq>`, so `XTRIM MINID ~ <horizon ms>` drops everything older. A fresh
/// connection per tick keeps the loop self-healing across redis restarts; the blocking
/// consumers own their connections, so the trim gets its own.
async fn trim_streams_once(redis_url: &str, stream_days: i64) {
    // Bounded connect: against a blackholed endpoint (a misapplied NetworkPolicy, not
    // just a refused port) a bare connect would stall the tick for the OS TCP timeout.
    const REDIS_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
    let conn = match redis::Client::open(redis_url) {
        Ok(client) => {
            match tokio::time::timeout(
                REDIS_CONNECT_TIMEOUT,
                client.get_multiplexed_async_connection(),
            )
            .await
            {
                Ok(result) => result,
                Err(_) => {
                    tracing::warn!("redis connect timed out; skipping stream trim this tick");
                    return;
                }
            }
        }
        Err(e) => Err(e),
    };
    let mut conn = match conn {
        Ok(conn) => conn,
        Err(e) => {
            tracing::warn!(error = %e, "redis unavailable; skipping stream trim this tick");
            return;
        }
    };
    let minid = (Utc::now() - ChronoDuration::days(stream_days)).timestamp_millis();
    for stream in [ROSTER_STREAM, CHAT_STREAM, SESSION_STREAM, REPORT_STREAM] {
        let trimmed: Result<i64, redis::RedisError> = redis::cmd("XTRIM")
            .arg(stream)
            .arg("MINID")
            .arg("~")
            .arg(minid)
            .query_async(&mut conn)
            .await;
        match trimmed {
            Ok(n) if n > 0 => tracing::info!(stream, trimmed = n, "stream time-trimmed"),
            Ok(_) => {}
            Err(e) => tracing::warn!(stream, error = %e, "stream trim failed; continuing"),
        }
    }
}
