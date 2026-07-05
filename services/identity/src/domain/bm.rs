//! BattleMetrics integration data access: the per-tenant connection (envelope-encrypted
//! token), import jobs with page-granular resumable cursors, the external-ID sync map,
//! and the ban-list registry (docs/phase4-plan.md decisions C/D/G).
//!
//! Request-path CRUD runs on the app pool (RLS-scoped). Supervisor/runner access
//! (claim, heartbeat, page upserts) runs on the owner pool with explicit `tenant_id`;
//! the runner is not a tenant principal, mirroring the ingestion consumer.

use crate::error::AppError;
use chrono::{DateTime, Utc};
use cupboard_crypto::hmac_sha256;
use cupboard_domain::TenantId;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

/// Lease freshness: a claim whose heartbeat is older than this is up for takeover.
pub const CLAIM_STALE_SECS: i64 = 120;

// ---------------------------------------------------------------------------
// Connection

/// Runner-side row (carries the sealed token + the sync settings the loops read).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct BmConnection {
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub bm_org_id: String,
    pub token_enc: Vec<u8>,
    pub token_dek: Vec<u8>,
    /// Cadences + target ban list + subset selections (`bm::sync` reads these).
    pub settings: serde_json::Value,
    pub sync_enabled: bool,
    pub sync_bans_outbound: bool,
}

const CONN_COLS: &str = "id, tenant_id, bm_org_id, token_enc, token_dek, settings, \
     sync_enabled, sync_bans_outbound";

/// Token-free view for the API. The sealed token never leaves the service.
#[derive(Debug, sqlx::FromRow, serde::Serialize)]
pub struct ConnectionView {
    pub id: Uuid,
    pub bm_org_id: String,
    pub status: String,
    pub last_error: Option<String>,
    pub sync_enabled: bool,
    pub sync_bans_outbound: bool,
    pub settings: serde_json::Value,
    pub last_tail_at: Option<DateTime<Utc>>,
    pub last_scan_at: Option<DateTime<Utc>>,
    pub sync_error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

const VIEW_COLS: &str = "id, bm_org_id, status, last_error, sync_enabled, \
     sync_bans_outbound, settings, last_tail_at, last_scan_at, sync_error, \
     created_at, updated_at";

pub struct NewConnection {
    pub bm_org_id: String,
    pub token_enc: Vec<u8>,
    pub token_dek: Vec<u8>,
}

/// Create or replace the tenant's single BM connection (re-connecting with a fresh
/// token resets status/errors).
pub async fn upsert_connection(
    app_pool: &PgPool,
    tenant: TenantId,
    actor: Uuid,
    input: NewConnection,
) -> Result<ConnectionView, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    // Existing org (if any), locked, to detect a re-point to a DIFFERENT BM organization.
    let prev_org: Option<String> =
        sqlx::query_scalar("SELECT bm_org_id FROM bm_connections WHERE tenant_id = $1 FOR UPDATE")
            .bind(tenant.0)
            .fetch_optional(&mut *tx)
            .await?;
    let mut view = sqlx::query_as::<_, ConnectionView>(&format!(
        "INSERT INTO bm_connections (tenant_id, bm_org_id, token_enc, token_dek) \
         VALUES ($1, $2, $3, $4) \
         ON CONFLICT (tenant_id) DO UPDATE SET \
           bm_org_id = EXCLUDED.bm_org_id, token_enc = EXCLUDED.token_enc, \
           token_dek = EXCLUDED.token_dek, status = 'connected', last_error = NULL, \
           updated_at = now() \
         RETURNING {VIEW_COLS}"
    ))
    .bind(tenant.0)
    .bind(&input.bm_org_id)
    .bind(&input.token_enc)
    .bind(&input.token_dek)
    .fetch_one(&mut *tx)
    .await?;

    let org_changed = prev_org.as_deref().is_some_and(|o| o != input.bm_org_id);
    if org_changed {
        // Re-pointing to a different BM org invalidates the old org's list registry and
        // any queued pushes: the old lists are no longer scannable with the new token, and
        // an errored fetch (or worse, an empty page) could mass-revoke the old imports.
        // Turn sync off, clear the target, drop the old list registry, and abandon
        // in-flight outbox ops. `bm_sync_map` rows STAY: historical imports remain valid
        // locally, and with the old lists gone the sweep never scans (nor touches) them.
        view = sqlx::query_as::<_, ConnectionView>(&format!(
            "UPDATE bm_connections SET sync_enabled = false, sync_bans_outbound = false, \
               settings = '{{}}'::jsonb, updated_at = now() WHERE tenant_id = $1 \
             RETURNING {VIEW_COLS}"
        ))
        .bind(tenant.0)
        .fetch_one(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM bm_ban_lists WHERE tenant_id = $1")
            .bind(tenant.0)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "UPDATE bm_outbox SET status = 'abandoned', next_attempt_at = now(), \
               last_error = 'connection re-pointed to a different BM organization' \
             WHERE tenant_id = $1 AND status IN ('pending', 'inflight', 'needs_verify')",
        )
        .bind(tenant.0)
        .execute(&mut *tx)
        .await?;
    }

    crate::domain::audit::record_in_tx(
        &mut tx,
        Some(tenant.0),
        Some(actor),
        "integrations.bm.connect",
        Some("bm_connection"),
        Some(view.id),
        Some(serde_json::json!({
            "bm_org_id": view.bm_org_id,
            "previous_bm_org_id": prev_org,
            "org_changed": org_changed,
        })),
    )
    .await?;

    tx.commit().await?;
    Ok(view)
}

pub async fn get_view(
    app_pool: &PgPool,
    tenant: TenantId,
) -> Result<Option<ConnectionView>, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    // RLS scopes the app pool already; the explicit filter is defense in depth (and
    // what lets the owner-pool test harness exercise these paths).
    let view = sqlx::query_as::<_, ConnectionView>(&format!(
        "SELECT {VIEW_COLS} FROM bm_connections WHERE tenant_id = $1 LIMIT 1"
    ))
    .bind(tenant.0)
    .fetch_optional(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(view)
}

// ---------------------------------------------------------------------------
// Import jobs

/// API-facing job summary.
#[derive(Debug, sqlx::FromRow, serde::Serialize)]
pub struct ImportJobView {
    pub id: Uuid,
    pub status: String,
    pub phase: String,
    pub phase_counts: serde_json::Value,
    pub error: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

const JOB_VIEW_COLS: &str =
    "id, status, phase, phase_counts, error, started_at, finished_at, created_at";

/// Runner-side job row (carries the cursor).
#[derive(Debug, sqlx::FromRow)]
pub struct ImportJob {
    pub id: Uuid,
    pub phase: String,
    pub cursor: serde_json::Value,
    pub phase_counts: serde_json::Value,
}

/// Queue an import for the tenant's connection. At most one live (queued/running/
/// paused) job per connection; a second enqueue is a client error, not a dup.
pub async fn enqueue_import(
    app_pool: &PgPool,
    tenant: TenantId,
    actor: Uuid,
) -> Result<ImportJobView, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let conn: Option<(Uuid, String)> =
        sqlx::query_as("SELECT id, status FROM bm_connections WHERE tenant_id = $1 LIMIT 1")
            .bind(tenant.0)
            .fetch_optional(&mut *tx)
            .await?;
    let (connection_id, status) = conn.ok_or_else(|| {
        AppError::NotFound("no BattleMetrics connection; connect a token first".into())
    })?;
    if status == "disabled" {
        return Err(AppError::BadRequest(
            "the BattleMetrics connection is disabled".into(),
        ));
    }

    // Start at the head of the PR4 pipeline (servers). The column default is the PR1
    // 'ban_lists' (0009 predates the breadth phases and is already applied, so its
    // default can't be rewritten); set the phase explicitly here instead.
    let job = sqlx::query_as::<_, ImportJobView>(&format!(
        "INSERT INTO bm_import_jobs (tenant_id, connection_id, requested_by, phase) \
         VALUES ($1, $2, $3, 'servers') RETURNING {JOB_VIEW_COLS}"
    ))
    .bind(tenant.0)
    .bind(connection_id)
    .bind(actor)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| match &e {
        sqlx::Error::Database(db) if db.constraint() == Some("ux_bm_import_jobs_live") => {
            AppError::BadRequest("an import is already queued or running".into())
        }
        _ => AppError::from(e),
    })?;

    crate::domain::audit::record_in_tx(
        &mut tx,
        Some(tenant.0),
        Some(actor),
        "integrations.bm.import.enqueue",
        Some("bm_import_job"),
        Some(job.id),
        None,
    )
    .await?;

    tx.commit().await?;
    Ok(job)
}

/// Tenant job controls. `pause` parks the live job at the next slice boundary (the
/// runner stops picking it up), `resume` re-queues a paused one, `cancel` is
/// terminal. Guarded transitions: a finished job is never resurrected.
pub async fn control_job(
    app_pool: &PgPool,
    tenant: TenantId,
    actor: Uuid,
    action: &str,
) -> Result<ImportJobView, AppError> {
    let (from, to): (&[&str], &str) = match action {
        "pause" => (&["queued", "running"], "paused"),
        "resume" => (&["paused"], "queued"),
        "cancel" => (&["queued", "running", "paused"], "cancelled"),
        _ => return Err(AppError::BadRequest("unknown job action".into())),
    };
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let job = sqlx::query_as::<_, ImportJobView>(&format!(
        "UPDATE bm_import_jobs SET status = $3, \
           finished_at = CASE WHEN $3 = 'cancelled' THEN now() ELSE finished_at END \
         WHERE tenant_id = $1 AND status = ANY($2) \
           AND id = (SELECT id FROM bm_import_jobs WHERE tenant_id = $1 \
                     AND status IN ('queued', 'running', 'paused') \
                     ORDER BY created_at DESC LIMIT 1) \
         RETURNING {JOB_VIEW_COLS}"
    ))
    .bind(tenant.0)
    .bind(from)
    .bind(to)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("no import job eligible for {action}")))?;

    crate::domain::audit::record_in_tx(
        &mut tx,
        Some(tenant.0),
        Some(actor),
        &format!("integrations.bm.import.{action}"),
        Some("bm_import_job"),
        Some(job.id),
        None,
    )
    .await?;
    tx.commit().await?;
    Ok(job)
}

pub async fn latest_job(
    app_pool: &PgPool,
    tenant: TenantId,
) -> Result<Option<ImportJobView>, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let job = sqlx::query_as::<_, ImportJobView>(&format!(
        "SELECT {JOB_VIEW_COLS} FROM bm_import_jobs WHERE tenant_id = $1 \
         ORDER BY created_at DESC LIMIT 1"
    ))
    .bind(tenant.0)
    .fetch_optional(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(job)
}

// ---------------------------------------------------------------------------
// Runner lease + job lifecycle (owner pool)

/// Claim up to `limit` connections that have runnable work (a live import job, or
/// inbound sync enabled on a healthy connection) and are unclaimed, ours already, or
/// stale. `FOR UPDATE SKIP LOCKED` keeps two supervisors from double-claiming in the
/// same instant; the stale-heartbeat window covers pod death. The sync arm requires
/// `status = 'connected'` so an errored token doesn't get hammered every tick; a
/// reconnect resets the status and sync resumes.
pub async fn claim_ready(
    owner_pool: &PgPool,
    claimer: &str,
    limit: i64,
) -> Result<Vec<BmConnection>, AppError> {
    let rows = sqlx::query_as::<_, BmConnection>(&format!(
        "UPDATE bm_connections SET claimed_by = $1, heartbeat_at = now() \
         WHERE id IN ( \
             SELECT c.id FROM bm_connections c \
             WHERE c.status <> 'disabled' \
               AND (c.claimed_by IS NULL OR c.claimed_by = $1 \
                    OR c.heartbeat_at < now() - make_interval(secs => $3)) \
               AND ((c.sync_enabled AND c.status = 'connected') \
                    OR EXISTS (SELECT 1 FROM bm_import_jobs j \
                               WHERE j.connection_id = c.id \
                                 AND j.status IN ('queued', 'running'))) \
             ORDER BY c.heartbeat_at ASC NULLS FIRST \
             LIMIT $2 \
             FOR UPDATE SKIP LOCKED \
         ) \
         RETURNING {CONN_COLS}"
    ))
    .bind(claimer)
    .bind(limit)
    .bind(CLAIM_STALE_SECS as f64)
    .fetch_all(owner_pool)
    .await?;
    Ok(rows)
}

/// Refresh the lease. `false` means another claimer took the connection over (the
/// runner must stop touching it).
pub async fn heartbeat(
    owner_pool: &PgPool,
    connection_id: Uuid,
    claimer: &str,
) -> Result<bool, AppError> {
    let res = sqlx::query(
        "UPDATE bm_connections SET heartbeat_at = now() WHERE id = $1 AND claimed_by = $2",
    )
    .bind(connection_id)
    .bind(claimer)
    .execute(owner_pool)
    .await?;
    Ok(res.rows_affected() == 1)
}

/// Release the lease if we still hold it (a takeover already released it for us).
pub async fn release_claim(
    owner_pool: &PgPool,
    connection_id: Uuid,
    claimer: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE bm_connections SET claimed_by = NULL, heartbeat_at = NULL \
         WHERE id = $1 AND claimed_by = $2",
    )
    .bind(connection_id)
    .bind(claimer)
    .execute(owner_pool)
    .await?;
    Ok(())
}

/// Mark the connection errored, fenced on the sealed token still being the one this
/// runner decrypted. A tenant who reconnected with a fresh token mid-run must not have
/// their healthy connection flipped back to error by a runner still holding the old
/// one. Returns whether the row was actually errored.
pub async fn set_connection_error_if_token_unchanged(
    owner_pool: &PgPool,
    connection_id: Uuid,
    token_enc: &[u8],
    message: &str,
) -> Result<bool, AppError> {
    let res = sqlx::query(
        "UPDATE bm_connections SET status = 'error', last_error = $2, updated_at = now() \
         WHERE id = $1 AND token_enc = $3",
    )
    .bind(connection_id)
    .bind(message)
    .bind(token_enc)
    .execute(owner_pool)
    .await?;
    Ok(res.rows_affected() == 1)
}

