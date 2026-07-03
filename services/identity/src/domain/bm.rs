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
    /// Cadences + subset selections (`bm::sync::SyncSettings` reads these).
    pub settings: serde_json::Value,
    pub sync_enabled: bool,
}

const CONN_COLS: &str = "id, tenant_id, bm_org_id, token_enc, token_dek, settings, sync_enabled";

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
    let view = sqlx::query_as::<_, ConnectionView>(&format!(
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

    crate::domain::audit::record_in_tx(
        &mut tx,
        Some(tenant.0),
        Some(actor),
        "integrations.bm.connect",
        Some("bm_connection"),
        Some(view.id),
        Some(serde_json::json!({ "bm_org_id": view.bm_org_id })),
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

    let job = sqlx::query_as::<_, ImportJobView>(&format!(
        "INSERT INTO bm_import_jobs (tenant_id, connection_id, requested_by) \
         VALUES ($1, $2, $3) RETURNING {JOB_VIEW_COLS}"
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

pub async fn mark_job_running(
    owner_pool: &PgPool,
    job_id: Uuid,
    claimer: &str,
) -> Result<bool, AppError> {
    let res = sqlx::query(&format!(
        "UPDATE bm_import_jobs SET status = 'running', \
         started_at = COALESCE(started_at, now()) WHERE id = $1 AND {}",
        JOB_CLAIM_FENCE.replace("$CLAIMER", "$2")
    ))
    .bind(job_id)
    .bind(claimer)
    .execute(owner_pool)
    .await?;
    Ok(res.rows_affected() == 1)
}

pub async fn finish_job(
    owner_pool: &PgPool,
    job_id: Uuid,
    status: &str,
    error: Option<&str>,
    claimer: &str,
) -> Result<bool, AppError> {
    let res = sqlx::query(&format!(
        "UPDATE bm_import_jobs SET status = $2, error = $3, finished_at = now(), \
         phase = CASE WHEN $2 = 'completed' THEN 'done' ELSE phase END \
         WHERE id = $1 AND {}",
        JOB_CLAIM_FENCE.replace("$CLAIMER", "$4")
    ))
    .bind(job_id)
    .bind(status)
    .bind(error)
    .bind(claimer)
    .execute(owner_pool)
    .await?;
    Ok(res.rows_affected() == 1)
}

/// Persist a page's progress inside that page's tx: phase, cursor, and counts move
/// together with the rows they describe, so a crash never double-imports a page.
/// `false` = the lease was taken over; the caller must roll the page back.
pub async fn save_job_progress(
    tx: &mut Transaction<'_, Postgres>,
    job_id: Uuid,
    phase: &str,
    cursor: &serde_json::Value,
    phase_counts: &serde_json::Value,
    claimer: &str,
) -> Result<bool, AppError> {
    let res = sqlx::query(&format!(
        "UPDATE bm_import_jobs SET phase = $2, cursor = $3, phase_counts = $4 \
         WHERE id = $1 AND {}",
        JOB_CLAIM_FENCE.replace("$CLAIMER", "$5")
    ))
    .bind(job_id)
    .bind(phase)
    .bind(cursor)
    .bind(phase_counts)
    .bind(claimer)
    .execute(&mut **tx)
    .await?;
    Ok(res.rows_affected() == 1)
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
    let existing: Vec<(String, Uuid, Option<Vec<u8>>, String)> = sqlx::query_as(
        "SELECT m.external_id, m.local_id, m.content_hash, b.status \
         FROM bm_sync_map m JOIN bans b ON b.id = m.local_id \
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
        sqlx::query(
            "UPDATE bm_sync_map SET bm_seen_at = now() \
             WHERE tenant_id = $1 AND entity_type = 'ban' AND external_id = ANY($2)",
        )
        .bind(tenant_id)
        .bind(&unchanged_ids)
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

        // BM edited a ban a local operator had revoked: the revoke stands (their most
        // recent explicit action), and the disagreement is logged for review.
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
                        u.local_snapshot, u.remote_snapshot, 'local_won' \
                 FROM unnest($2::text[], $3::uuid[], $4::jsonb[], $5::jsonb[]) \
                      AS u(external_id, local_id, local_snapshot, remote_snapshot)",
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
                    .map(|_| serde_json::json!({ "status": "revoked" }))
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
        out.updated = changed.len();
    }

    Ok(out)
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
/// else the tail poll. Success clears the surfaced sync error.
pub async fn record_sync_tick(
    owner_pool: &PgPool,
    connection_id: Uuid,
    claimer: &str,
    scan: bool,
) -> Result<(), AppError> {
    let column = if scan { "last_scan_at" } else { "last_tail_at" };
    sqlx::query(&format!(
        "UPDATE bm_connections SET {column} = now(), sync_error = NULL \
         WHERE id = $1 AND claimed_by = $2"
    ))
    .bind(connection_id)
    .bind(claimer)
    .execute(owner_pool)
    .await?;
    Ok(())
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

/// Tenant toggle for inbound sync.
pub async fn set_sync_enabled(
    app_pool: &PgPool,
    tenant: TenantId,
    actor: Uuid,
    enabled: bool,
) -> Result<ConnectionView, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let view = sqlx::query_as::<_, ConnectionView>(&format!(
        "UPDATE bm_connections SET sync_enabled = $2, updated_at = now() \
         WHERE tenant_id = $1 RETURNING {VIEW_COLS}"
    ))
    .bind(tenant.0)
    .bind(enabled)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| {
        AppError::NotFound("no BattleMetrics connection; connect a token first".into())
    })?;

    crate::domain::audit::record_in_tx(
        &mut tx,
        Some(tenant.0),
        Some(actor),
        "integrations.bm.sync.toggle",
        Some("bm_connection"),
        Some(view.id),
        Some(serde_json::json!({ "sync_enabled": enabled })),
    )
    .await?;
    tx.commit().await?;
    Ok(view)
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

pub async fn list_conflicts(
    app_pool: &PgPool,
    tenant: TenantId,
) -> Result<Vec<ConflictView>, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let conflicts = sqlx::query_as::<_, ConflictView>(
        "SELECT id, entity_type, external_id, local_id, direction, local_snapshot, \
                remote_snapshot, resolution, created_at \
         FROM bm_sync_conflicts WHERE tenant_id = $1 \
         ORDER BY created_at DESC LIMIT 100",
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

        assert!(
            !mark_job_running(&pool, job.id, "fence-b").await.unwrap(),
            "a non-holder must not flip the job running"
        );
        assert!(mark_job_running(&pool, job.id, "fence-a").await.unwrap());

        let mut tx = pool.begin().await.unwrap();
        let cursor = serde_json::json!({});
        assert!(
            !save_job_progress(&mut tx, job.id, "bans", &cursor, &cursor, "fence-b")
                .await
                .unwrap(),
            "a non-holder must not move the cursor"
        );
        assert!(
            save_job_progress(&mut tx, job.id, "bans", &cursor, &cursor, "fence-a")
                .await
                .unwrap()
        );
        tx.commit().await.unwrap();

        assert!(
            !finish_job(&pool, job.id, "failed", Some("x"), "fence-b")
                .await
                .unwrap(),
            "a non-holder must not fail the job"
        );
        assert!(finish_job(&pool, job.id, "completed", None, "fence-a")
            .await
            .unwrap());
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

        let (count, resolution): (i64, Option<String>) = sqlx::query_as(
            "SELECT count(*), min(resolution) FROM bm_sync_conflicts \
             WHERE tenant_id = $1 AND external_id = 'bm-ban-r'",
        )
        .bind(tenant.0)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 1, "the disagreement must be logged");
        assert_eq!(resolution.as_deref(), Some("local_won"));
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

    fn rand_digits() -> String {
        let id = Uuid::new_v4().as_u128();
        format!("{:010}", id % 10_000_000_000)
    }
}
