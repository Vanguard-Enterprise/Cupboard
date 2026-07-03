//! Import job execution: walks the phase pipeline (PR1: ban_lists -> bans -> done),
//! one BM page per DB transaction, persisting the cursor with each page so a crash or
//! claim takeover loses at most one page of work (plan decision G).

use super::mapping;
use crate::domain::bm::{self, BmConnection, ImportJob};
use crate::error::AppError;
use cupboard_bmapi::types::{included_identifier_map, BanAttrs, BanListAttrs};
use cupboard_bmapi::{BmClient, BmError};
use std::sync::atomic::{AtomicBool, Ordering};
use uuid::Uuid;

/// Resumable position within a phase. `next_url` is BM's `links.next` verbatim;
/// `sub_id` is the ban list being walked; `pending` the lists still to walk.
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct Cursor {
    #[serde(default)]
    next_url: Option<String>,
    #[serde(default)]
    sub_id: Option<String>,
    #[serde(default)]
    pending: Vec<String>,
}

/// Per-phase counters surfaced to the wizard, accumulated across resumes.
#[derive(Default)]
struct Counts(serde_json::Map<String, serde_json::Value>);

impl Counts {
    fn from_value(v: &serde_json::Value) -> Self {
        Self(v.as_object().cloned().unwrap_or_default())
    }
    fn inc(&mut self, key: &str) {
        self.add(key, 1);
    }
    fn add(&mut self, key: &str, by: usize) {
        if by == 0 {
            return;
        }
        let cur = self.0.get(key).and_then(|v| v.as_u64()).unwrap_or(0);
        self.0.insert(key.to_string(), (cur + by as u64).into());
    }
    fn value(&self) -> serde_json::Value {
        serde_json::Value::Object(self.0.clone())
    }
}

enum ExecError {
    Bm(BmError),
    App(AppError),
    /// Another claimer took the connection; leave the job running for them.
    LostClaim,
}

/// What the runner should do after this job attempt.
pub enum RunnerSignal {
    /// Look for the next live job as usual.
    Continue,
    /// Stop the runner: the lease is gone or its in-memory state (token) is stale;
    /// the supervisor's next claim resumes with a fresh row.
    Stop,
}

impl From<BmError> for ExecError {
    fn from(e: BmError) -> Self {
        ExecError::Bm(e)
    }
}
impl From<AppError> for ExecError {
    fn from(e: AppError) -> Self {
        ExecError::App(e)
    }
}
impl From<sqlx::Error> for ExecError {
    fn from(e: sqlx::Error) -> Self {
        ExecError::App(e.into())
    }
}

/// Run `job` to a terminal state (or until the claim is lost). Never returns an error:
/// failures land in the job row / connection status where the wizard can see them. All
/// job/connection writes are fenced on `claimer` still holding the lease.
pub async fn execute_job(
    pool: &sqlx::PgPool,
    client: &BmClient,
    conn: &BmConnection,
    job: ImportJob,
    pepper: &[u8],
    lost_claim: &AtomicBool,
    claimer: &str,
) -> RunnerSignal {
    let job_id = job.id;
    match run_phases(pool, client, conn, job, pepper, lost_claim, claimer).await {
        Ok(()) => RunnerSignal::Continue,
        Err(ExecError::LostClaim) => {
            tracing::info!(job = %job_id, "claim lost mid-import; new owner resumes from cursor");
            RunnerSignal::Stop
        }
        Err(ExecError::Bm(e)) if e.is_auth() => {
            // Only fail things if the stored token is still the one we decrypted; a
            // tenant may have reconnected mid-run, in which case the auth failure is
            // ours alone and a fresh claim will pick up the new token.
            match bm::set_connection_error_if_token_unchanged(
                pool,
                conn.id,
                &conn.token_enc,
                &e.to_string(),
            )
            .await
            {
                Ok(true) => {
                    tracing::warn!(job = %job_id, error = %e,
                        "BM auth failure; connection marked errored");
                    let _ =
                        bm::finish_job(pool, job_id, "failed", Some(&e.to_string()), claimer).await;
                    RunnerSignal::Continue
                }
                Ok(false) => {
                    tracing::info!(job = %job_id,
                        "BM auth failure with a rotated token; runner restarts for re-claim");
                    RunnerSignal::Stop
                }
                Err(err) => {
                    tracing::warn!(job = %job_id, error = ?err, "token fence check failed");
                    RunnerSignal::Stop
                }
            }
        }
        Err(ExecError::Bm(e)) => {
            // The client already retried; this is persistent BM trouble. Cursor stays
            // where the last page left it.
            tracing::warn!(job = %job_id, error = %e, "import failed on BM error; cursor kept");
            let _ = bm::finish_job(pool, job_id, "failed", Some(&e.to_string()), claimer).await;
            RunnerSignal::Continue
        }
        Err(ExecError::App(e)) => {
            tracing::error!(job = %job_id, error = ?e, "import failed on internal error");
            let _ = bm::finish_job(
                pool,
                job_id,
                "failed",
                Some("internal error; see service logs"),
                claimer,
            )
            .await;
            RunnerSignal::Continue
        }
    }
}

