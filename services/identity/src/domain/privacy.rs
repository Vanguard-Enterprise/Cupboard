//! Privacy walkers (Phase 7 PR2, decisions A/A2/B/B2/D): per-player export + erasure over
//! the identity schema, called by the auth-owned coordinator via `/internal/privacy/*`.
//!
//! Semantics (decision B): NULL the raw, keep the hash, tombstone the player. The walk is
//! anchored on players resolved from hashed identifiers; bans additionally match by
//! `subject_hash` so enforcement context is scrubbed even where `player_id` was never set.
//! The walk therefore runs even when NO player row resolves: hash-matched bans and the
//! raw-value BM sweeps cover the BM-import/manual shapes that never got a
//! `player_identifiers` row. `subject_hash`, `reason`, and `evidence` are RETAINED (the
//! ban still enforces after erasure - the whole point of the Phase 2 value/hash
//! separation).
//!
//! Scope (decision A2): platform scope walks everything incl. the global graph; tenant
//! scope touches ONLY that tenant's tenant-scoped rows and never the global tables.
//! Erasure is idempotent (decision D): every write carries a not-already-erased guard, so
//! a re-run yields all-zero counts. Dry-run mode runs the same predicates as COUNTs and
//! writes nothing. Real runs execute in ONE owner-pool transaction (the merge precedent).

use crate::error::AppError;
use cupboard_crypto::hmac_sha256;
use serde_json::json;
use sqlx::PgPool;
use std::collections::BTreeMap;
use uuid::Uuid;

/// Privacy stance of every identity-schema table (decision B2). The schema-inventory
/// oracle test fails on any table missing here, so every future migration must take a
/// stance to pass CI. This list also drives export, so export and erasure cannot drift.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Classification {
    /// The walkers export and (where there is anything erasable) erase these rows.
    Walked,
    /// Holds no player data (org/infra bookkeeping only).
    NoPlayerData,
    /// Player-adjacent rows retained under a stated lawful basis (disclosure page).
    RetainedWithBasis,
}

pub const CLASSIFIED: &[(&str, Classification)] = &[
    ("players", Classification::Walked),
    ("player_identifiers", Classification::Walked),
    ("identity_signals", Classification::Walked),
    ("name_history", Classification::Walked),
    ("player_sessions", Classification::Walked),
    ("chat_messages", Classification::Walked),
    ("player_reports", Classification::Walked),
    ("player_notes", Classification::Walked),
    ("player_flags", Classification::Walked),
    ("bans", Classification::Walked),
    // Surrogate ids + status only; exported as player data, nothing raw to erase.
    ("ban_evasion_alerts", Classification::Walked),
    ("bm_sync_map", Classification::Walked),
    ("bm_outbox", Classification::Walked),
    ("bm_sync_conflicts", Classification::Walked),
    // Alt-graph links are surrogate-only and deliberately survive erasure
    // (legitimate interest: evasion detection; ARCHITECTURE #14).
    ("player_links", Classification::RetainedWithBasis),
    ("manual_links", Classification::RetainedWithBasis),
    // Merge audit snapshot: surrogate ids + row counts (un-merge support).
    ("merge_log", Classification::RetainedWithBasis),
    // 2y retention window, legal obligation + legitimate interest (decision #3).
    ("audit_log", Classification::RetainedWithBasis),
    // Import bookkeeping; cursor blobs are time-bounded by the retention loop.
    ("bm_import_jobs", Classification::RetainedWithBasis),
    ("sharing_pools", Classification::NoPlayerData),
    ("pool_members", Classification::NoPlayerData),
    ("ban_pool_shares", Classification::NoPlayerData),
    ("bm_connections", Classification::NoPlayerData),
    ("bm_ban_lists", Classification::NoPlayerData),
    ("_sqlx_migrations", Classification::NoPlayerData),
];

#[derive(Debug, Clone, Copy)]
pub enum Scope {
    Platform,
    Tenant(Uuid),
}

impl Scope {
    fn tenant(&self) -> Option<Uuid> {
        match self {
            Scope::Platform => None,
            Scope::Tenant(t) => Some(*t),
        }
    }
}

/// Raw identifiers of the data subject; at least one is present (handler-validated).
#[derive(Debug, Clone)]
pub struct Subject {
    pub steam_id: Option<String>,
    pub discord_id: Option<String>,
}