/// The oldest live job for a connection, if any (queued, or running from a previous
/// incarnation whose cursor we resume).
pub async fn next_live_job(
    owner_pool: &PgPool,
    connection_id: Uuid,
) -> Result<Option<ImportJob>, AppError> {
    let job = sqlx::query_as::<_, ImportJob>(
        "SELECT id, phase, cursor, phase_counts FROM bm_import_jobs \
         WHERE connection_id = $1 AND status IN ('queued', 'running') \
         ORDER BY created_at ASC LIMIT 1",
    )
    .bind(connection_id)
    .fetch_optional(owner_pool)
    .await?;
    Ok(job)
}

/// Fence fragment shared by every job write: the job's connection must still be leased
/// to this claimer. A taken-over runner that has not yet noticed (heartbeat is every
/// 30s) must not flip the shared job's status or rewind the cursor the new owner has
/// advanced. `rows_affected == 0` = fence miss = stop writing.
const JOB_CLAIM_FENCE: &str = "connection_id IN \
     (SELECT id FROM bm_connections WHERE claimed_by = $CLAIMER)";

/// Outcome of a fenced, status-guarded job-status write. A bare `false` conflated two very
/// different misses; splitting them lets the runner KEEP the lease when the tenant merely
/// paused or cancelled the job, instead of dropping it (and halting sync) as if the lease
/// had been taken over.
#[derive(Debug, PartialEq, Eq)]
pub enum JobWrite {
    /// The row moved to the requested state.
    Applied,
    /// We still hold the lease, but the job left the runnable set (the tenant paused or
    /// cancelled it): stop working the job, keep the claim.
    NotRunnable,
    /// The lease was taken over (fence miss): stop the runner so a fresh claim resumes.
    LeaseLost,
}

/// Classify a 0-row job write on the owner pool: if the job's connection is still leased to
/// `claimer` the miss came from the status guard (paused/cancelled), otherwise the lease
/// moved. Jobs are never deleted, so a missing row can only mean the fence no longer holds.
async fn classify_job_miss(
    owner_pool: &PgPool,
    job_id: Uuid,
    claimer: &str,
) -> Result<JobWrite, AppError> {
    let held: Option<i32> = sqlx::query_scalar(&format!(
        "SELECT 1 FROM bm_import_jobs WHERE id = $1 AND {}",
        JOB_CLAIM_FENCE.replace("$CLAIMER", "$2")
    ))
    .bind(job_id)
    .bind(claimer)
    .fetch_optional(owner_pool)
    .await?;
    Ok(if held.is_some() {
        JobWrite::NotRunnable
    } else {
        JobWrite::LeaseLost
    })
}

pub async fn mark_job_running(
    owner_pool: &PgPool,
    job_id: Uuid,
    claimer: &str,
) -> Result<JobWrite, AppError> {
    // The status guard keeps a racing runner from resurrecting a job the tenant just
    // paused or cancelled.
    let res = sqlx::query(&format!(
        "UPDATE bm_import_jobs SET status = 'running', \
         started_at = COALESCE(started_at, now()) \
         WHERE id = $1 AND status IN ('queued', 'running') AND {}",
        JOB_CLAIM_FENCE.replace("$CLAIMER", "$2")
    ))
    .bind(job_id)
    .bind(claimer)
    .execute(owner_pool)
    .await?;
    if res.rows_affected() == 1 {
        return Ok(JobWrite::Applied);
    }
    classify_job_miss(owner_pool, job_id, claimer).await
}

pub async fn finish_job(
    owner_pool: &PgPool,
    job_id: Uuid,
    status: &str,
    error: Option<&str>,
    claimer: &str,
) -> Result<JobWrite, AppError> {
    // The status guard keeps a completing runner from overwriting a tenant's
    // pause/cancel that landed during the final pages.
    let res = sqlx::query(&format!(
        "UPDATE bm_import_jobs SET status = $2, error = $3, finished_at = now(), \
         phase = CASE WHEN $2 = 'completed' THEN 'done' ELSE phase END \
         WHERE id = $1 AND status IN ('queued', 'running') AND {}",
        JOB_CLAIM_FENCE.replace("$CLAIMER", "$4")
    ))
    .bind(job_id)
    .bind(status)
    .bind(error)
    .bind(claimer)
    .execute(owner_pool)
    .await?;
    if res.rows_affected() == 1 {
        return Ok(JobWrite::Applied);
    }
    classify_job_miss(owner_pool, job_id, claimer).await
}

/// Persist a page's progress inside that page's tx: phase, cursor, and counts move
/// together with the rows they describe, so a crash never double-imports a page. The same
/// status guard as `mark_job_running`/`finish_job` fences it, so a tenant pause/cancel
/// landing mid-slice stops the in-flight page from committing (it rolls back) instead of
/// letting the runner keep importing into a cancelled job. `NotRunnable` = the tenant
/// paused/cancelled (keep the claim); `LeaseLost` = the lease moved (both roll the page
/// back).
pub async fn save_job_progress(
    tx: &mut Transaction<'_, Postgres>,
    job_id: Uuid,
    phase: &str,
    cursor: &serde_json::Value,
    phase_counts: &serde_json::Value,
    claimer: &str,
) -> Result<JobWrite, AppError> {
    let res = sqlx::query(&format!(
        "UPDATE bm_import_jobs SET phase = $2, cursor = $3, phase_counts = $4 \
         WHERE id = $1 AND status IN ('queued', 'running') AND {}",
        JOB_CLAIM_FENCE.replace("$CLAIMER", "$5")
    ))
    .bind(job_id)
    .bind(phase)
    .bind(cursor)
    .bind(phase_counts)
    .bind(claimer)
    .execute(&mut **tx)
    .await?;
    if res.rows_affected() == 1 {
        return Ok(JobWrite::Applied);
    }
    // Distinguish a tenant pause/cancel (lease still ours) from a takeover, probing within
    // the same tx so the classification is consistent with the write it just attempted.
    let held: Option<i32> = sqlx::query_scalar(&format!(
        "SELECT 1 FROM bm_import_jobs WHERE id = $1 AND {}",
        JOB_CLAIM_FENCE.replace("$CLAIMER", "$2")
    ))
    .bind(job_id)
    .bind(claimer)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(if held.is_some() {
        JobWrite::NotRunnable
    } else {
        JobWrite::LeaseLost
    })
}

// ---------------------------------------------------------------------------
// Ban-list registry

pub struct ImportedBanList {
    pub external_id: String,
    pub name: Option<String>,
    pub action: Option<String>,
    pub owner_bm_org: Option<String>,
    pub subscribed: bool,
    pub perm_create: bool,
    pub perm_update: bool,
    pub perm_delete: bool,
}

/// Upsert a discovered ban list. `import_enabled` is tenant-managed and survives
/// re-discovery.
pub async fn upsert_ban_list(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    list: &ImportedBanList,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO bm_ban_lists \
           (tenant_id, external_id, name, action, owner_bm_org, subscribed, \
            perm_create, perm_update, perm_delete) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) \
         ON CONFLICT (tenant_id, external_id) DO UPDATE SET \
           name = EXCLUDED.name, action = EXCLUDED.action, \
           owner_bm_org = EXCLUDED.owner_bm_org, subscribed = EXCLUDED.subscribed, \
           perm_create = EXCLUDED.perm_create, perm_update = EXCLUDED.perm_update, \
           perm_delete = EXCLUDED.perm_delete, updated_at = now()",
    )
    .bind(tenant_id)
    .bind(&list.external_id)
    .bind(&list.name)
    .bind(&list.action)
    .bind(&list.owner_bm_org)
    .bind(list.subscribed)
    .bind(list.perm_create)
    .bind(list.perm_update)
    .bind(list.perm_delete)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[derive(Debug, sqlx::FromRow, serde::Serialize)]
pub struct BanListView {
    pub external_id: String,
    pub name: Option<String>,
    pub owner_bm_org: Option<String>,
    pub subscribed: bool,
    pub perm_create: bool,
    pub import_enabled: bool,
}

pub async fn list_ban_lists(
    app_pool: &PgPool,
    tenant: TenantId,
) -> Result<Vec<BanListView>, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let lists = sqlx::query_as::<_, BanListView>(
        "SELECT external_id, name, owner_bm_org, subscribed, perm_create, import_enabled \
         FROM bm_ban_lists WHERE tenant_id = $1 ORDER BY subscribed, name NULLS LAST",
    )
    .bind(tenant.0)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(lists)
}

/// Import-enabled list ids, in the stable order the bans phase walks them.
pub async fn import_enabled_list_ids(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
) -> Result<Vec<String>, AppError> {
    let ids: Vec<(String,)> = sqlx::query_as(
        "SELECT external_id FROM bm_ban_lists \
         WHERE tenant_id = $1 AND import_enabled ORDER BY external_id",
    )
    .bind(tenant_id)
    .fetch_all(&mut **tx)
    .await?;
    Ok(ids.into_iter().map(|(id,)| id).collect())
}

// ---------------------------------------------------------------------------
// Import breadth: servers, players, notes (PR4)

/// Idempotent sync-map upsert for a non-ban entity (server or player). Keyed on
/// `(tenant_id, entity_type, external_id)`: a re-run converges `local_id`/`meta` instead
/// of erroring. The fleet server upsert and this map write are not one transaction, so
/// this must tolerate a repeat.
async fn upsert_mapping(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    entity_type: &str,
    external_id: &str,
    local_id: Uuid,
    meta: &serde_json::Value,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO bm_sync_map \
           (tenant_id, entity_type, external_id, local_id, meta, bm_seen_at, \
            local_synced_at, last_direction) \
         VALUES ($1, $2, $3, $4, $5, now(), now(), 'inbound') \
         ON CONFLICT (tenant_id, entity_type, external_id) DO UPDATE SET \
           local_id = EXCLUDED.local_id, meta = EXCLUDED.meta, bm_seen_at = now(), \
           local_synced_at = now(), last_direction = 'inbound'",
    )
    .bind(tenant_id)
    .bind(entity_type)
    .bind(external_id)
    .bind(local_id)
    .bind(meta)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Map a BM server (external id) to its fleet server uuid.
pub async fn upsert_server_mapping(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    external_id: &str,
    local_id: Uuid,
    meta: &serde_json::Value,
) -> Result<(), AppError> {
    upsert_mapping(tx, tenant_id, "server", external_id, local_id, meta).await
}

/// Map a BM player (external id) to its Cupboard player uuid.
pub async fn upsert_player_mapping(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    external_id: &str,
    local_id: Uuid,
    meta: &serde_json::Value,
) -> Result<(), AppError> {
    upsert_mapping(tx, tenant_id, "player", external_id, local_id, meta).await
}

/// Record an observed name in the global name history (same table native ingest writes).
/// `last_seen_at` only moves forward.
pub async fn upsert_name_history(
    tx: &mut Transaction<'_, Postgres>,
    player_id: Uuid,
    name: &str,
    obs: DateTime<Utc>,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO name_history (player_id, name, first_seen_at, last_seen_at) \
         VALUES ($1, $2, $3, $3) \
         ON CONFLICT (player_id, name) DO UPDATE SET \
           last_seen_at = GREATEST(name_history.last_seen_at, EXCLUDED.last_seen_at)",
    )
    .bind(player_id)
    .bind(name)
    .bind(obs)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Record an observed IP as an identity signal (same shape native ingest writes), so
/// imported players feed link detection exactly like natively-seen ones. Unlike native
/// ingest this must NOT count as a sighting: re-importing the same BM record is not a new
/// observation, so `sighting_count` is only ever the initial 1 (matching native's first
/// insert) and never incremented on conflict. `last_seen_at` only moves forward
/// (`GREATEST`), so importing a player's historical `createdAt` can't rewind a recency the
/// native graph already advanced; `first_seen_at` is preserved.
pub async fn upsert_ip_signal(
    tx: &mut Transaction<'_, Postgres>,
    player_id: Uuid,
    value: &str,
    value_hash: &[u8],
    obs: DateTime<Utc>,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO identity_signals \
           (player_id, type, value, value_hash, sighting_count, first_seen_at, last_seen_at) \
         VALUES ($1, 'ip', $2, $3, 1, $4, $4) \
         ON CONFLICT (player_id, type, value_hash) DO UPDATE SET \
           last_seen_at = GREATEST(identity_signals.last_seen_at, EXCLUDED.last_seen_at)",
    )
    .bind(player_id)
    .bind(value)
    .bind(value_hash)
    .bind(obs)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Whether Cupboard player `local_id` is already mapped to a BM player OTHER than
/// `external_id` for this tenant. Two BM player records that share a steam id (BM merge
/// leftovers) resolve to one Cupboard player; mapping the second would collide on
/// `bm_sync_map`'s `UNIQUE (tenant_id, entity_type, local_id)`, which `map_upsert_err`
/// would misread as a lost claim and wedge the import. The caller skips such a player.
/// Runs inside the page tx (indexed by the same unique key), so a mapping written earlier
/// in the same page but not yet committed counts too: cross-page AND same-page safe.
pub async fn player_mapped_to_other_external(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    local_id: Uuid,
    external_id: &str,
) -> Result<bool, AppError> {
    let existing: Option<String> = sqlx::query_scalar(
        "SELECT external_id FROM bm_sync_map \
         WHERE tenant_id = $1 AND entity_type = 'player' AND local_id = $2 \
           AND external_id <> $3 LIMIT 1",
    )
    .bind(tenant_id)
    .bind(local_id)
    .bind(external_id)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(existing.is_some())
}