/// A unique-violation on the sync map means another runner is importing the same
/// connection concurrently (our lease was taken over but we have not observed it yet):
/// treat it as a lost claim, not a job failure.
fn map_upsert_err(e: AppError) -> ExecError {
    if let AppError::Internal(any) = &e {
        if let Some(sqlx::Error::Database(db)) = any.downcast_ref::<sqlx::Error>() {
            if db
                .constraint()
                .is_some_and(|c| c.starts_with("bm_sync_map"))
            {
                return ExecError::LostClaim;
            }
        }
    }
    ExecError::App(e)
}

async fn run_phases(
    pool: &sqlx::PgPool,
    client: &BmClient,
    conn: &BmConnection,
    job: ImportJob,
    pepper: &[u8],
    lost_claim: &AtomicBool,
    claimer: &str,
) -> Result<(), ExecError> {
    if !bm::mark_job_running(pool, job.id, claimer).await? {
        return Err(ExecError::LostClaim);
    }
    let mut phase = job.phase.clone();
    let mut cursor: Cursor = serde_json::from_value(job.cursor.clone()).unwrap_or_default();
    let mut counts = Counts::from_value(&job.phase_counts);

    loop {
        if lost_claim.load(Ordering::Relaxed) {
            return Err(ExecError::LostClaim);
        }
        match phase.as_str() {
            // Breadth phases land in PR4; a job carrying one just moves along the
            // pipeline (order: servers -> ban_lists -> bans -> players -> notes).
            "servers" => phase = "ban_lists".into(),
            "players" | "notes" => phase = "done".into(),

            "ban_lists" => {
                let url = cursor
                    .next_url
                    .clone()
                    .unwrap_or_else(|| client.ban_lists_first_page());
                let doc = client.list_page::<BanListAttrs>(&url).await?;

                let mut tx = pool.begin().await?;
                for res in &doc.data {
                    bm::upsert_ban_list(
                        &mut tx,
                        conn.tenant_id,
                        &mapping::imported_list(res, conn),
                    )
                    .await?;
                    counts.inc("ban_lists");
                }
                cursor.next_url = doc.links.next.clone();
                if cursor.next_url.is_none() {
                    // Enumerate the bans-phase work queue. pop() takes from the back,
                    // so reverse to walk lists in ascending id order.
                    let mut pending = bm::import_enabled_list_ids(&mut tx, conn.tenant_id).await?;
                    pending.reverse();
                    let sub_id = pending.pop();
                    cursor = Cursor {
                        next_url: None,
                        sub_id,
                        pending,
                    };
                    phase = if cursor.sub_id.is_some() {
                        "bans".into()
                    } else {
                        "done".into()
                    };
                }
                save(&mut tx, job.id, &phase, &cursor, &counts, claimer).await?;
                tx.commit().await?;
            }

            "bans" => {
                let Some(list_id) = cursor.sub_id.clone() else {
                    phase = "done".into();
                    continue;
                };
                let url = cursor
                    .next_url
                    .clone()
                    .unwrap_or_else(|| client.bans_first_page(&list_id));
                let doc = client.list_page::<BanAttrs>(&url).await?;
                let ids_map = included_identifier_map(&doc.included);
                let (page, skipped) = mapping::imported_ban_page(&doc.data, &ids_map, &list_id);

                let mut tx = pool.begin().await?;
                let outcome = bm::apply_ban_page(&mut tx, conn.tenant_id, pepper, &page)
                    .await
                    .map_err(map_upsert_err)?;
                counts.add("bans_imported", outcome.inserted);
                counts.add("bans_updated", outcome.updated);
                counts.add("bans_unchanged", outcome.unchanged);
                counts.add("bans_skipped_no_identifier", skipped);
                counts.add("sync_conflicts", outcome.conflicts);
                cursor.next_url = doc.links.next.clone();
                if cursor.next_url.is_none() {
                    cursor.sub_id = cursor.pending.pop();
                    if cursor.sub_id.is_none() {
                        phase = "done".into();
                    }
                }
                save(&mut tx, job.id, &phase, &cursor, &counts, claimer).await?;
                tx.commit().await?;
            }

            _ => {
                // "done" (or anything unknown, defensively): terminal.
                if !bm::finish_job(pool, job.id, "completed", None, claimer).await? {
                    return Err(ExecError::LostClaim);
                }
                tracing::info!(job = %job.id, tenant = %conn.tenant_id, counts = %counts.value(),
                    "BM import completed");
                return Ok(());
            }
        }
    }
}

