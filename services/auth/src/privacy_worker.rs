//! The privacy coordinator worker (Phase 7 PR2, decisions A/C/D): a plain interval
//! loop in the `billing_loop` shape that drives `privacy_jobs`. Each tick reclaims
//! stale `running` jobs (crash recovery; the walkers are idempotent so a full re-run
//! is safe), then drains the queue: per job it resolves the subject from auth's own
//! identity store, fans out to the identity and tenant walkers over HTTP (scoped
//! PRIVACY_TOKEN, decision F), and runs the auth self-walk in-process.
//!
//! Export (decision C): assemble `{auth, identity, tenant}` (each service's response
//! merged AS-IS under its key, walker asymmetries included), gzip, store inline with
//! a 7-day one-time download. Erase (decision D): the first pass runs everything
//! `dry_run=true` and parks the merged counts in `awaiting_confirm`; after a confirm
//! re-queues the job, the second pass (recognized by the stored dry-run counts) runs
//! for real and finishes with the merged real counts.
//!
//! Failures mark the job `failed` with a TERSE, identifier-free error (service +
//! action + status only); raw identifiers never enter errors or logs (decision G).
//! TRANSIENT walker failures (5xx/timeout/connect) first get a bounded requeue via
//! [`privacy::requeue_for_retry`] (up to 2 retries, 3 total attempts): the walkers
//! are idempotent, so re-running a partially-erased job from the top is safe, and
//! the retry plus the service-prefixed stored error is the plan's decision D(5)
//! resumability story. Every walker HTTP call carries a per-request timeout so a
//! hung walker can never wedge the worker.

use crate::config::Config;
use crate::domain::privacy::{self, PrivacyJob};
use crate::domain::privacy_walk::{self, Scope, Subject};
use chrono::Utc;
use flate2::write::GzEncoder;
use flate2::Compression;
use opentelemetry::metrics::ObservableGauge;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::io::Write as _;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tracing::Instrument as _;
use uuid::Uuid;

/// Jobs stuck in `running` longer than this are re-queued each tick.
const STALE_RUNNING_AFTER: chrono::Duration = chrono::Duration::minutes(30);
/// Export bundle TTL (decision C).
const BUNDLE_TTL: chrono::Duration = chrono::Duration::days(7);
/// Per-request deadline on every walker HTTP call: a hung walker times the call out
/// (a transient failure, retried) instead of wedging the worker loop.
const WALKER_TIMEOUT: Duration = Duration::from_secs(60);

/// Run until aborted. `main` gates the spawn on PRIVACY_TOKEN being present; the
/// in-loop check is belt-and-braces (fail closed, decision F).
pub async fn run(owner_pool: PgPool, http: reqwest::Client, config: Arc<Config>) {
    if config.privacy_token.is_none() {
        tracing::warn!("PRIVACY_TOKEN unset; privacy coordinator worker not running");
        return;
    }
    tracing::info!(
        tick_secs = config.privacy_worker_tick_secs,
        identity_url = %config.identity_internal_url,
        tenant_url = %config.tenant_internal_url,
        "privacy coordinator worker started"
    );
    let mut ticker = tokio::time::interval(Duration::from_secs(config.privacy_worker_tick_secs));
    loop {
        ticker.tick().await;
        // Each tick runs in its own task so a panic anywhere inside it is absorbed
        // as a JoinError and the loop keeps ticking (the billing_loop pattern).
        let tick = {
            let pool = owner_pool.clone();
            let http = http.clone();
            let config = config.clone();
            tokio::spawn(async move {
                tick_once(&pool, &http, &config)
                    .instrument(tracing::info_span!("privacy_worker"))
                    .await;
            })
        };
        // A tick that returns (no panic) is a completed drain pass; stamp the
        // last-success gauge so a stalled/dead loop is detectable (decision L).
        match tick.await {
            Ok(()) => record_privacy_success(),
            Err(e) => {
                tracing::error!(error = %e, "privacy worker tick crashed; the loop continues")
            }
        }
    }
}