/// Insert an imported note, guarded by a `note` sync-map row so a re-scan never
/// duplicates it. `false` = already mapped (nothing inserted). Author is NULL (BM notes
/// carry no Cupboard staff user); `origin = 'bm'`.
pub async fn insert_imported_note(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    player_id: Uuid,
    note_external_id: &str,
    body: &str,
    created_at: DateTime<Utc>,
) -> Result<bool, AppError> {
    let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT local_id FROM bm_sync_map \
         WHERE tenant_id = $1 AND entity_type = 'note' AND external_id = $2",
    )
    .bind(tenant_id)
    .bind(note_external_id)
    .fetch_optional(&mut **tx)
    .await?;
    if existing.is_some() {
        return Ok(false);
    }
    let note_id: Uuid = sqlx::query_scalar(
        "INSERT INTO player_notes (tenant_id, player_id, author, body, origin, created_at) \
         VALUES ($1, $2, NULL, $3, 'bm', $4) RETURNING id",
    )
    .bind(tenant_id)
    .bind(player_id)
    .bind(body)
    .bind(created_at)
    .fetch_one(&mut **tx)
    .await?;
    sqlx::query(
        "INSERT INTO bm_sync_map \
           (tenant_id, entity_type, external_id, local_id, bm_seen_at, local_synced_at, \
            last_direction) \
         VALUES ($1, 'note', $2, $3, now(), now(), 'inbound')",
    )
    .bind(tenant_id)
    .bind(note_external_id)
    .bind(note_id)
    .execute(&mut **tx)
    .await?;
    Ok(true)
}

/// The next page of player map rows for the notes phase's keyset walk, ordered by
/// `external_id` (a stable total order; the walk visits each player exactly once). The
/// cursor carries only the last processed external id, never the full id set.
pub async fn mapped_player_page(
    owner_pool: &PgPool,
    tenant_id: Uuid,
    after_external_id: Option<&str>,
    limit: i64,
) -> Result<Vec<(String, Uuid)>, AppError> {
    let rows: Vec<(String, Uuid)> = sqlx::query_as(
        "SELECT external_id, local_id FROM bm_sync_map \
         WHERE tenant_id = $1 AND entity_type = 'player' \
           AND ($2::text IS NULL OR external_id > $2) \
         ORDER BY external_id ASC LIMIT $3",
    )
    .bind(tenant_id)
    .bind(after_external_id)
    .bind(limit)
    .fetch_all(owner_pool)
    .await?;
    Ok(rows)
}

// ---------------------------------------------------------------------------
// Imported bans

pub struct ImportedBan {
    /// BM's resource id for the ban (the sync-map key).
    pub external_id: String,
    pub subject_type: String,
    pub subject_value: String,
    pub reason: Option<String>,
    pub issued_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
    /// Canonical content hash (`cupboard_bmapi::ban_content_hash`).
    pub content_hash: Vec<u8>,
    /// BM fidelity the local row can't hold: uid, note, full identifier array,
    /// banList, orgWide, server/player refs.
    pub meta: serde_json::Value,
}

/// Outcome of one applied page.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct PageOutcome {
    pub inserted: usize,
    pub updated: usize,
    pub unchanged: usize,
    /// Subset of `updated` that hit a locally-revoked ban: the edit's fields applied
    /// but the revoke stood, and an inbound conflict row was logged (decision I).
    pub conflicts: usize,
}

/// Batched, idempotent apply of one page of BM bans; the import and both sync loops
/// share it. Unchanged hash = touch `bm_seen_at`; changed hash = refresh the ban to
/// BM's state (re-resolving the player link) without resurrecting a local revoke;
/// new = insert ban + map row. Set-based statements per page, not per ban: on a
/// 100k-ban org the DB round trips, not the BM rate limiter, would otherwise be the
/// import bottleneck.
pub async fn apply_ban_page(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    pepper: &[u8],
    bans: &[ImportedBan],
) -> Result<PageOutcome, AppError> {
    let mut out = PageOutcome::default();
    // Dedup within the page (first occurrence wins): a repeated external_id would
    // violate the map unique index inside one multi-row INSERT.
    let mut seen = std::collections::HashSet::new();
    let bans: Vec<&ImportedBan> = bans
        .iter()
        .filter(|b| seen.insert(b.external_id.as_str()))
        .collect();
    if bans.is_empty() {
        return Ok(out);
    }

    let ext_ids: Vec<String> = bans.iter().map(|b| b.external_id.clone()).collect();
    // LEFT JOIN: a map row whose bans row was removed out-of-band must still count as
    // existing, or its external_id would be re-inserted into the map and violate the
    // unique index, wedging every page that contains it.
    let existing: Vec<(String, Uuid, Option<Vec<u8>>, String)> = sqlx::query_as(
        "SELECT m.external_id, m.local_id, m.content_hash, COALESCE(b.status, 'missing') \
         FROM bm_sync_map m LEFT JOIN bans b ON b.id = m.local_id \
         WHERE m.tenant_id = $1 AND m.entity_type = 'ban' AND m.external_id = ANY($2)",
    )
    .bind(tenant_id)
    .bind(&ext_ids)
    .fetch_all(&mut **tx)
    .await?;
    let existing: std::collections::HashMap<String, (Uuid, Option<Vec<u8>>, String)> = existing
        .into_iter()
        .map(|(ext, local, hash, status)| (ext, (local, hash, status)))
        .collect();

    struct Prepared<'a> {
        ban: &'a ImportedBan,
        subject_hash: Vec<u8>,
        status: &'static str,
    }
    let now = Utc::now();
    let prepared: Vec<Prepared> = bans
        .iter()
        .map(|ban| Prepared {
            ban,
            subject_hash: hmac_sha256(ban.subject_value.as_bytes(), pepper).to_vec(),
            status: if ban.expires_at.is_some_and(|e| e <= now) {
                "expired"
            } else {
                "active"
            },
        })
        .collect();

    let mut fresh: Vec<&Prepared> = Vec::new();
    let mut unchanged_ids: Vec<String> = Vec::new();
    let mut changed: Vec<(&Prepared, Uuid, &str)> = Vec::new(); // (row, local_id, local status)
    for p in &prepared {
        match existing.get(&p.ban.external_id) {
            None => fresh.push(p),
            Some((_, Some(hash), _)) if *hash == p.ban.content_hash => {
                unchanged_ids.push(p.ban.external_id.clone());
            }
            Some((local_id, _, local_status)) => changed.push((p, *local_id, local_status)),
        }
    }

    if !unchanged_ids.is_empty() {
        // Meta refreshes even on unchanged content: list membership is not hashed,
        // and the delete sweep scopes on meta->>'ban_list', so a stale list id there
        // would exempt a moved ban from its own list's sweep.
        let unchanged_meta: Vec<serde_json::Value> = prepared
            .iter()
            .filter(|p| unchanged_ids.contains(&p.ban.external_id))
            .map(|p| p.ban.meta.clone())
            .collect();
        sqlx::query(
            "UPDATE bm_sync_map m SET bm_seen_at = now(), meta = u.meta \
             FROM unnest($2::text[], $3::jsonb[]) AS u(external_id, meta) \
             WHERE m.tenant_id = $1 AND m.entity_type = 'ban' \
               AND m.external_id = u.external_id",
        )
        .bind(tenant_id)
        .bind(&unchanged_ids)
        .bind(&unchanged_meta)
        .execute(&mut **tx)
        .await?;
        out.unchanged = unchanged_ids.len();
    }

    if !fresh.is_empty() {
        // Resolve player links for the whole page in one statement (same resolution
        // bans::create does per ban).
        let types: Vec<String> = fresh.iter().map(|p| p.ban.subject_type.clone()).collect();
        let hashes: Vec<Vec<u8>> = fresh.iter().map(|p| p.subject_hash.clone()).collect();
        let resolved: Vec<(String, Vec<u8>, Uuid)> = sqlx::query_as(
            "SELECT pi.type, pi.value_hash, pi.player_id FROM player_identifiers pi \
             WHERE (pi.type, pi.value_hash) IN (SELECT * FROM unnest($1::text[], $2::bytea[]))",
        )
        .bind(&types)
        .bind(&hashes)
        .fetch_all(&mut **tx)
        .await?;
        let players: std::collections::HashMap<(String, Vec<u8>), Uuid> =
            resolved.into_iter().map(|(t, h, p)| ((t, h), p)).collect();

        let local_ids: Vec<Uuid> = fresh.iter().map(|_| Uuid::now_v7()).collect();
        let player_ids: Vec<Option<Uuid>> = fresh
            .iter()
            .map(|p| {
                players
                    .get(&(p.ban.subject_type.clone(), p.subject_hash.clone()))
                    .copied()
            })
            .collect();
        sqlx::query(
            "INSERT INTO bans \
               (id, tenant_id, subject_type, subject_value, subject_hash, player_id, \
                scope, reason, issued_at, expires_at, status, origin) \
             SELECT u.id, $1, u.subject_type, u.subject_value, u.subject_hash, \
                    u.player_id, 'network', u.reason, u.issued_at, u.expires_at, \
                    u.status, 'bm' \
             FROM unnest($2::uuid[], $3::text[], $4::text[], $5::bytea[], $6::uuid[], \
                         $7::text[], $8::timestamptz[], $9::timestamptz[], $10::text[]) \
                  AS u(id, subject_type, subject_value, subject_hash, player_id, \
                       reason, issued_at, expires_at, status)",
        )
        .bind(tenant_id)
        .bind(&local_ids)
        .bind(&types)
        .bind(
            fresh
                .iter()
                .map(|p| p.ban.subject_value.clone())
                .collect::<Vec<_>>(),
        )
        .bind(&hashes)
        .bind(&player_ids)
        .bind(
            fresh
                .iter()
                .map(|p| p.ban.reason.clone())
                .collect::<Vec<_>>(),
        )
        .bind(fresh.iter().map(|p| p.ban.issued_at).collect::<Vec<_>>())
        .bind(fresh.iter().map(|p| p.ban.expires_at).collect::<Vec<_>>())
        .bind(
            fresh
                .iter()
                .map(|p| p.status.to_string())
                .collect::<Vec<_>>(),
        )
        .execute(&mut **tx)
        .await?;

        sqlx::query(
            "INSERT INTO bm_sync_map \
               (tenant_id, entity_type, external_id, local_id, content_hash, meta, \
                bm_seen_at, local_synced_at, last_direction) \
             SELECT $1, 'ban', u.external_id, u.local_id, u.content_hash, u.meta, \
                    now(), now(), 'inbound' \
             FROM unnest($2::text[], $3::uuid[], $4::bytea[], $5::jsonb[]) \
                  AS u(external_id, local_id, content_hash, meta)",
        )
        .bind(tenant_id)
        .bind(
            fresh
                .iter()
                .map(|p| p.ban.external_id.clone())
                .collect::<Vec<_>>(),
        )
        .bind(&local_ids)
        .bind(
            fresh
                .iter()
                .map(|p| p.ban.content_hash.clone())
                .collect::<Vec<_>>(),
        )
        .bind(fresh.iter().map(|p| p.ban.meta.clone()).collect::<Vec<_>>())
        .execute(&mut **tx)
        .await?;
        out.inserted = fresh.len();
    }

    if !changed.is_empty() {
        // Conflict rows FIRST, while the bans row still holds its pre-edit state: BM
        // edited a ban a local operator had revoked; the revoke stands (their most
        // recent explicit action) and the disagreement is logged with both sides'
        // actual snapshots for the review UI.
        let conflicted: Vec<&(&Prepared, Uuid, &str)> = changed
            .iter()
            .filter(|(_, _, local_status)| *local_status == "revoked")
            .collect();
        if !conflicted.is_empty() {
            sqlx::query(
                "INSERT INTO bm_sync_conflicts \
                   (tenant_id, entity_type, external_id, local_id, direction, \
                    local_snapshot, remote_snapshot, resolution) \
                 SELECT $1, 'ban', u.external_id, u.local_id, 'inbound', \
                        jsonb_build_object( \
                            'status', b.status, 'reason', b.reason, \
                            'expires_at', b.expires_at, 'revoked_at', b.revoked_at, \
                            'revoke_reason', b.revoke_reason), \
                        u.remote_snapshot, 'local_won' \
                 FROM unnest($2::text[], $3::uuid[], $4::jsonb[]) \
                      AS u(external_id, local_id, remote_snapshot) \
                 JOIN bans b ON b.id = u.local_id",
            )
            .bind(tenant_id)
            .bind(
                conflicted
                    .iter()
                    .map(|(p, ..)| p.ban.external_id.clone())
                    .collect::<Vec<_>>(),
            )
            .bind(
                conflicted
                    .iter()
                    .map(|(_, local, _)| *local)
                    .collect::<Vec<_>>(),
            )
            .bind(
                conflicted
                    .iter()
                    .map(|(p, ..)| {
                        serde_json::json!({
                            "reason": p.ban.reason,
                            "expires_at": p.ban.expires_at,
                            "meta": p.ban.meta,
                        })
                    })
                    .collect::<Vec<_>>(),
            )
            .execute(&mut **tx)
            .await?;
            out.conflicts = conflicted.len();
        }

        // The subject may have changed (BM-side identifier edit): player_id is
        // re-resolved per row; a stale link would pin the ban to the wrong profile.
        sqlx::query(
            "UPDATE bans b SET \
               subject_type = u.subject_type, subject_value = u.subject_value, \
               subject_hash = u.subject_hash, reason = u.reason, \
               expires_at = u.expires_at, \
               status = CASE WHEN b.status = 'revoked' THEN b.status ELSE u.status END, \
               player_id = (SELECT pi.player_id FROM player_identifiers pi \
                            WHERE pi.type = u.subject_type \
                              AND pi.value_hash = u.subject_hash) \
             FROM unnest($1::uuid[], $2::text[], $3::text[], $4::bytea[], $5::text[], \
                         $6::timestamptz[], $7::text[]) \
                  AS u(local_id, subject_type, subject_value, subject_hash, reason, \
                       expires_at, status) \
             WHERE b.id = u.local_id",
        )
        .bind(
            changed
                .iter()
                .map(|(_, local, _)| *local)
                .collect::<Vec<_>>(),
        )
        .bind(
            changed
                .iter()
                .map(|(p, ..)| p.ban.subject_type.clone())
                .collect::<Vec<_>>(),
        )
        .bind(
            changed
                .iter()
                .map(|(p, ..)| p.ban.subject_value.clone())
                .collect::<Vec<_>>(),
        )
        .bind(
            changed
                .iter()
                .map(|(p, ..)| p.subject_hash.clone())
                .collect::<Vec<_>>(),
        )
        .bind(
            changed
                .iter()
                .map(|(p, ..)| p.ban.reason.clone())
                .collect::<Vec<_>>(),
        )
        .bind(
            changed
                .iter()
                .map(|(p, ..)| p.ban.expires_at)
                .collect::<Vec<_>>(),
        )
        .bind(
            changed
                .iter()
                .map(|(p, ..)| p.status.to_string())
                .collect::<Vec<_>>(),
        )
        .execute(&mut **tx)
        .await?;

        sqlx::query(
            "UPDATE bm_sync_map m SET \
               content_hash = u.content_hash, meta = u.meta, bm_seen_at = now(), \
               local_synced_at = now(), last_direction = 'inbound' \
             FROM unnest($2::text[], $3::bytea[], $4::jsonb[]) \
                  AS u(external_id, content_hash, meta) \
             WHERE m.tenant_id = $1 AND m.entity_type = 'ban' \
               AND m.external_id = u.external_id",
        )
        .bind(tenant_id)
        .bind(
            changed
                .iter()
                .map(|(p, ..)| p.ban.external_id.clone())
                .collect::<Vec<_>>(),
        )
        .bind(
            changed
                .iter()
                .map(|(p, ..)| p.ban.content_hash.clone())
                .collect::<Vec<_>>(),
        )
        .bind(
            changed
                .iter()
                .map(|(p, ..)| p.ban.meta.clone())
                .collect::<Vec<_>>(),
        )
        .execute(&mut **tx)
        .await?;

        out.updated = changed.len();
    }

    Ok(out)
}