async fn save(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    job_id: Uuid,
    phase: &str,
    cursor: &Cursor,
    counts: &Counts,
    claimer: &str,
) -> Result<(), ExecError> {
    let cursor_v =
        serde_json::to_value(cursor).map_err(|e| ExecError::App(AppError::Internal(e.into())))?;
    // A fence miss means the lease moved: error out BEFORE the caller commits, so the
    // whole page rolls back instead of racing the new owner's writes.
    if !bm::save_job_progress(tx, job_id, phase, &cursor_v, &counts.value(), claimer).await? {
        return Err(ExecError::LostClaim);
    }
    Ok(())
}

#[cfg(test)]
mod e2e_tests {
    //! End-to-end import against the in-process stub BM server + real Postgres
    //! (TEST_DATABASE_URL; skip-pass otherwise, like every DB suite here).

    use super::*;
    use crate::domain::bm as bmdom;
    use cupboard_bmapi::stub::{StubBan, StubBanList, StubBm, StubData};
    use cupboard_domain::TenantId;
    use tokio::sync::OnceCell;

    static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
    static MIGRATED: OnceCell<()> = OnceCell::const_new();

    const TOKEN: &str = "stub-token";
    const PEPPER: &[u8] = b"bm-import-pepper";
    /// All e2e tests claim as this runner so the fenced job writes go through.
    const CLAIMER: &str = "e2e-runner";