/// Stamp the last successful privacy-coordinator drain pass as unix seconds on an OTel
/// observable gauge (`cupboard_privacy_worker_last_success_seconds` in Mimir), so an
/// alert can flag a stalled/dead worker with `time() - <metric>`. Observable (not
/// synchronous) so the callback re-observes the stored value every export cycle and
/// the series stays present between ticks. Zero extra labels (decision L cardinality
/// budget); the metric only ever appears when the worker runs (PRIVACY_TOKEN set), so
/// it is simply absent otherwise (noData -> OK). The global meter is a no-op when
/// telemetry is logs-only.
fn record_privacy_success() {
    static LAST_SUCCESS: AtomicI64 = AtomicI64::new(0);
    static GAUGE: OnceLock<ObservableGauge<i64>> = OnceLock::new();
    GAUGE.get_or_init(|| {
        opentelemetry::global::meter("cupboard.auth")
            .i64_observable_gauge("cupboard.privacy_worker.last_success_seconds")
            .with_description("Unix time (s) of the last successful privacy-coordinator drain pass")
            .with_callback(|observer| {
                let last = LAST_SUCCESS.load(Ordering::Relaxed);
                if last > 0 {
                    observer.observe(last, &[]);
                }
            })
            .build()
    });
    LAST_SUCCESS.store(Utc::now().timestamp(), Ordering::Relaxed);
}

/// One worker tick: reclaim stale running jobs, then drain the queue. Public so
/// tests drive it directly against walker stubs. Returns the number of jobs
/// processed (finished, parked awaiting confirm, or failed).
pub async fn tick_once(pool: &PgPool, http: &reqwest::Client, config: &Config) -> u64 {
    match privacy::reclaim_stale_running(pool, STALE_RUNNING_AFTER).await {
        Ok(0) => {}
        Ok(n) => tracing::info!(reclaimed = n, "requeued stale running privacy jobs"),
        Err(e) => tracing::warn!(error = ?e, "stale-running reclaim failed; continuing"),
    }
    let mut processed = 0u64;
    loop {
        let job = match privacy::claim_next_queued(pool).await {
            Ok(Some(job)) => job,
            Ok(None) => break,
            Err(e) => {
                tracing::warn!(error = ?e, "privacy job claim failed; ending tick");
                break;
            }
        };
        let (id, kind) = (job.id, job.kind.clone());
        match process_job(pool, http, config, job).await {
            Ok(outcome) => tracing::info!(job = %id, kind, outcome, "privacy job step done"),
            Err(failure) => {
                // Transient walker failures get a bounded requeue first (the walkers
                // are idempotent, decision D(5)); only when the attempts are
                // exhausted does the job go terminal.
                let mut requeued = false;
                if failure.transient {
                    match privacy::requeue_for_retry(pool, id).await {
                        Ok(hit) => requeued = hit,
                        Err(e) => {
                            tracing::warn!(job = %id, error = ?e, "privacy job requeue failed")
                        }
                    }
                }
                if requeued {
                    tracing::info!(
                        job = %id, kind, error = %failure.message,
                        "privacy job hit a transient walker failure; requeued for retry"
                    );
                } else {
                    tracing::warn!(job = %id, kind, error = %failure.message, "privacy job failed");
                    if let Err(e) = privacy::fail_job(pool, id, &failure.message).await {
                        tracing::error!(job = %id, error = ?e, "could not mark privacy job failed");
                    }
                }
            }
        }
        processed += 1;
    }
    processed
}

/// A job-step failure: the terse, identifier-free message stored on the job row,
/// plus whether the failure is transient (a walker 5xx/timeout/connect, worth a
/// bounded retry) or permanent.
struct JobFailure {
    message: String,
    transient: bool,
}

impl JobFailure {
    fn fatal(message: impl Into<String>) -> Self {
        JobFailure {
            message: message.into(),
            transient: false,
        }
    }

    fn transient(message: impl Into<String>) -> Self {
        JobFailure {
            message: message.into(),
            transient: true,
        }
    }
}

/// Drive one claimed job to its next state. `Err` carries the terse,
/// identifier-free message stored on the job row.
async fn process_job(
    pool: &PgPool,
    http: &reqwest::Client,
    config: &Config,
    job: PrivacyJob,
) -> Result<&'static str, JobFailure> {
    let scope = match (job.scope_kind.as_str(), job.tenant_id) {
        ("platform", _) => Scope::Platform,
        ("tenant", Some(t)) => Scope::Tenant(t),
        _ => return Err(JobFailure::fatal("job has an invalid scope")),
    };
    let subject = resolve_subject(pool, &job)
        .await
        .map_err(|_| JobFailure::fatal("subject resolution failed"))?;
    let walkers = Walkers {
        http,
        token: config
            .privacy_token
            .as_deref()
            .ok_or_else(|| JobFailure::fatal("privacy token not configured"))?,
        identity_base: &config.identity_internal_url,
        tenant_base: &config.tenant_internal_url,
    };
    match job.kind.as_str() {
        "export" => export_job(pool, &walkers, &job, scope, &subject).await,
        "erase" => erase_job(pool, &walkers, &job, scope, &subject).await,
        _ => Err(JobFailure::fatal("job has an unknown kind")),
    }
}

