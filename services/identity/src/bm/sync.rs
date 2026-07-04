//! Inbound sync loops (plan decision H). BM exposes no last-modified field and no ban
//! webhooks, so staying in sync means:
//!
//!   * **tail poll** (default 60s): newest-first walk per enabled list, stopping at
//!     the first page that introduces nothing new or changed. Catches new bans within
//!     a tick at ~1 request per list when idle.
//!   * **full re-scan** (default 15 min): the import iterator re-run end to end.
//!     Content-hash diffs catch edits; absence catches deletes, which revoke locally,
//!     but only after a COMPLETE scan (an aborted scan must never mass-revoke).
//!
//! Both loops run inside the per-connection runner, sharing its rate-limited client
//! and pausing while an import job executes.

use super::mapping;
use crate::domain::bm::{self, BmConnection};
use crate::error::AppError;
use chrono::{DateTime, Utc};
use cupboard_bmapi::types::{included_identifier_map, BanAttrs};
use cupboard_bmapi::{BmClient, BmError};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

pub(crate) struct SyncSettings {
    pub tail: Duration,
    pub rescan: Duration,
}

/// Cadences from the connection's settings jsonb, clamped to sane bounds.
pub(crate) fn settings_from(settings: &serde_json::Value) -> SyncSettings {
    let secs = |key: &str, default: u64, min: u64, max: u64| {
        settings
            .get(key)
            .and_then(|v| v.as_u64())
            .unwrap_or(default)
            .clamp(min, max)
    };
    SyncSettings {
        tail: Duration::from_secs(secs("tail_secs", 60, 15, 3_600)),
        rescan: Duration::from_secs(secs("rescan_secs", 900, 60, 86_400)),
    }
}

pub(crate) enum SyncError {
    Bm(BmError),
    App(AppError),
    /// The lease moved mid-scan; stop without sweeping.
    LostClaim,
}

impl SyncError {
    pub(crate) fn is_auth(&self) -> bool {
        matches!(self, SyncError::Bm(e) if e.is_auth())
    }
    /// Tenant-visible message (surfaced in `sync_error`): internals stay generic.
    pub(crate) fn message(&self) -> String {
        match self {
            SyncError::Bm(e) => e.to_string(),
            SyncError::App(_) => "internal error; see service logs".into(),
            SyncError::LostClaim => "claim lost mid-sync".into(),
        }
    }

    /// Full detail for logs.
    pub(crate) fn detail(&self) -> String {
        match self {
            SyncError::Bm(e) => e.to_string(),
            SyncError::App(e) => format!("{e:?}"),
            SyncError::LostClaim => "claim lost mid-sync".into(),
        }
    }
}

impl From<BmError> for SyncError {
    fn from(e: BmError) -> Self {
        SyncError::Bm(e)
    }
}
impl From<AppError> for SyncError {
    fn from(e: AppError) -> Self {
        SyncError::App(e)
    }
}
impl From<sqlx::Error> for SyncError {
    fn from(e: sqlx::Error) -> Self {
        SyncError::App(e.into())
    }
}

/// A completed scan swept; an aborted one must record nothing (a partial scan is not
/// a scan).
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ScanOutcome {
    Completed,
    /// Sync was toggled off (or the connection vanished) mid-scan: stopped early,
    /// sweep skipped, not an error.
    Aborted,
}

/// One tail tick. Newest-first per list; a page that inserted/updated nothing means
/// mapped territory was reached. `deep` ignores that stop condition and walks every
/// page: the runner requests it after a failed tick, because a committed page 1 would
/// otherwise hide a stranded backlog below it until the next re-scan. (A page
/// consisting entirely of unmappable bans also stops a shallow walk early; the
/// re-scan covers anything below it.)
pub(crate) async fn tail_poll(
    pool: &sqlx::PgPool,
    client: &BmClient,
    conn: &BmConnection,
    pepper: &[u8],
    claimer: &str,
    deep: bool,
) -> Result<(), SyncError> {
    let lists = bm::import_enabled_list_ids_pool(pool, conn.tenant_id).await?;
    for list_id in &lists {
        let mut url = client.bans_first_page(list_id);
        loop {
            let doc = client.list_page::<BanAttrs>(&url).await?;
            let ids_map = included_identifier_map(&doc.included);
            let (page, _skipped) = mapping::imported_ban_page(&doc.data, &ids_map, list_id);

            let mut tx = pool.begin().await?;
            // Fenced like the import path's per-page save: a stale runner must
            // roll its page back, not race the new lease holder's writes.
            if !bm::claim_held_in_tx(&mut tx, conn.id, claimer).await? {
                return Err(SyncError::LostClaim);
            }
            let outcome = bm::apply_ban_page(&mut tx, conn.tenant_id, pepper, &page).await?;
            tx.commit().await?;
            if outcome.inserted + outcome.updated > 0 {
                tracing::info!(tenant = %conn.tenant_id, list = %list_id,
                    inserted = outcome.inserted, updated = outcome.updated,
                    conflicts = outcome.conflicts, "tail poll applied changes");
            }
            match doc.links.next {
                Some(next) if deep || outcome.inserted + outcome.updated > 0 => url = next,
                _ => break,
            }
        }
    }
    Ok(())
}

