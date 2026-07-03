//! Import job execution: walks the phase pipeline (PR1: ban_lists -> bans -> done),
//! one BM page per DB transaction, persisting the cursor with each page so a crash or
//! claim takeover loses at most one page of work (plan decision G).

use crate::domain::bm::{
    self, BmConnection, ImportJob, ImportOutcome, ImportedBan, ImportedBanList,
};
use crate::error::AppError;
use chrono::Utc;
use cupboard_bmapi::types::{
    included_identifier_map, BanAttrs, BanIdentifier, BanListAttrs, Resource,
};
use cupboard_bmapi::{ban_content_hash, BmClient, BmError};
use std::collections::HashMap;
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
        let cur = self.0.get(key).and_then(|v| v.as_u64()).unwrap_or(0);
        self.0.insert(key.to_string(), (cur + 1).into());
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
/// failures land in the job row / connection status where the wizard can see them.
pub async fn execute_job(
    pool: &sqlx::PgPool,
    client: &BmClient,
    conn: &BmConnection,
    job: ImportJob,
    pepper: &[u8],
    lost_claim: &AtomicBool,
) {
    let job_id = job.id;
    match run_phases(pool, client, conn, job, pepper, lost_claim).await {
        Ok(()) => {}
        Err(ExecError::LostClaim) => {
            tracing::info!(job = %job_id, "claim lost mid-import; new owner resumes from cursor");
        }
        Err(ExecError::Bm(e)) if e.is_auth() => {
            tracing::warn!(job = %job_id, error = %e, "BM auth failure; connection marked errored");
            let _ = bm::set_connection_error(pool, conn.id, &e.to_string()).await;
            let _ = bm::finish_job(pool, job_id, "failed", Some(&e.to_string())).await;
        }
        Err(ExecError::Bm(e)) => {
            // The client already retried; this is persistent BM trouble. Cursor stays
            // where the last page left it.
            tracing::warn!(job = %job_id, error = %e, "import failed on BM error; cursor kept");
            let _ = bm::finish_job(pool, job_id, "failed", Some(&e.to_string())).await;
        }
        Err(ExecError::App(e)) => {
            tracing::error!(job = %job_id, error = ?e, "import failed on internal error");
            let _ = bm::finish_job(
                pool,
                job_id,
                "failed",
                Some("internal error; see service logs"),
            )
            .await;
        }
    }
}

async fn run_phases(
    pool: &sqlx::PgPool,
    client: &BmClient,
    conn: &BmConnection,
    job: ImportJob,
    pepper: &[u8],
    lost_claim: &AtomicBool,
) -> Result<(), ExecError> {
    bm::mark_job_running(pool, job.id).await?;
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
                    bm::upsert_ban_list(&mut tx, conn.tenant_id, &imported_list(res, conn)).await?;
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
                save(&mut tx, job.id, &phase, &cursor, &counts).await?;
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

                let mut tx = pool.begin().await?;
                for res in &doc.data {
                    match imported_ban(res, &ids_map, &list_id) {
                        Some(ban) => {
                            match bm::upsert_imported_ban(&mut tx, conn.tenant_id, pepper, &ban)
                                .await?
                            {
                                ImportOutcome::Inserted => counts.inc("bans_imported"),
                                ImportOutcome::Updated => counts.inc("bans_updated"),
                                ImportOutcome::Unchanged => counts.inc("bans_unchanged"),
                            }
                        }
                        None => counts.inc("bans_skipped_no_identifier"),
                    }
                }
                cursor.next_url = doc.links.next.clone();
                if cursor.next_url.is_none() {
                    cursor.sub_id = cursor.pending.pop();
                    if cursor.sub_id.is_none() {
                        phase = "done".into();
                    }
                }
                save(&mut tx, job.id, &phase, &cursor, &counts).await?;
                tx.commit().await?;
            }

            _ => {
                // "done" (or anything unknown, defensively): terminal.
                bm::finish_job(pool, job.id, "completed", None).await?;
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
) -> Result<(), ExecError> {
    let cursor_v =
        serde_json::to_value(cursor).map_err(|e| ExecError::App(AppError::Internal(e.into())))?;
    bm::save_job_progress(tx, job_id, phase, &cursor_v, &counts.value()).await?;
    Ok(())
}

fn imported_list(res: &Resource<BanListAttrs>, conn: &BmConnection) -> ImportedBanList {
    // The list's owning org rides the "organization" relationship ("owner" accepted
    // defensively); a list owned by someone else is a subscription.
    let owner = res
        .rel_id("organization")
        .or_else(|| res.rel_id("owner"))
        .map(str::to_string);
    let subscribed = owner.as_deref().is_some_and(|o| o != conn.bm_org_id);
    ImportedBanList {
        external_id: res.id.clone(),
        name: res.attributes.name.clone(),
        action: res.attributes.action.clone(),
        owner_bm_org: owner,
        subscribed,
        perm_create: res.attributes.perm_create.unwrap_or(false),
        perm_update: res.attributes.perm_update.unwrap_or(false),
        perm_delete: res.attributes.perm_delete.unwrap_or(false),
    }
}

/// Cupboard subject types an imported identifier can become, most durable first.
const PRECEDENCE: [&str; 5] = ["steam", "eos", "beguid", "ip", "name"];

