//! Import job execution: walks the phase pipeline (servers -> ban_lists -> bans ->
//! players -> notes -> done), one BM page per DB transaction, persisting the cursor with
//! each page so a crash or claim takeover loses at most one page of work (plan decision
//! G). The servers/players/notes phases (PR4) are subset-gated by `conn.settings`.

use super::fleet_client::{FleetClient, FleetError, ImportedServer};
use super::mapping;
use crate::domain::bm::{self, BmConnection, ImportJob, JobWrite};
use crate::domain::ingest::resolve_or_create_player;
use crate::error::AppError;
use chrono::Utc;
use cupboard_bmapi::types::{
    included_identifier_map, BanAttrs, BanListAttrs, NoteAttrs, PlayerAttrs, Resource, ServerAttrs,
};
use cupboard_bmapi::{BmClient, BmError};
use cupboard_crypto::hmac_sha256;
use std::sync::atomic::{AtomicBool, Ordering};
use uuid::Uuid;

/// Longest text the import writes into fleet (server names) or the shared global identity
/// tables (player names): fleet caps names at 128 bytes, and the global name table is
/// unbounded, so a tag-stuffed BM hostname must be truncated rather than wedging the job.
const MAX_IMPORT_TEXT: usize = 128;

/// Truncate `s` to at most `max` bytes on a char boundary (never mid-UTF-8).
fn truncate_bytes(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Read a boolean import-subset toggle from `settings`, defaulting to on: a fresh
/// connection with `{}` settings imports every phase.
fn subset_enabled(settings: &serde_json::Value, key: &str) -> bool {
    settings.get(key).and_then(|v| v.as_bool()).unwrap_or(true)
}

/// One player's resolved `(kind, value)` identifiers paired with its BM resource, as the
/// players phase orders and walks a page.
type ResolvedPlayer<'a> = (Vec<(String, String)>, &'a Resource<PlayerAttrs>);