/// Stamp `bm_seen_at` for every external id BM returned on a page, INCLUDING ones
/// that failed to map (null attributes, unresolved identifier refs). The delete sweep
/// keys on this stamp: a ban BM still serves must never look absent just because one
/// fetch of it was unmappable.
pub async fn touch_seen_external_ids(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    external_ids: &[String],
) -> Result<(), AppError> {
    if external_ids.is_empty() {
        return Ok(());
    }
    sqlx::query(
        "UPDATE bm_sync_map SET bm_seen_at = now() \
         WHERE tenant_id = $1 AND entity_type = 'ban' AND external_id = ANY($2)",
    )
    .bind(tenant_id)
    .bind(external_ids)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// In-transaction lease check for sync page writes (the import path fences via
/// `save_job_progress`; the sync loops have no job row, so they fence explicitly).
/// `FOR SHARE` holds the connection row until this tx commits, so a takeover's claim
/// UPDATE serializes strictly after our writes instead of racing them.
pub async fn claim_held_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    connection_id: Uuid,
    claimer: &str,
) -> Result<bool, AppError> {
    let held: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM bm_connections WHERE id = $1 AND claimed_by = $2 FOR SHARE",
    )
    .bind(connection_id)
    .bind(claimer)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(held.is_some())
}

/// Delete detection after a COMPLETE re-scan: active bm-origin bans in the scanned
/// lists whose map row was not touched since `scan_start` no longer exist on BM;
/// revoke them locally. Scoped to `scanned_lists` so lists excluded from import never
/// have their bans swept. Returns the revoked (local id, external id) pairs.
pub async fn revoke_bans_absent_from_scan(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    scan_start: DateTime<Utc>,
    scanned_lists: &[String],
) -> Result<Vec<(Uuid, String)>, AppError> {
    let revoked: Vec<(Uuid, String)> = sqlx::query_as(
        "UPDATE bans b SET status = 'revoked', revoked_at = now(), \
           revoke_reason = 'removed in BattleMetrics' \
         FROM bm_sync_map m \
         WHERE m.tenant_id = $1 AND m.entity_type = 'ban' AND m.local_id = b.id \
           AND m.bm_seen_at < $2 AND b.status = 'active' AND b.origin = 'bm' \
           AND m.meta->>'ban_list' = ANY($3) \
         RETURNING b.id, m.external_id",
    )
    .bind(tenant_id)
    .bind(scan_start)
    .bind(scanned_lists)
    .fetch_all(&mut **tx)
    .await?;

    if !revoked.is_empty() {
        sqlx::query(
            "UPDATE bm_sync_map SET local_synced_at = now(), last_direction = 'inbound' \
             WHERE tenant_id = $1 AND entity_type = 'ban' AND external_id = ANY($2)",
        )
        .bind(tenant_id)
        .bind(
            revoked
                .iter()
                .map(|(_, ext)| ext.clone())
                .collect::<Vec<_>>(),
        )
        .execute(&mut **tx)
        .await?;
        // BM deletions are rare; per-row audit entries are fine here.
        for (local_id, external_id) in &revoked {
            crate::domain::audit::record_in_tx(
                tx,
                Some(tenant_id),
                None,
                "ban.revoke",
                Some("ban"),
                Some(*local_id),
                Some(serde_json::json!({ "source": "bm_sync", "external_id": external_id })),
            )
            .await?;
        }
    }
    Ok(revoked)
}

/// Post-scan detection of BM-side deletions of OUR pushed (cupboard-origin) bans. The
/// revoke sweep deliberately skips `origin = 'cupboard'`: a BM admin deleting a ban we
/// pushed is a disagreement, not an authority, so it must never silently revoke the local
/// ban. Instead log an OUTBOUND conflict (`manual_pending`, local snapshot only) for
/// operator review, deduped against any still-open conflict for the same external id.
/// Returns the flagged (local id, external id) pairs.
pub async fn flag_outbound_deletions(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    scan_start: DateTime<Utc>,
    scanned_lists: &[String],
) -> Result<Vec<(Uuid, String)>, AppError> {
    let flagged: Vec<(Option<Uuid>, String)> = sqlx::query_as(
        "INSERT INTO bm_sync_conflicts \
           (tenant_id, entity_type, external_id, local_id, direction, \
            local_snapshot, remote_snapshot, resolution) \
         SELECT $1, 'ban', m.external_id, b.id, 'outbound', \
                jsonb_build_object( \
                    'status', b.status, 'reason', b.reason, \
                    'expires_at', b.expires_at, 'subject_value', b.subject_value), \
                NULL, 'manual_pending' \
         FROM bm_sync_map m JOIN bans b ON b.id = m.local_id \
         WHERE m.tenant_id = $1 AND m.entity_type = 'ban' AND m.bm_seen_at < $2 \
           AND b.status = 'active' AND b.origin = 'cupboard' \
           AND m.meta->>'ban_list' = ANY($3) \
           AND NOT EXISTS (SELECT 1 FROM bm_sync_conflicts c \
                           WHERE c.tenant_id = $1 AND c.entity_type = 'ban' \
                             AND c.external_id = m.external_id AND c.resolved_at IS NULL) \
         RETURNING local_id, external_id",
    )
    .bind(tenant_id)
    .bind(scan_start)
    .bind(scanned_lists)
    .fetch_all(&mut **tx)
    .await?;
    Ok(flagged
        .into_iter()
        .map(|(local, ext)| (local.unwrap_or_default(), ext))
        .collect())
}

// ---------------------------------------------------------------------------
// Sync loop bookkeeping + conflict review

/// Fresh runner-side read of a connection (settings/toggles apply within a tick).
pub async fn fresh_connection(
    owner_pool: &PgPool,
    connection_id: Uuid,
) -> Result<Option<BmConnection>, AppError> {
    let conn = sqlx::query_as::<_, BmConnection>(&format!(
        "SELECT {CONN_COLS} FROM bm_connections WHERE id = $1"
    ))
    .bind(connection_id)
    .fetch_optional(owner_pool)
    .await?;
    Ok(conn)
}

/// Pool variant of the enabled-list enumeration for the sync loops.
pub async fn import_enabled_list_ids_pool(
    owner_pool: &PgPool,
    tenant_id: Uuid,
) -> Result<Vec<String>, AppError> {
    let ids: Vec<(String,)> = sqlx::query_as(
        "SELECT external_id FROM bm_ban_lists \
         WHERE tenant_id = $1 AND import_enabled ORDER BY external_id",
    )
    .bind(tenant_id)
    .fetch_all(owner_pool)
    .await?;
    Ok(ids.into_iter().map(|(id,)| id).collect())
}

/// Stamp a successful sync tick (fenced on the lease). `scan` = the full re-scan,
/// else the tail poll. Only a successful SCAN clears the surfaced error: a healthy
/// 60s tail must not mask a persistently failing 15-minute re-scan.
pub async fn record_sync_tick(
    owner_pool: &PgPool,
    connection_id: Uuid,
    claimer: &str,
    scan: bool,
) -> Result<(), AppError> {
    let set = if scan {
        "last_scan_at = now(), last_tail_at = now(), sync_error = NULL"
    } else {
        "last_tail_at = now()"
    };
    sqlx::query(&format!(
        "UPDATE bm_connections SET {set} WHERE id = $1 AND claimed_by = $2"
    ))
    .bind(connection_id)
    .bind(claimer)
    .execute(owner_pool)
    .await?;
    Ok(())
}

/// `(last_tail_at, last_scan_at)` as persisted.
pub type SyncTimestamps = (Option<DateTime<Utc>>, Option<DateTime<Utc>>);

/// Persisted sync timestamps, for seeding a fresh runner's cadence state: a pod
/// restart must not trigger an immediate full re-scan of every connection.
pub async fn sync_timestamps(
    owner_pool: &PgPool,
    connection_id: Uuid,
) -> Result<SyncTimestamps, AppError> {
    let row: Option<SyncTimestamps> =
        sqlx::query_as("SELECT last_tail_at, last_scan_at FROM bm_connections WHERE id = $1")
            .bind(connection_id)
            .fetch_optional(owner_pool)
            .await?;
    Ok(row.unwrap_or((None, None)))
}

/// Surface a transient sync failure (fenced). Does not flip `status`: the connection
/// itself is fine, one tick failed.
pub async fn record_sync_error(
    owner_pool: &PgPool,
    connection_id: Uuid,
    claimer: &str,
    message: &str,
) -> Result<(), AppError> {
    sqlx::query("UPDATE bm_connections SET sync_error = $3 WHERE id = $1 AND claimed_by = $2")
        .bind(connection_id)
        .bind(claimer)
        .bind(message)
        .execute(owner_pool)
        .await?;
    Ok(())
}

/// Tenant-requested sync settings changes; absent fields keep their value.
#[derive(Debug, Default)]
pub struct SyncChanges {
    pub sync_enabled: Option<bool>,
    pub sync_bans_outbound: Option<bool>,
    pub target_ban_list: Option<String>,
    /// Opt-in (decision O, default off): queue pushes for existing active
    /// Cupboard-origin bans when enabling outbound.
    pub backfill_existing: bool,
    /// Import subset gates (default on when absent from settings).
    pub import_servers: Option<bool>,
    pub import_players: Option<bool>,
    pub import_notes: Option<bool>,
}

/// Apply sync settings. Outbound requires a valid writable target list (owned, or
/// subscribed with owner-granted create permission). Returns the updated view and
/// how many backfill ops were queued.
pub async fn update_sync_settings(
    app_pool: &PgPool,
    tenant: TenantId,
    actor: Uuid,
    changes: SyncChanges,
) -> Result<(ConnectionView, u64), AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let current: Option<(Uuid, serde_json::Value, bool, bool, String)> = sqlx::query_as(
        "SELECT id, settings, sync_enabled, sync_bans_outbound, status FROM bm_connections \
         WHERE tenant_id = $1 FOR UPDATE",
    )
    .bind(tenant.0)
    .fetch_optional(&mut *tx)
    .await?;
    let (_, mut settings, cur_enabled, cur_outbound, conn_status) = current.ok_or_else(|| {
        AppError::NotFound("no BattleMetrics connection; connect a token first".into())
    })?;

    // Enabling sync on an errored/disabled connection would persist the toggle while
    // claim_ready (rightly) never picks it up: reject loudly instead of no-opping.
    let enabling = changes.sync_enabled == Some(true) || changes.sync_bans_outbound == Some(true);
    if enabling && conn_status != "connected" {
        return Err(AppError::BadRequest(format!(
            "the connection is {conn_status}; reconnect with a valid token before enabling sync"
        )));
    }

    if let Some(list) = &changes.target_ban_list {
        let perms: Option<(bool, bool)> = sqlx::query_as(
            "SELECT subscribed, perm_create FROM bm_ban_lists \
             WHERE tenant_id = $1 AND external_id = $2",
        )
        .bind(tenant.0)
        .bind(list)
        .fetch_optional(&mut *tx)
        .await?;
        match perms {
            None => {
                return Err(AppError::BadRequest(
                    "unknown ban list; run an import first".into(),
                ))
            }
            Some((true, false)) => {
                return Err(AppError::BadRequest(
                    "the list owner has not granted create permission on that list".into(),
                ))
            }
            _ => {}
        }
        settings["target_ban_list"] = serde_json::json!(list);
    }
    for (key, value) in [
        ("import_servers", changes.import_servers),
        ("import_players", changes.import_players),
        ("import_notes", changes.import_notes),
    ] {
        if let Some(v) = value {
            settings[key] = serde_json::json!(v);
        }
    }

    let mut sync_enabled = changes.sync_enabled.unwrap_or(cur_enabled);
    let mut outbound = changes.sync_bans_outbound.unwrap_or(cur_outbound);
    // Invariant: outbound implies sync_enabled (the runner, claim, and enqueue paths
    // all key on sync_enabled; outbound without it would queue ops nothing drains).
    // Enabling outbound switches sync on; disabling sync switches outbound off.
    if outbound && !sync_enabled {
        if changes.sync_bans_outbound == Some(true) {
            sync_enabled = true;
        } else {
            outbound = false;
        }
    }
    if outbound {
        let has_target = settings
            .get("target_ban_list")
            .and_then(|v| v.as_str())
            .is_some();
        if !has_target {
            return Err(AppError::BadRequest(
                "choose a target ban list before enabling outbound sync".into(),
            ));
        }
    }

    let view = sqlx::query_as::<_, ConnectionView>(&format!(
        "UPDATE bm_connections SET sync_enabled = $2, sync_bans_outbound = $3, \
         settings = $4, updated_at = now() WHERE tenant_id = $1 RETURNING {VIEW_COLS}"
    ))
    .bind(tenant.0)
    .bind(sync_enabled)
    .bind(outbound)
    .bind(&settings)
    .fetch_one(&mut *tx)
    .await?;

    let backfilled = if changes.backfill_existing && outbound {
        enqueue_backfill(&mut tx, tenant).await?
    } else {
        0
    };

    crate::domain::audit::record_in_tx(
        &mut tx,
        Some(tenant.0),
        Some(actor),
        "integrations.bm.sync.settings",
        Some("bm_connection"),
        Some(view.id),
        Some(serde_json::json!({
            "sync_enabled": sync_enabled,
            "sync_bans_outbound": outbound,
            "target_ban_list": settings.get("target_ban_list"),
            "backfilled": backfilled,
        })),
    )
    .await?;
    tx.commit().await?;
    Ok((view, backfilled))
}

