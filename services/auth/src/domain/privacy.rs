//! Privacy job data layer (Phase 7 decisions A/A2/C/D): thin CRUD + the two
//! concurrency primitives over `privacy_jobs` (0009). No orchestration lives here;
//! the coordinator/worker own the fan-out and drive these transitions.
//!
//! Everything runs on the OWNER pool: the table is global (a person spans tenants by
//! design) and no tenant-scoped request path touches it. The bundle bytes never ride
//! [`PrivacyJob`]; they move only through [`store_bundle`]/[`take_bundle_once`].

use crate::error::AppError;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

/// A privacy job row, minus the bundle bytes (write-only via [`store_bundle`], read
/// exactly once via [`take_bundle_once`]).
#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct PrivacyJob {
    pub id: Uuid,
    pub kind: String,
    pub scope_kind: String,
    pub tenant_id: Option<Uuid>,
    pub steam_id: Option<String>,
    pub discord_id: Option<String>,
    pub player_account_id: Option<Uuid>,
    pub status: String,
    pub attempts: i32,
    pub dry_run_counts: Option<serde_json::Value>,
    pub result_counts: Option<serde_json::Value>,
    pub error: Option<String>,
    pub requested_by: Option<Uuid>,
    pub requested_via: String,
    pub bundle_expires_at: Option<DateTime<Utc>>,
    pub downloaded_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

const SELECT_COLS: &str = "id, kind, scope_kind, tenant_id, steam_id, discord_id, \
     player_account_id, status, attempts, dry_run_counts, result_counts, error, \
     requested_by, requested_via, bundle_expires_at, downloaded_at, created_at, updated_at";

/// Inputs for [`create_job`]. Shape validation (kind/scope/subject presence) is the
/// caller's job; the 0009 CHECK constraints are the backstop.
#[derive(Debug, Clone)]
pub struct NewPrivacyJob {
    pub kind: String,
    pub scope_kind: String,
    pub tenant_id: Option<Uuid>,
    pub steam_id: Option<String>,
    pub discord_id: Option<String>,
    pub player_account_id: Option<Uuid>,
    pub requested_by: Option<Uuid>,
    pub requested_via: String,
}

/// Insert a job in `queued`; id and timestamps come from the table defaults.
pub async fn create_job(pool: &PgPool, new: NewPrivacyJob) -> Result<PrivacyJob, AppError> {
    let sql = format!(
        "INSERT INTO privacy_jobs \
         (kind, scope_kind, tenant_id, steam_id, discord_id, player_account_id, \
          requested_by, requested_via) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING {SELECT_COLS}"
    );
    let job = sqlx::query_as::<_, PrivacyJob>(&sql)
        .bind(&new.kind)
        .bind(&new.scope_kind)
        .bind(new.tenant_id)
        .bind(&new.steam_id)
        .bind(&new.discord_id)
        .bind(new.player_account_id)
        .bind(new.requested_by)
        .bind(&new.requested_via)
        .fetch_one(pool)
        .await?;
    Ok(job)
}