struct Ctx {
    ids: Vec<Uuid>,
    hashes: Vec<Vec<u8>>,
    tenant: Option<Uuid>,
    steam: Option<String>,
    note_ids: Vec<Uuid>,
    ban_ids: Vec<Uuid>,
}

/// Resolve the subject to player ids: hash each identifier with the pepper against
/// `player_identifiers.value_hash`, then follow `merged_into` chains so BOTH the tombstone
/// and the survivor enter the walk (rows may still reference either).
async fn resolve(
    pool: &PgPool,
    pepper: &[u8],
    subject: &Subject,
) -> Result<(Vec<Uuid>, Vec<Vec<u8>>), AppError> {
    let steam_hash = subject
        .steam_id
        .as_deref()
        .map(|v| hmac_sha256(v.as_bytes(), pepper).to_vec());
    let discord_hash = subject
        .discord_id
        .as_deref()
        .map(|v| hmac_sha256(v.as_bytes(), pepper).to_vec());
    let hashes: Vec<Vec<u8>> = [steam_hash.clone(), discord_hash.clone()]
        .into_iter()
        .flatten()
        .collect();

    let direct: Vec<Uuid> = sqlx::query_scalar(
        "SELECT DISTINCT player_id FROM player_identifiers \
         WHERE (type = 'steam' AND value_hash = $1) OR (type = 'discord' AND value_hash = $2)",
    )
    .bind(steam_hash)
    .bind(discord_hash)
    .fetch_all(pool)
    .await?;

    let mut all: std::collections::BTreeSet<Uuid> = direct.iter().copied().collect();
    let mut queue: Vec<Uuid> = direct;
    while let Some(id) = queue.pop() {
        let next: Option<Option<Uuid>> = sqlx::query_scalar(
            "SELECT merged_into FROM players WHERE id = $1 AND status = 'merged'",
        )
        .bind(id)
        .fetch_optional(pool)
        .await?;
        if let Some(Some(into)) = next {
            if all.insert(into) {
                queue.push(into);
            }
        }
    }
    Ok((all.into_iter().collect(), hashes))
}

/// Which bind set a step's SQL uses ($-placeholders are positional per variant).
enum Binds {
    /// $1 = player ids (global-table steps; platform scope only).
    Ids,
    /// $1 = player ids, $2 = tenant (NULL = platform, no filter).
    IdsTenant,
    /// $1 = player ids, $2 = identifier hashes, $3 = tenant.
    IdsHashesTenant,
    /// $1 = player ids, $2 = note ids, $3 = ban ids, $4 = tenant.
    MapTenant,
    /// $1 = raw steam id (step skipped when absent), $2 = tenant.
    SteamTenant,
}

struct Step {
    table: &'static str,
    platform_only: bool,
    write_sql: String,
    count_sql: String,
    binds: Binds,
}

const TENANT_CLAUSE: &str = "($2::uuid IS NULL OR tenant_id = $2)";