/// One full re-scan: every enabled list walked completely (edits apply by hash diff),
/// then active bm-origin bans absent from the scan are revoked locally. The sweep is
/// the destructive half, so it only runs when the walk COMPLETED, the tenant still
/// has sync enabled, and this runner still holds the lease.
pub(crate) async fn full_rescan(
    pool: &sqlx::PgPool,
    client: &BmClient,
    conn: &BmConnection,
    pepper: &[u8],
    claimer: &str,
    lost_claim: &AtomicBool,
) -> Result<ScanOutcome, SyncError> {
    // DB clock, not app clock: the sweep compares against server-side `bm_seen_at`
    // stamps, so the watermark must come from the same clock.
    let scan_start: DateTime<Utc> = sqlx::query_scalar("SELECT now()")
        .fetch_one(pool)
        .await
        .map_err(AppError::from)?;
    let lists = bm::import_enabled_list_ids_pool(pool, conn.tenant_id).await?;

    for list_id in &lists {
        let mut url = client.bans_first_page(list_id);
        loop {
            if lost_claim.load(Ordering::Relaxed) {
                return Err(SyncError::LostClaim);
            }
            // Disabling sync must stop an in-flight scan: the toggle is the tenant's
            // emergency brake, and the sweep below is the part that bites.
            match bm::fresh_connection(pool, conn.id).await? {
                Some(cur) if cur.sync_enabled => {}
                _ => return Ok(ScanOutcome::Aborted),
            }

            let doc = client.list_page::<BanAttrs>(&url).await?;
            let ids_map = included_identifier_map(&doc.included);
            let (page, skipped) = mapping::imported_ban_page(&doc.data, &ids_map, list_id);

            let mut tx = pool.begin().await?;
            if !bm::claim_held_in_tx(&mut tx, conn.id, claimer).await? {
                return Err(SyncError::LostClaim);
            }
            bm::apply_ban_page(&mut tx, conn.tenant_id, pepper, &page).await?;
            // Every id BM returned counts as seen, INCLUDING unmappable ones
            // (skipped rows): a ban BM still serves must never be swept because one
            // fetch of it failed to map.
            if skipped > 0 {
                let all_ids: Vec<String> = doc.data.iter().map(|r| r.id.clone()).collect();
                bm::touch_seen_external_ids(&mut tx, conn.tenant_id, &all_ids).await?;
            }
            tx.commit().await?;

            match doc.links.next {
                Some(next) => url = next,
                None => break,
            }
        }
    }

    // Every list walked to the end: anything unseen no longer exists on BM.
    match bm::fresh_connection(pool, conn.id).await? {
        Some(cur) if cur.sync_enabled => {}
        _ => return Ok(ScanOutcome::Aborted),
    }
    let mut tx = pool.begin().await?;
    if !bm::claim_held_in_tx(&mut tx, conn.id, claimer).await? {
        return Err(SyncError::LostClaim);
    }
    let revoked =
        bm::revoke_bans_absent_from_scan(&mut tx, conn.tenant_id, scan_start, &lists).await?;
    tx.commit().await?;
    if !revoked.is_empty() {
        tracing::info!(tenant = %conn.tenant_id, count = revoked.len(),
            "re-scan revoked bans removed on BattleMetrics");
    }
    Ok(ScanOutcome::Completed)
}