pub async fn get_job(pool: &PgPool, id: Uuid) -> Result<Option<PrivacyJob>, AppError> {
    let sql = format!("SELECT {SELECT_COLS} FROM privacy_jobs WHERE id = $1");
    Ok(sqlx::query_as::<_, PrivacyJob>(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await?)
}

/// List jobs newest first, optionally filtered to one requester.
pub async fn list_jobs(
    pool: &PgPool,
    requested_by: Option<Uuid>,
    limit: i64,
) -> Result<Vec<PrivacyJob>, AppError> {
    let sql = format!(
        "SELECT {SELECT_COLS} FROM privacy_jobs \
         WHERE $1::uuid IS NULL OR requested_by = $1 \
         ORDER BY created_at DESC LIMIT $2"
    );
    Ok(sqlx::query_as::<_, PrivacyJob>(&sql)
        .bind(requested_by)
        .bind(limit)
        .fetch_all(pool)
        .await?)
}

/// List one tenant's jobs newest first (the operator surface, decision A2: the scope
/// org is the only lens an operator ever gets).
pub async fn list_jobs_for_tenant(
    pool: &PgPool,
    tenant_id: Uuid,
    limit: i64,
) -> Result<Vec<PrivacyJob>, AppError> {
    let sql = format!(
        "SELECT {SELECT_COLS} FROM privacy_jobs WHERE tenant_id = $1 \
         ORDER BY created_at DESC LIMIT $2"
    );
    Ok(sqlx::query_as::<_, PrivacyJob>(&sql)
        .bind(tenant_id)
        .bind(limit)
        .fetch_all(pool)
        .await?)
}

/// List one player's self-serve jobs newest first (the player surface: only jobs the
/// player themselves requested; operator jobs about them stay invisible).
pub async fn list_jobs_for_player(
    pool: &PgPool,
    player_account_id: Uuid,
    limit: i64,
) -> Result<Vec<PrivacyJob>, AppError> {
    let sql = format!(
        "SELECT {SELECT_COLS} FROM privacy_jobs \
         WHERE player_account_id = $1 AND requested_via = 'player' \
         ORDER BY created_at DESC LIMIT $2"
    );
    Ok(sqlx::query_as::<_, PrivacyJob>(&sql)
        .bind(player_account_id)
        .bind(limit)
        .fetch_all(pool)
        .await?)
}

/// The worker-claim primitive: atomically move the oldest `queued` job to `running`
/// and return it. `FOR UPDATE SKIP LOCKED` makes concurrent claimers pick disjoint
/// rows, so a job is claimed exactly once. `None` = nothing queued.
pub async fn claim_next_queued(pool: &PgPool) -> Result<Option<PrivacyJob>, AppError> {
    let sql = format!(
        "UPDATE privacy_jobs SET status = 'running', updated_at = now() \
         WHERE id = (SELECT id FROM privacy_jobs WHERE status = 'queued' \
                     ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) \
         RETURNING {SELECT_COLS}"
    );
    Ok(sqlx::query_as::<_, PrivacyJob>(&sql)
        .fetch_optional(pool)
        .await?)
}

/// The crash-recovery path the wave-2 worker calls each tick: requeue jobs stuck in
/// `running` longer than `stale_after` (a worker that died mid-job would otherwise
/// strand them forever). Returns the number of jobs reclaimed. No schema support is
/// needed beyond `updated_at`, and no cursor columns: the walkers are idempotent, so
/// re-running a partially-completed job from the top is safe.
pub async fn reclaim_stale_running(
    pool: &PgPool,
    stale_after: chrono::Duration,
) -> Result<u64, AppError> {
    let cutoff = Utc::now() - stale_after;
    let reclaimed = sqlx::query(
        "UPDATE privacy_jobs SET status = 'queued', updated_at = now() \
         WHERE status = 'running' AND updated_at < $1",
    )
    .bind(cutoff)
    .execute(pool)
    .await?;
    Ok(reclaimed.rows_affected())
}

/// Mark a job `completed` with its per-store row counts. Guarded on `running`: a
/// late or duplicate attempt (a stale worker finishing after a reclaim, a double
/// drive in tests) can never overwrite a terminal or awaiting_confirm state.
pub async fn finish_job(
    pool: &PgPool,
    id: Uuid,
    result_counts: &serde_json::Value,
) -> Result<(), AppError> {
    let updated = sqlx::query(
        "UPDATE privacy_jobs \
         SET status = 'completed', result_counts = $2, updated_at = now() \
         WHERE id = $1 AND status = 'running'",
    )
    .bind(id)
    .bind(result_counts)
    .execute(pool)
    .await?;
    require_hit(updated)
}

/// Mark a job `failed` with the error detail. Guarded on `running` only: a late
/// failure report must never overwrite a completed/awaiting_confirm/failed job.
pub async fn fail_job(pool: &PgPool, id: Uuid, error: &str) -> Result<(), AppError> {
    let updated = sqlx::query(
        "UPDATE privacy_jobs SET status = 'failed', error = $2, updated_at = now() \
         WHERE id = $1 AND status = 'running'",
    )
    .bind(id)
    .bind(error)
    .execute(pool)
    .await?;
    require_hit(updated)
}

/// Bounded retry for TRANSIENT walker failures (5xx/timeout/connect): requeue a
/// still-`running` job and bump its attempt counter, up to 2 retries (3 total
/// attempts). Returns whether it requeued; `false` means the attempts are exhausted
/// (or the job is no longer running) and the caller should mark it failed. The
/// walkers are idempotent, so re-running a partially-erased job from the top is
/// safe; together with the per-phase progress in the stored error (the failing
/// service name is prepended) this is the plan's decision D(5) resumability story.
pub async fn requeue_for_retry(pool: &PgPool, id: Uuid) -> Result<bool, AppError> {
    let requeued = sqlx::query(
        "UPDATE privacy_jobs \
         SET status = 'queued', attempts = attempts + 1, updated_at = now() \
         WHERE id = $1 AND status = 'running' AND attempts < 2",
    )
    .bind(id)
    .execute(pool)
    .await?;
    Ok(requeued.rows_affected() > 0)
}

/// Store the dry-run counts and park the job in `awaiting_confirm` (decision D rail 1:
/// every erasure shows its blast radius before the destructive pass runs). Guarded on
/// `running`: only the claimed pass may park a job.
pub async fn store_dry_run(
    pool: &PgPool,
    id: Uuid,
    counts: &serde_json::Value,
) -> Result<(), AppError> {
    let updated = sqlx::query(
        "UPDATE privacy_jobs \
         SET status = 'awaiting_confirm', dry_run_counts = $2, updated_at = now() \
         WHERE id = $1 AND status = 'running'",
    )
    .bind(id)
    .bind(counts)
    .execute(pool)
    .await?;
    require_hit(updated)
}

/// Confirm a dry-run: `awaiting_confirm` back to `queued` for the destructive pass.
/// Guarded so ONLY awaiting_confirm rows confirm; any other status is a `Conflict`
/// (a confirm must never resurrect a completed/failed/running job).
pub async fn confirm_job(pool: &PgPool, id: Uuid) -> Result<(), AppError> {
    let confirmed = sqlx::query(
        "UPDATE privacy_jobs SET status = 'queued', updated_at = now() \
         WHERE id = $1 AND status = 'awaiting_confirm'",
    )
    .bind(id)
    .execute(pool)
    .await?;
    if confirmed.rows_affected() > 0 {
        return Ok(());
    }
    match get_job(pool, id).await? {
        Some(job) => Err(AppError::Conflict(format!(
            "job is {}, not awaiting confirmation",
            job.status
        ))),
        None => Err(AppError::NotFound("privacy job not found".into())),
    }
}

/// Attach the export bundle and its download deadline (decision C: inline bytea,
/// 7-day TTL decided by the caller). Guarded on `running`: bundles are written by
/// the claimed export pass only, so a late duplicate can never resurrect a bundle
/// that was already taken (or overwrite a terminal job).
pub async fn store_bundle(
    pool: &PgPool,
    id: Uuid,
    bytes: &[u8],
    expires_at: DateTime<Utc>,
) -> Result<(), AppError> {
    let updated = sqlx::query(
        "UPDATE privacy_jobs \
         SET bundle = $2, bundle_expires_at = $3, updated_at = now() \
         WHERE id = $1 AND status = 'running'",
    )
    .bind(id)
    .bind(bytes)
    .bind(expires_at)
    .execute(pool)
    .await?;
    require_hit(updated)
}

/// The one-time-download primitive (the login-code DELETE-RETURNING precedent): NULL
/// the bundle and stamp the download in one statement, returning the bytes read from
/// the statement's pre-update snapshot. A concurrent second caller blocks on the row
/// lock, re-checks `bundle IS NOT NULL` against the updated tuple, and gets `None`;
/// expired bundles are never handed out.
pub async fn take_bundle_once(pool: &PgPool, id: Uuid) -> Result<Option<Vec<u8>>, AppError> {
    Ok(sqlx::query_scalar(
        "WITH taken AS ( \
             UPDATE privacy_jobs \
             SET bundle = NULL, downloaded_at = now(), updated_at = now() \
             WHERE id = $1 AND bundle IS NOT NULL AND bundle_expires_at > now() \
             RETURNING id \
         ) \
         SELECT bundle FROM privacy_jobs WHERE id IN (SELECT id FROM taken)",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?)
}

/// Map a guarded single-row UPDATE's outcome: zero rows = no such job, or the job
/// is not in the `running` state the transition requires.
fn require_hit(result: sqlx::postgres::PgQueryResult) -> Result<(), AppError> {
    if result.rows_affected() > 0 {
        Ok(())
    } else {
        Err(AppError::NotFound(
            "privacy job not found or not running".into(),
        ))
    }
}