/// The erase walk, one entry per touched table, in contract order. Every predicate embeds
/// its idempotency guard, so counts are "rows this run would change", not "rows matched".
fn erase_steps() -> Vec<Step> {
    let step =
        |table: &'static str, platform_only: bool, write: String, pred: &str, binds: Binds| Step {
            table,
            platform_only,
            write_sql: write,
            count_sql: format!("SELECT count(*) FROM {table} WHERE {pred}"),
            binds,
        };

    let idents = "player_id = ANY($1) AND value IS NOT NULL";
    let names = "player_id = ANY($1)";
    let sessions =
        format!("player_id = ANY($1) AND {TENANT_CLAUSE} AND (ip IS NOT NULL OR name IS NOT NULL)");
    let chat = format!(
        "player_id = ANY($1) AND {TENANT_CLAUSE} AND \
         (name IS DISTINCT FROM '[erased]' OR message IS DISTINCT FROM '[erased]')"
    );
    let reports = format!(
        "(reporter_player_id = ANY($1) OR target_player_id = ANY($1)) AND {TENANT_CLAUSE} AND \
         (reporter_name IS DISTINCT FROM '[erased]' OR target_name IS DISTINCT FROM '[erased]' \
          OR subject IS DISTINCT FROM '[erased]' OR message IS DISTINCT FROM '[erased]')"
    );
    let notes =
        format!("player_id = ANY($1) AND {TENANT_CLAUSE} AND body IS DISTINCT FROM '[erased]'");
    let flags = format!("player_id = ANY($1) AND {TENANT_CLAUSE}");
    let bans = "(player_id = ANY($1) OR subject_hash = ANY($2)) \
         AND ($3::uuid IS NULL OR tenant_id = $3) \
         AND (subject_value IS NOT NULL OR player_id IS NOT NULL)";
    let map = "((entity_type = 'player' AND local_id = ANY($1)) \
         OR (entity_type = 'note' AND local_id = ANY($2)) \
         OR (entity_type = 'ban' AND local_id = ANY($3))) \
         AND ($4::uuid IS NULL OR tenant_id = $4) AND meta <> '{}'::jsonb";
    let outbox = format!("strpos(payload::text, $1) > 0 AND {TENANT_CLAUSE}");
    let conflicts = format!(
        "(strpos(coalesce(local_snapshot::text, ''), $1) > 0 \
          OR strpos(coalesce(remote_snapshot::text, ''), $1) > 0) AND {TENANT_CLAUSE}"
    );
    let players = "id = ANY($1) AND status = 'active'";

    vec![
        step(
            "player_identifiers",
            true,
            format!("UPDATE player_identifiers SET value = NULL WHERE {idents}"),
            idents,
            Binds::Ids,
        ),
        step(
            "identity_signals",
            true,
            format!("UPDATE identity_signals SET value = NULL WHERE {idents}"),
            idents,
            Binds::Ids,
        ),
        step(
            "name_history",
            true,
            format!("DELETE FROM name_history WHERE {names}"),
            names,
            Binds::Ids,
        ),
        step(
            "player_sessions",
            false,
            format!("UPDATE player_sessions SET ip = NULL, name = NULL WHERE {sessions}"),
            &sessions,
            Binds::IdsTenant,
        ),
        step(
            "chat_messages",
            false,
            format!(
                "UPDATE chat_messages SET name = '[erased]', message = '[erased]' WHERE {chat}"
            ),
            &chat,
            Binds::IdsTenant,
        ),
        step(
            "player_reports",
            false,
            format!(
                "UPDATE player_reports SET reporter_name = '[erased]', target_name = '[erased]', \
                 subject = '[erased]', message = '[erased]' WHERE {reports}"
            ),
            &reports,
            Binds::IdsTenant,
        ),
        step(
            "player_notes",
            false,
            format!("UPDATE player_notes SET body = '[erased]' WHERE {notes}"),
            &notes,
            Binds::IdsTenant,
        ),
        step(
            "player_flags",
            false,
            format!("DELETE FROM player_flags WHERE {flags}"),
            &flags,
            Binds::IdsTenant,
        ),
        step(
            "bans",
            false,
            format!("UPDATE bans SET subject_value = NULL, player_id = NULL WHERE {bans}"),
            bans,
            Binds::IdsHashesTenant,
        ),
        step(
            "bm_sync_map",
            false,
            format!("UPDATE bm_sync_map SET meta = '{{}}'::jsonb WHERE {map}"),
            map,
            Binds::MapTenant,
        ),
        // Value sweep. A NON-terminal row (pending/inflight/needs_verify) whose payload
        // is swept can never push anything sensible; leaving it queued would have the
        // drain settle it as a noisy 'failed'. 'abandoned' is the honest terminal state
        // (status/error columns per migration 0011). Terminal rows just lose the payload.
        step(
            "bm_outbox",
            false,
            format!(
                "UPDATE bm_outbox SET payload = '{{}}'::jsonb, \
                 status = CASE WHEN status IN ('pending', 'inflight', 'needs_verify') \
                     THEN 'abandoned' ELSE status END, \
                 last_error = CASE WHEN status IN ('pending', 'inflight', 'needs_verify') \
                     THEN 'payload swept by privacy erasure' ELSE last_error END \
                 WHERE {outbox}"
            ),
            &outbox,
            Binds::SteamTenant,
        ),
        step(
            "bm_sync_conflicts",
            false,
            format!(
                "UPDATE bm_sync_conflicts SET \
                 local_snapshot = CASE WHEN strpos(coalesce(local_snapshot::text, ''), $1) > 0 \
                     THEN '{{}}'::jsonb ELSE local_snapshot END, \
                 remote_snapshot = CASE WHEN strpos(coalesce(remote_snapshot::text, ''), $1) > 0 \
                     THEN '{{}}'::jsonb ELSE remote_snapshot END \
                 WHERE {conflicts}"
            ),
            &conflicts,
            Binds::SteamTenant,
        ),
        // Last: tombstone. Only currently-active players; merged tombstones stay 'merged'.
        step(
            "players",
            true,
            format!("UPDATE players SET status = 'erased', updated_at = now() WHERE {players}"),
            players,
            Binds::Ids,
        ),
    ]
}

