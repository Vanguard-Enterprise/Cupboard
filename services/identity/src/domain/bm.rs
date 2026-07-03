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

/// Runner-side row (carries the sealed token; the sync settings/flags join it in PR2
/// when the sync loops start reading them).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct BmConnection {
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub bm_org_id: String,
    pub token_enc: Vec<u8>,
    pub token_dek: Vec<u8>,
}

const CONN_COLS: &str = "id, tenant_id, bm_org_id, token_enc, token_dek";

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
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

const VIEW_COLS: &str = "id, bm_org_id, status, last_error, sync_enabled, \
     sync_bans_outbound, settings, created_at, updated_at";

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

/// Claim up to `limit` connections that have runnable work (a live import job today;
/// sync-enabled connections join in PR2) and are unclaimed, ours already, or stale.
/// `FOR UPDATE SKIP LOCKED` keeps two supervisors from double-claiming in the same
/// instant; the stale-heartbeat window covers pod death.
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
               AND EXISTS (SELECT 1 FROM bm_import_jobs j \
                           WHERE j.connection_id = c.id \
                             AND j.status IN ('queued', 'running')) \
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

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum ImportOutcome {
    Inserted,
    Updated,
    Unchanged,
}

/// Idempotent import upsert keyed by the sync map. Unchanged hash = touch
/// `bm_seen_at` only; changed hash = refresh the ban to BM's state (without
/// resurrecting a locally revoked ban; PR2's diff loop owns richer semantics).
pub async fn upsert_imported_ban(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    pepper: &[u8],
    ban: &ImportedBan,
) -> Result<ImportOutcome, AppError> {
    let existing: Option<(Uuid, Option<Vec<u8>>)> = sqlx::query_as(
        "SELECT local_id, content_hash FROM bm_sync_map \
         WHERE tenant_id = $1 AND entity_type = 'ban' AND external_id = $2",
    )
    .bind(tenant_id)
    .bind(&ban.external_id)
    .fetch_optional(&mut **tx)
    .await?;

    let subject_hash = hmac_sha256(ban.subject_value.as_bytes(), pepper).to_vec();
    let status = if ban.expires_at.is_some_and(|e| e <= Utc::now()) {
        "expired"
    } else {
        "active"
    };

    match existing {
        None => {
            // Link the ban to a known player when the identifier already exists in the
            // graph (same resolution bans::create does).
            let player_id: Option<Uuid> = sqlx::query_scalar(
                "SELECT player_id FROM player_identifiers WHERE type = $1 AND value_hash = $2",
            )
            .bind(&ban.subject_type)
            .bind(&subject_hash)
            .fetch_optional(&mut **tx)
            .await?;

            let local_id: Uuid = sqlx::query_scalar(
                "INSERT INTO bans \
                   (tenant_id, subject_type, subject_value, subject_hash, player_id, \
                    scope, reason, issued_at, expires_at, status, origin) \
                 VALUES ($1, $2, $3, $4, $5, 'network', $6, $7, $8, $9, 'bm') \
                 RETURNING id",
            )
            .bind(tenant_id)
            .bind(&ban.subject_type)
            .bind(&ban.subject_value)
            .bind(&subject_hash)
            .bind(player_id)
            .bind(&ban.reason)
            .bind(ban.issued_at)
            .bind(ban.expires_at)
            .bind(status)
            .fetch_one(&mut **tx)
            .await?;

            sqlx::query(
                "INSERT INTO bm_sync_map \
                   (tenant_id, entity_type, external_id, local_id, content_hash, meta, \
                    bm_seen_at, local_synced_at, last_direction) \
                 VALUES ($1, 'ban', $2, $3, $4, $5, now(), now(), 'inbound')",
            )
            .bind(tenant_id)
            .bind(&ban.external_id)
            .bind(local_id)
            .bind(&ban.content_hash)
            .bind(&ban.meta)
            .execute(&mut **tx)
            .await?;
            Ok(ImportOutcome::Inserted)
        }
        Some((_, Some(hash))) if hash == ban.content_hash => {
            sqlx::query(
                "UPDATE bm_sync_map SET bm_seen_at = now() \
                 WHERE tenant_id = $1 AND entity_type = 'ban' AND external_id = $2",
            )
            .bind(tenant_id)
            .bind(&ban.external_id)
            .execute(&mut **tx)
            .await?;
            Ok(ImportOutcome::Unchanged)
        }
        Some((local_id, _)) => {
            // The subject may have changed (BM-side identifier edit), so player_id is
            // re-resolved from the new identifier; keeping the old link would pin the
            // ban to the wrong player's profile.
            sqlx::query(
                "UPDATE bans SET subject_type = $2, subject_value = $3, subject_hash = $4, \
                   reason = $5, expires_at = $6, \
                   status = CASE WHEN status = 'revoked' THEN status ELSE $7 END, \
                   player_id = (SELECT player_id FROM player_identifiers \
                                WHERE type = $2 AND value_hash = $4) \
                 WHERE id = $1",
            )
            .bind(local_id)
            .bind(&ban.subject_type)
            .bind(&ban.subject_value)
            .bind(&subject_hash)
            .bind(&ban.reason)
            .bind(ban.expires_at)
            .bind(status)
            .execute(&mut **tx)
            .await?;

            sqlx::query(
                "UPDATE bm_sync_map SET content_hash = $3, meta = $4, bm_seen_at = now(), \
                   local_synced_at = now(), last_direction = 'inbound' \
                 WHERE tenant_id = $1 AND entity_type = 'ban' AND external_id = $2",
            )
            .bind(tenant_id)
            .bind(&ban.external_id)
            .bind(&ban.content_hash)
            .bind(&ban.meta)
            .execute(&mut **tx)
            .await?;
            Ok(ImportOutcome::Updated)
        }
    }
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
        assert_eq!(
            upsert_imported_ban(&mut tx, tenant.0, pepper, &ban)
                .await
                .unwrap(),
            ImportOutcome::Inserted
        );
        // Same page re-run: unchanged.
        assert_eq!(
            upsert_imported_ban(&mut tx, tenant.0, pepper, &ban)
                .await
                .unwrap(),
            ImportOutcome::Unchanged
        );
        // BM-side edit (different hash): updated in place, still one ban.
        let edited = imported_ban("bm-ban-1", &subject, "toxicity");
        assert_eq!(
            upsert_imported_ban(&mut tx, tenant.0, pepper, &edited)
                .await
                .unwrap(),
            ImportOutcome::Updated
        );
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
        upsert_imported_ban(
            &mut tx,
            tenant.0,
            pepper,
            &imported_ban("bm-rp", &subject_a, "x"),
        )
        .await
        .unwrap();
        // BM-side identifier correction: the ban now targets subject B.
        assert_eq!(
            upsert_imported_ban(
                &mut tx,
                tenant.0,
                pepper,
                &imported_ban("bm-rp", &subject_b, "x"),
            )
            .await
            .unwrap(),
            ImportOutcome::Updated
        );
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
        upsert_imported_ban(&mut tx, tenant.0, pepper, &ban)
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

        let edited = imported_ban("bm-ban-r", &subject, "edited reason");
        let mut tx = pool.begin().await.unwrap();
        assert_eq!(
            upsert_imported_ban(&mut tx, tenant.0, pepper, &edited)
                .await
                .unwrap(),
            ImportOutcome::Updated
        );
        let status: String = sqlx::query_scalar(
            "SELECT status FROM bans WHERE tenant_id = $1 AND subject_value = $2",
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
        tx.commit().await.unwrap();
    }

    fn rand_digits() -> String {
        let id = Uuid::new_v4().as_u128();
        format!("{:010}", id % 10_000_000_000)
    }
}