#[cfg(test)]
mod e2e_tests {
    //! End-to-end sync against the in-process stub BM server + real Postgres. A "BM
    //! state change" is modeled by starting a fresh stub with the new dataset and a
    //! client pointed at it (the client is stateless; the DB carries all sync state).

    use super::*;
    use crate::domain::bm as bmdom;
    use cupboard_bmapi::stub::{StubBan, StubBanList, StubBm, StubData};
    use cupboard_domain::TenantId;
    use tokio::sync::OnceCell;
    use uuid::Uuid;

    static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
    static MIGRATED: OnceCell<()> = OnceCell::const_new();

    const TOKEN: &str = "stub-token";
    const PEPPER: &[u8] = b"bm-sync-pepper";
    /// Tests claim as this runner so the per-page lease fences pass.
    const CLAIMER: &str = "sync-e2e-runner";

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

    /// Connection + registered ban list `l1`; returns the runner-side connection.
    async fn seed_connection(pool: &sqlx::PgPool, tenant: TenantId) -> BmConnection {
        let view = bmdom::upsert_connection(
            pool,
            tenant,
            Uuid::new_v4(),
            bmdom::NewConnection {
                bm_org_id: "9999".into(),
                token_enc: vec![0],
                token_dek: vec![0],
            },
        )
        .await
        .expect("connect");
        sqlx::query(
            "INSERT INTO bm_ban_lists (tenant_id, external_id, name) VALUES ($1, 'l1', 'L1') \
             ON CONFLICT (tenant_id, external_id) DO NOTHING",
        )
        .bind(tenant.0)
        .execute(pool)
        .await
        .expect("list");
        // Enable sync + claim in one statement: the scan's abort check reads
        // sync_enabled, its page fences read claimed_by.
        sqlx::query(
            "UPDATE bm_connections SET sync_enabled = true, claimed_by = $2, \
             heartbeat_at = now() WHERE id = $1",
        )
        .bind(view.id)
        .bind(CLAIMER)
        .execute(pool)
        .await
        .expect("claim");
        bmdom::fresh_connection(pool, view.id)
            .await
            .expect("fresh")
            .expect("exists")
    }

    fn stub_ban(i: usize, reason: &str) -> StubBan {
        StubBan::new(
            "l1",
            format!("ban-{i}"),
            format!("uid{i:05}"),
            format!("2026-01-01T00:{:02}:{:02}Z", (i / 60) % 60, i % 60),
            reason,
        )
        .identifiers(serde_json::json!([
            {"type": "steamID", "identifier": format!("7656119800{i:06}")}
        ]))
    }

    fn stub_with(bans: Vec<StubBan>) -> StubData {
        StubData::new(TOKEN)
            .with_ban_list(StubBanList::new("l1", "L1"))
            .with_bans(bans)
    }

    async fn ban_state(
        pool: &sqlx::PgPool,
        tenant: TenantId,
        subject: &str,
    ) -> Option<(String, Option<String>, Option<String>)> {
        sqlx::query_as(
            "SELECT status, reason, revoke_reason FROM bans \
             WHERE tenant_id = $1 AND subject_value = $2",
        )
        .bind(tenant.0)
        .bind(subject)
        .fetch_optional(pool)
        .await
        .expect("ban state")
    }