fn bind_step<'q>(
    sql: &'q str,
    binds: &Binds,
    ctx: &'q Ctx,
) -> sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments> {
    let q = sqlx::query(sql);
    match binds {
        Binds::Ids => q.bind(&ctx.ids),
        Binds::IdsTenant => q.bind(&ctx.ids).bind(ctx.tenant),
        Binds::IdsHashesTenant => q.bind(&ctx.ids).bind(&ctx.hashes).bind(ctx.tenant),
        Binds::MapTenant => q
            .bind(&ctx.ids)
            .bind(&ctx.note_ids)
            .bind(&ctx.ban_ids)
            .bind(ctx.tenant),
        Binds::SteamTenant => q.bind(ctx.steam.as_deref()).bind(ctx.tenant),
    }
}

fn bind_scalar<'q>(
    sql: &'q str,
    binds: &Binds,
    ctx: &'q Ctx,
) -> sqlx::query::QueryScalar<'q, sqlx::Postgres, i64, sqlx::postgres::PgArguments> {
    let q = sqlx::query_scalar(sql);
    match binds {
        Binds::Ids => q.bind(&ctx.ids),
        Binds::IdsTenant => q.bind(&ctx.ids).bind(ctx.tenant),
        Binds::IdsHashesTenant => q.bind(&ctx.ids).bind(&ctx.hashes).bind(ctx.tenant),
        Binds::MapTenant => q
            .bind(&ctx.ids)
            .bind(&ctx.note_ids)
            .bind(&ctx.ban_ids)
            .bind(ctx.tenant),
        Binds::SteamTenant => q.bind(ctx.steam.as_deref()).bind(ctx.tenant),
    }
}

/// Note + ban ids collected BEFORE any mutation: the bm_sync_map scrub addresses rows by
/// local_id, and the bans update NULLs player_id, so collecting after would miss rows.
async fn collect_entity_ids(
    conn: &mut sqlx::PgConnection,
    ctx: &mut Ctx,
) -> Result<(), sqlx::Error> {
    ctx.note_ids = sqlx::query_scalar(
        "SELECT id FROM player_notes WHERE player_id = ANY($1) \
         AND ($2::uuid IS NULL OR tenant_id = $2)",
    )
    .bind(&ctx.ids)
    .bind(ctx.tenant)
    .fetch_all(&mut *conn)
    .await?;
    ctx.ban_ids = sqlx::query_scalar(
        "SELECT id FROM bans WHERE (player_id = ANY($1) OR subject_hash = ANY($2)) \
         AND ($3::uuid IS NULL OR tenant_id = $3)",
    )
    .bind(&ctx.ids)
    .bind(&ctx.hashes)
    .bind(ctx.tenant)
    .fetch_all(&mut *conn)
    .await?;
    Ok(())
}

/// Erase the subject's rows per scope. Returns per-table changed-row counts. `dry_run`
/// runs the identical predicates as COUNTs and writes nothing (decision D). The walk
/// runs even when NO player row resolves: every predicate is safe with an empty id
/// list, bans match `subject_hash = ANY(hashes)` independently, and
/// [`collect_entity_ids`] still resolves ban ids through the hash arm, so hash-only
/// bans (the BM-import/manual shape) are scrubbed too. The audit row is skipped when
/// no player resolved AND every count is zero (no audit noise for unknown subjects).
pub async fn erase(
    pool: &PgPool,
    pepper: &[u8],
    scope: Scope,
    subject: &Subject,
    dry_run: bool,
) -> Result<BTreeMap<String, i64>, AppError> {
    let (ids, hashes) = resolve(pool, pepper, subject).await?;
    let mut counts = BTreeMap::new();
    let mut ctx = Ctx {
        ids,
        hashes,
        tenant: scope.tenant(),
        steam: subject.steam_id.clone(),
        note_ids: Vec::new(),
        ban_ids: Vec::new(),
    };
    let steps = erase_steps();

    if dry_run {
        let mut conn = pool.acquire().await?;
        collect_entity_ids(&mut conn, &mut ctx).await?;
        drop(conn);
        for s in &steps {
            if s.platform_only && ctx.tenant.is_some() {
                continue;
            }
            let n = if matches!(s.binds, Binds::SteamTenant) && ctx.steam.is_none() {
                0
            } else {
                bind_scalar(&s.count_sql, &s.binds, &ctx)
                    .fetch_one(pool)
                    .await?
            };
            counts.insert(s.table.to_string(), n);
        }
        return Ok(counts);
    }

    let mut tx = pool.begin().await?;
    collect_entity_ids(&mut tx, &mut ctx).await?;
    for s in &steps {
        if s.platform_only && ctx.tenant.is_some() {
            continue;
        }
        let n = if matches!(s.binds, Binds::SteamTenant) && ctx.steam.is_none() {
            0
        } else {
            bind_step(&s.write_sql, &s.binds, &ctx)
                .execute(&mut *tx)
                .await?
                .rows_affected() as i64
        };
        counts.insert(s.table.to_string(), n);
    }

    // Audit is a GDPR obligation itself (decision D). Surrogate ids + counts only;
    // never the raw identifiers. Skipped when no player resolved and nothing changed:
    // an unknown subject leaves no erasure to record, only noise.
    if !ctx.ids.is_empty() || counts.values().any(|&n| n != 0) {
        crate::domain::audit::record_in_tx(
            &mut tx,
            ctx.tenant,
            None,
            "player.erase",
            Some("player"),
            ctx.ids.first().copied(),
            Some(json!({ "player_ids": ctx.ids, "counts": counts })),
        )
        .await
        .map_err(AppError::from)?;
    }
    tx.commit().await?;
    Ok(counts)
}