// ---------------------------------------------------------------------------
// Outbound outbox (decision J)

/// A drained-side outbox row.
#[derive(Debug, sqlx::FromRow)]
pub struct OutboxOp {
    pub id: Uuid,
    pub local_id: Uuid,
    pub op: String,
    pub payload: serde_json::Value,
    pub status: String,
    pub attempts: i32,
}

/// Enqueue the outbound push for a just-created Cupboard ban, in the caller's tx.
/// No-op unless the tenant has outbound sync on. Unsupported subjects land as
/// `abandoned` rows (visible on the status page) rather than vanishing silently.
pub async fn enqueue_outbound_create(
    tx: &mut Transaction<'_, Postgres>,
    tenant: TenantId,
    ban: &crate::domain::bans::Ban,
) -> Result<(), AppError> {
    if !outbound_enabled(tx, tenant).await? {
        return Ok(());
    }
    let supported = ban.subject_type == "steam";
    let payload = serde_json::json!({
        "subject_type": ban.subject_type,
        "subject_value": ban.subject_value,
        "reason": ban.reason,
        "expires_at": ban.expires_at,
        "scope": ban.scope,
        "server_id": ban.server_id,
    });
    sqlx::query(
        "INSERT INTO bm_outbox (tenant_id, local_id, op, payload, status, last_error) \
         VALUES ($1, $2, 'create', $3, $4, $5)",
    )
    .bind(tenant.0)
    .bind(ban.id)
    .bind(&payload)
    .bind(if supported { "pending" } else { "abandoned" })
    .bind(if supported {
        None
    } else {
        Some("only steam-subject bans sync to BattleMetrics today")
    })
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Enqueue the outbound unban for a just-revoked ban, in the caller's tx. Applies to
/// every origin: revoking an imported ban must also remove it on BM (decision I; the
/// drain resolves the external id through the sync map either way).
pub async fn enqueue_outbound_delete(
    tx: &mut Transaction<'_, Postgres>,
    tenant: TenantId,
    ban_id: Uuid,
) -> Result<(), AppError> {
    if !outbound_enabled(tx, tenant).await? {
        return Ok(());
    }
    sqlx::query("INSERT INTO bm_outbox (tenant_id, local_id, op) VALUES ($1, $2, 'delete')")
        .bind(tenant.0)
        .bind(ban_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn outbound_enabled(
    tx: &mut Transaction<'_, Postgres>,
    tenant: TenantId,
) -> Result<bool, AppError> {
    // FOR SHARE serializes against update_sync_settings' FOR UPDATE: a ban created
    // concurrently with enable-outbound-plus-backfill either blocks until the toggle
    // commits (and enqueues itself) or commits first (and the backfill picks it up).
    // A plain read could thread between the backfill snapshot and the toggle commit,
    // silently losing the ban from both paths.
    //
    // Deliberately NOT gated on status = 'connected': enqueueing while the connection is
    // token-errored is exactly what the outbox is FOR. The op waits `pending` until a
    // healthy runner (post-reconnect) drains it. Dropping it here would silently lose a
    // staff ban/unban with no path to ever push it, contradicting the degradation matrix.
    let on: Option<bool> = sqlx::query_scalar(
        "SELECT sync_bans_outbound FROM bm_connections \
         WHERE tenant_id = $1 AND sync_enabled FOR SHARE",
    )
    .bind(tenant.0)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(on.unwrap_or(false))
}

/// The not-yet-settled create op for a ban, if any (a revoke must supersede it; see
/// the drain's ordering discipline).
pub async fn unsettled_create_for(
    owner_pool: &PgPool,
    tenant_id: Uuid,
    local_id: Uuid,
) -> Result<Option<OutboxOp>, AppError> {
    let op = sqlx::query_as::<_, OutboxOp>(
        "SELECT id, local_id, op, payload, status, attempts FROM bm_outbox \
         WHERE tenant_id = $1 AND local_id = $2 AND op = 'create' \
           AND status IN ('pending', 'inflight', 'needs_verify') \
         ORDER BY created_at ASC LIMIT 1",
    )
    .bind(tenant_id)
    .bind(local_id)
    .fetch_optional(owner_pool)
    .await?;
    Ok(op)
}

/// External ids among `candidates` already mapped to a DIFFERENT local ban, keyed to that
/// other `local_id`. The verify pass must never blindly adopt those (it would violate the
/// map's uniqueness and wedge the op); instead it inspects the other ban to decide between
/// leaving it alone and merging an inbound-race duplicate.
pub async fn externally_mapped_local_ids(
    owner_pool: &PgPool,
    tenant_id: Uuid,
    local_id: Uuid,
    candidates: &[String],
) -> Result<std::collections::HashMap<String, Uuid>, AppError> {
    if candidates.is_empty() {
        return Ok(Default::default());
    }
    let rows: Vec<(String, Uuid)> = sqlx::query_as(
        "SELECT external_id, local_id FROM bm_sync_map \
         WHERE tenant_id = $1 AND entity_type = 'ban' AND external_id = ANY($2) \
           AND local_id <> $3",
    )
    .bind(tenant_id)
    .bind(candidates)
    .bind(local_id)
    .fetch_all(owner_pool)
    .await?;
    Ok(rows.into_iter().collect())
}

/// The inbound-race merge: our ambiguous create actually landed as BM ban `external_id`,
/// but the tail poll imported it as a fresh bm-origin ban `interloper_local_id` before the
/// verify ran, so the verify sees the landed ban already mapped elsewhere. When the
/// interloper is genuinely the duplicate (origin `bm`, same `subject_hash` as our op's ban
/// `op_local_id`), repoint the map row to our ban (stamped as an outbound adoption with the
/// echo-guard hash/meta), revoke the interloper, and report success so the drain finishes
/// the op `done` instead of re-issuing the create. Fenced on the lease; `Ok(false)` = fence
/// miss OR not the race artifact (the caller must re-issue normally, or stop on a fence
/// miss (it distinguishes via the returned reason).
#[allow(clippy::too_many_arguments)]
pub async fn merge_outbound_race(
    owner_pool: &PgPool,
    tenant_id: Uuid,
    connection_id: Uuid,
    claimer: &str,
    op_local_id: Uuid,
    interloper_local_id: Uuid,
    external_id: &str,
    content_hash: &[u8],
    meta: &serde_json::Value,
) -> Result<MergeOutcome, AppError> {
    let mut tx = owner_pool.begin().await?;
    // Hold the connection row so a takeover serializes after this merge, matching the
    // per-page fence discipline.
    let held: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM bm_connections WHERE id = $1 AND claimed_by = $2 FOR SHARE",
    )
    .bind(connection_id)
    .bind(claimer)
    .fetch_optional(&mut *tx)
    .await?;
    if held.is_none() {
        tx.rollback().await?;
        return Ok(MergeOutcome::FenceMiss);
    }
    // Confirm the interloper really is a bm-origin duplicate of our ban (same subject).
    let is_dup: bool = sqlx::query_scalar(
        "SELECT EXISTS( \
           SELECT 1 FROM bans dup JOIN bans ours ON ours.id = $2 AND ours.tenant_id = $1 \
           WHERE dup.id = $3 AND dup.tenant_id = $1 AND dup.origin = 'bm' \
             AND dup.subject_hash = ours.subject_hash)",
    )
    .bind(tenant_id)
    .bind(op_local_id)
    .bind(interloper_local_id)
    .fetch_one(&mut *tx)
    .await?;
    if !is_dup {
        tx.rollback().await?;
        return Ok(MergeOutcome::NotDuplicate);
    }
    // Repoint the map row from the interloper to our ban (the echo guard now points at
    // OUR local ban). The interloper drops its map association and is revoked below.
    sqlx::query(
        "UPDATE bm_sync_map SET local_id = $3, content_hash = $4, meta = $5, \
           bm_seen_at = now(), local_synced_at = now(), last_direction = 'outbound' \
         WHERE tenant_id = $1 AND entity_type = 'ban' AND external_id = $2",
    )
    .bind(tenant_id)
    .bind(external_id)
    .bind(op_local_id)
    .bind(content_hash)
    .bind(meta)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE bans SET status = 'revoked', revoked_at = now(), \
           revoke_reason = 'merged into outbound push' \
         WHERE id = $1 AND tenant_id = $2 AND status <> 'revoked'",
    )
    .bind(interloper_local_id)
    .bind(tenant_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(MergeOutcome::Merged)
}

/// Outcome of [`merge_outbound_race`].
#[derive(Debug, PartialEq, Eq)]
pub enum MergeOutcome {
    /// The interloper was the race duplicate: merged, op is done.
    Merged,
    /// The other ban is not our duplicate: re-issue the create normally.
    NotDuplicate,
    /// The lease was taken over: stop the drain.
    FenceMiss,
}

/// Due outbox work, oldest first (create-then-revoke of one ban must stay ordered).
/// `inflight` rows come back once their lease (`next_attempt_at`) lapses: a crash
/// mid-send must not strand an op.
pub async fn due_outbox_ops(
    owner_pool: &PgPool,
    tenant_id: Uuid,
    limit: i64,
) -> Result<Vec<OutboxOp>, AppError> {
    let ops = sqlx::query_as::<_, OutboxOp>(
        "SELECT id, local_id, op, payload, status, attempts FROM bm_outbox \
         WHERE tenant_id = $1 AND status IN ('pending', 'needs_verify', 'inflight') \
           AND next_attempt_at <= now() \
         ORDER BY created_at ASC LIMIT $2",
    )
    .bind(tenant_id)
    .bind(limit)
    .fetch_all(owner_pool)
    .await?;
    Ok(ops)
}

/// Fence fragment shared by every outbox write: the op's connection must still be leased
/// to this claimer. A stale runner whose push outlived the 10-minute inflight lease must
/// not overwrite the new owner's settled status or double-push a create.
const OUTBOX_CLAIM_FENCE: &str = "EXISTS (SELECT 1 FROM bm_connections c \
     WHERE c.id = $CONN AND c.claimed_by = $CLAIMER)";

/// Claim one op for a push attempt: `inflight` with a 10-minute lease, so a crashed
/// drain surfaces the op again instead of stranding it. Fenced on the connection
/// lease and on the op still being drainable: a stale runner resuming after a
/// takeover must not flip a settled op back and double-push it. Also pins the list this
/// attempt targets (`attempted_list`, set once and preserved across retries) so a verify
/// after a retarget still existence-checks the ORIGINAL list. `false` = stop draining.
pub async fn mark_outbox_inflight(
    owner_pool: &PgPool,
    id: Uuid,
    connection_id: Uuid,
    claimer: &str,
    target_list: &str,
) -> Result<bool, AppError> {
    let res = sqlx::query(
        "UPDATE bm_outbox SET status = 'inflight', attempts = attempts + 1, \
         next_attempt_at = now() + interval '10 minutes', \
         payload = jsonb_set(payload, '{attempted_list}', \
                             to_jsonb(COALESCE(payload->>'attempted_list', $4::text))) \
         WHERE id = $1 AND status IN ('pending', 'needs_verify', 'inflight') \
           AND EXISTS (SELECT 1 FROM bm_connections c \
                       WHERE c.id = $2 AND c.claimed_by = $3)",
    )
    .bind(id)
    .bind(connection_id)
    .bind(claimer)
    .bind(target_list)
    .execute(owner_pool)
    .await?;
    Ok(res.rows_affected() == 1)
}

/// Settle an op after a push attempt, fenced on the lease. `retry_in` schedules the next
/// attempt for non-terminal statuses. `false` = fence miss (lease taken over): the caller
/// must stop the drain and leave the op for the new owner.
pub async fn finish_outbox_op(
    owner_pool: &PgPool,
    id: Uuid,
    connection_id: Uuid,
    claimer: &str,
    status: &str,
    error: Option<&str>,
    retry_in: Option<std::time::Duration>,
) -> Result<bool, AppError> {
    let res = sqlx::query(&format!(
        "UPDATE bm_outbox SET status = $2, last_error = $3, \
         next_attempt_at = now() + make_interval(secs => $4) \
         WHERE id = $1 AND {}",
        OUTBOX_CLAIM_FENCE
            .replace("$CONN", "$5")
            .replace("$CLAIMER", "$6")
    ))
    .bind(id)
    .bind(status)
    .bind(error)
    .bind(retry_in.map(|d| d.as_secs_f64()).unwrap_or(0.0))
    .bind(connection_id)
    .bind(claimer)
    .execute(owner_pool)
    .await?;
    Ok(res.rows_affected() == 1)
}

/// Record a successfully pushed ban in the sync map (the echo guard: the inbound
/// loops skip records whose hash matches what we wrote), fenced on the lease. Upserts
/// on `local_id`: a verify-then-push retry may find a row already recorded. `false` =
/// fence miss (lease taken over): the caller stops the drain.
#[allow(clippy::too_many_arguments)]
pub async fn record_outbound_ban(
    owner_pool: &PgPool,
    tenant_id: Uuid,
    connection_id: Uuid,
    claimer: &str,
    local_id: Uuid,
    external_id: &str,
    content_hash: &[u8],
    meta: &serde_json::Value,
) -> Result<bool, AppError> {
    let res = sqlx::query(&format!(
        "INSERT INTO bm_sync_map \
           (tenant_id, entity_type, external_id, local_id, content_hash, meta, \
            bm_seen_at, local_synced_at, last_direction) \
         SELECT $1, 'ban', $2, $3, $4, $5, now(), now(), 'outbound' \
         WHERE {} \
         ON CONFLICT (tenant_id, entity_type, local_id) DO UPDATE SET \
           external_id = EXCLUDED.external_id, content_hash = EXCLUDED.content_hash, \
           meta = EXCLUDED.meta, bm_seen_at = now(), local_synced_at = now(), \
           last_direction = 'outbound'",
        OUTBOX_CLAIM_FENCE
            .replace("$CONN", "$6")
            .replace("$CLAIMER", "$7")
    ))
    .bind(tenant_id)
    .bind(external_id)
    .bind(local_id)
    .bind(content_hash)
    .bind(meta)
    .bind(connection_id)
    .bind(claimer)
    .execute(owner_pool)
    .await?;
    Ok(res.rows_affected() == 1)
}

/// Refresh the stored hash after an outbound edit-shaped push (the expire-now
/// fallback), so the next re-scan sees it as an echo, not a BM edit. Fenced on the
/// lease; `false` = fence miss (lease taken over).
pub async fn update_outbound_hash(
    owner_pool: &PgPool,
    tenant_id: Uuid,
    connection_id: Uuid,
    claimer: &str,
    local_id: Uuid,
    content_hash: &[u8],
) -> Result<bool, AppError> {
    let res = sqlx::query(&format!(
        "UPDATE bm_sync_map SET content_hash = $3, local_synced_at = now(), \
           last_direction = 'outbound' \
         WHERE tenant_id = $1 AND entity_type = 'ban' AND local_id = $2 AND {}",
        OUTBOX_CLAIM_FENCE
            .replace("$CONN", "$4")
            .replace("$CLAIMER", "$5")
    ))
    .bind(tenant_id)
    .bind(local_id)
    .bind(content_hash)
    .bind(connection_id)
    .bind(claimer)
    .execute(owner_pool)
    .await?;
    Ok(res.rows_affected() == 1)
}

/// The BM server id a local fleet server maps to, if the server-import phase mapped it.
/// A server-scoped outbound ban uses this to send a `server` relationship instead of
/// escalating to an org-wide ban.
pub async fn server_external_id(
    owner_pool: &PgPool,
    tenant_id: Uuid,
    local_server_id: Uuid,
) -> Result<Option<String>, AppError> {
    let ext: Option<String> = sqlx::query_scalar(
        "SELECT external_id FROM bm_sync_map \
         WHERE tenant_id = $1 AND entity_type = 'server' AND local_id = $2",
    )
    .bind(tenant_id)
    .bind(local_server_id)
    .fetch_optional(owner_pool)
    .await?;
    Ok(ext)
}

/// The BM ban id for a local ban, if it was ever mapped (imported or pushed).
pub async fn external_ban_id(
    owner_pool: &PgPool,
    tenant_id: Uuid,
    local_id: Uuid,
) -> Result<Option<String>, AppError> {
    let ext: Option<String> = sqlx::query_scalar(
        "SELECT external_id FROM bm_sync_map \
         WHERE tenant_id = $1 AND entity_type = 'ban' AND local_id = $2",
    )
    .bind(tenant_id)
    .bind(local_id)
    .fetch_optional(owner_pool)
    .await?;
    Ok(ext)
}

/// Inputs for recomputing the echo-guard hash after an expire-now fallback: the local
/// reason plus the map meta (identifiers array + note, as BM holds them).
pub async fn outbound_fallback_inputs(
    owner_pool: &PgPool,
    tenant_id: Uuid,
    local_id: Uuid,
) -> Result<Option<(Option<String>, serde_json::Value)>, AppError> {
    let row: Option<(Option<String>, serde_json::Value)> = sqlx::query_as(
        "SELECT b.reason, m.meta FROM bans b \
         JOIN bm_sync_map m ON m.tenant_id = b.tenant_id AND m.entity_type = 'ban' \
           AND m.local_id = b.id \
         WHERE b.tenant_id = $1 AND b.id = $2",
    )
    .bind(tenant_id)
    .bind(local_id)
    .fetch_optional(owner_pool)
    .await?;
    Ok(row)
}

/// Requeue terminally-failed outbox ops (request path): reset `failed` rows to
/// `pending`, due now, attempt counter cleared, so a healthy runner drains them after a
/// BM outage that outlasted the retry window. Returns how many were requeued.
pub async fn retry_failed_outbox(
    app_pool: &PgPool,
    tenant: TenantId,
    actor: Uuid,
) -> Result<u64, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let requeued = sqlx::query(
        "UPDATE bm_outbox SET status = 'pending', attempts = 0, next_attempt_at = now(), \
           last_error = NULL \
         WHERE tenant_id = $1 AND status = 'failed'",
    )
    .bind(tenant.0)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    crate::domain::audit::record_in_tx(
        &mut tx,
        Some(tenant.0),
        Some(actor),
        "integrations.bm.outbox.retry",
        Some("bm_connection"),
        None,
        Some(serde_json::json!({ "requeued": requeued })),
    )
    .await?;
    tx.commit().await?;
    Ok(requeued)
}

/// Opportunistic outbox hygiene (owner pool): drop long-settled `done` rows so the table
/// does not grow one row per ban create/revoke forever. Best-effort, called at most once
/// per drain. Returns how many rows were pruned.
pub async fn prune_done_outbox(owner_pool: &PgPool, tenant_id: Uuid) -> Result<u64, AppError> {
    let pruned = sqlx::query(
        "DELETE FROM bm_outbox \
         WHERE tenant_id = $1 AND status = 'done' AND created_at < now() - interval '7 days'",
    )
    .bind(tenant_id)
    .execute(owner_pool)
    .await?
    .rows_affected();
    Ok(pruned)
}

/// Opt-in backfill (decision O): queue pushes for active, steam-subject, non-BM
/// bans that were never mapped. Returns how many were queued.
pub async fn enqueue_backfill(
    tx: &mut Transaction<'_, Postgres>,
    tenant: TenantId,
) -> Result<u64, AppError> {
    let res = sqlx::query(
        "INSERT INTO bm_outbox (tenant_id, local_id, op, payload) \
         SELECT b.tenant_id, b.id, 'create', jsonb_build_object( \
             'subject_type', b.subject_type, 'subject_value', b.subject_value, \
             'reason', b.reason, 'expires_at', b.expires_at, 'scope', b.scope, \
             'server_id', b.server_id) \
         FROM bans b \
         WHERE b.tenant_id = $1 AND b.status = 'active' AND b.origin <> 'bm' \
           AND b.subject_type = 'steam' \
           AND NOT EXISTS (SELECT 1 FROM bm_sync_map m WHERE m.tenant_id = b.tenant_id \
                             AND m.entity_type = 'ban' AND m.local_id = b.id) \
           AND NOT EXISTS (SELECT 1 FROM bm_outbox o WHERE o.tenant_id = b.tenant_id \
                             AND o.local_id = b.id AND o.op = 'create' \
                             AND o.status IN ('pending', 'inflight', 'needs_verify'))",
    )
    .bind(tenant.0)
    .execute(&mut **tx)
    .await?;
    Ok(res.rows_affected())
}

/// Outbox queue depths for the status page.
#[derive(Debug, Default, serde::Serialize)]
pub struct OutboxSummary {
    pub pending: i64,
    pub needs_verify: i64,
    pub failed: i64,
    pub abandoned: i64,
}

/// Health facts for the status payload: whether ANY import ever completed (the
/// wizard's sync-step unlock; the latest job alone misleads after a failed re-run)
/// and how many conflicts still await review (the list is windowed; the count is not).
pub async fn sync_health_counts(
    app_pool: &PgPool,
    tenant: TenantId,
) -> Result<(bool, i64), AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let has_completed_import: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM bm_import_jobs WHERE tenant_id = $1 \
           AND status = 'completed')",
    )
    .bind(tenant.0)
    .fetch_one(&mut *tx)
    .await?;
    let unresolved_conflicts: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM bm_sync_conflicts WHERE tenant_id = $1 AND resolved_at IS NULL",
    )
    .bind(tenant.0)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok((has_completed_import, unresolved_conflicts))
}