    #[tokio::test]
    async fn tail_poll_picks_up_new_bans_cheaply() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP tail_poll_picks_up_new_bans_cheaply: TEST_DATABASE_URL unset");
            return;
        };
        let tenant = TenantId(Uuid::new_v4());
        let conn = seed_connection(&pool, tenant).await;

        // Baseline state on "BM": 30 bans, fully scanned in.
        let baseline: Vec<StubBan> = (0..30).map(|i| stub_ban(i, "cheating")).collect();
        let stub_a = StubBm::start(stub_with(baseline.clone())).await;
        let client_a = BmClient::new(stub_a.base_url(), TOKEN);
        full_rescan(
            &pool,
            &client_a,
            &conn,
            PEPPER,
            CLAIMER,
            &AtomicBool::new(false),
        )
        .await
        .map_err(|e| e.message())
        .expect("baseline scan");

        // BM gains one new ban (newest timestamp so it leads the -timestamp order).
        let mut with_new = baseline.clone();
        with_new.push(
            StubBan::new("l1", "ban-new", "uidnew", "2026-02-01T00:00:00Z", "fresh").identifiers(
                serde_json::json!([
                    {"type": "steamID", "identifier": "76561198009999999"}
                ]),
            ),
        );
        let stub_b = StubBm::start(stub_with(with_new)).await;
        let client_b = BmClient::new(stub_b.base_url(), TOKEN);
        tail_poll(&pool, &client_b, &conn, PEPPER, CLAIMER, false)
            .await
            .map_err(|e| e.message())
            .expect("tail");

        let state = ban_state(&pool, tenant, "76561198009999999").await;
        assert!(state.is_some(), "tail poll must land the new ban");
        assert_eq!(state.unwrap().0, "active");
        // 31 bans = one page; the tail stopped without walking further.
        let ban_requests = stub_b
            .requests()
            .iter()
            .filter(|r| r.path_and_query.starts_with("/bans"))
            .count();
        assert_eq!(ban_requests, 1, "idle-ish tail must stay cheap");
    }

    #[tokio::test]
    async fn rescan_applies_edits_and_revokes_deletes() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP rescan_applies_edits_and_revokes_deletes: TEST_DATABASE_URL unset");
            return;
        };
        let tenant = TenantId(Uuid::new_v4());
        let conn = seed_connection(&pool, tenant).await;

        let baseline: Vec<StubBan> = (0..30).map(|i| stub_ban(i, "cheating")).collect();
        let stub_a = StubBm::start(stub_with(baseline)).await;
        let client_a = BmClient::new(stub_a.base_url(), TOKEN);
        full_rescan(
            &pool,
            &client_a,
            &conn,
            PEPPER,
            CLAIMER,
            &AtomicBool::new(false),
        )
        .await
        .map_err(|e| e.message())
        .expect("baseline scan");

        // BM-side changes: ban-5 edited, ban-7 deleted.
        let changed: Vec<StubBan> = (0..30)
            .filter(|i| *i != 7)
            .map(|i| stub_ban(i, if i == 5 { "edited reason" } else { "cheating" }))
            .collect();
        let stub_b = StubBm::start(stub_with(changed)).await;
        let client_b = BmClient::new(stub_b.base_url(), TOKEN);
        full_rescan(
            &pool,
            &client_b,
            &conn,
            PEPPER,
            CLAIMER,
            &AtomicBool::new(false),
        )
        .await
        .map_err(|e| e.message())
        .expect("second scan");

        let edited = ban_state(&pool, tenant, "7656119800000005").await.unwrap();
        assert_eq!(
            (edited.0.as_str(), edited.1.as_deref()),
            ("active", Some("edited reason")),
            "edit must apply by hash diff"
        );
        let deleted = ban_state(&pool, tenant, "7656119800000007").await.unwrap();
        assert_eq!(deleted.0, "revoked", "absent ban must revoke locally");
        assert_eq!(deleted.2.as_deref(), Some("removed in BattleMetrics"));
        let untouched = ban_state(&pool, tenant, "7656119800000009").await.unwrap();
        assert_eq!(untouched.0, "active", "present bans stay active");
    }

    #[tokio::test]
    async fn unmappable_page_rows_survive_the_sweep() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP unmappable_page_rows_survive_the_sweep: TEST_DATABASE_URL unset");
            return;
        };
        let tenant = TenantId(Uuid::new_v4());
        let conn = seed_connection(&pool, tenant).await;

        // Baseline: the ban imports normally.
        let stub_a = StubBm::start(stub_with(vec![stub_ban(0, "cheating")])).await;
        let client_a = BmClient::new(stub_a.base_url(), TOKEN);
        full_rescan(
            &pool,
            &client_a,
            &conn,
            PEPPER,
            CLAIMER,
            &AtomicBool::new(false),
        )
        .await
        .map_err(|e| e.message())
        .expect("baseline scan");
        assert!(ban_state(&pool, tenant, "7656119800000000").await.is_some());

        // BM still serves the ban, but this fetch of it is unmappable (empty
        // identifiers): it must count as seen, not as deleted.
        let broken = StubBan::new(
            "l1",
            "ban-0",
            "uid00000",
            "2026-01-01T00:00:00Z",
            "cheating",
        )
        .identifiers(serde_json::json!([]));
        let stub_b = StubBm::start(stub_with(vec![broken])).await;
        let client_b = BmClient::new(stub_b.base_url(), TOKEN);
        let outcome = full_rescan(
            &pool,
            &client_b,
            &conn,
            PEPPER,
            CLAIMER,
            &AtomicBool::new(false),
        )
        .await
        .map_err(|e| e.message())
        .expect("second scan");
        assert_eq!(outcome, ScanOutcome::Completed);

        let state = ban_state(&pool, tenant, "7656119800000000").await.unwrap();
        assert_eq!(
            state.0, "active",
            "a ban BM still serves must never be swept because one fetch was unmappable"
        );
    }

    #[tokio::test]
    async fn disabled_sync_aborts_the_scan_without_sweeping() {
        let Some(pool) = setup().await else {
            eprintln!(
                "SKIP disabled_sync_aborts_the_scan_without_sweeping: TEST_DATABASE_URL unset"
            );
            return;
        };
        let tenant = TenantId(Uuid::new_v4());
        let conn = seed_connection(&pool, tenant).await;

        let stub_a = StubBm::start(stub_with(vec![stub_ban(0, "cheating")])).await;
        let client_a = BmClient::new(stub_a.base_url(), TOKEN);
        full_rescan(
            &pool,
            &client_a,
            &conn,
            PEPPER,
            CLAIMER,
            &AtomicBool::new(false),
        )
        .await
        .map_err(|e| e.message())
        .expect("baseline scan");

        // The ban is gone on BM, but the tenant hit the off switch: the scan must
        // abort without running the destructive sweep.
        sqlx::query("UPDATE bm_connections SET sync_enabled = false WHERE id = $1")
            .bind(conn.id)
            .execute(&pool)
            .await
            .unwrap();
        let stub_b = StubBm::start(stub_with(Vec::new())).await;
        let client_b = BmClient::new(stub_b.base_url(), TOKEN);
        let outcome = full_rescan(
            &pool,
            &client_b,
            &conn,
            PEPPER,
            CLAIMER,
            &AtomicBool::new(false),
        )
        .await
        .map_err(|e| e.message())
        .expect("aborted scan");
        assert_eq!(outcome, ScanOutcome::Aborted);

        let state = ban_state(&pool, tenant, "7656119800000000").await.unwrap();
        assert_eq!(state.0, "active", "an aborted scan must not sweep");
    }

    #[tokio::test]
    async fn sweep_only_touches_scanned_lists() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP sweep_only_touches_scanned_lists: TEST_DATABASE_URL unset");
            return;
        };
        let tenant = TenantId(Uuid::new_v4());
        let conn = seed_connection(&pool, tenant).await;

        // A ban living in list l2, which is registered but import-disabled: the scan
        // never visits it, so the sweep must not revoke it.
        sqlx::query(
            "INSERT INTO bm_ban_lists (tenant_id, external_id, name, import_enabled) \
             VALUES ($1, 'l2', 'L2', false)",
        )
        .bind(tenant.0)
        .execute(&pool)
        .await
        .unwrap();
        let l2_ban = crate::domain::bm::ImportedBan {
            external_id: "l2-ban".into(),
            subject_type: "steam".into(),
            subject_value: "76561198012121212".into(),
            reason: Some("x".into()),
            issued_at: Utc::now(),
            expires_at: None,
            content_hash: vec![1, 2, 3],
            meta: serde_json::json!({ "ban_list": "l2" }),
        };
        let mut tx = pool.begin().await.unwrap();
        bmdom::apply_ban_page(&mut tx, tenant.0, PEPPER, std::slice::from_ref(&l2_ban))
            .await
            .unwrap();
        tx.commit().await.unwrap();

        // Scan l1 (empty on BM): the sweep runs but is scoped to l1.
        let stub = StubBm::start(stub_with(Vec::new())).await;
        let client = BmClient::new(stub.base_url(), TOKEN);
        full_rescan(
            &pool,
            &client,
            &conn,
            PEPPER,
            CLAIMER,
            &AtomicBool::new(false),
        )
        .await
        .map_err(|e| e.message())
        .expect("scan");

        let l2_state = ban_state(&pool, tenant, "76561198012121212").await.unwrap();
        assert_eq!(
            l2_state.0, "active",
            "a ban in an unscanned list must survive the sweep"
        );
    }
}