/// The steam identifier value in a resolved `(kind, value)` list, if any (matching is
/// steam-only today).
fn steam_identifier(idents: &[(String, String)]) -> Option<&str> {
    idents
        .iter()
        .find(|(kind, _)| kind == "steamID")
        .map(|(_, value)| value.as_str())
}

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
    /// The tenant paused or cancelled the job mid-slice: stop working it but KEEP the
    /// claim, so inbound/outbound sync (and any next job) carry on for this connection.
    JobGone,
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
#[allow(clippy::too_many_arguments)]
pub async fn execute_job(
    pool: &sqlx::PgPool,
    client: &BmClient,
    conn: &BmConnection,
    job: ImportJob,
    pepper: &[u8],
    lost_claim: &AtomicBool,
    claimer: &str,
    fleet: Option<&FleetClient>,
) -> RunnerSignal {
    let job_id = job.id;
    match run_phases(pool, client, conn, job, pepper, lost_claim, claimer, fleet).await {
        Ok(()) => RunnerSignal::Continue,
        Err(ExecError::LostClaim) => {
            tracing::info!(job = %job_id, "claim lost mid-import; new owner resumes from cursor");
            RunnerSignal::Stop
        }
        Err(ExecError::JobGone) => {
            // The tenant paused or cancelled it: we still hold the lease, so keep it and
            // let the runner drain the outbox / pick up sync work.
            tracing::info!(job = %job_id, "import job paused or cancelled by tenant; keeping the claim");
            RunnerSignal::Continue
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

/// Pages committed per `execute_job` call before yielding back to the runner loop.
/// The job stays `running` with its cursor persisted; the runner drains the outbox
/// (staff unbans must not wait hours behind a big import) and re-enters. Bigger than
/// any test fixture; small enough that the outbox gets airtime every ~20-40s.
const PAGES_PER_SLICE: usize = 20;

#[allow(clippy::too_many_arguments)]
async fn run_phases(
    pool: &sqlx::PgPool,
    client: &BmClient,
    conn: &BmConnection,
    job: ImportJob,
    pepper: &[u8],
    lost_claim: &AtomicBool,
    claimer: &str,
    fleet: Option<&FleetClient>,
) -> Result<(), ExecError> {
    match bm::mark_job_running(pool, job.id, claimer).await? {
        JobWrite::Applied => {}
        JobWrite::NotRunnable => return Err(ExecError::JobGone),
        JobWrite::LeaseLost => return Err(ExecError::LostClaim),
    }
    let mut phase = job.phase.clone();
    let mut cursor: Cursor = serde_json::from_value(job.cursor.clone()).unwrap_or_default();
    let mut counts = Counts::from_value(&job.phase_counts);
    let mut pages = 0usize;

    loop {
        if lost_claim.load(Ordering::Relaxed) {
            return Err(ExecError::LostClaim);
        }
        if pages >= PAGES_PER_SLICE {
            // Yield the slice: cursor and counts are already committed with the last
            // page; the runner re-enters through next_live_job.
            return Ok(());
        }
        match phase.as_str() {
            "servers" => {
                // Gated off, or no fleet target: advance with a counted reason. The
                // counts persist on the next phase's page save (or the final "done"
                // save), so nothing is lost.
                if !subset_enabled(&conn.settings, "import_servers") {
                    counts.inc("servers_skipped_disabled");
                    phase = "ban_lists".into();
                    continue;
                }
                let Some(fleet) = fleet else {
                    counts.inc("servers_skipped_unconfigured");
                    phase = "ban_lists".into();
                    continue;
                };
                let url = cursor
                    .next_url
                    .clone()
                    .unwrap_or_else(|| client.servers_first_page(&conn.bm_org_id));
                let doc = client.list_page::<ServerAttrs>(&url).await?;

                // The fleet upsert is an HTTP call, so it runs OUTSIDE the tx; its result
                // (the server uuid) is recorded in the tx. The map upsert is idempotent,
                // so a crash between the fleet call and the commit re-converges on re-run.
                let mut upserted: Vec<(String, Uuid, serde_json::Value)> = Vec::new();
                for res in &doc.data {
                    let a = &res.attributes;
                    let (Some(name), Some(ip)) = (
                        a.name.as_deref().map(str::trim).filter(|s| !s.is_empty()),
                        a.ip.as_deref().map(str::trim).filter(|s| !s.is_empty()),
                    ) else {
                        // No host to dial: fleet requires a non-empty rcon_host, so skip.
                        counts.inc("servers_skipped_incomplete");
                        continue;
                    };
                    // Sanitize BM's server-controlled fields so one bad record can't 400 the
                    // whole import: cap the name to fleet's 128-byte limit, and drop an
                    // out-of-range query port (fleet rejects 0/>65535) rather than sending it.
                    let name = truncate_bytes(name, MAX_IMPORT_TEXT);
                    let query_port = a.port_query.filter(|p| (1..=65535).contains(p));
                    let local_id = match fleet
                        .upsert_imported_server(&ImportedServer {
                            tenant_id: conn.tenant_id,
                            external_id: res.id.clone(),
                            name: name.to_string(),
                            rcon_host: ip.to_string(),
                            query_port,
                        })
                        .await
                    {
                        Ok(id) => id,
                        // A 4xx means this one server's payload is unusable: skip-and-count
                        // it, never fail the job (bans/players/notes must still run).
                        Err(FleetError::Rejected(msg)) => {
                            tracing::warn!(external_id = %res.id, error = %msg,
                                "fleet rejected an imported server; skipping it");
                            counts.inc("servers_skipped_invalid");
                            continue;
                        }
                        // A 5xx/transport error is transient: fail the job with the cursor
                        // kept so a re-run resumes from this page.
                        Err(FleetError::Transient(e)) => {
                            return Err(ExecError::App(AppError::Internal(e)))
                        }
                    };
                    let meta = serde_json::json!({ "name": name, "ip": ip, "port": a.port });
                    upserted.push((res.id.clone(), local_id, meta));
                }

                let mut tx = pool.begin().await?;
                for (external_id, local_id, meta) in &upserted {
                    bm::upsert_server_mapping(
                        &mut tx,
                        conn.tenant_id,
                        external_id,
                        *local_id,
                        meta,
                    )
                    .await?;
                    counts.inc("servers_imported");
                }
                cursor.next_url = doc.links.next.clone();
                if cursor.next_url.is_none() {
                    phase = "ban_lists".into();
                }
                save(&mut tx, job.id, &phase, &cursor, &counts, claimer).await?;
                tx.commit().await?;
                pages += 1;
            }

            "players" => {
                if !subset_enabled(&conn.settings, "import_players") {
                    counts.inc("players_skipped_disabled");
                    phase = "notes".into();
                    continue;
                }
                let url = cursor
                    .next_url
                    .clone()
                    .unwrap_or_else(|| client.players_first_page(&conn.bm_org_id));
                let doc = client.list_page::<PlayerAttrs>(&url).await?;
                let ids_map = included_identifier_map(&doc.included);

                // Resolve each player's identifiers once, then process the page in steam-id
                // order. resolve_or_create_player locks the shared (global, un-tenanted)
                // players/player_identifiers rows and the tx spans the whole page, so two
                // import runners touching the same global player (a steam id shared across
                // orgs) must take those row locks in ONE order or Postgres would abort one
                // on a deadlock; a stable sort by steam id gives every runner that order.
                let mut page: Vec<ResolvedPlayer> = doc
                    .data
                    .iter()
                    .map(|res| (mapping::resolved_player_identifiers(res, &ids_map), res))
                    .collect();
                page.sort_by(|(a, _), (b, _)| steam_identifier(a).cmp(&steam_identifier(b)));

                let mut tx = pool.begin().await?;
                for (idents, res) in &page {
                    let Some(steam_value) = steam_identifier(idents) else {
                        // Unmatchable without a steam id: no map row, no graph writes.
                        counts.inc("players_skipped_no_steam");
                        continue;
                    };
                    let obs = res.attributes.created_at.unwrap_or_else(Utc::now);
                    let steam_hash = hmac_sha256(steam_value.as_bytes(), pepper).to_vec();
                    let player_id =
                        resolve_or_create_player(&mut tx, steam_value, &steam_hash, obs)
                            .await
                            .map_err(|e| ExecError::App(AppError::Internal(e)))?;

                    // Cross-page/-run duplicate guard: a second BM record sharing this
                    // player's steam id (BM merge leftovers) resolves to the same Cupboard
                    // player, and mapping it again would collide on bm_sync_map's local_id
                    // unique index, which map_upsert_err would misread as a lost claim and
                    // wedge the import. Skip its mapping AND graph writes. The check runs in
                    // this tx, so a mapping written earlier on THIS page counts too.
                    if bm::player_mapped_to_other_external(
                        &mut tx,
                        conn.tenant_id,
                        player_id,
                        &res.id,
                    )
                    .await?
                    {
                        counts.inc("players_duplicate_steam");
                        continue;
                    }
                    counts.inc("players_matched");

                    if let Some(name) = res
                        .attributes
                        .name
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        // Bound the name: it lands in the shared, unbounded global name table.
                        bm::upsert_name_history(
                            &mut tx,
                            player_id,
                            truncate_bytes(name, MAX_IMPORT_TEXT),
                            obs,
                        )
                        .await?;
                    }
                    let mut wrote_ip = false;
                    for (kind, value) in idents {
                        if kind == "ip" && !value.is_empty() {
                            let hash = hmac_sha256(value.as_bytes(), pepper).to_vec();
                            bm::upsert_ip_signal(&mut tx, player_id, value, &hash, obs).await?;
                            wrote_ip = true;
                        }
                    }
                    // Compute alt-links from the imported IP evidence, exactly as native
                    // ingest does after a signal write; otherwise a shared IP established
                    // purely by import stays invisible until the player is next seen live.
                    // (No check_evasion here: importing history must not raise live-connect
                    // evasion alerts.)
                    if wrote_ip {
                        crate::domain::links::evaluate_links(&mut tx, player_id, obs)
                            .await
                            .map_err(|e| ExecError::App(AppError::Internal(e)))?;
                    }

                    // eos/beguid/others never become graph rows (matching is steam-only
                    // today); they ride the map meta so nothing is lost.
                    let meta = serde_json::json!({
                        "name": res.attributes.name,
                        "identifiers": idents
                            .iter()
                            .map(|(kind, value)| serde_json::json!({ "type": kind, "value": value }))
                            .collect::<Vec<_>>(),
                    });
                    bm::upsert_player_mapping(&mut tx, conn.tenant_id, &res.id, player_id, &meta)
                        .await
                        .map_err(map_upsert_err)?;
                }
                cursor.next_url = doc.links.next.clone();
                if cursor.next_url.is_none() {
                    // Notes keyset starts from the smallest player external id.
                    cursor.sub_id = None;
                    phase = "notes".into();
                }
                save(&mut tx, job.id, &phase, &cursor, &counts, claimer).await?;
                tx.commit().await?;
                pages += 1;
            }

            "notes" => {
                if !subset_enabled(&conn.settings, "import_notes") {
                    counts.inc("notes_skipped_disabled");
                    phase = "done".into();
                    continue;
                }
                // Keyset over player map rows by external id: cursor.sub_id is the last
                // player fully processed. cursor.next_url is the current player's next BM
                // note page (None = start that player from page 1). ONE BM note page per tx
                // (plan decision G), so a deep-page BM error loses at most one page and each
                // page counts against the slice budget, keeping the outbox airtime bound.
                let next =
                    bm::mapped_player_page(pool, conn.tenant_id, cursor.sub_id.as_deref(), 1)
                        .await?;
                let Some((external_id, player_id)) = next.into_iter().next() else {
                    phase = "done".into();
                    continue;
                };

                let url = cursor
                    .next_url
                    .clone()
                    .unwrap_or_else(|| client.player_notes_first_page(&external_id));
                let doc = client.list_page::<NoteAttrs>(&url).await?;

                let mut tx = pool.begin().await?;
                for res in &doc.data {
                    let created = res.attributes.created_at.unwrap_or_else(Utc::now);
                    let body = res.attributes.note.as_deref().map(str::trim).unwrap_or("");
                    if body.is_empty() {
                        counts.inc("notes_skipped_empty");
                        continue;
                    }
                    if bm::insert_imported_note(
                        &mut tx,
                        conn.tenant_id,
                        player_id,
                        &res.id,
                        body,
                        created,
                    )
                    .await
                    .map_err(map_upsert_err)?
                    {
                        counts.inc("notes_imported");
                    }
                }
                match doc.links.next.clone() {
                    // More note pages for this player: stay on it, resume from the next page.
                    Some(n) => cursor.next_url = Some(n),
                    // This player is done: advance the keyset to the next player.
                    None => {
                        cursor.sub_id = Some(external_id);
                        cursor.next_url = None;
                    }
                }
                save(&mut tx, job.id, &phase, &cursor, &counts, claimer).await?;
                tx.commit().await?;
                pages += 1;
            }

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
                        "players".into()
                    };
                }
                save(&mut tx, job.id, &phase, &cursor, &counts, claimer).await?;
                tx.commit().await?;
                pages += 1;
            }

            "bans" => {
                let Some(list_id) = cursor.sub_id.clone() else {
                    // No list to walk: fall through to the players phase, resetting the
                    // cursor so its keyset/next_url start fresh.
                    cursor = Cursor::default();
                    phase = "players".into();
                    continue;
                };
                let url = cursor
                    .next_url
                    .clone()
                    .unwrap_or_else(|| client.bans_first_page(&list_id));
                let doc = client.list_page::<BanAttrs>(&url).await?;
                let ids_map = included_identifier_map(&doc.included);
                let (page, skips) = mapping::imported_ban_page(&doc.data, &ids_map, &list_id);

                let mut tx = pool.begin().await?;
                let outcome = bm::apply_ban_page(&mut tx, conn.tenant_id, pepper, &page)
                    .await
                    .map_err(map_upsert_err)?;
                counts.add("bans_imported", outcome.inserted);
                counts.add("bans_updated", outcome.updated);
                counts.add("bans_unchanged", outcome.unchanged);
                counts.add("bans_skipped_no_identifier", skips.no_identifier);
                counts.add("bans_skipped_bad_expiry", skips.bad_expiry);
                counts.add("sync_conflicts", outcome.conflicts);
                cursor.next_url = doc.links.next.clone();
                if cursor.next_url.is_none() {
                    cursor.sub_id = cursor.pending.pop();
                    if cursor.sub_id.is_none() {
                        // All lists walked: on to players with a fresh cursor.
                        cursor = Cursor::default();
                        phase = "players".into();
                    }
                }
                save(&mut tx, job.id, &phase, &cursor, &counts, claimer).await?;
                tx.commit().await?;
                pages += 1;
            }

            _ => {
                // "done" (or anything unknown, defensively): terminal. Persist the final
                // counts first so a phase that only skipped (gated off, no page save of
                // its own) still surfaces its reason to the wizard.
                let mut tx = pool.begin().await?;
                save(&mut tx, job.id, "done", &cursor, &counts, claimer).await?;
                tx.commit().await?;
                match bm::finish_job(pool, job.id, "completed", None, claimer).await? {
                    JobWrite::Applied => {}
                    JobWrite::NotRunnable => return Err(ExecError::JobGone),
                    JobWrite::LeaseLost => return Err(ExecError::LostClaim),
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
    // Error out BEFORE the caller commits, so the whole page rolls back instead of racing
    // the new owner (lease moved) or persisting into a job the tenant just paused/cancelled.
    match bm::save_job_progress(tx, job_id, phase, &cursor_v, &counts.value(), claimer).await? {
        JobWrite::Applied => Ok(()),
        JobWrite::NotRunnable => Err(ExecError::JobGone),
        JobWrite::LeaseLost => Err(ExecError::LostClaim),
    }
}

#[cfg(test)]
mod e2e_tests {
    //! End-to-end import against the in-process stub BM server + real Postgres
    //! (TEST_DATABASE_URL; skip-pass otherwise, like every DB suite here).

    use super::*;
    use crate::domain::bm as bmdom;
    use cupboard_bmapi::stub::{
        StubBan, StubBanList, StubBm, StubData, StubNote, StubPlayer, StubServer,
    };
    use cupboard_domain::TenantId;
    use tokio::sync::OnceCell;

    const FLEET_TOKEN: &str = "fleet-internal-token";

    /// A globally-unique steam id per call, so identity-graph rows (global, un-tenanted)
    /// don't collide across tests sharing the DB.
    fn uniq_steam() -> String {
        format!("7656119{:010}", Uuid::new_v4().as_u128() % 10_000_000_000)
    }

    /// In-process fleet stub for the servers phase: checks `X-Internal-Token`, records
    /// each import body, and returns a deterministic uuid per external id (mirroring
    /// fleet's idempotent upsert-by-external-id).
    struct FleetStub {
        base: String,
        calls: std::sync::Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
    }

    async fn stub_fleet() -> FleetStub {
        use axum::response::IntoResponse as _;
        use std::collections::HashMap;
        use std::sync::{Arc, Mutex};
        let calls: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
        let ids: Arc<Mutex<HashMap<String, Uuid>>> = Arc::new(Mutex::new(HashMap::new()));
        let calls_h = calls.clone();
        let app = axum::Router::new().route(
            "/internal/servers/import",
            axum::routing::post(
                move |headers: axum::http::HeaderMap, body: axum::Json<serde_json::Value>| {
                    let calls = calls_h.clone();
                    let ids = ids.clone();
                    async move {
                        let ok = headers
                            .get("x-internal-token")
                            .and_then(|v| v.to_str().ok())
                            == Some(FLEET_TOKEN);
                        if !ok {
                            return (
                                axum::http::StatusCode::UNAUTHORIZED,
                                axum::Json(serde_json::json!({ "error": "bad token" })),
                            )
                                .into_response();
                        }
                        let ext = body.0["external_id"]
                            .as_str()
                            .unwrap_or_default()
                            .to_string();
                        // Sentinel for the 4xx-skip test: fleet rejects this one server.
                        if ext.starts_with("reject-4xx") {
                            return (
                                axum::http::StatusCode::BAD_REQUEST,
                                axum::Json(serde_json::json!({ "error": "bad server" })),
                            )
                                .into_response();
                        }
                        calls.lock().unwrap().push(body.0);
                        let id = *ids.lock().unwrap().entry(ext).or_insert_with(Uuid::new_v4);
                        axum::Json(serde_json::json!({ "id": id })).into_response()
                    }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        FleetStub {
            base: format!("http://{addr}"),
            calls: calls.clone(),
        }
    }

    fn fleet_client(stub: &FleetStub) -> FleetClient {
        FleetClient::new(
            reqwest::Client::new(),
            stub.base.clone(),
            FLEET_TOKEN.into(),
        )
    }

    async fn map_count(pool: &sqlx::PgPool, tenant: TenantId, entity: &str) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM bm_sync_map WHERE tenant_id = $1 AND entity_type = $2",
        )
        .bind(tenant.0)
        .bind(entity)
        .fetch_one(pool)
        .await
        .expect("map count")
    }

    async fn bm_notes_count(pool: &sqlx::PgPool, tenant: TenantId) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM player_notes WHERE tenant_id = $1 AND origin = 'bm'",
        )
        .bind(tenant.0)
        .fetch_one(pool)
        .await
        .expect("notes count")
    }

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
            sync_bans_outbound: false,
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
            None,
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
            None,
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
            None,
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
            None,
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
            None,
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

    #[tokio::test]
    async fn servers_phase_upserts_via_fleet_and_reruns_stable() {
        let Some(pool) = setup().await else {
            eprintln!(
                "SKIP servers_phase_upserts_via_fleet_and_reruns_stable: TEST_DATABASE_URL unset"
            );
            return;
        };
        let stub = StubBm::start(StubData::new(TOKEN).with_servers(vec![
                StubServer::new("bs-1", "Alpha")
                    .ip("10.0.0.1")
                    .port(28015)
                    .port_query(28017),
                StubServer::new("bs-2", "Bravo").ip("10.0.0.2").port_query(28018),
                StubServer::new("bs-3", "Charlie").ip("10.0.0.3"),
            ]))
        .await;
        let client = cupboard_bmapi::BmClient::new(stub.base_url(), TOKEN);
        let fleet_stub = stub_fleet().await;
        let fleet = fleet_client(&fleet_stub);
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
            Some(&fleet),
        )
        .await;

        let (status, phase, counts) = job_row(&pool, job_id).await;
        assert_eq!((status.as_str(), phase.as_str()), ("completed", "done"));
        assert_eq!(counts["servers_imported"], 3, "counts: {counts}");
        assert_eq!(
            fleet_stub.calls.lock().unwrap().len(),
            3,
            "one fleet upsert per server"
        );
        assert_eq!(map_count(&pool, tenant, "server").await, 3);
        // query_port rides through; rcon_port is omitted (fleet defaults it).
        let first = fleet_stub.calls.lock().unwrap()[0].clone();
        assert_eq!(first["rcon_host"], "10.0.0.1");
        assert_eq!(first["query_port"], 28017);

        // Re-run: fleet called again (idempotent server-side), map rows stable.
        bmdom::enqueue_import(&pool, tenant, Uuid::new_v4())
            .await
            .expect("re-enqueue");
        let rerun = bmdom::next_live_job(&pool, conn.id)
            .await
            .unwrap()
            .expect("second job");
        execute_job(
            &pool,
            &client,
            &conn,
            rerun,
            PEPPER,
            &AtomicBool::new(false),
            CLAIMER,
            Some(&fleet),
        )
        .await;
        assert_eq!(
            fleet_stub.calls.lock().unwrap().len(),
            6,
            "fleet re-upserts on re-run"
        );
        assert_eq!(
            map_count(&pool, tenant, "server").await,
            3,
            "map rows stable across re-run"
        );
    }

    #[tokio::test]
    async fn players_phase_lands_graph_rows_and_skips_no_steam() {
        let Some(pool) = setup().await else {
            eprintln!(
                "SKIP players_phase_lands_graph_rows_and_skips_no_steam: TEST_DATABASE_URL unset"
            );
            return;
        };
        let steam = uniq_steam();
        let stub = StubBm::start(StubData::new(TOKEN).with_players(vec![
                StubPlayer::new("p-1", "Neo")
                    .created_at("2026-01-02T03:04:05Z")
                    .identifier("steamID", &steam)
                    .identifier("ip", "203.0.113.5")
                    .identifier("eosID", "eos-abc"),
                // No steam identifier: unmatchable, must be skipped with no graph writes.
                StubPlayer::new("p-2", "Trinity").identifier("ip", "203.0.113.9"),
            ]))
        .await;
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
            None,
        )
        .await;

        let (status, _, counts) = job_row(&pool, job_id).await;
        assert_eq!(status, "completed");
        assert_eq!(counts["players_matched"], 1, "counts: {counts}");
        assert_eq!(counts["players_skipped_no_steam"], 1, "counts: {counts}");
        assert_eq!(
            map_count(&pool, tenant, "player").await,
            1,
            "only p-1 mapped"
        );

        let player_id: Uuid = sqlx::query_scalar(
            "SELECT player_id FROM player_identifiers WHERE type = 'steam' AND value = $1",
        )
        .bind(&steam)
        .fetch_one(&pool)
        .await
        .expect("player identifier created");
        let names: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM name_history WHERE player_id = $1 AND name = 'Neo'",
        )
        .bind(player_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(names, 1, "name lands in name_history");
        let ips: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM identity_signals WHERE player_id = $1 AND type = 'ip'",
        )
        .bind(player_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(ips, 1, "ip lands as an identity signal");
        let meta: serde_json::Value = sqlx::query_scalar(
            "SELECT meta FROM bm_sync_map WHERE tenant_id = $1 AND entity_type = 'player' \
             AND external_id = 'p-1'",
        )
        .bind(tenant.0)
        .fetch_one(&pool)
        .await
        .unwrap();
        let kinds: Vec<String> = meta["identifiers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["type"].as_str().unwrap().to_string())
            .collect();
        assert!(kinds.contains(&"eosID".to_string()), "eos rides the meta");

        // Re-run: resolve reuses, UNIQUEs dedup, no new rows anywhere.
        bmdom::enqueue_import(&pool, tenant, Uuid::new_v4())
            .await
            .expect("re-enqueue");
        let rerun = bmdom::next_live_job(&pool, conn.id)
            .await
            .unwrap()
            .expect("second job");
        execute_job(
            &pool,
            &client,
            &conn,
            rerun,
            PEPPER,
            &AtomicBool::new(false),
            CLAIMER,
            None,
        )
        .await;
        let players: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM player_identifiers WHERE type='steam' AND value=$1",
        )
        .bind(&steam)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(players, 1, "re-import must not duplicate the player");
        assert_eq!(map_count(&pool, tenant, "player").await, 1);
    }

    #[tokio::test]
    async fn notes_phase_imports_reruns_clean_and_resumes_from_cursor() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP notes_phase_imports_reruns_clean_and_resumes_from_cursor: TEST_DATABASE_URL unset");
            return;
        };
        let (s1, s2) = (uniq_steam(), uniq_steam());
        let ts = "2026-01-01T00:00:00Z";
        let stub = StubBm::start(
            StubData::new(TOKEN)
                .with_players(vec![
                    StubPlayer::new("pn-1", "P1").identifier("steamID", &s1),
                    StubPlayer::new("pn-2", "P2").identifier("steamID", &s2),
                ])
                .with_notes(
                    "pn-1",
                    vec![
                        StubNote::new("na-1", "alpha", ts),
                        StubNote::new("na-2", "beta", ts),
                        StubNote::new("na-3", "", ts), // empty body -> skipped
                    ],
                )
                .with_notes(
                    "pn-2",
                    vec![
                        StubNote::new("nb-1", "delta", ts),
                        StubNote::new("nb-2", "echo", ts),
                        StubNote::new("nb-3", "foxtrot", ts),
                    ],
                ),
        )
        .await;
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
            None,
        )
        .await;

        let (status, _, counts) = job_row(&pool, job_id).await;
        assert_eq!(status, "completed");
        assert_eq!(
            counts["notes_imported"], 5,
            "2 + 3 non-empty notes: {counts}"
        );
        assert_eq!(counts["notes_skipped_empty"], 1, "counts: {counts}");
        assert_eq!(bm_notes_count(&pool, tenant).await, 5);

        // Re-run: every note already mapped -> zero new rows.
        bmdom::enqueue_import(&pool, tenant, Uuid::new_v4())
            .await
            .expect("re-enqueue");
        let rerun = bmdom::next_live_job(&pool, conn.id)
            .await
            .unwrap()
            .expect("second job");
        execute_job(
            &pool,
            &client,
            &conn,
            rerun,
            PEPPER,
            &AtomicBool::new(false),
            CLAIMER,
            None,
        )
        .await;
        assert_eq!(
            bm_notes_count(&pool, tenant).await,
            5,
            "re-import must not duplicate notes"
        );

        // Resume mid-phase: cursor parked past pn-1, and pn-2's note artifacts wiped.
        // Only pn-2 must be revisited (keyset skips pn-1), re-creating its 3 notes.
        let pn2_player: Uuid = sqlx::query_scalar(
            "SELECT local_id FROM bm_sync_map WHERE tenant_id = $1 AND entity_type = 'player' \
             AND external_id = 'pn-2'",
        )
        .bind(tenant.0)
        .fetch_one(&pool)
        .await
        .unwrap();
        sqlx::query("DELETE FROM player_notes WHERE tenant_id = $1 AND player_id = $2")
            .bind(tenant.0)
            .bind(pn2_player)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "DELETE FROM bm_sync_map WHERE tenant_id = $1 AND entity_type = 'note' \
             AND external_id = ANY($2)",
        )
        .bind(tenant.0)
        .bind(vec!["nb-1".to_string(), "nb-2".into(), "nb-3".into()])
        .execute(&pool)
        .await
        .unwrap();
        assert_eq!(
            bm_notes_count(&pool, tenant).await,
            2,
            "pn-1's notes remain"
        );

        bmdom::enqueue_import(&pool, tenant, Uuid::new_v4())
            .await
            .expect("re-enqueue");
        let resume = bmdom::next_live_job(&pool, conn.id)
            .await
            .unwrap()
            .expect("resume job");
        let resume_id = resume.id;
        sqlx::query("UPDATE bm_import_jobs SET phase = 'notes', cursor = $2 WHERE id = $1")
            .bind(resume_id)
            .bind(serde_json::json!({ "sub_id": "pn-1" }))
            .execute(&pool)
            .await
            .unwrap();
        let resume = bmdom::next_live_job(&pool, conn.id)
            .await
            .unwrap()
            .expect("resumable job");
        assert_eq!(resume.phase, "notes");

        execute_job(
            &pool,
            &client,
            &conn,
            resume,
            PEPPER,
            &AtomicBool::new(false),
            CLAIMER,
            None,
        )
        .await;
        let (status, phase, counts) = job_row(&pool, resume_id).await;
        assert_eq!((status.as_str(), phase.as_str()), ("completed", "done"));
        assert_eq!(
            counts["notes_imported"], 3,
            "only pn-2 reprocessed (keyset skipped pn-1): {counts}"
        );
        assert_eq!(
            bm_notes_count(&pool, tenant).await,
            5,
            "pn-2's 3 notes re-created; pn-1's 2 untouched"
        );
    }

    #[tokio::test]
    async fn subset_disables_players_phase() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP subset_disables_players_phase: TEST_DATABASE_URL unset");
            return;
        };
        let stub = StubBm::start(StubData::new(TOKEN).with_players(vec![
            StubPlayer::new("dp-1", "Nobody").identifier("steamID", uniq_steam()),
        ]))
        .await;
        let client = cupboard_bmapi::BmClient::new(stub.base_url(), TOKEN);
        let tenant = TenantId(Uuid::new_v4());
        let (mut conn, job) = seed_job(&pool, tenant).await;
        // Runner-side settings gate the phase; the DB row need not change.
        conn.settings = serde_json::json!({ "import_players": false });
        let job_id = job.id;

        execute_job(
            &pool,
            &client,
            &conn,
            job,
            PEPPER,
            &AtomicBool::new(false),
            CLAIMER,
            None,
        )
        .await;

        let (status, phase, counts) = job_row(&pool, job_id).await;
        assert_eq!((status.as_str(), phase.as_str()), ("completed", "done"));
        assert_eq!(counts["players_skipped_disabled"], 1, "counts: {counts}");
        assert!(
            counts.get("players_matched").is_none(),
            "no players imported when disabled: {counts}"
        );
        assert_eq!(
            map_count(&pool, tenant, "player").await,
            0,
            "a disabled phase writes nothing"
        );
    }

    #[tokio::test]
    async fn full_pipeline_all_phases_complete() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP full_pipeline_all_phases_complete: TEST_DATABASE_URL unset");
            return;
        };
        let steam = uniq_steam();
        let stub = StubBm::start(
            StubData::new(TOKEN)
                .with_servers(vec![StubServer::new("fs-1", "Srv")
                    .ip("10.1.1.1")
                    .port_query(28017)])
                .with_ban_list(StubBanList::new("l1", "Main"))
                .with_bans(vec![StubBan::new(
                    "l1",
                    "fb-1",
                    "fuid-1",
                    "2026-01-01T00:00:00Z",
                    "cheating",
                )
                .identifiers(serde_json::json!([
                    {"type": "steamID", "identifier": steam}
                ]))])
                .with_players(vec![
                    StubPlayer::new("fp-1", "Player").identifier("steamID", &steam)
                ])
                .with_notes(
                    "fp-1",
                    vec![StubNote::new(
                        "fn-1",
                        "watch this one",
                        "2026-01-01T00:00:00Z",
                    )],
                ),
        )
        .await;
        let client = cupboard_bmapi::BmClient::new(stub.base_url(), TOKEN);
        let fleet_stub = stub_fleet().await;
        let fleet = fleet_client(&fleet_stub);
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
            Some(&fleet),
        )
        .await;

        let (status, phase, counts) = job_row(&pool, job_id).await;
        assert_eq!((status.as_str(), phase.as_str()), ("completed", "done"));
        assert_eq!(counts["servers_imported"], 1, "counts: {counts}");
        assert_eq!(counts["ban_lists"], 1, "counts: {counts}");
        assert_eq!(counts["bans_imported"], 1, "counts: {counts}");
        assert_eq!(counts["players_matched"], 1, "counts: {counts}");
        assert_eq!(counts["notes_imported"], 1, "counts: {counts}");
        assert_eq!(map_count(&pool, tenant, "server").await, 1);
        assert_eq!(map_count(&pool, tenant, "player").await, 1);
        assert_eq!(ban_count(&pool, tenant).await, 1);
        assert_eq!(bm_notes_count(&pool, tenant).await, 1);
    }

    #[tokio::test]
    async fn native_recency_and_signal_count_survive_import() {
        let Some(pool) = setup().await else {
            eprintln!(
                "SKIP native_recency_and_signal_count_survive_import: TEST_DATABASE_URL unset"
            );
            return;
        };
        let steam = uniq_steam();
        let ip = "203.0.113.77";
        let stub = StubBm::start(StubData::new(TOKEN).with_players(vec![
            // BM's createdAt is years in the past; it must never rewind live recency.
            StubPlayer::new("rp-1", "OldTimer")
                .created_at("2020-01-01T00:00:00Z")
                .identifier("steamID", &steam)
                .identifier("ip", ip),
        ]))
        .await;
        let client = cupboard_bmapi::BmClient::new(stub.base_url(), TOKEN);
        let tenant = TenantId(Uuid::new_v4());
        let (conn, job) = seed_job(&pool, tenant).await;

        execute_job(
            &pool,
            &client,
            &conn,
            job,
            PEPPER,
            &AtomicBool::new(false),
            CLAIMER,
            None,
        )
        .await;

        let player_id: Uuid = sqlx::query_scalar(
            "SELECT player_id FROM player_identifiers WHERE type='steam' AND value=$1",
        )
        .bind(&steam)
        .fetch_one(&pool)
        .await
        .expect("player created");

        // Simulate live native activity AFTER the import: recency advances, sightings accrue.
        sqlx::query("UPDATE players SET last_seen_at = now() WHERE id = $1")
            .bind(player_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE identity_signals SET last_seen_at = now(), sighting_count = 5 \
             WHERE player_id = $1 AND type = 'ip'",
        )
        .bind(player_id)
        .execute(&pool)
        .await
        .unwrap();

        // Re-import the same player (BM createdAt still 2020): must not rewind recency, and
        // must not count the re-import as a sighting.
        bmdom::enqueue_import(&pool, tenant, Uuid::new_v4())
            .await
            .expect("re-enqueue");
        let rerun = bmdom::next_live_job(&pool, conn.id)
            .await
            .unwrap()
            .expect("second job");
        execute_job(
            &pool,
            &client,
            &conn,
            rerun,
            PEPPER,
            &AtomicBool::new(false),
            CLAIMER,
            None,
        )
        .await;

        let (last_seen_recent, sightings): (bool, i32) = sqlx::query_as(
            "SELECT (p.last_seen_at > now() - interval '1 hour'), s.sighting_count::int4 \
             FROM players p JOIN identity_signals s \
               ON s.player_id = p.id AND s.type = 'ip' \
             WHERE p.id = $1",
        )
        .bind(player_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(
            last_seen_recent,
            "import must not rewind players.last_seen_at to BM's historical createdAt"
        );
        assert_eq!(
            sightings, 5,
            "re-import must not bump sighting_count (an import is not a sighting)"
        );
    }

    #[tokio::test]
    async fn players_phase_skips_cross_run_duplicate_steam() {
        let Some(pool) = setup().await else {
            eprintln!(
                "SKIP players_phase_skips_cross_run_duplicate_steam: TEST_DATABASE_URL unset"
            );
            return;
        };
        let steam = uniq_steam();
        let tenant = TenantId(Uuid::new_v4());
        let (conn, _) = seed_job(&pool, tenant).await;

        // Run 1: only dup-1 exists on BM, so it maps to a fresh Cupboard player.
        let stub1 = StubBm::start(StubData::new(TOKEN).with_players(vec![
            StubPlayer::new("dup-1", "First").identifier("steamID", &steam),
        ]))
        .await;
        let client1 = cupboard_bmapi::BmClient::new(stub1.base_url(), TOKEN);
        let job1 = bmdom::next_live_job(&pool, conn.id)
            .await
            .unwrap()
            .expect("first job");
        execute_job(
            &pool,
            &client1,
            &conn,
            job1,
            PEPPER,
            &AtomicBool::new(false),
            CLAIMER,
            None,
        )
        .await;
        assert_eq!(map_count(&pool, tenant, "player").await, 1);

        // Run 2: a SECOND BM record now shares dup-1's steam id (a BM merge leftover). The
        // committed dup-1 mapping must make dup-2 a counted duplicate, not a job-wedging
        // unique-index violation misread as a lost claim.
        let stub2 = StubBm::start(StubData::new(TOKEN).with_players(vec![
            StubPlayer::new("dup-1", "First").identifier("steamID", &steam),
            StubPlayer::new("dup-2", "Second").identifier("steamID", &steam),
        ]))
        .await;
        let client2 = cupboard_bmapi::BmClient::new(stub2.base_url(), TOKEN);
        bmdom::enqueue_import(&pool, tenant, Uuid::new_v4())
            .await
            .expect("re-enqueue");
        let job2 = bmdom::next_live_job(&pool, conn.id)
            .await
            .unwrap()
            .expect("second job");
        let job2_id = job2.id;
        execute_job(
            &pool,
            &client2,
            &conn,
            job2,
            PEPPER,
            &AtomicBool::new(false),
            CLAIMER,
            None,
        )
        .await;

        let (status, phase, counts) = job_row(&pool, job2_id).await;
        assert_eq!(
            (status.as_str(), phase.as_str()),
            ("completed", "done"),
            "a duplicate steam id must not wedge the job"
        );
        assert_eq!(counts["players_duplicate_steam"], 1, "counts: {counts}");
        assert_eq!(
            map_count(&pool, tenant, "player").await,
            1,
            "the duplicate BM record gets no second map row"
        );
    }

    #[tokio::test]
    async fn servers_phase_sanitizes_long_name_and_bad_port() {
        let Some(pool) = setup().await else {
            eprintln!(
                "SKIP servers_phase_sanitizes_long_name_and_bad_port: TEST_DATABASE_URL unset"
            );
            return;
        };
        let stub = StubBm::start(StubData::new(TOKEN).with_servers(vec![
                StubServer::new("bs-long", "N".repeat(200))
                    .ip("10.0.0.9")
                    .port_query(28017),
                StubServer::new("bs-badport", "Shorty")
                    .ip("10.0.0.10")
                    .port_query(99999),
            ]))
        .await;
        let client = cupboard_bmapi::BmClient::new(stub.base_url(), TOKEN);
        let fleet_stub = stub_fleet().await;
        let fleet = fleet_client(&fleet_stub);
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
            Some(&fleet),
        )
        .await;

        // A 200-char name and an out-of-range query port must be sanitized, not fatal: both
        // servers import and the pipeline reaches 'done'.
        let (status, phase, counts) = job_row(&pool, job_id).await;
        assert_eq!((status.as_str(), phase.as_str()), ("completed", "done"));
        assert_eq!(counts["servers_imported"], 2, "counts: {counts}");
        let calls = fleet_stub.calls.lock().unwrap().clone();
        let long = calls
            .iter()
            .find(|c| c["external_id"] == "bs-long")
            .expect("long-named server sent");
        assert!(
            long["name"].as_str().unwrap().len() <= 128,
            "the over-long name is truncated to fleet's 128-byte limit"
        );
        let bad = calls
            .iter()
            .find(|c| c["external_id"] == "bs-badport")
            .expect("bad-port server sent");
        assert!(
            bad["query_port"].is_null(),
            "the out-of-range query port is nulled out, not sent"
        );
    }

    #[tokio::test]
    async fn servers_phase_skips_fleet_4xx_as_counted_skip() {
        let Some(pool) = setup().await else {
            eprintln!(
                "SKIP servers_phase_skips_fleet_4xx_as_counted_skip: TEST_DATABASE_URL unset"
            );
            return;
        };
        let stub = StubBm::start(StubData::new(TOKEN).with_servers(vec![
                StubServer::new("ok-1", "Good").ip("10.0.0.1").port_query(28017),
                StubServer::new("reject-4xx-1", "Bad").ip("10.0.0.2").port_query(28017),
            ]))
        .await;
        let client = cupboard_bmapi::BmClient::new(stub.base_url(), TOKEN);
        let fleet_stub = stub_fleet().await;
        let fleet = fleet_client(&fleet_stub);
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
            Some(&fleet),
        )
        .await;

        // A fleet 4xx on one server is a counted skip, never a job failure: the other
        // server still imports and the job completes.
        let (status, phase, counts) = job_row(&pool, job_id).await;
        assert_eq!((status.as_str(), phase.as_str()), ("completed", "done"));
        assert_eq!(counts["servers_imported"], 1, "counts: {counts}");
        assert_eq!(counts["servers_skipped_invalid"], 1, "counts: {counts}");
        assert_eq!(map_count(&pool, tenant, "server").await, 1);
    }

    #[tokio::test]
    async fn imported_shared_ip_forms_a_link() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP imported_shared_ip_forms_a_link: TEST_DATABASE_URL unset");
            return;
        };
        let ip = "203.0.113.88";
        let (s1, s2) = (uniq_steam(), uniq_steam());
        let stub = StubBm::start(StubData::new(TOKEN).with_players(vec![
            StubPlayer::new("lp-1", "A").identifier("steamID", &s1).identifier("ip", ip),
            StubPlayer::new("lp-2", "B").identifier("steamID", &s2).identifier("ip", ip),
        ]))
        .await;
        let client = cupboard_bmapi::BmClient::new(stub.base_url(), TOKEN);
        let tenant = TenantId(Uuid::new_v4());
        let (conn, job) = seed_job(&pool, tenant).await;

        execute_job(
            &pool,
            &client,
            &conn,
            job,
            PEPPER,
            &AtomicBool::new(false),
            CLAIMER,
            None,
        )
        .await;

        let ids: Vec<Uuid> = sqlx::query_scalar(
            "SELECT player_id FROM player_identifiers WHERE type='steam' AND value = ANY($1)",
        )
        .bind(vec![s1.clone(), s2.clone()])
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(ids.len(), 2, "both imported players exist");
        let (lo, hi) = if ids[0] < ids[1] {
            (ids[0], ids[1])
        } else {
            (ids[1], ids[0])
        };
        let links: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM player_links WHERE player_a = $1 AND player_b = $2",
        )
        .bind(lo)
        .bind(hi)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            links, 1,
            "an IP shared purely through import must still form an alt link"
        );
    }

    #[tokio::test]
    async fn cancel_keeps_claim_and_imports_nothing() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP cancel_keeps_claim_and_imports_nothing: TEST_DATABASE_URL unset");
            return;
        };
        let stub = StubBm::start(stub_data(5)).await;
        let client = cupboard_bmapi::BmClient::new(stub.base_url(), TOKEN);
        let tenant = TenantId(Uuid::new_v4());
        let (conn, job) = seed_job(&pool, tenant).await;
        let job_id = job.id;

        // The tenant cancels between claim and the runner marking the job running.
        sqlx::query(
            "UPDATE bm_import_jobs SET status = 'cancelled', finished_at = now() WHERE id = $1",
        )
        .bind(job_id)
        .execute(&pool)
        .await
        .unwrap();

        let signal = execute_job(
            &pool,
            &client,
            &conn,
            job,
            PEPPER,
            &AtomicBool::new(false),
            CLAIMER,
            None,
        )
        .await;

        assert!(
            matches!(signal, RunnerSignal::Continue),
            "a tenant cancel must not be misread as a lost claim (which would Stop the runner)"
        );
        assert_eq!(
            ban_count(&pool, tenant).await,
            0,
            "a cancelled job imports nothing"
        );
        let (status, _, _) = job_row(&pool, job_id).await;
        assert_eq!(status, "cancelled", "the job stays cancelled");
        let claimed: Option<String> =
            sqlx::query_scalar("SELECT claimed_by FROM bm_connections WHERE id = $1")
                .bind(conn.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            claimed.as_deref(),
            Some(CLAIMER),
            "the connection stays claimed so inbound/outbound sync continue"
        );
    }
}