    async fn setup() -> Option<sqlx::PgPool> {
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

    fn stub_data(ban_count: usize) -> StubData {
        let mut bans = Vec::with_capacity(ban_count);
        for i in 0..ban_count {
            bans.push(
                StubBan::new(
                    "l1",
                    format!("ban-{i}"),
                    format!("uid{i:05}"),
                    format!("2026-01-01T00:{:02}:{:02}Z", (i / 60) % 60, i % 60),
                    "cheating",
                )
                .identifiers(serde_json::json!([
                    {"type": "steamID", "identifier": format!("7656119800{i:06}")}
                ])),
            );
        }
        StubData::new(TOKEN)
            .with_ban_list(StubBanList::new("l1", "Main list"))
            .with_bans(bans)
    }

    /// Connection row + queued job; returns (runner-side connection, runner-side job).
    async fn seed_job(pool: &sqlx::PgPool, tenant: TenantId) -> (BmConnection, ImportJob) {
        let view = bmdom::upsert_connection(
            pool,
            tenant,
            Uuid::new_v4(),
            bmdom::NewConnection {
                bm_org_id: "9999".into(),
                // The test drives the client directly; the sealed token is never read.
                token_enc: vec![0],
                token_dek: vec![0],
            },
        )
        .await
        .expect("connect");
        // Claim BEFORE enqueueing: with no live job the connection is invisible to
        // other tests' claim_ready sweeps, and once claimed (fresh) it can't be
        // stolen, so the fenced writes below are deterministic.
        sqlx::query(
            "UPDATE bm_connections SET claimed_by = $2, heartbeat_at = now() WHERE id = $1",
        )
        .bind(view.id)
        .bind(CLAIMER)
        .execute(pool)
        .await
        .expect("claim");
        bmdom::enqueue_import(pool, tenant, Uuid::new_v4())
            .await
            .expect("enqueue");
        let job = bmdom::next_live_job(pool, view.id)
            .await
            .expect("job query")
            .expect("live job");
        let conn = BmConnection {
            id: view.id,
            tenant_id: tenant.0,
            bm_org_id: "9999".into(),
            token_enc: vec![0],
            token_dek: vec![0],
            settings: serde_json::json!({}),
            sync_enabled: false,
        };
        (conn, job)
    }

    async fn job_row(pool: &sqlx::PgPool, id: Uuid) -> (String, String, serde_json::Value) {
        sqlx::query_as("SELECT status, phase, phase_counts FROM bm_import_jobs WHERE id = $1")
            .bind(id)
            .fetch_one(pool)
            .await
            .expect("job row")
    }

    async fn ban_count(pool: &sqlx::PgPool, tenant: TenantId) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM bans WHERE tenant_id = $1 AND origin = 'bm'")
            .bind(tenant.0)
            .fetch_one(pool)
            .await
            .expect("count")
    }

