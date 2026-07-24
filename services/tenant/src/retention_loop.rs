//! The retention/purge loop (Phase 7 decision E): hourly tick, per-table cutoffs from
//! config (plan decision #3 windows), owner pool, bounded work per tick (a row cap, no
//! vacuum storms). Tenant's slice: `store_webhook_events` and `billing_webhook_events`
//! payloads are NULLed past RETENTION_WEBHOOK_PAYLOAD_DAYS (the rows are KEPT: they are
//! the replay-dedupe record), `audit_log` rows are deleted past RETENTION_AUDIT_DAYS,
//! and the ticket stream is time-trimmed to RETENTION_STREAM_DAYS via `XTRIM MINID`
//! (`XADD MAXLEN ~` bounds length, not time; a quiet stream could hold player data for
//! months). Tickets and ticket_messages are deliberately untouched: support history is
//! retained indefinitely (plan decision #3).

use crate::config::Config;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use cupboard_domain::TICKET_STREAM;
use opentelemetry::metrics::ObservableGauge;
use sqlx::PgPool;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tracing::Instrument as _;

/// Per-table per-tick row cap (decision E: bounded work). Whatever the cap leaves
/// behind is caught by later ticks; the cutoffs are absolute, so nothing drifts.
pub const ROW_CAP: i64 = 10_000;
/// Bound on the redis connect for the stream trim; the PG purges never wait on redis.
const REDIS_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

/// What one tick purged, per table. Returned so tests can assert exact counts.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct PurgeCounts {
    pub store_webhook_payloads: u64,
    pub billing_webhook_payloads: u64,
    pub audit_rows: u64,
    pub stream_entries: u64,
}

pub async fn run(owner_pool: PgPool, config: Arc<Config>) {
    tracing::info!(
        tick_secs = config.retention_tick_secs,
        webhook_payload_days = config.retention_webhook_payload_days,
        audit_days = config.retention_audit_days,
        stream_days = config.retention_stream_days,
        "retention loop started"
    );
    let mut ticker = tokio::time::interval(Duration::from_secs(config.retention_tick_secs));
    loop {
        ticker.tick().await;
        // Each tick runs in its own task so a panic anywhere inside it is absorbed as a
        // JoinError and the loop keeps ticking (the billing_loop discipline). Errors
        // inside the tick log and continue, never propagate.
        let tick = {
            let pool = owner_pool.clone();
            let config = config.clone();
            tokio::spawn(async move {
                purge_once(&pool, &config, ROW_CAP)
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
        opentelemetry::global::meter("cupboard.tenant")
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

/// One purge tick. Public so tests drive it directly; `row_cap` is a parameter so tests
/// can exercise the bound with a small value. Each table is purged independently and
/// only rows the cutoff clearly covers are touched (anchor timestamp present and
/// strictly before the cutoff).
pub async fn purge_once(owner_pool: &PgPool, config: &Config, row_cap: i64) -> PurgeCounts {
    let now = Utc::now();
    let payload_cutoff = now - ChronoDuration::days(config.retention_webhook_payload_days);
    let audit_cutoff = now - ChronoDuration::days(config.retention_audit_days);
    let stream_cutoff = now - ChronoDuration::days(config.retention_stream_days);

    let counts = PurgeCounts {
        store_webhook_payloads: null_webhook_payloads(
            owner_pool,
            "store_webhook_events",
            payload_cutoff,
            row_cap,
        )
        .await,
        billing_webhook_payloads: null_webhook_payloads(
            owner_pool,
            "billing_webhook_events",
            payload_cutoff,
            row_cap,
        )
        .await,
        audit_rows: purge_audit_log(owner_pool, audit_cutoff, row_cap).await,
        stream_entries: trim_ticket_stream(config, stream_cutoff).await,
    };

    tracing::info!(
        store_webhook_payloads = counts.store_webhook_payloads,
        billing_webhook_payloads = counts.billing_webhook_payloads,
        audit_rows = counts.audit_rows,
        stream_entries = counts.stream_entries,
        "retention purge tick done"
    );
    counts
}

/// NULL expired webhook payload bodies, keeping the rows: they are the replay-dedupe
/// record (unique event id), so a DELETE would reopen the replay window. `table` is one
/// of two code constants, never external input.
async fn null_webhook_payloads(
    pool: &PgPool,
    table: &str,
    cutoff: DateTime<Utc>,
    row_cap: i64,
) -> u64 {
    let sql = format!(
        "WITH expired AS (
             SELECT id FROM {table}
             WHERE received_at IS NOT NULL AND received_at < $1 AND payload IS NOT NULL
             LIMIT $2
         )
         UPDATE {table} t SET payload = NULL FROM expired e WHERE t.id = e.id"
    );
    match sqlx::query(&sql)
        .bind(cutoff)
        .bind(row_cap)
        .execute(pool)
        .await
    {
        Ok(done) => done.rows_affected(),
        Err(e) => {
            tracing::warn!(table, error = ?e, "webhook payload purge failed");
            0
        }
    }
}

/// Delete audit rows past the retention window (2y default; the retention basis is the
/// legal/ops record, plan decision #3).
async fn purge_audit_log(pool: &PgPool, cutoff: DateTime<Utc>, row_cap: i64) -> u64 {
    let sql = "WITH expired AS (
                   SELECT id FROM audit_log
                   WHERE created_at IS NOT NULL AND created_at < $1
                   LIMIT $2
               )
               DELETE FROM audit_log a USING expired e WHERE a.id = e.id";
    match sqlx::query(sql)
        .bind(cutoff)
        .bind(row_cap)
        .execute(pool)
        .await
    {
        Ok(done) => done.rows_affected(),
        Err(e) => {
            tracing::warn!(error = ?e, "audit_log purge failed");
            0
        }
    }
}

/// Time-trim the ticket stream: entry ids are ms-timestamp-prefixed, so `MINID` at the
/// cutoff in milliseconds drops everything older than the window. `~` lets redis trim
/// at node granularity (cheap; a retention horizon does not need exactness). Best
/// effort: unconfigured or unreachable redis skips with a log, the PG purges above have
/// already run. Connecting per tick mirrors the boot-time bus connect in main; at an
/// hourly cadence a persistent connection buys nothing.
async fn trim_ticket_stream(config: &Config, cutoff: DateTime<Utc>) -> u64 {
    let Some(url) = config.redis_url.as_deref() else {
        tracing::debug!("REDIS_URL unset; ticket stream trim skipped");
        return 0;
    };
    let client = match redis::Client::open(url) {
        Ok(client) => client,
        Err(e) => {
            tracing::warn!(error = %e, "invalid REDIS_URL; ticket stream trim skipped");
            return 0;
        }
    };
    let mut conn = match tokio::time::timeout(
        REDIS_CONNECT_TIMEOUT,
        client.get_multiplexed_async_connection(),
    )
    .await
    {
        Ok(Ok(conn)) => conn,
        Ok(Err(e)) => {
            tracing::warn!(error = %e, "redis unreachable; ticket stream trim skipped");
            return 0;
        }
        Err(_) => {
            tracing::warn!("redis connect timed out; ticket stream trim skipped");
            return 0;
        }
    };
    match redis::cmd("XTRIM")
        .arg(TICKET_STREAM)
        .arg("MINID")
        .arg("~")
        .arg(cutoff.timestamp_millis())
        .query_async::<i64>(&mut conn)
        .await
    {
        Ok(trimmed) => trimmed.max(0) as u64,
        Err(e) => {
            tracing::warn!(error = %e, "ticket stream trim failed");
            0
        }
    }
}