/// Resolve the full fan-out subject (decision A: pass all three onward). A named
/// account id pulls its linked identities; bare identifiers look their account up.
/// Job-supplied values win over resolved ones.
async fn resolve_subject(pool: &PgPool, job: &PrivacyJob) -> Result<Subject, sqlx::Error> {
    let mut subject = Subject {
        steam_id: job.steam_id.clone(),
        discord_id: job.discord_id.clone(),
        player_account_id: job.player_account_id,
    };
    if subject.player_account_id.is_none() {
        subject.player_account_id = sqlx::query_scalar(
            "SELECT player_account_id FROM player_identities \
             WHERE (provider = 'steam' AND subject = $1::text) \
                OR (provider = 'discord' AND subject = $2::text) \
             LIMIT 1",
        )
        .bind(subject.steam_id.as_deref())
        .bind(subject.discord_id.as_deref())
        .fetch_optional(pool)
        .await?;
    }
    if let Some(account) = subject.player_account_id {
        let identities: Vec<(String, String)> = sqlx::query_as(
            "SELECT provider, subject FROM player_identities \
             WHERE player_account_id = $1 ORDER BY linked_at",
        )
        .bind(account)
        .fetch_all(pool)
        .await?;
        for (provider, value) in identities {
            match provider.as_str() {
                "steam" if subject.steam_id.is_none() => subject.steam_id = Some(value),
                "discord" if subject.discord_id.is_none() => subject.discord_id = Some(value),
                _ => {}
            }
        }
    }
    Ok(subject)
}

struct Walkers<'a> {
    http: &'a reqwest::Client,
    token: &'a str,
    identity_base: &'a str,
    tenant_base: &'a str,
}

impl Walkers<'_> {
    /// POST one walker endpoint. `None` when the call is skipped because identity
    /// cannot address the subject (no steam/discord identifier survives resolution,
    /// e.g. re-running after the identities were already erased): identity joins on
    /// hashed identifiers only, so an empty result is the truthful answer, not a lie.
    async fn call(
        &self,
        service: &'static str,
        action: &'static str,
        scope: Scope,
        subject: &Subject,
        dry_run: Option<bool>,
    ) -> Result<Option<Value>, JobFailure> {
        let identity_addressable = subject.steam_id.is_some() || subject.discord_id.is_some();
        if service == "identity" && !identity_addressable {
            return Ok(None);
        }
        let (scope_kind, tenant_id) = match scope {
            Scope::Platform => ("platform", None),
            Scope::Tenant(t) => ("tenant", Some(t)),
        };
        let mut body = json!({
            "scope_kind": scope_kind,
            "tenant_id": tenant_id,
            "steam_id": subject.steam_id,
            "discord_id": subject.discord_id,
            "player_account_id": subject.player_account_id,
        });
        if let Some(dry) = dry_run {
            body["dry_run"] = json!(dry);
        }
        let base = match service {
            "identity" => self.identity_base,
            _ => self.tenant_base,
        };
        // Terse failures only: service + action + status. Never identifiers, and
        // never reqwest's error text (it embeds the URL). Timeouts, connect errors,
        // and 5xx answers are TRANSIENT (retried, bounded); 4xx answers are not.
        let resp = self
            .http
            .post(format!("{base}/internal/privacy/{action}"))
            .timeout(WALKER_TIMEOUT)
            .header("x-internal-token", self.token)
            .json(&body)
            .send()
            .await
            .map_err(|_| JobFailure::transient(format!("{service} {action} request failed")))?;
        let status = resp.status();
        if !status.is_success() {
            let message = format!("{service} {action} returned status {}", status.as_u16());
            return Err(if status.is_server_error() {
                JobFailure::transient(message)
            } else {
                JobFailure::fatal(message)
            });
        }
        let body: Value = resp.json().await.map_err(|_| {
            JobFailure::fatal(format!("{service} {action} returned an unreadable body"))
        })?;
        Ok(Some(body))
    }
}