pub async fn outbox_summary(
    app_pool: &PgPool,
    tenant: TenantId,
) -> Result<OutboxSummary, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT status, count(*) FROM bm_outbox \
         WHERE tenant_id = $1 AND status <> 'done' GROUP BY status",
    )
    .bind(tenant.0)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    let mut summary = OutboxSummary::default();
    for (status, count) in rows {
        match status.as_str() {
            "pending" | "inflight" => summary.pending += count,
            "needs_verify" => summary.needs_verify += count,
            "failed" => summary.failed += count,
            "abandoned" => summary.abandoned += count,
            _ => {}
        }
    }
    Ok(summary)
}

#[derive(Debug, sqlx::FromRow, serde::Serialize)]
pub struct ConflictView {
    pub id: Uuid,
    pub entity_type: String,
    pub external_id: String,
    pub local_id: Option<Uuid>,
    pub direction: String,
    pub local_snapshot: Option<serde_json::Value>,
    pub remote_snapshot: Option<serde_json::Value>,
    pub resolution: String,
    pub created_at: DateTime<Utc>,
}

/// Resolve a logged sync conflict. `keep_local` acknowledges it (the automatic
/// local-won outcome stands); `accept_remote` re-applies BM's side to the local ban:
/// the revoke is lifted and the remote reason/expiry take effect. No outbox op is
/// enqueued: the ban already exists on BM (the conflict CAME from a BM edit).
pub async fn resolve_conflict(
    app_pool: &PgPool,
    tenant: TenantId,
    actor: Uuid,
    conflict_id: Uuid,
    choice: &str,
) -> Result<ConflictView, AppError> {
    let resolution = match choice {
        "keep_local" => "manual_resolved",
        "accept_remote" => "remote_won",
        _ => return Err(AppError::BadRequest("unknown resolution choice".into())),
    };
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let conflict = sqlx::query_as::<_, ConflictView>(
        "UPDATE bm_sync_conflicts SET resolution = $3, resolved_by = $4, resolved_at = now() \
         WHERE id = $1 AND tenant_id = $2 AND resolved_at IS NULL \
         RETURNING id, entity_type, external_id, local_id, direction, local_snapshot, \
                   remote_snapshot, resolution, created_at",
    )
    .bind(conflict_id)
    .bind(tenant.0)
    .bind(resolution)
    .bind(actor)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::NotFound("no unresolved conflict with that id".into()))?;

    if conflict.entity_type == "ban" {
        if let Some(local_id) = conflict.local_id {
            match (conflict.direction.as_str(), choice) {
                // INBOUND (BM edited a locally-revoked ban): accepting the remote side
                // lifts the revoke. The ban row already carries BM's CURRENT fields
                // (apply_ban_page wrote them when it logged the conflict, and again for
                // any later BM edits); only the revoke stood. Re-applying the conflict's
                // frozen snapshot would resurrect stale values the echo-guard hash
                // (already matching BM's current content) would never let a re-scan
                // repair, so just lift the revoke and recompute status from the expiry.
                ("inbound", "accept_remote") => {
                    sqlx::query(
                        "UPDATE bans SET \
                           status = CASE WHEN expires_at IS NOT NULL AND expires_at <= now() \
                                         THEN 'expired' ELSE 'active' END, \
                           revoked_by = NULL, revoked_at = NULL, revoke_reason = NULL \
                         WHERE id = $1 AND tenant_id = $2 AND status = 'revoked'",
                    )
                    .bind(local_id)
                    .bind(tenant.0)
                    .execute(&mut *tx)
                    .await?;
                    // The original revoke also queued a delete op. Left alone, it would
                    // drain and delete the just-reactivated ban on BM, and the next
                    // re-scan sweep would re-revoke it locally, silently undoing this
                    // resolution. Abandon those unsettled deletes.
                    sqlx::query(
                        "UPDATE bm_outbox SET status = 'abandoned', next_attempt_at = now(), \
                           last_error = 'superseded by conflict resolution' \
                         WHERE tenant_id = $1 AND local_id = $2 AND op = 'delete' \
                           AND status IN ('pending', 'inflight', 'needs_verify')",
                    )
                    .bind(tenant.0)
                    .bind(local_id)
                    .execute(&mut *tx)
                    .await?;
                }
                // OUTBOUND (BM deleted a ban we pushed): keeping local re-pushes it.
                ("outbound", "keep_local") => {
                    sqlx::query(
                        "INSERT INTO bm_outbox (tenant_id, local_id, op, payload) \
                         SELECT b.tenant_id, b.id, 'create', jsonb_build_object( \
                             'subject_type', b.subject_type, 'subject_value', b.subject_value, \
                             'reason', b.reason, 'expires_at', b.expires_at, 'scope', b.scope, \
                             'server_id', b.server_id) \
                         FROM bans b \
                         WHERE b.id = $1 AND b.tenant_id = $2 AND b.status = 'active'",
                    )
                    .bind(local_id)
                    .bind(tenant.0)
                    .execute(&mut *tx)
                    .await?;
                }
                // OUTBOUND accept-remote: honor BM's removal by revoking locally.
                ("outbound", "accept_remote") => {
                    sqlx::query(
                        "UPDATE bans SET status = 'revoked', revoked_by = $3, \
                           revoked_at = now(), \
                           revoke_reason = 'removed in BattleMetrics, accepted by operator' \
                         WHERE id = $1 AND tenant_id = $2 AND status = 'active'",
                    )
                    .bind(local_id)
                    .bind(tenant.0)
                    .bind(actor)
                    .execute(&mut *tx)
                    .await?;
                }
                _ => {}
            }
        }
    }

    crate::domain::audit::record_in_tx(
        &mut tx,
        Some(tenant.0),
        Some(actor),
        "integrations.bm.conflict.resolve",
        Some("bm_sync_conflict"),
        Some(conflict.id),
        Some(serde_json::json!({ "choice": choice })),
    )
    .await?;
    tx.commit().await?;
    Ok(conflict)
}

