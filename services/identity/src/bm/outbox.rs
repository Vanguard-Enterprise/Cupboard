//! Outbound drain (decisions J/K): pushes queued Cupboard ban changes to BM through
//! the runner's rate-limited client.
//!
//! Create -> `POST /bans` on the tenant's target list; revoke -> `DELETE /bans/{id}`
//! with a `PATCH expires=now` fallback when the token lacks `ban:delete`. Every
//! successful write stores the response's canonical hash in the sync map: that is the
//! echo guard that keeps the inbound loops from re-importing our own writes.
//!
//! Discipline that keeps the queue safe:
//!   * Ordering: a revoke SUPERSEDES any unsettled create for the same ban (the
//!     create is verified-then-abandoned first), so a backed-off create retry can
//!     never resurrect a ban after its revoke drained.
//!   * Lease fence: claiming an op checks the connection lease and the op's own
//!     drainable status, so a stale runner resuming after a takeover cannot flip a
//!     settled op back and double-push it.
//!   * Ambiguity: BM has no idempotency keys, so an ambiguous create (timeout after
//!     send, 5xx) parks as `needs_verify` and the next attempt existence-checks
//!     before re-issuing. The check only adopts a ban that plausibly IS our push:
//!     same subject, hash-normalized-equal reason, same expiry, and not already
//!     mapped to a different local ban.

use super::sync::SyncError;
use crate::domain::bm::{self, BmConnection, OutboxOp};
use chrono::{DateTime, Utc};
use cupboard_bmapi::types::{included_identifier_map, BanAttrs, BanIdentifier, Resource};
use cupboard_bmapi::{ban_content_hash, BmClient, BmError, NewBmBan};
use std::collections::HashMap;
use std::time::Duration;
use uuid::Uuid;

const DRAIN_BATCH: i64 = 25;
const MAX_PUSH_ATTEMPTS: i32 = 10;

/// 30s doubling to a 15-minute ceiling.
fn retry_backoff(attempts: i32) -> Duration {
    let secs = 30u64.saturating_mul(1u64 << attempts.clamp(0, 5) as u32);
    Duration::from_secs(secs.min(900))
}

/// Drain one batch of due ops. Auth errors abort the drain (the runner applies the
/// token-fence discipline); per-op failures settle into the op's own status.
pub(crate) async fn drain(
    pool: &sqlx::PgPool,
    client: &BmClient,
    conn: &BmConnection,
    claimer: &str,
) -> Result<usize, SyncError> {
    let ops = bm::due_outbox_ops(pool, conn.tenant_id, DRAIN_BATCH).await?;
    if ops.is_empty() {
        return Ok(0);
    }
    // The endpoint refuses to enable outbound without a target list; an op somehow
    // drained without one waits rather than failing terminally.
    let Some(target_list) = conn
        .settings
        .get("target_ban_list")
        .and_then(|v| v.as_str())
        .map(str::to_string)
    else {
        return Err(SyncError::App(crate::error::AppError::BadRequest(
            "outbound ops queued but no target ban list is configured".into(),
        )));
    };

    let count = ops.len();
    for op in ops {
        let resumed_ambiguous = op.status == "needs_verify" || op.status == "inflight";
        if !bm::mark_outbox_inflight(pool, op.id, conn.id, claimer).await? {
            // Lease moved, or the op settled under a new owner: stop draining.
            return Err(SyncError::LostClaim);
        }
        match op.op.as_str() {
            "create" => {
                push_create(pool, client, conn, &target_list, &op, resumed_ambiguous).await?
            }
            _ => push_delete(pool, client, conn, &target_list, &op).await?,
        }
    }
    Ok(count)
}

fn payload_expires(payload: &serde_json::Value) -> Option<DateTime<Utc>> {
    payload
        .get("expires_at")
        .and_then(|v| v.as_str())
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.with_timezone(&Utc))
}