/// Export flow (decision C): fan out, assemble, gzip, store with the 7-day one-time
/// TTL, finish with per-service per-table row counts.
async fn export_job(
    pool: &PgPool,
    walkers: &Walkers<'_>,
    job: &PrivacyJob,
    scope: Scope,
    subject: &Subject,
) -> Result<&'static str, JobFailure> {
    let identity = walkers
        .call("identity", "export", scope, subject, None)
        .await?
        .unwrap_or_else(|| json!({}));
    let tenant = walkers
        .call("tenant", "export", scope, subject, None)
        .await?
        .unwrap_or_else(|| json!({}));
    let auth = privacy_walk::export(pool, scope, subject)
        .await
        .map_err(|_| JobFailure::fatal("auth export walk failed"))?;
    let auth = Value::Object(auth);

    // Per-service per-table row counts; the walker asymmetry (identity wraps its
    // table map in `data` next to `player_ids`, tenant in `data` alone, auth is the
    // bare map) is tolerated here and preserved as-is in the bundle below.
    let counts = json!({
        "auth": table_counts(Some(&auth)),
        "identity": table_counts(identity.get("data")),
        "tenant": table_counts(tenant.get("data")),
    });
    let bundle = json!({ "auth": auth, "identity": identity, "tenant": tenant });
    let bytes = gzip(&bundle).map_err(|_| JobFailure::fatal("bundle compression failed"))?;
    privacy::store_bundle(pool, job.id, &bytes, Utc::now() + BUNDLE_TTL)
        .await
        .map_err(|_| JobFailure::fatal("bundle store failed"))?;
    privacy::finish_job(pool, job.id, &counts)
        .await
        .map_err(|_| JobFailure::fatal("job finish failed"))?;
    Ok("completed")
}

/// Erase flow (decision D): dry-run pass first (parked `awaiting_confirm`), real
/// pass after the confirm re-queue, recognized by the stored dry-run counts. Remote
/// walkers run before the auth self-walk so a failed pass leaves auth's identity
/// rows intact for the retry's subject resolution.
async fn erase_job(
    pool: &PgPool,
    walkers: &Walkers<'_>,
    job: &PrivacyJob,
    scope: Scope,
    subject: &Subject,
) -> Result<&'static str, JobFailure> {
    let dry_run = job.dry_run_counts.is_none();
    let identity = walkers
        .call("identity", "erase", scope, subject, Some(dry_run))
        .await?;
    let tenant = walkers
        .call("tenant", "erase", scope, subject, Some(dry_run))
        .await?;
    let auth = privacy_walk::erase(pool, scope, subject, dry_run)
        .await
        .map_err(|_| JobFailure::fatal("auth erase walk failed"))?;

    // Merge each service's counts map as-is under its key (identity's keyset varies
    // by scope, tenant's is fixed; both are stored verbatim).
    let counts_of = |body: Option<Value>| {
        body.and_then(|mut b| b.get_mut("counts").map(Value::take))
            .unwrap_or_else(|| json!({}))
    };
    let merged = json!({
        "auth": auth,
        "identity": counts_of(identity),
        "tenant": counts_of(tenant),
    });
    if dry_run {
        privacy::store_dry_run(pool, job.id, &merged)
            .await
            .map_err(|_| JobFailure::fatal("dry-run store failed"))?;
        Ok("awaiting_confirm")
    } else {
        privacy::finish_job(pool, job.id, &merged)
            .await
            .map_err(|_| JobFailure::fatal("job finish failed"))?;
        Ok("completed")
    }
}

/// `{table: n}` from a `{table: [rows]}` map; non-array/absent values are skipped.
fn table_counts(data: Option<&Value>) -> Value {
    let mut counts = serde_json::Map::new();
    if let Some(map) = data.and_then(Value::as_object) {
        for (table, rows) in map {
            if let Some(rows) = rows.as_array() {
                counts.insert(table.clone(), json!(rows.len()));
            }
        }
    }
    Value::Object(counts)
}

fn gzip(value: &Value) -> std::io::Result<Vec<u8>> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&serde_json::to_vec(value)?)?;
    encoder.finish()
}

/// Re-exported for route-layer reuse: the id-derived bundle filename.
pub fn bundle_filename(id: Uuid) -> String {
    format!("privacy-export-{id}.json.gz")
}