fn bm_kind_to_subject(kind: &str) -> Option<&'static str> {
    match kind {
        "steamID" => Some("steam"),
        "eosID" | "egsID" | "epicID" => Some("eos"),
        "BEGUID" | "legacyBEGUID" => Some("beguid"),
        "ip" => Some("ip"),
        "name" => Some("name"),
        _ => None,
    }
}

fn pick_primary(resolved: &[(String, String)]) -> Option<(&'static str, String)> {
    let mut best: Option<(usize, &'static str, &str)> = None;
    for (kind, value) in resolved {
        if value.is_empty() {
            continue;
        }
        if let Some(subject) = bm_kind_to_subject(kind) {
            let rank = PRECEDENCE
                .iter()
                .position(|p| *p == subject)
                .expect("subject came from PRECEDENCE");
            if best.is_none_or(|(r, _, _)| rank < r) {
                best = Some((rank, subject, value));
            }
        }
    }
    best.map(|(_, kind, value)| (kind, value.to_string()))
}

/// Map one BM ban resource to an importable ban. `None` = no usable identifier
/// (counted, per decision F). The full resolved array + BM extras ride `meta`.
fn imported_ban(
    res: &Resource<BanAttrs>,
    ids_map: &HashMap<String, (String, String)>,
    list_id: &str,
) -> Option<ImportedBan> {
    let a = &res.attributes;
    let mut resolved: Vec<(String, String)> = Vec::new();
    let mut unresolved = 0u32;
    for ident in &a.identifiers {
        match ident {
            BanIdentifier::Ref(n) => match ids_map.get(&n.to_string()) {
                Some((kind, value)) => resolved.push((kind.clone(), value.clone())),
                None => unresolved += 1,
            },
            BanIdentifier::Manual(m) => resolved.push((m.kind.clone(), m.identifier.clone())),
            BanIdentifier::Other(_) => unresolved += 1,
        }
    }
    let (subject_type, subject_value) = pick_primary(&resolved)?;
    let content_hash =
        ban_content_hash(a.reason.as_deref(), a.expires, &resolved, a.note.as_deref());
    let meta = serde_json::json!({
        "uid": a.uid,
        "note": a.note,
        "org_wide": a.org_wide,
        "auto_add_enabled": a.auto_add_enabled,
        "native_enabled": a.native_enabled,
        "identifiers": resolved
            .iter()
            .map(|(kind, value)| serde_json::json!({ "type": kind, "value": value }))
            .collect::<Vec<_>>(),
        "unresolved_identifiers": unresolved,
        "ban_list": list_id,
        "bm_server": res.rel_id("server"),
        "bm_player": res.rel_id("player"),
    });
    Some(ImportedBan {
        external_id: res.id.clone(),
        subject_type: subject_type.to_string(),
        subject_value,
        reason: a.reason.clone(),
        issued_at: a.timestamp.unwrap_or_else(Utc::now),
        expires_at: a.expires,
        content_hash,
        meta,
    })
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

        execute_job(&pool, &client, &conn, job, PEPPER, &AtomicBool::new(false)).await;

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

        execute_job(&pool, &client, &conn, job, PEPPER, &AtomicBool::new(false)).await;

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

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(input: &[(&str, &str)]) -> Vec<(String, String)> {
        input
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn primary_identifier_precedence() {
        let picked = pick_primary(&pairs(&[
            ("ip", "1.2.3.4"),
            ("BEGUID", "beguid-1"),
            ("steamID", "76561198000000001"),
        ]))
        .unwrap();
        assert_eq!(picked, ("steam", "76561198000000001".to_string()));

        let picked = pick_primary(&pairs(&[("ip", "1.2.3.4"), ("eosID", "eos-1")])).unwrap();
        assert_eq!(picked.0, "eos");

        assert!(pick_primary(&pairs(&[("unknownKind", "x")])).is_none());
        assert!(pick_primary(&[]).is_none());
    }

    #[test]
    fn ban_without_usable_identifier_is_skipped() {
        let res: Resource<BanAttrs> = serde_json::from_value(serde_json::json!({
            "type": "ban",
            "id": "b1",
            "attributes": { "identifiers": [ {"unexpected": 1} ] }
        }))
        .unwrap();
        assert!(imported_ban(&res, &HashMap::new(), "l1").is_none());
    }

    #[test]
    fn numeric_refs_resolve_through_included_map() {
        let res: Resource<BanAttrs> = serde_json::from_value(serde_json::json!({
            "type": "ban",
            "id": "b2",
            "attributes": {
                "reason": "cheating",
                "identifiers": [7, {"type": "ip", "identifier": "9.9.9.9"}]
            },
            "relationships": { "banList": {"data": {"type": "banList", "id": "l1"}} }
        }))
        .unwrap();
        let mut map = HashMap::new();
        map.insert(
            "7".to_string(),
            ("steamID".to_string(), "76561198000000009".to_string()),
        );
        let ban = imported_ban(&res, &map, "l1").expect("importable");
        assert_eq!(ban.subject_type, "steam");
        assert_eq!(ban.subject_value, "76561198000000009");
        let idents = ban.meta.get("identifiers").unwrap().as_array().unwrap();
        assert_eq!(idents.len(), 2, "meta keeps the full array");
    }
}