async fn push_create(
    pool: &sqlx::PgPool,
    client: &BmClient,
    conn: &BmConnection,
    target_list: &str,
    op: &OutboxOp,
    verify_first: bool,
) -> Result<(), SyncError> {
    let payload = &op.payload;
    let Some(subject) = payload
        .get("subject_value")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
    else {
        bm::finish_outbox_op(pool, op.id, "failed", Some("malformed payload"), None).await?;
        return Ok(());
    };
    let reason = payload
        .get("reason")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let expires = payload_expires(payload);
    let identifiers = vec![("steamID".to_string(), subject.clone())];

    // An op that already had an ambiguous attempt may have landed: look before
    // re-issuing (BM has no idempotency keys).
    if verify_first {
        if let Some((found, resolved)) = find_existing(
            pool,
            client,
            conn,
            target_list,
            op.local_id,
            &subject,
            reason.as_deref(),
            expires,
        )
        .await?
        {
            record_mapping(
                pool,
                conn,
                op.local_id,
                target_list,
                &found,
                &resolved,
                payload,
            )
            .await?;
            bm::finish_outbox_op(pool, op.id, "done", None, None).await?;
            return Ok(());
        }
    }

    // Server-scoped bans have no BM server mapping until PR4: pushed org-wide, the
    // narrowing noted in the map meta (decision J).
    let new_ban = NewBmBan {
        org_id: &conn.bm_org_id,
        ban_list_id: target_list,
        reason: reason.as_deref(),
        note: None,
        expires,
        identifiers: &identifiers,
        org_wide: true,
    };
    match client.create_ban(&new_ban).await {
        Ok(resource) => {
            let resolved = resolve_identifiers(&resource, &HashMap::new());
            record_mapping(
                pool,
                conn,
                op.local_id,
                target_list,
                &resource,
                &resolved,
                payload,
            )
            .await?;
            bm::finish_outbox_op(pool, op.id, "done", None, None).await?;
            Ok(())
        }
        Err(e) => settle_error(pool, op, e, true).await,
    }
}

async fn push_delete(
    pool: &sqlx::PgPool,
    client: &BmClient,
    conn: &BmConnection,
    target_list: &str,
    op: &OutboxOp,
) -> Result<(), SyncError> {
    // Ordering discipline: a revoke supersedes any unsettled create for the same ban.
    // A create that ever reached the wire may have landed unacknowledged, so verify
    // (and map) it first; then the delete below removes it. Without this, a
    // backed-off create retry would re-push the ban AFTER its revoke drained,
    // resurrecting it on BM permanently.
    if let Some(create_op) = bm::unsettled_create_for(pool, conn.tenant_id, op.local_id).await? {
        if create_op.attempts > 0 {
            let subject = create_op
                .payload
                .get("subject_value")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let reason = create_op
                .payload
                .get("reason")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            if !subject.is_empty() {
                if let Some((found, resolved)) = find_existing(
                    pool,
                    client,
                    conn,
                    target_list,
                    op.local_id,
                    &subject,
                    reason.as_deref(),
                    payload_expires(&create_op.payload),
                )
                .await?
                {
                    record_mapping(
                        pool,
                        conn,
                        op.local_id,
                        target_list,
                        &found,
                        &resolved,
                        &create_op.payload,
                    )
                    .await?;
                }
            }
        }
        bm::finish_outbox_op(
            pool,
            create_op.id,
            "abandoned",
            Some("superseded by revoke"),
            None,
        )
        .await?;
    }

    let Some(external_id) = bm::external_ban_id(pool, conn.tenant_id, op.local_id).await? else {
        // Never reached BM (and never imported): nothing to undo remotely.
        bm::finish_outbox_op(pool, op.id, "done", None, None).await?;
        return Ok(());
    };
    match client.delete_ban(&external_id).await {
        // Deleted or already gone: convergent either way.
        Ok(_) => {
            bm::finish_outbox_op(pool, op.id, "done", None, None).await?;
            Ok(())
        }
        Err(BmError::Forbidden(_)) => {
            // Token lacks ban:delete: expire it instead (decision J).
            match client.expire_ban_now(&external_id).await {
                Ok(sent_expiry) => {
                    // The ban still exists on BM, now expired: refresh the echo-guard
                    // hash so the next re-scan reads the change as our own write
                    // instead of a BM edit. Best effort; a drift costs one
                    // self-resolving conflict row.
                    if let Some((reason, meta)) =
                        bm::outbound_fallback_inputs(pool, conn.tenant_id, op.local_id).await?
                    {
                        let identifiers = meta_identifiers(&meta);
                        let note = meta.get("note").and_then(|v| v.as_str());
                        let hash = ban_content_hash(
                            reason.as_deref(),
                            Some(sent_expiry),
                            &identifiers,
                            note,
                        );
                        bm::update_outbound_hash(pool, conn.tenant_id, op.local_id, &hash).await?;
                    }
                    bm::finish_outbox_op(pool, op.id, "done", None, None).await?;
                    Ok(())
                }
                Err(e) => settle_error(pool, op, e, false).await,
            }
        }
        Err(e) => settle_error(pool, op, e, false).await,
    }
}