    #[tokio::test]
    async fn full_import_lands_bans_and_reruns_unchanged() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP full_import_lands_bans_and_reruns_unchanged: TEST_DATABASE_URL unset");
            return;
        };
        let stub = StubBm::start(stub_data(130)).await;
        let client = cupboard_bmapi::BmClient::new(stub.base_url(), TOKEN);
        let tenant = TenantId(Uuid::new_v4());
        let (conn, job) = seed_job(&pool, tenant).await;
        let job_id = job.id;

        execute_job(
            &pool,
            &client,
            &conn,
            job,
            PEPPER,
            &AtomicBool::new(false),
            CLAIMER,
        )
        .await;

        let (status, phase, counts) = job_row(&pool, job_id).await;
        assert_eq!((status.as_str(), phase.as_str()), ("completed", "done"));
        assert_eq!(counts["bans_imported"], 130, "counts: {counts}");
        assert_eq!(ban_count(&pool, tenant).await, 130);
        let mapped: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM bm_sync_map WHERE tenant_id = $1 AND entity_type = 'ban'",
        )
        .bind(tenant.0)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(mapped, 130, "every ban gets a sync-map row");

        // Re-import: same iterator, zero new rows, everything counted unchanged.
        bmdom::enqueue_import(&pool, tenant, Uuid::new_v4())
            .await
            .expect("re-enqueue");
        let rerun = bmdom::next_live_job(&pool, conn.id)
            .await
            .unwrap()
            .expect("second job");
        let rerun_id = rerun.id;
        execute_job(
            &pool,
            &client,
            &conn,
            rerun,
            PEPPER,
            &AtomicBool::new(false),
            CLAIMER,
        )
        .await;
        let (status, _, counts) = job_row(&pool, rerun_id).await;
        assert_eq!(status, "completed");
        assert_eq!(counts["bans_unchanged"], 130, "counts: {counts}");
        assert_eq!(
            ban_count(&pool, tenant).await,
            130,
            "re-import must not duplicate"
        );
    }

    #[tokio::test]
    async fn resume_from_mid_cursor_imports_only_the_tail() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP resume_from_mid_cursor_imports_only_the_tail: TEST_DATABASE_URL unset");
            return;
        };
        // Reference run captures the real page-2 URL (250 bans = 3 pages of 100).
        let stub = StubBm::start(stub_data(250)).await;
        let client = cupboard_bmapi::BmClient::new(stub.base_url(), TOKEN);
        let tenant_a = TenantId(Uuid::new_v4());
        let (conn_a, job_a) = seed_job(&pool, tenant_a).await;
        execute_job(
            &pool,
            &client,
            &conn_a,
            job_a,
            PEPPER,
            &AtomicBool::new(false),
            CLAIMER,
        )
        .await;
        assert_eq!(ban_count(&pool, tenant_a).await, 250);
        let bans_pages: Vec<String> = stub
            .requests()
            .iter()
            .filter(|r| r.path_and_query.starts_with("/bans"))
            .map(|r| r.path_and_query.clone())
            .collect();
        assert_eq!(bans_pages.len(), 3, "3 pages walked: {bans_pages:?}");
        let page2_url = format!("{}{}", stub.base_url(), bans_pages[1]);

        // Fresh tenant, job hand-cranked to the page-2 cursor: only the tail imports.
        let tenant_b = TenantId(Uuid::new_v4());
        let (conn_b, job_b) = seed_job(&pool, tenant_b).await;
        let cursor = serde_json::json!({
            "next_url": page2_url,
            "sub_id": "l1",
            "pending": [],
        });
        sqlx::query("UPDATE bm_import_jobs SET phase = 'bans', cursor = $2 WHERE id = $1")
            .bind(job_b.id)
            .bind(&cursor)
            .execute(&pool)
            .await
            .unwrap();
        let job_b = bmdom::next_live_job(&pool, conn_b.id)
            .await
            .unwrap()
            .expect("resumable job");
        assert_eq!(job_b.phase, "bans");

        execute_job(
            &pool,
            &client,
            &conn_b,
            job_b,
            PEPPER,
            &AtomicBool::new(false),
            CLAIMER,
        )
        .await;
        assert_eq!(
            ban_count(&pool, tenant_b).await,
            150,
            "resume from page 2 imports exactly the remaining 150"
        );
        let (status, phase, _) = job_row(
            &pool,
            bmdom::latest_job(&pool, tenant_b)
                .await
                .unwrap()
                .unwrap()
                .id,
        )
        .await;
        assert_eq!((status.as_str(), phase.as_str()), ("completed", "done"));
    }

    #[tokio::test]
    async fn auth_failure_marks_connection_errored() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP auth_failure_marks_connection_errored: TEST_DATABASE_URL unset");
            return;
        };
        let stub = StubBm::start(stub_data(1)).await;
        // Wrong bearer: the stub 401s every request.
        let client = cupboard_bmapi::BmClient::new(stub.base_url(), "wrong-token");
        let tenant = TenantId(Uuid::new_v4());
        let (conn, job) = seed_job(&pool, tenant).await;
        let job_id = job.id;

        execute_job(
            &pool,
            &client,
            &conn,
            job,
            PEPPER,
            &AtomicBool::new(false),
            CLAIMER,
        )
        .await;

        let (status, _, _) = job_row(&pool, job_id).await;
        assert_eq!(status, "failed");
        let (conn_status, last_error): (String, Option<String>) =
            sqlx::query_as("SELECT status, last_error FROM bm_connections WHERE id = $1")
                .bind(conn.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(conn_status, "error");
        assert!(last_error.is_some(), "the tenant must see why it failed");
    }
}