pub async fn list_conflicts(
    app_pool: &PgPool,
    tenant: TenantId,
) -> Result<Vec<ConflictView>, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let conflicts = sqlx::query_as::<_, ConflictView>(
        "SELECT id, entity_type, external_id, local_id, direction, local_snapshot, \
                remote_snapshot, resolution, created_at \
         FROM bm_sync_conflicts WHERE tenant_id = $1 \
         ORDER BY (resolved_at IS NULL) DESC, created_at DESC LIMIT 100",
    )
    .bind(tenant.0)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(conflicts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::OnceCell;

    static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
    static MIGRATED: OnceCell<()> = OnceCell::const_new();

    async fn setup() -> Option<PgPool> {
        let url = std::env::var("TEST_DATABASE_URL").ok()?;
        let pool = cupboard_db::connect_scoped(&url, 5, "identity,public")
            .await
            .expect("connect");
        MIGRATED
            .get_or_init(|| async {
                sqlx::query("CREATE SCHEMA IF NOT EXISTS identity")
                    .execute(&pool)
                    .await
                    .expect("schema");
                MIGRATOR.run(&pool).await.expect("migrate");
            })
            .await;
        Some(pool)
    }

    async fn connect_tenant(pool: &PgPool, tenant: TenantId) -> ConnectionView {
        upsert_connection(
            pool,
            tenant,
            Uuid::new_v4(),
            NewConnection {
                bm_org_id: "12345".into(),
                token_enc: vec![1, 2, 3],
                token_dek: vec![4, 5, 6],
            },
        )
        .await
        .expect("connect")
    }

    fn imported_ban(external_id: &str, subject: &str, reason: &str) -> ImportedBan {
        ImportedBan {
            external_id: external_id.into(),
            subject_type: "steam".into(),
            subject_value: subject.into(),
            reason: Some(reason.into()),
            issued_at: Utc::now(),
            expires_at: None,
            content_hash: cupboard_bmapi::ban_content_hash(
                Some(reason),
                None,
                &[("steamID".into(), subject.into())],
                None,
            ),
            meta: serde_json::json!({ "ban_list": "list-1" }),
        }
    }

    #[tokio::test]
    async fn connection_upsert_replaces_and_resets_status() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP connection_upsert_replaces_and_resets_status: TEST_DATABASE_URL unset");
            return;
        };
        let tenant = TenantId(Uuid::new_v4());
        let first = connect_tenant(&pool, tenant).await;
        sqlx::query("UPDATE bm_connections SET status = 'error', last_error = 'x' WHERE id = $1")
            .bind(first.id)
            .execute(&pool)
            .await
            .unwrap();

        let second = connect_tenant(&pool, tenant).await;
        assert_eq!(second.id, first.id, "one connection per tenant");
        assert_eq!(second.status, "connected", "reconnect resets status");
        assert!(second.last_error.is_none());
    }

    #[tokio::test]
    async fn only_one_live_import_job() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP only_one_live_import_job: TEST_DATABASE_URL unset");
            return;
        };
        let tenant = TenantId(Uuid::new_v4());
        connect_tenant(&pool, tenant).await;
        let actor = Uuid::new_v4();
        enqueue_import(&pool, tenant, actor).await.expect("first");
        let err = enqueue_import(&pool, tenant, actor)
            .await
            .expect_err("second live job must be rejected");
        assert!(matches!(err, AppError::BadRequest(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn claim_heartbeat_release_cycle() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP claim_heartbeat_release_cycle: TEST_DATABASE_URL unset");
            return;
        };
        let tenant = TenantId(Uuid::new_v4());
        connect_tenant(&pool, tenant).await;
        enqueue_import(&pool, tenant, Uuid::new_v4())
            .await
            .expect("enqueue");

        // Large limit: the shared test DB accumulates claimable connections from
        // other suites/runs, and ours must be inside the batch.
        let mine = claim_ready(&pool, "runner-a", 1000).await.expect("claim");
        let conn = mine
            .iter()
            .find(|c| c.tenant_id == tenant.0)
            .expect("claimed our connection");

        // Another claimer can't steal a fresh claim...
        let stolen = claim_ready(&pool, "runner-b", 1000).await.expect("claim2");
        assert!(
            !stolen.iter().any(|c| c.id == conn.id),
            "fresh claim must not be taken over"
        );
        // ...and the loser's heartbeat correctly reports not-owned.
        assert!(!heartbeat(&pool, conn.id, "runner-b").await.unwrap());
        assert!(heartbeat(&pool, conn.id, "runner-a").await.unwrap());

        // Stale heartbeat = takeover allowed.
        sqlx::query(
            "UPDATE bm_connections SET heartbeat_at = now() - interval '10 minutes' WHERE id = $1",
        )
        .bind(conn.id)
        .execute(&pool)
        .await
        .unwrap();
        let stolen = claim_ready(&pool, "runner-b", 1000).await.expect("claim3");
        assert!(
            stolen.iter().any(|c| c.id == conn.id),
            "stale claim must be taken over"
        );
        // Original owner's heartbeat now fails: it must stop.
        assert!(!heartbeat(&pool, conn.id, "runner-a").await.unwrap());

        release_claim(&pool, conn.id, "runner-b").await.unwrap();
        let row: (Option<String>,) =
            sqlx::query_as("SELECT claimed_by FROM bm_connections WHERE id = $1")
                .bind(conn.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(row.0.is_none());
    }

    #[tokio::test]
    async fn imported_ban_upsert_is_idempotent_and_detects_change() {
        let Some(pool) = setup().await else {
            eprintln!(
                "SKIP imported_ban_upsert_is_idempotent_and_detects_change: TEST_DATABASE_URL unset"
            );
            return;
        };
        let tenant = TenantId(Uuid::new_v4());
        let pepper = b"bm-pepper";
        let subject = format!("7656119{}", rand_digits());

        let ban = imported_ban("bm-ban-1", &subject, "cheating");
        let mut tx = pool.begin().await.unwrap();
        let out = apply_ban_page(&mut tx, tenant.0, pepper, std::slice::from_ref(&ban))
            .await
            .unwrap();
        assert_eq!((out.inserted, out.updated, out.unchanged), (1, 0, 0));
        // Same page re-run: unchanged.
        let out = apply_ban_page(&mut tx, tenant.0, pepper, std::slice::from_ref(&ban))
            .await
            .unwrap();
        assert_eq!((out.inserted, out.updated, out.unchanged), (0, 0, 1));
        // BM-side edit (different hash): updated in place, still one ban.
        let edited = imported_ban("bm-ban-1", &subject, "toxicity");
        let out = apply_ban_page(&mut tx, tenant.0, pepper, std::slice::from_ref(&edited))
            .await
            .unwrap();
        assert_eq!((out.inserted, out.updated, out.unchanged), (0, 1, 0));
        assert_eq!(out.conflicts, 0, "an active ban edited is not a conflict");
        let (count, reason, origin): (i64, Option<String>, String) = sqlx::query_as(
            "SELECT count(*), min(reason), min(origin) FROM bans \
             WHERE tenant_id = $1 AND subject_value = $2",
        )
        .bind(tenant.0)
        .bind(&subject)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        assert_eq!(count, 1, "update must not duplicate");
        assert_eq!(reason.as_deref(), Some("toxicity"));
        assert_eq!(origin, "bm");
        tx.commit().await.unwrap();

        // The imported ban enforces like a native one.
        let hits = crate::domain::bans::enforce(
            &pool,
            pepper,
            tenant.0,
            Uuid::new_v4(),
            std::slice::from_ref(&subject),
        )
        .await
        .unwrap();
        assert_eq!(hits.len(), 1, "imported ban must enforce");
        assert_eq!(hits[0].reason.as_deref(), Some("toxicity"));
    }

    #[tokio::test]
    async fn job_controls_transition_and_guard() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP job_controls_transition_and_guard: TEST_DATABASE_URL unset");
            return;
        };
        let tenant = TenantId(Uuid::new_v4());
        let view = connect_tenant(&pool, tenant).await;
        sqlx::query(
            "UPDATE bm_connections SET claimed_by = 'ctrl-a', heartbeat_at = now() WHERE id = $1",
        )
        .bind(view.id)
        .execute(&pool)
        .await
        .unwrap();
        let actor = Uuid::new_v4();
        let job = enqueue_import(&pool, tenant, actor).await.expect("enqueue");

        // Pause parks the job: not picked up, not resurrectable by the runner.
        let paused = control_job(&pool, tenant, actor, "pause").await.unwrap();
        assert_eq!(paused.status, "paused");
        assert!(next_live_job(&pool, view.id).await.unwrap().is_none());
        assert_eq!(
            mark_job_running(&pool, job.id, "ctrl-a").await.unwrap(),
            JobWrite::NotRunnable,
            "a runner must not resurrect a paused job, but the lease stays ours"
        );

        // Resume re-queues; cancel is terminal and wins over a completing runner.
        assert_eq!(
            control_job(&pool, tenant, actor, "resume")
                .await
                .unwrap()
                .status,
            "queued"
        );
        assert_eq!(
            control_job(&pool, tenant, actor, "cancel")
                .await
                .unwrap()
                .status,
            "cancelled"
        );
        assert!(
            control_job(&pool, tenant, actor, "resume").await.is_err(),
            "cancel is terminal"
        );
        assert_eq!(
            finish_job(&pool, job.id, "completed", None, "ctrl-a")
                .await
                .unwrap(),
            JobWrite::NotRunnable,
            "a completing runner must not overwrite a cancel, but the lease stays ours"
        );
        let status: String = sqlx::query_scalar("SELECT status FROM bm_import_jobs WHERE id = $1")
            .bind(job.id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(status, "cancelled");
    }

    #[tokio::test]
    async fn job_writes_are_fenced_on_the_lease() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP job_writes_are_fenced_on_the_lease: TEST_DATABASE_URL unset");
            return;
        };
        let tenant = TenantId(Uuid::new_v4());
        let view = connect_tenant(&pool, tenant).await;
        sqlx::query(
            "UPDATE bm_connections SET claimed_by = 'fence-a', heartbeat_at = now() WHERE id = $1",
        )
        .bind(view.id)
        .execute(&pool)
        .await
        .unwrap();
        let job = enqueue_import(&pool, tenant, Uuid::new_v4())
            .await
            .expect("enqueue");

        assert_eq!(
            mark_job_running(&pool, job.id, "fence-b").await.unwrap(),
            JobWrite::LeaseLost,
            "a non-holder must not flip the job running"
        );
        assert_eq!(
            mark_job_running(&pool, job.id, "fence-a").await.unwrap(),
            JobWrite::Applied
        );

        let mut tx = pool.begin().await.unwrap();
        let cursor = serde_json::json!({});
        assert_eq!(
            save_job_progress(&mut tx, job.id, "bans", &cursor, &cursor, "fence-b")
                .await
                .unwrap(),
            JobWrite::LeaseLost,
            "a non-holder must not move the cursor"
        );
        assert_eq!(
            save_job_progress(&mut tx, job.id, "bans", &cursor, &cursor, "fence-a")
                .await
                .unwrap(),
            JobWrite::Applied
        );
        tx.commit().await.unwrap();

        assert_eq!(
            finish_job(&pool, job.id, "failed", Some("x"), "fence-b")
                .await
                .unwrap(),
            JobWrite::LeaseLost,
            "a non-holder must not fail the job"
        );
        assert_eq!(
            finish_job(&pool, job.id, "completed", None, "fence-a")
                .await
                .unwrap(),
            JobWrite::Applied
        );
    }

    #[tokio::test]
    async fn update_repoints_player_link_when_subject_changes() {
        let Some(pool) = setup().await else {
            eprintln!(
                "SKIP update_repoints_player_link_when_subject_changes: TEST_DATABASE_URL unset"
            );
            return;
        };
        let tenant = TenantId(Uuid::new_v4());
        let pepper = b"bm-pepper";
        let subject_a = format!("7656119{}", rand_digits());
        let subject_b = format!("7656119{}", rand_digits());

        // Two known players, one per identifier.
        let mut player_ids = Vec::new();
        for subject in [&subject_a, &subject_b] {
            let pid: Uuid = sqlx::query_scalar("INSERT INTO players DEFAULT VALUES RETURNING id")
                .fetch_one(&pool)
                .await
                .expect("player");
            sqlx::query(
                "INSERT INTO player_identifiers (player_id, type, value, value_hash) \
                 VALUES ($1, 'steam', $2, $3)",
            )
            .bind(pid)
            .bind(subject)
            .bind(hmac_sha256(subject.as_bytes(), pepper).to_vec())
            .execute(&pool)
            .await
            .expect("identifier");
            player_ids.push(pid);
        }

        let mut tx = pool.begin().await.unwrap();
        apply_ban_page(
            &mut tx,
            tenant.0,
            pepper,
            std::slice::from_ref(&imported_ban("bm-rp", &subject_a, "x")),
        )
        .await
        .unwrap();
        // BM-side identifier correction: the ban now targets subject B.
        let out = apply_ban_page(
            &mut tx,
            tenant.0,
            pepper,
            std::slice::from_ref(&imported_ban("bm-rp", &subject_b, "x")),
        )
        .await
        .unwrap();
        assert_eq!(out.updated, 1);
        let linked: Option<Uuid> = sqlx::query_scalar(
            "SELECT player_id FROM bans WHERE tenant_id = $1 AND subject_value = $2",
        )
        .bind(tenant.0)
        .bind(&subject_b)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        assert_eq!(
            linked,
            Some(player_ids[1]),
            "the ban must repoint to the corrected identifier's player"
        );
        tx.commit().await.unwrap();
    }

    #[tokio::test]
    async fn locally_revoked_ban_is_not_resurrected_by_import_refresh() {
        let Some(pool) = setup().await else {
            eprintln!(
                "SKIP locally_revoked_ban_is_not_resurrected_by_import_refresh: TEST_DATABASE_URL unset"
            );
            return;
        };
        let tenant = TenantId(Uuid::new_v4());
        let pepper = b"bm-pepper";
        let subject = format!("7656119{}", rand_digits());

        let ban = imported_ban("bm-ban-r", &subject, "cheating");
        let mut tx = pool.begin().await.unwrap();
        apply_ban_page(&mut tx, tenant.0, pepper, std::slice::from_ref(&ban))
            .await
            .unwrap();
        tx.commit().await.unwrap();

        sqlx::query(
            "UPDATE bans SET status = 'revoked', revoked_at = now() \
             WHERE tenant_id = $1 AND subject_value = $2",
        )
        .bind(tenant.0)
        .bind(&subject)
        .execute(&pool)
        .await
        .unwrap();

        // A BM edit against the revoked ban: fields apply, the revoke stands, and an
        // inbound conflict is logged (decision I).
        let edited = imported_ban("bm-ban-r", &subject, "edited reason");
        let mut tx = pool.begin().await.unwrap();
        let out = apply_ban_page(&mut tx, tenant.0, pepper, std::slice::from_ref(&edited))
            .await
            .unwrap();
        assert_eq!((out.updated, out.conflicts), (1, 1));
        let (status, reason): (String, Option<String>) = sqlx::query_as(
            "SELECT status, reason FROM bans WHERE tenant_id = $1 AND subject_value = $2",
        )
        .bind(tenant.0)
        .bind(&subject)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        assert_eq!(
            status, "revoked",
            "import refresh must not resurrect a revoke"
        );
        assert_eq!(reason.as_deref(), Some("edited reason"));
        tx.commit().await.unwrap();

        let (count, resolution, local_snapshot): (i64, Option<String>, Option<serde_json::Value>) =
            sqlx::query_as(
                "SELECT count(*), min(resolution), \
                        (array_agg(local_snapshot))[1] FROM bm_sync_conflicts \
                 WHERE tenant_id = $1 AND external_id = 'bm-ban-r'",
            )
            .bind(tenant.0)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1, "the disagreement must be logged");
        assert_eq!(resolution.as_deref(), Some("local_won"));
        // The snapshot captures the PRE-edit local state (the same tx overwrites it).
        let snap = local_snapshot.expect("local snapshot present");
        assert_eq!(snap["status"], "revoked");
        assert_eq!(
            snap["reason"], "cheating",
            "pre-edit reason, not the incoming one"
        );
        assert!(
            !snap["revoked_at"].is_null(),
            "revocation context preserved"
        );
    }

    #[tokio::test]
    async fn orphan_map_row_does_not_wedge_the_page() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP orphan_map_row_does_not_wedge_the_page: TEST_DATABASE_URL unset");
            return;
        };
        let tenant = TenantId(Uuid::new_v4());
        let pepper = b"bm-pepper";
        let subject = format!("7656119{}", rand_digits());

        let ban = imported_ban("orph-1", &subject, "cheating");
        let mut tx = pool.begin().await.unwrap();
        apply_ban_page(&mut tx, tenant.0, pepper, std::slice::from_ref(&ban))
            .await
            .unwrap();
        tx.commit().await.unwrap();

        // The bans row vanishes out-of-band; the map row remains (no FK).
        sqlx::query("DELETE FROM bans WHERE tenant_id = $1 AND subject_value = $2")
            .bind(tenant.0)
            .bind(&subject)
            .execute(&pool)
            .await
            .unwrap();

        // Re-applying the same external id must not re-insert into the map (unique
        // violation would wedge every page containing it).
        let mut tx = pool.begin().await.unwrap();
        let out = apply_ban_page(&mut tx, tenant.0, pepper, std::slice::from_ref(&ban))
            .await
            .expect("orphan must not wedge the page");
        assert_eq!(out.inserted, 0, "an orphan is existing, not fresh");
        let edited = imported_ban("orph-1", &subject, "edited");
        apply_ban_page(&mut tx, tenant.0, pepper, std::slice::from_ref(&edited))
            .await
            .expect("changed path tolerates the missing bans row");
        tx.commit().await.unwrap();
    }

    #[tokio::test]
    async fn unchanged_content_still_refreshes_meta() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP unchanged_content_still_refreshes_meta: TEST_DATABASE_URL unset");
            return;
        };
        let tenant = TenantId(Uuid::new_v4());
        let pepper = b"bm-pepper";
        let subject = format!("7656119{}", rand_digits());

        // Same content hash, different list membership (lists are not hashed): the
        // sweep scopes on meta ban_list, so meta must track the move.
        let mut on_l1 = imported_ban("mv-1", &subject, "x");
        on_l1.meta = serde_json::json!({ "ban_list": "l1" });
        let mut on_l2 = imported_ban("mv-1", &subject, "x");
        on_l2.meta = serde_json::json!({ "ban_list": "l2" });

        let mut tx = pool.begin().await.unwrap();
        apply_ban_page(&mut tx, tenant.0, pepper, std::slice::from_ref(&on_l1))
            .await
            .unwrap();
        let out = apply_ban_page(&mut tx, tenant.0, pepper, std::slice::from_ref(&on_l2))
            .await
            .unwrap();
        assert_eq!(out.unchanged, 1);
        let list: String = sqlx::query_scalar(
            "SELECT meta->>'ban_list' FROM bm_sync_map \
             WHERE tenant_id = $1 AND entity_type = 'ban' AND external_id = 'mv-1'",
        )
        .bind(tenant.0)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        assert_eq!(list, "l2", "meta must follow the list move");
        tx.commit().await.unwrap();
    }

    #[tokio::test]
    async fn enabling_sync_on_errored_connection_is_rejected() {
        let Some(pool) = setup().await else {
            eprintln!(
                "SKIP enabling_sync_on_errored_connection_is_rejected: TEST_DATABASE_URL unset"
            );
            return;
        };
        let tenant = TenantId(Uuid::new_v4());
        let view = connect_tenant(&pool, tenant).await;
        sqlx::query("UPDATE bm_connections SET status = 'error' WHERE id = $1")
            .bind(view.id)
            .execute(&pool)
            .await
            .unwrap();

        let err = update_sync_settings(
            &pool,
            tenant,
            Uuid::new_v4(),
            SyncChanges {
                sync_enabled: Some(true),
                ..Default::default()
            },
        )
        .await
        .expect_err("enable on an errored connection must fail loudly");
        assert!(matches!(err, AppError::BadRequest(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn conflict_resolution_paths() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP conflict_resolution_paths: TEST_DATABASE_URL unset");
            return;
        };
        let tenant = TenantId(Uuid::new_v4());
        let pepper = b"bm-pepper";
        let actor = Uuid::new_v4();

        // Two revoked bans, each edited on BM afterwards: two logged conflicts.
        let mut conflict_ids = Vec::new();
        for (ext, subject) in [
            ("cr-1", format!("7656119{}", rand_digits())),
            ("cr-2", format!("7656119{}", rand_digits())),
        ] {
            let mut tx = pool.begin().await.unwrap();
            apply_ban_page(
                &mut tx,
                tenant.0,
                pepper,
                std::slice::from_ref(&imported_ban(ext, &subject, "original")),
            )
            .await
            .unwrap();
            tx.commit().await.unwrap();
            sqlx::query(
                "UPDATE bans SET status = 'revoked', revoked_at = now() \
                 WHERE tenant_id = $1 AND subject_value = $2",
            )
            .bind(tenant.0)
            .bind(&subject)
            .execute(&pool)
            .await
            .unwrap();
            let mut tx = pool.begin().await.unwrap();
            apply_ban_page(
                &mut tx,
                tenant.0,
                pepper,
                std::slice::from_ref(&imported_ban(ext, &subject, "bm edit")),
            )
            .await
            .unwrap();
            tx.commit().await.unwrap();
            let id: Uuid = sqlx::query_scalar(
                "SELECT id FROM bm_sync_conflicts WHERE tenant_id = $1 AND external_id = $2",
            )
            .bind(tenant.0)
            .bind(ext)
            .fetch_one(&pool)
            .await
            .unwrap();
            conflict_ids.push((id, subject));
        }

        // A newer BM edit lands after conflict A was logged (and logs conflict B):
        // accepting the OLDER conflict must lift the revoke while preserving the
        // row's newest fields, never resurrecting the stale snapshot.
        let mut tx = pool.begin().await.unwrap();
        apply_ban_page(
            &mut tx,
            tenant.0,
            pepper,
            std::slice::from_ref(&imported_ban("cr-1", &conflict_ids[0].1, "newest edit")),
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();

        let resolved = resolve_conflict(&pool, tenant, actor, conflict_ids[0].0, "accept_remote")
            .await
            .unwrap();
        assert_eq!(resolved.resolution, "remote_won");
        let (status, reason): (String, Option<String>) = sqlx::query_as(
            "SELECT status, reason FROM bans WHERE tenant_id = $1 AND subject_value = $2",
        )
        .bind(tenant.0)
        .bind(&conflict_ids[0].1)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            (status.as_str(), reason.as_deref()),
            ("active", Some("newest edit")),
            "accept_remote lifts the revoke and keeps the row's current fields"
        );

        // keep_local acknowledges without touching the ban.
        resolve_conflict(&pool, tenant, actor, conflict_ids[1].0, "keep_local")
            .await
            .unwrap();
        let status: String = sqlx::query_scalar(
            "SELECT status FROM bans WHERE tenant_id = $1 AND subject_value = $2",
        )
        .bind(tenant.0)
        .bind(&conflict_ids[1].1)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(status, "revoked", "keep_local must not resurrect");

        // Double-resolution is rejected.
        assert!(
            resolve_conflict(&pool, tenant, actor, conflict_ids[0].0, "keep_local")
                .await
                .is_err(),
            "a resolved conflict is terminal"
        );
    }

    #[tokio::test]
    async fn batch_page_mixes_outcomes_and_dedups() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP batch_page_mixes_outcomes_and_dedups: TEST_DATABASE_URL unset");
            return;
        };
        let tenant = TenantId(Uuid::new_v4());
        let pepper = b"bm-pepper";
        let (sa, sb, sc) = (
            format!("7656119{}", rand_digits()),
            format!("7656119{}", rand_digits()),
            format!("7656119{}", rand_digits()),
        );

        // Pre-apply A (will be unchanged) and B (will arrive edited).
        let mut tx = pool.begin().await.unwrap();
        apply_ban_page(
            &mut tx,
            tenant.0,
            pepper,
            &[
                imported_ban("mix-a", &sa, "one"),
                imported_ban("mix-b", &sb, "two"),
            ],
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();

        // One mixed page: new C (repeated: dedup keeps the first), unchanged A,
        // edited B.
        let mut tx = pool.begin().await.unwrap();
        let out = apply_ban_page(
            &mut tx,
            tenant.0,
            pepper,
            &[
                imported_ban("mix-c", &sc, "new"),
                imported_ban("mix-c", &sc, "dup ignored"),
                imported_ban("mix-a", &sa, "one"),
                imported_ban("mix-b", &sb, "two edited"),
            ],
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(
            (out.inserted, out.updated, out.unchanged, out.conflicts),
            (1, 1, 1, 0),
            "mixed page outcomes"
        );
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM bans WHERE tenant_id = $1 AND origin = 'bm'")
                .bind(tenant.0)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 3, "dedup within the page must not double-insert");
    }

    #[tokio::test]
    async fn reconnect_with_new_org_resets_lists_and_outbox() {
        let Some(pool) = setup().await else {
            eprintln!(
                "SKIP reconnect_with_new_org_resets_lists_and_outbox: TEST_DATABASE_URL unset"
            );
            return;
        };
        let tenant = TenantId(Uuid::new_v4());
        connect_tenant(&pool, tenant).await; // org 12345

        // Enable sync, register a list, queue an outbox op (all under the old org).
        sqlx::query(
            "UPDATE bm_connections SET sync_enabled = true, sync_bans_outbound = true, \
             settings = '{\"target_ban_list\": \"l1\"}'::jsonb WHERE tenant_id = $1",
        )
        .bind(tenant.0)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO bm_ban_lists (tenant_id, external_id, name) VALUES ($1, 'l1', 'L1')",
        )
        .bind(tenant.0)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO bm_outbox (tenant_id, local_id, op) VALUES ($1, $2, 'delete')")
            .bind(tenant.0)
            .bind(Uuid::new_v4())
            .execute(&pool)
            .await
            .unwrap();

        // Reconnect with a DIFFERENT org id.
        let view = upsert_connection(
            &pool,
            tenant,
            Uuid::new_v4(),
            NewConnection {
                bm_org_id: "67890".into(),
                token_enc: vec![9],
                token_dek: vec![9],
            },
        )
        .await
        .expect("reconnect");
        assert_eq!(view.bm_org_id, "67890");
        assert!(
            !view.sync_enabled && !view.sync_bans_outbound,
            "org change clears sync flags"
        );
        assert_eq!(view.settings, serde_json::json!({}), "target list cleared");

        let lists: i64 =
            sqlx::query_scalar("SELECT count(*) FROM bm_ban_lists WHERE tenant_id = $1")
                .bind(tenant.0)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(lists, 0, "the old org's list registry is dropped");
        let abandoned: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM bm_outbox WHERE tenant_id = $1 AND status = 'abandoned'",
        )
        .bind(tenant.0)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(abandoned, 1, "in-flight outbox ops are abandoned");

        // Reconnecting with the SAME org keeps everything (no reset).
        sqlx::query(
            "INSERT INTO bm_ban_lists (tenant_id, external_id, name) VALUES ($1, 'l9', 'L9')",
        )
        .bind(tenant.0)
        .execute(&pool)
        .await
        .unwrap();
        upsert_connection(
            &pool,
            tenant,
            Uuid::new_v4(),
            NewConnection {
                bm_org_id: "67890".into(),
                token_enc: vec![1],
                token_dek: vec![1],
            },
        )
        .await
        .expect("same-org reconnect");
        let lists: i64 =
            sqlx::query_scalar("SELECT count(*) FROM bm_ban_lists WHERE tenant_id = $1")
                .bind(tenant.0)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(lists, 1, "a same-org reconnect must not wipe the registry");
    }

    fn rand_digits() -> String {
        let id = Uuid::new_v4().as_u128();
        format!("{:010}", id % 10_000_000_000)
    }
}