/// Record a pushed/adopted ban in the sync map (the echo guard). `identifiers` must
/// be the RESOLVED list (numeric refs dereferenced): the inbound loops hash resolved
/// pairs, and a hash computed over fewer identifiers would read every subsequent
/// re-scan of our own write as a BM edit.
async fn record_mapping(
    pool: &sqlx::PgPool,
    conn: &BmConnection,
    local_id: Uuid,
    target_list: &str,
    resource: &Resource<BanAttrs>,
    identifiers: &[(String, String)],
    payload: &serde_json::Value,
) -> Result<(), SyncError> {
    let hash = ban_content_hash(
        resource.attributes.reason.as_deref(),
        resource.attributes.expires,
        identifiers,
        resource.attributes.note.as_deref(),
    );
    let meta = serde_json::json!({
        "uid": resource.attributes.uid,
        "note": resource.attributes.note,
        "org_wide": resource.attributes.org_wide,
        "identifiers": identifiers
            .iter()
            .map(|(kind, value)| serde_json::json!({ "type": kind, "value": value }))
            .collect::<Vec<_>>(),
        "ban_list": target_list,
        "pushed": true,
        "local_scope": payload.get("scope"),
    });
    bm::record_outbound_ban(pool, conn.tenant_id, local_id, &resource.id, &hash, &meta).await?;
    Ok(())
}

/// The existence check for ambiguous creates: the newest ban on the target list that
/// plausibly IS our push. Same subject, reason equal under the hash normalization
/// (null and "" compare equal), same expiry, and not already mapped to a DIFFERENT
/// local ban (adopting one of those would violate the map's uniqueness and wedge the
/// op). Returns the resource plus its resolved identifiers.
#[allow(clippy::too_many_arguments)]
async fn find_existing(
    pool: &sqlx::PgPool,
    client: &BmClient,
    conn: &BmConnection,
    target_list: &str,
    local_id: Uuid,
    subject: &str,
    reason: Option<&str>,
    expires: Option<DateTime<Utc>>,
) -> Result<Option<(Resource<BanAttrs>, Vec<(String, String)>)>, SyncError> {
    let url = client.bans_search_page(target_list, subject);
    let doc = client.list_page::<BanAttrs>(&url).await?;
    let ids_map = included_identifier_map(&doc.included);
    let candidates: Vec<String> = doc.data.iter().map(|r| r.id.clone()).collect();
    let taken =
        bm::externally_mapped_elsewhere(pool, conn.tenant_id, local_id, &candidates).await?;
    for res in doc.data {
        if taken.contains(&res.id) {
            continue;
        }
        let resolved = resolve_identifiers(&res, &ids_map);
        let matches_subject = resolved
            .iter()
            .any(|(kind, value)| kind == "steamID" && value == subject);
        let reason_matches = res.attributes.reason.as_deref().unwrap_or("") == reason.unwrap_or("");
        let expires_matches = res.attributes.expires == expires;
        if matches_subject && reason_matches && expires_matches {
            return Ok(Some((res, resolved)));
        }
    }
    Ok(None)
}

/// Resolved (type, value) pairs: manual entries inline, numeric refs through the
/// page's included map.
fn resolve_identifiers(
    resource: &Resource<BanAttrs>,
    ids_map: &HashMap<String, (String, String)>,
) -> Vec<(String, String)> {
    resource
        .attributes
        .identifiers
        .iter()
        .filter_map(|i| match i {
            BanIdentifier::Manual(m) => Some((m.kind.clone(), m.identifier.clone())),
            BanIdentifier::Ref(n) => ids_map.get(&n.to_string()).cloned(),
            BanIdentifier::Other(_) => None,
        })
        .collect()
}