/// Export the subject's rows per scope as `{table: [row objects]}` with the subject's
/// raw values included. Mirrors the erase row selections (decision B2: one
/// classification list drives both) and, like erase, runs even when NO player row
/// resolves: hash-matched bans and the raw-value BM sweeps still export (the
/// BM-import/manual shape). Third-party redaction (decision C): `bm_outbox.payload`
/// and the `bm_sync_conflicts` snapshots are internal sync records, not the subject's
/// data, so they ship as a redaction marker; on `player_reports`, the OPPOSING
/// party's name is masked (an Art. 15 bundle must not hand out other people's data).
/// Erase behavior is deliberately broader and unchanged. Tenant scope excludes the
/// global graph entirely (decision A2).
pub async fn export(
    pool: &PgPool,
    pepper: &[u8],
    scope: Scope,
    subject: &Subject,
) -> Result<(Vec<Uuid>, serde_json::Map<String, serde_json::Value>), AppError> {
    let (ids, hashes) = resolve(pool, pepper, subject).await?;
    let mut data = serde_json::Map::new();
    let mut ctx = Ctx {
        ids,
        hashes,
        tenant: scope.tenant(),
        steam: subject.steam_id.clone(),
        note_ids: Vec::new(),
        ban_ids: Vec::new(),
    };
    {
        let mut conn = pool.acquire().await?;
        collect_entity_ids(&mut conn, &mut ctx).await?;
    }

    let sel = |table: &str, pred: &str| {
        format!(
            "SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]'::jsonb) \
             FROM {table} t WHERE {pred}"
        )
    };
    let tenant_clause = "($2::uuid IS NULL OR t.tenant_id = $2)";
    let tables: Vec<(&'static str, String, Binds)> = vec![
        ("players", sel("players", "t.id = ANY($1)"), Binds::Ids),
        (
            "player_identifiers",
            sel("player_identifiers", "t.player_id = ANY($1)"),
            Binds::Ids,
        ),
        (
            "identity_signals",
            sel("identity_signals", "t.player_id = ANY($1)"),
            Binds::Ids,
        ),
        (
            "name_history",
            sel("name_history", "t.player_id = ANY($1)"),
            Binds::Ids,
        ),
        (
            "player_sessions",
            sel(
                "player_sessions",
                &format!("t.player_id = ANY($1) AND {tenant_clause}"),
            ),
            Binds::IdsTenant,
        ),
        (
            "chat_messages",
            sel(
                "chat_messages",
                &format!("t.player_id = ANY($1) AND {tenant_clause}"),
            ),
            Binds::IdsTenant,
        ),
        // The opposing party's name is a third party's data: subject-as-reporter masks
        // target_name, subject-as-target masks reporter_name; a report where the
        // subject's ids sit on BOTH sides redacts neither.
        (
            "player_reports",
            format!(
                "SELECT coalesce(jsonb_agg(CASE \
                     WHEN t.reporter_player_id = ANY($1) AND t.target_player_id = ANY($1) \
                         THEN to_jsonb(t) \
                     WHEN t.reporter_player_id = ANY($1) \
                         THEN jsonb_set(to_jsonb(t), '{{target_name}}', '\"[third party]\"') \
                     ELSE jsonb_set(to_jsonb(t), '{{reporter_name}}', '\"[third party]\"') \
                 END ORDER BY t.id), '[]'::jsonb) \
                 FROM player_reports t \
                 WHERE (t.reporter_player_id = ANY($1) OR t.target_player_id = ANY($1)) \
                 AND {tenant_clause}"
            ),
            Binds::IdsTenant,
        ),
        (
            "player_notes",
            sel(
                "player_notes",
                &format!("t.player_id = ANY($1) AND {tenant_clause}"),
            ),
            Binds::IdsTenant,
        ),
        (
            "player_flags",
            sel(
                "player_flags",
                &format!("t.player_id = ANY($1) AND {tenant_clause}"),
            ),
            Binds::IdsTenant,
        ),
        (
            "ban_evasion_alerts",
            sel(
                "ban_evasion_alerts",
                &format!("t.suspect_player = ANY($1) AND {tenant_clause}"),
            ),
            Binds::IdsTenant,
        ),
        (
            "bans",
            sel(
                "bans",
                "(t.player_id = ANY($1) OR t.subject_hash = ANY($2)) \
                 AND ($3::uuid IS NULL OR t.tenant_id = $3)",
            ),
            Binds::IdsHashesTenant,
        ),
        (
            "bm_sync_map",
            sel(
                "bm_sync_map",
                "((t.entity_type = 'player' AND t.local_id = ANY($1)) \
                  OR (t.entity_type = 'note' AND t.local_id = ANY($2)) \
                  OR (t.entity_type = 'ban' AND t.local_id = ANY($3))) \
                 AND ($4::uuid IS NULL OR t.tenant_id = $4)",
            ),
            Binds::MapTenant,
        ),
        // BM sync internals are Cupboard's operational records, not the subject's data:
        // rows export with ids/status/timestamps intact but the jsonb contents replaced
        // by a redaction marker (erase still sweeps the real payloads).
        (
            "bm_outbox",
            format!(
                "SELECT coalesce(jsonb_agg( \
                     jsonb_set(to_jsonb(t), '{{payload}}', '\"[internal sync record]\"') \
                 ORDER BY t.id), '[]'::jsonb) \
                 FROM bm_outbox t \
                 WHERE strpos(t.payload::text, $1) > 0 AND {tenant_clause}"
            ),
            Binds::SteamTenant,
        ),
        (
            "bm_sync_conflicts",
            format!(
                "SELECT coalesce(jsonb_agg(jsonb_set(jsonb_set(to_jsonb(t), \
                     '{{local_snapshot}}', '\"[internal sync record]\"'), \
                     '{{remote_snapshot}}', '\"[internal sync record]\"') \
                 ORDER BY t.id), '[]'::jsonb) \
                 FROM bm_sync_conflicts t \
                 WHERE (strpos(coalesce(t.local_snapshot::text, ''), $1) > 0 \
                     OR strpos(coalesce(t.remote_snapshot::text, ''), $1) > 0) \
                 AND {tenant_clause}"
            ),
            Binds::SteamTenant,
        ),
    ];

    for (table, sql, binds) in &tables {
        let platform_only = matches!(binds, Binds::Ids);
        if platform_only && ctx.tenant.is_some() {
            continue;
        }
        let rows = if matches!(binds, Binds::SteamTenant) && ctx.steam.is_none() {
            serde_json::Value::Array(Vec::new())
        } else {
            let q = sqlx::query_scalar::<_, serde_json::Value>(sql);
            let q = match binds {
                Binds::Ids => q.bind(&ctx.ids),
                Binds::IdsTenant => q.bind(&ctx.ids).bind(ctx.tenant),
                Binds::IdsHashesTenant => q.bind(&ctx.ids).bind(&ctx.hashes).bind(ctx.tenant),
                Binds::MapTenant => q
                    .bind(&ctx.ids)
                    .bind(&ctx.note_ids)
                    .bind(&ctx.ban_ids)
                    .bind(ctx.tenant),
                Binds::SteamTenant => q.bind(ctx.steam.as_deref()).bind(ctx.tenant),
            };
            q.fetch_one(pool).await?
        };
        data.insert(table.to_string(), rows);
    }
    Ok((ctx.ids, data))
}