fn meta_identifiers(meta: &serde_json::Value) -> Vec<(String, String)> {
    meta.get("identifiers")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|entry| {
                    let kind = entry.get("type")?.as_str()?;
                    let value = entry.get("value")?.as_str()?;
                    Some((kind.to_string(), value.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Per-op error settlement. Auth errors bubble (they concern the whole connection);
/// everything else lands in the op row.
async fn settle_error(
    pool: &sqlx::PgPool,
    op: &OutboxOp,
    e: BmError,
    is_create: bool,
) -> Result<(), SyncError> {
    match e {
        BmError::Unauthorized => Err(SyncError::Bm(e)),
        BmError::AmbiguousMutation(msg) if is_create => {
            // Same attempt ceiling as plain retries: a permanently-ambiguous op must
            // eventually surface as failed instead of verifying forever.
            let status = if op.attempts >= MAX_PUSH_ATTEMPTS {
                "failed"
            } else {
                "needs_verify"
            };
            bm::finish_outbox_op(
                pool,
                op.id,
                status,
                Some(&msg),
                Some(retry_backoff(op.attempts)),
            )
            .await?;
            Ok(())
        }
        // Deletes are idempotent: an ambiguous outcome just retries.
        BmError::AmbiguousMutation(msg) => {
            bm::finish_outbox_op(
                pool,
                op.id,
                "pending",
                Some(&msg),
                Some(retry_backoff(op.attempts)),
            )
            .await?;
            Ok(())
        }
        BmError::Forbidden(msg) => {
            // Create-path permission problem (the delete path already used its
            // fallback): terminal, visible.
            bm::finish_outbox_op(pool, op.id, "failed", Some(&msg), None).await?;
            Ok(())
        }
        BmError::RateLimited | BmError::Transport(_) | BmError::Decode(_) | BmError::Status(..) => {
            let msg = e.to_string();
            if op.attempts >= MAX_PUSH_ATTEMPTS {
                bm::finish_outbox_op(pool, op.id, "failed", Some(&msg), None).await?;
            } else {
                bm::finish_outbox_op(
                    pool,
                    op.id,
                    "pending",
                    Some(&msg),
                    Some(retry_backoff(op.attempts)),
                )
                .await?;
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod e2e_tests {
    //! End-to-end outbound drain against the in-process stub BM server + real
    //! Postgres, including the echo-guard round trip with the inbound re-scan.

    use super::*;
    use crate::domain::bans::{self, NewBan};
    use crate::domain::bm as bmdom;
    use cupboard_bmapi::stub::{Fault, StubBanList, StubBm, StubData};
    use cupboard_domain::TenantId;
    use std::sync::atomic::AtomicBool;
    use tokio::sync::OnceCell;
    use uuid::Uuid;

    static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
    static MIGRATED: OnceCell<()> = OnceCell::const_new();

    const TOKEN: &str = "stub-token";
    const PEPPER: &[u8] = b"bm-outbox-pepper";
    /// Tests claim as this runner so the sync-side lease fences pass.
    const CLAIMER: &str = "outbox-e2e-runner";

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

    /// Connection with outbound sync on, target list `l1` registered.
    async fn seed_outbound(pool: &sqlx::PgPool, tenant: TenantId) -> BmConnection {
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
        sqlx::query(
            "UPDATE bm_connections SET sync_enabled = true, sync_bans_outbound = true, \
             settings = '{\"target_ban_list\": \"l1\"}'::jsonb, \
             claimed_by = $2, heartbeat_at = now() WHERE id = $1",
        )
        .bind(view.id)
        .bind(CLAIMER)
        .execute(pool)
        .await
        .expect("enable outbound");
        bmdom::fresh_connection(pool, view.id)
            .await
            .expect("fresh")
            .expect("exists")
    }

    fn empty_stub() -> StubData {
        StubData::new(TOKEN).with_ban_list(StubBanList::new("l1", "L1"))
    }

    fn local_ban(subject: &str) -> NewBan {
        NewBan {
            subject_type: "steam".into(),
            subject_value: subject.into(),
            player_id: None,
            scope: "network".into(),
            server_id: None,
            reason: Some("cheating".into()),
            issued_by: Uuid::new_v4(),
            expires_at: None,
        }
    }

    fn subject() -> String {
        let id = Uuid::new_v4().as_u128();
        format!("7656119{:010}", id % 10_000_000_000)
    }

    async fn outbox_rows(pool: &sqlx::PgPool, tenant: TenantId) -> Vec<(String, String)> {
        sqlx::query_as("SELECT op, status FROM bm_outbox WHERE tenant_id = $1 ORDER BY created_at")
            .bind(tenant.0)
            .fetch_all(pool)
            .await
            .expect("outbox rows")
    }

    #[tokio::test]
    async fn push_then_rescan_is_an_echo_not_an_edit() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP push_then_rescan_is_an_echo_not_an_edit: TEST_DATABASE_URL unset");
            return;
        };
        let tenant = TenantId(Uuid::new_v4());
        let conn = seed_outbound(&pool, tenant).await;
        let stub = StubBm::start(empty_stub()).await;
        let client = BmClient::new(stub.base_url(), TOKEN);
        let sub = subject();

        // Staff ban enqueues the push inside its own tx.
        let ban = bans::create(&pool, tenant, PEPPER, local_ban(&sub))
            .await
            .expect("local ban");
        assert_eq!(
            outbox_rows(&pool, tenant).await,
            vec![("create".to_string(), "pending".to_string())]
        );

        let drained = drain(&pool, &client, &conn, CLAIMER)
            .await
            .map_err(|e| e.message());
        assert_eq!(drained, Ok(1));
        assert_eq!(
            outbox_rows(&pool, tenant).await,
            vec![("create".to_string(), "done".to_string())]
        );
        let external = bmdom::external_ban_id(&pool, tenant.0, ban.id)
            .await
            .unwrap()
            .expect("mapped after push");
        assert!(
            external.starts_with("srv-ban-"),
            "stub-assigned id: {external}"
        );

        // The re-scan sees our own write: echo guard means zero changes, zero
        // conflicts, no duplicate ban.
        super::super::sync::full_rescan(
            &pool,
            &client,
            &conn,
            PEPPER,
            CLAIMER,
            &AtomicBool::new(false),
        )
        .await
        .map_err(|e| e.message())
        .expect("rescan");
        let (count, status): (i64, String) = sqlx::query_as(
            "SELECT count(*), min(status) FROM bans WHERE tenant_id = $1 AND subject_value = $2",
        )
        .bind(tenant.0)
        .bind(&sub)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!((count, status.as_str()), (1, "active"), "no dup, no flip");
        let conflicts: i64 =
            sqlx::query_scalar("SELECT count(*) FROM bm_sync_conflicts WHERE tenant_id = $1")
                .bind(tenant.0)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(conflicts, 0, "an echo must not log a conflict");
    }

    #[tokio::test]
    async fn revoke_deletes_on_bm_with_forbidden_fallback() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP revoke_deletes_on_bm_with_forbidden_fallback: TEST_DATABASE_URL unset");
            return;
        };
        let tenant = TenantId(Uuid::new_v4());
        let conn = seed_outbound(&pool, tenant).await;
        let stub = StubBm::start(empty_stub()).await;
        let client = BmClient::new(stub.base_url(), TOKEN);

        // Two pushed bans: one revoked via DELETE, one via the 403 PATCH fallback.
        let (sub_a, sub_b) = (subject(), subject());
        let ban_a = bans::create(&pool, tenant, PEPPER, local_ban(&sub_a))
            .await
            .unwrap();
        let ban_b = bans::create(&pool, tenant, PEPPER, local_ban(&sub_b))
            .await
            .unwrap();
        drain(&pool, &client, &conn, CLAIMER)
            .await
            .map_err(|e| e.message())
            .expect("push both");

        // Plain delete path.
        bans::revoke(&pool, tenant, ban_a.id, Uuid::new_v4(), None)
            .await
            .unwrap()
            .expect("revoked a");
        drain(&pool, &client, &conn, CLAIMER)
            .await
            .map_err(|e| e.message())
            .expect("drain delete");

        // Fallback path: DELETE forbidden, PATCH expire succeeds.
        bans::revoke(&pool, tenant, ban_b.id, Uuid::new_v4(), None)
            .await
            .unwrap()
            .expect("revoked b");
        stub.push_fault(Fault::Status(403));
        drain(&pool, &client, &conn, CLAIMER)
            .await
            .map_err(|e| e.message())
            .expect("drain fallback");

        let statuses: Vec<(String, String)> = outbox_rows(&pool, tenant).await;
        assert!(
            statuses.iter().all(|(_, s)| s == "done"),
            "all ops settle: {statuses:?}"
        );

        // Re-scan after both unbans: ban A is gone from BM (list shrinks), ban B is
        // expired there; neither may resurrect locally nor log conflicts.
        super::super::sync::full_rescan(
            &pool,
            &client,
            &conn,
            PEPPER,
            CLAIMER,
            &AtomicBool::new(false),
        )
        .await
        .map_err(|e| e.message())
        .expect("rescan");
        for (ban, sub) in [(&ban_a, &sub_a), (&ban_b, &sub_b)] {
            let status: String = sqlx::query_scalar("SELECT status FROM bans WHERE id = $1")
                .bind(ban.id)
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(status, "revoked", "{sub} must stay revoked");
        }
        let conflicts: i64 =
            sqlx::query_scalar("SELECT count(*) FROM bm_sync_conflicts WHERE tenant_id = $1")
                .bind(tenant.0)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(conflicts, 0, "convergent unbans must not log conflicts");
    }

    #[tokio::test]
    async fn ambiguous_create_verifies_before_reissuing() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP ambiguous_create_verifies_before_reissuing: TEST_DATABASE_URL unset");
            return;
        };
        let tenant = TenantId(Uuid::new_v4());
        let conn = seed_outbound(&pool, tenant).await;
        let stub = StubBm::start(empty_stub()).await;
        let client = BmClient::new(stub.base_url(), TOKEN);
        let sub = subject();

        bans::create(&pool, tenant, PEPPER, local_ban(&sub))
            .await
            .unwrap();

        // First attempt: 500 (fault preempts the stub, so nothing landed).
        stub.push_fault(Fault::Status(500));
        drain(&pool, &client, &conn, CLAIMER)
            .await
            .map_err(|e| e.message())
            .expect("first drain");
        assert_eq!(
            outbox_rows(&pool, tenant).await,
            vec![("create".to_string(), "needs_verify".to_string())]
        );

        // Second attempt: verify finds nothing (it really never landed), re-issues.
        sqlx::query("UPDATE bm_outbox SET next_attempt_at = now() WHERE tenant_id = $1")
            .bind(tenant.0)
            .execute(&pool)
            .await
            .unwrap();
        drain(&pool, &client, &conn, CLAIMER)
            .await
            .map_err(|e| e.message())
            .expect("second drain");
        assert_eq!(
            outbox_rows(&pool, tenant).await,
            vec![("create".to_string(), "done".to_string())]
        );
        let methods: Vec<String> = stub
            .requests()
            .iter()
            .map(|r| {
                format!(
                    "{} {}",
                    r.method,
                    r.path_and_query.split('?').next().unwrap()
                )
            })
            .collect();
        assert_eq!(
            methods,
            vec!["POST /bans", "GET /bans", "POST /bans"],
            "verify (GET) must precede the re-issue"
        );
    }

    #[tokio::test]
    async fn ambiguous_create_that_landed_is_adopted_not_duplicated() {
        let Some(pool) = setup().await else {
            eprintln!(
                "SKIP ambiguous_create_that_landed_is_adopted_not_duplicated: TEST_DATABASE_URL unset"
            );
            return;
        };
        let tenant = TenantId(Uuid::new_v4());
        let conn = seed_outbound(&pool, tenant).await;
        let stub = StubBm::start(empty_stub()).await;
        let client = BmClient::new(stub.base_url(), TOKEN);
        let sub = subject();

        let ban = bans::create(&pool, tenant, PEPPER, local_ban(&sub))
            .await
            .unwrap();
        // Simulate applied-but-unacknowledged: the ban exists on BM, the op thinks
        // the outcome is unknown.
        let identifiers = vec![("steamID".to_string(), sub.clone())];
        let pre_existing = client
            .create_ban(&NewBmBan {
                org_id: "9999",
                ban_list_id: "l1",
                reason: Some("cheating"),
                note: None,
                expires: None,
                identifiers: &identifiers,
                org_wide: true,
            })
            .await
            .expect("pre-create");
        sqlx::query("UPDATE bm_outbox SET status = 'needs_verify' WHERE tenant_id = $1")
            .bind(tenant.0)
            .execute(&pool)
            .await
            .unwrap();
        let before = stub.requests().len();

        drain(&pool, &client, &conn, CLAIMER)
            .await
            .map_err(|e| e.message())
            .expect("drain");
        let external = bmdom::external_ban_id(&pool, tenant.0, ban.id)
            .await
            .unwrap()
            .expect("adopted");
        assert_eq!(external, pre_existing.id, "must adopt the found ban");
        let posts_after = stub
            .requests()
            .iter()
            .skip(before)
            .filter(|r| r.method == "POST")
            .count();
        assert_eq!(posts_after, 0, "no duplicate POST after verify found it");
    }

    #[tokio::test]
    async fn revoke_supersedes_a_backed_off_create() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP revoke_supersedes_a_backed_off_create: TEST_DATABASE_URL unset");
            return;
        };
        let tenant = TenantId(Uuid::new_v4());
        let conn = seed_outbound(&pool, tenant).await;
        let stub = StubBm::start(empty_stub()).await;
        let client = BmClient::new(stub.base_url(), TOKEN);
        let sub = subject();

        // The create attempt was ambiguous AND actually landed on BM.
        let ban = bans::create(&pool, tenant, PEPPER, local_ban(&sub))
            .await
            .unwrap();
        let identifiers = vec![("steamID".to_string(), sub.clone())];
        client
            .create_ban(&NewBmBan {
                org_id: "9999",
                ban_list_id: "l1",
                reason: Some("cheating"),
                note: None,
                expires: None,
                identifiers: &identifiers,
                org_wide: true,
            })
            .await
            .expect("landed unacknowledged");
        // Park the create as ambiguous with a long backoff (as a real 5xx would).
        sqlx::query(
            "UPDATE bm_outbox SET status = 'needs_verify', attempts = 1, \
             next_attempt_at = now() + interval '5 minutes' \
             WHERE tenant_id = $1 AND op = 'create'",
        )
        .bind(tenant.0)
        .execute(&pool)
        .await
        .unwrap();

        // Staff revokes while the create is still backed off: the delete is due NOW.
        bans::revoke(&pool, tenant, ban.id, Uuid::new_v4(), None)
            .await
            .unwrap()
            .expect("revoked");
        drain(&pool, &client, &conn, CLAIMER)
            .await
            .map_err(|e| e.message())
            .expect("drain the delete");

        let rows = outbox_rows(&pool, tenant).await;
        assert_eq!(
            rows,
            vec![
                ("create".to_string(), "abandoned".to_string()),
                ("delete".to_string(), "done".to_string()),
            ],
            "the revoke supersedes the create (verified, adopted, then deleted): {rows:?}"
        );
        // The landed ban is gone from BM: no resurrection possible (the create is
        // terminal) and nothing remains to re-import.
        let remaining = client
            .list_page::<cupboard_bmapi::types::BanAttrs>(&client.bans_first_page("l1"))
            .await
            .expect("list")
            .data
            .len();
        assert_eq!(
            remaining, 0,
            "the unacknowledged-but-landed ban was deleted"
        );
    }

    #[tokio::test]
    async fn drain_is_fenced_on_the_lease() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP drain_is_fenced_on_the_lease: TEST_DATABASE_URL unset");
            return;
        };
        let tenant = TenantId(Uuid::new_v4());
        let conn = seed_outbound(&pool, tenant).await;
        let stub = StubBm::start(empty_stub()).await;
        let client = BmClient::new(stub.base_url(), TOKEN);

        bans::create(&pool, tenant, PEPPER, local_ban(&subject()))
            .await
            .unwrap();
        // Another runner took the lease: this (now stale) drainer must stop before
        // pushing anything.
        sqlx::query("UPDATE bm_connections SET claimed_by = 'someone-else' WHERE id = $1")
            .bind(conn.id)
            .execute(&pool)
            .await
            .unwrap();
        let err = drain(&pool, &client, &conn, CLAIMER)
            .await
            .expect_err("stale drain must stop");
        assert_eq!(err.message(), "claim lost mid-sync");
        assert!(stub.requests().is_empty(), "no push from a stale runner");
        assert_eq!(
            outbox_rows(&pool, tenant).await,
            vec![("create".to_string(), "pending".to_string())],
            "the op stays drainable for the new lease holder"
        );
    }

    #[tokio::test]
    async fn outbound_enable_implies_sync_enabled() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP outbound_enable_implies_sync_enabled: TEST_DATABASE_URL unset");
            return;
        };
        let tenant = TenantId(Uuid::new_v4());
        let conn = seed_outbound(&pool, tenant).await;
        // Start from sync fully off (the outbound form never sends sync_enabled).
        sqlx::query(
            "UPDATE bm_connections SET sync_enabled = false, sync_bans_outbound = false \
             WHERE id = $1",
        )
        .bind(conn.id)
        .execute(&pool)
        .await
        .unwrap();

        let (view, _) = bmdom::update_sync_settings(
            &pool,
            tenant,
            Uuid::new_v4(),
            bmdom::SyncChanges {
                sync_bans_outbound: Some(true),
                ..Default::default()
            },
        )
        .await
        .expect("enable outbound");
        assert!(
            view.sync_enabled && view.sync_bans_outbound,
            "outbound requires a live runner: enabling it must enable sync"
        );

        // And the inverse: switching sync off never leaves outbound silently queued.
        let (view, _) = bmdom::update_sync_settings(
            &pool,
            tenant,
            Uuid::new_v4(),
            bmdom::SyncChanges {
                sync_enabled: Some(false),
                ..Default::default()
            },
        )
        .await
        .expect("disable sync");
        assert!(
            !view.sync_enabled && !view.sync_bans_outbound,
            "disabling sync must also disable outbound"
        );
    }

    #[tokio::test]
    async fn unsupported_subject_is_abandoned_and_backfill_scopes_correctly() {
        let Some(pool) = setup().await else {
            eprintln!(
                "SKIP unsupported_subject_is_abandoned_and_backfill_scopes_correctly: TEST_DATABASE_URL unset"
            );
            return;
        };
        let tenant = TenantId(Uuid::new_v4());
        let conn = seed_outbound(&pool, tenant).await;
        let stub = StubBm::start(empty_stub()).await;
        let client = BmClient::new(stub.base_url(), TOKEN);

        // An eac ban with outbound on: visible as abandoned, never drained.
        let mut eac = local_ban(&subject());
        eac.subject_type = "eac".into();
        bans::create(&pool, tenant, PEPPER, eac).await.unwrap();
        assert_eq!(
            outbox_rows(&pool, tenant).await,
            vec![("create".to_string(), "abandoned".to_string())]
        );
        drain(&pool, &client, &conn, CLAIMER)
            .await
            .map_err(|e| e.message())
            .expect("drain skips abandoned");
        assert!(stub.requests().is_empty(), "abandoned ops never hit BM");

        // Backfill: only the unmapped, active, steam, non-bm ban queues. Disable
        // outbound first so creates during setup don't enqueue on their own.
        sqlx::query("UPDATE bm_connections SET sync_bans_outbound = false WHERE id = $1")
            .bind(conn.id)
            .execute(&pool)
            .await
            .unwrap();
        let steam_active = bans::create(&pool, tenant, PEPPER, local_ban(&subject()))
            .await
            .unwrap();
        let revoked = bans::create(&pool, tenant, PEPPER, local_ban(&subject()))
            .await
            .unwrap();
        bans::revoke(&pool, tenant, revoked.id, Uuid::new_v4(), None)
            .await
            .unwrap();
        let (view, backfilled) = bmdom::update_sync_settings(
            &pool,
            tenant,
            Uuid::new_v4(),
            bmdom::SyncChanges {
                sync_enabled: Some(true),
                sync_bans_outbound: Some(true),
                backfill_existing: true,
                ..Default::default()
            },
        )
        .await
        .expect("backfill");
        assert!(view.sync_bans_outbound);
        assert_eq!(backfilled, 1, "exactly the unmapped active steam ban");
        let queued: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM bm_outbox WHERE tenant_id = $1 AND local_id = $2 \
             AND status = 'pending'",
        )
        .bind(tenant.0)
        .bind(steam_active.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(queued, 1);
    }
}
