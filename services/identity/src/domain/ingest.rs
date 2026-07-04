//! Ingestion: turn bus events into upserts across the global identity graph and the
//! tenant's data (docs/identity-schema.md "Ingestion upsert").
//!
//! - [`ingest_roster`] — poll snapshots, the self-healing baseline.
//! - [`ingest_session_edge`] — real-time connect/disconnect edges (console stream / plugin),
//!   giving exact session boundaries between polls.
//! - [`ingest_chat`] — chat messages.
//!
//! All run on the owner pool: they write the no-RLS global tables and set `tenant_id`
//! explicitly on tenant tables. One transaction per event. Roster ingestion is idempotent;
//! the edge/chat paths tolerate replays (an already-open session is refreshed, a re-closed
//! session is a no-op; a replayed chat line duplicates, which moderation context absorbs).

use cupboard_crypto::hmac_sha256;
use cupboard_domain::{ChatEvent, ReportEvent, RosterEvent, SessionEdge, SessionEvent};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

/// A SteamID64 the graph should track — digits, not the `"0"`/empty server sentinel.
fn is_player_steam_id(s: &str) -> bool {
    !s.is_empty() && s != "0" && s.bytes().all(|b| b.is_ascii_digit())
}

/// Upper bound on a reported session length (400 days). Guards the push path, where
/// `connected_seconds` is attacker-controllable and an absurd value would panic chrono.
const MAX_CONNECTED_SECS: i64 = 400 * 24 * 60 * 60;

/// Longest text we persist into the global (no-RLS) tables — names and identifier
/// values. Server-controlled input; the request body cap alone is far too loose.
const MAX_GLOBAL_TEXT: usize = 128;

/// Truncate to [`MAX_GLOBAL_TEXT`] on a char boundary (never mid-UTF-8).
fn bound_text(s: &str) -> &str {
    let mut end = s.len().min(MAX_GLOBAL_TEXT);
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Apply a roster snapshot. See module docs.
pub async fn ingest_roster(
    pool: &PgPool,
    pepper: &[u8],
    event: &RosterEvent,
) -> anyhow::Result<()> {
    let tenant = event.tenant_id.0;
    let server = event.server_id.0;
    let obs = event.observed_at;

    let mut tx = pool.begin().await?;
    let mut present: Vec<Uuid> = Vec::with_capacity(event.players.len());

    for p in &event.players {
        // Skip bots/NPCs/junk (steam_id "0", empty, or non-digit): the edge/chat/report
        // paths already gate on this, but a pushed roster reaches here directly and must
        // not mint phantom players in the shared global graph.
        if !is_player_steam_id(&p.steam_id) {
            continue;
        }
        present.push(ingest_one_player(&mut tx, pepper, tenant, server, p, obs).await?);
    }

    // Close open sessions for players no longer on this server (empty roster closes all:
    // `<> ALL('{}')` is true for every row).
    sqlx::query(
        "UPDATE player_sessions SET disconnected_at = $4 \
         WHERE tenant_id = $1 AND server_id = $2 AND disconnected_at IS NULL \
           AND player_id <> ALL($3)",
    )
    .bind(tenant)
    .bind(server)
    .bind(&present)
    .bind(obs)
    .execute(&mut *tx)
    .await?;

    // Re-evaluate alt-links for each observed player and raise evasion alerts if they're
    // linked to a banned player on this tenant. Advisory only — never auto-bans.
    for &player_id in &present {
        crate::domain::links::evaluate_links(&mut tx, player_id, obs).await?;
        crate::domain::links::check_evasion(&mut tx, tenant, player_id, obs).await?;
    }

    tx.commit().await?;
    Ok(())
}

/// The per-player upsert shared by roster snapshots and connect edges: resolve/create the
/// player, refresh name history + IP/owner signals, and open-or-refresh the session.
async fn ingest_one_player(
    tx: &mut Transaction<'_, Postgres>,
    pepper: &[u8],
    tenant: Uuid,
    server: Uuid,
    p: &cupboard_domain::ObservedPlayer,
    obs: chrono::DateTime<chrono::Utc>,
) -> anyhow::Result<Uuid> {
    let steam_hash = hmac_sha256(p.steam_id.as_bytes(), pepper).to_vec();
    let player_id = resolve_or_create_player(tx, &p.steam_id, &steam_hash, obs).await?;

    // Name history. Bound the name — it's written into the shared global table and is
    // server-controlled (only the request body cap bounds it upstream).
    if !p.name.is_empty() {
        sqlx::query(
            "INSERT INTO name_history (player_id, name, first_seen_at, last_seen_at) \
             VALUES ($1, $2, $3, $3) \
             ON CONFLICT (player_id, name) DO UPDATE SET last_seen_at = $3",
        )
        .bind(player_id)
        .bind(bound_text(&p.name))
        .bind(obs)
        .execute(&mut **tx)
        .await?;
    }

    // IP signal (linking + the session's stored IP). An empty IP would hash to the
    // constant hmac("") and falsely link every such player — treat it as absent.
    let ip = p.ip.as_deref().filter(|ip| !ip.is_empty());
    let ip_hash = ip.map(|ip| hmac_sha256(ip.as_bytes(), pepper).to_vec());
    if let (Some(ip), Some(h)) = (ip, &ip_hash) {
        upsert_signal(tx, player_id, "ip", Some(ip), h, obs).await?;
    }

    // Steam-owner signal (family share — a strong alt signal).
    if let Some(owner) = &p.owner_steam_id {
        let owner_hash = hmac_sha256(owner.as_bytes(), pepper).to_vec();
        upsert_signal(tx, player_id, "steam_owner", Some(owner), &owner_hash, obs).await?;
    }

    // EAC identifier (plugin-observed). An identifier is a unique global key: if this
    // EAC id already belongs to a DIFFERENT player we don't steal it — we bump its
    // last_seen and leave ownership alone (a contested EAC id is alt evidence, consumed
    // by link tuning later, not a reason to rewire the graph mid-ingest).
    if let Some(eac) = &p.eac_id {
        let eac_hash = hmac_sha256(eac.as_bytes(), pepper).to_vec();
        let owner_of_eac: Uuid = sqlx::query_scalar(
            "INSERT INTO player_identifiers (player_id, type, value, value_hash, first_seen_at, last_seen_at) \
             VALUES ($1, 'eac', $2, $3, $4, $4) \
             ON CONFLICT (type, value_hash) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at \
             RETURNING player_id",
        )
        .bind(player_id)
        .bind(bound_text(eac))
        .bind(&eac_hash)
        .bind(obs)
        .fetch_one(&mut **tx)
        .await?;
        if owner_of_eac != player_id {
            tracing::debug!(%player_id, %owner_of_eac, "eac id already owned by another player (possible alt)");
        }
    }

    upsert_session(tx, tenant, server, player_id, p, ip_hash.as_deref(), obs).await?;
    Ok(player_id)
}

/// Apply one real-time connect/disconnect edge.
///
/// `Connected` mirrors a one-player roster upsert (player, name history, IP signal, open
/// session, link/evasion re-eval) with an exact `connected_at`. `Disconnected` closes the
/// open session with an exact timestamp instead of waiting for the next poll to notice.
pub async fn ingest_session_edge(
    pool: &PgPool,
    pepper: &[u8],
    event: &SessionEvent,
) -> anyhow::Result<()> {
    if !is_player_steam_id(&event.steam_id) {
        return Ok(());
    }
    let tenant = event.tenant_id.0;
    let server = event.server_id.0;
    let at = event.at;
    let steam_hash = hmac_sha256(event.steam_id.as_bytes(), pepper).to_vec();

    let mut tx = pool.begin().await?;
    match event.edge {
        SessionEdge::Connected => {
            // Owner arrives from plugin connects (family share); console joins send None.
            // Owner == self isn't a share — drop it like the roster mapping does.
            let owner = event
                .owner_steam_id
                .as_ref()
                .filter(|o| !o.is_empty() && *o != "0" && **o != event.steam_id)
                .cloned();
            let observed = cupboard_domain::ObservedPlayer {
                steam_id: event.steam_id.clone(),
                owner_steam_id: owner,
                name: event.name.clone(),
                ip: event.ip.clone(),
                eac_id: event.eac_id.clone().filter(|e| !e.is_empty()),
                connected_seconds: 0,
            };
            let player_id =
                ingest_one_player(&mut tx, pepper, tenant, server, &observed, at).await?;
            crate::domain::links::evaluate_links(&mut tx, player_id, at).await?;
            crate::domain::links::check_evasion(&mut tx, tenant, player_id, at).await?;
        }
        SessionEdge::Disconnected => {
            // Close via the identifier (the player must exist if we ever opened a session).
            sqlx::query(
                "UPDATE player_sessions SET disconnected_at = $4, last_seen_at = $4 \
                 WHERE tenant_id = $1 AND server_id = $2 AND disconnected_at IS NULL \
                   AND player_id = (SELECT player_id FROM player_identifiers \
                                    WHERE type = 'steam' AND value_hash = $3)",
            )
            .bind(tenant)
            .bind(server)
            .bind(&steam_hash)
            .bind(at)
            .execute(&mut *tx)
            .await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

/// Store one chat message, resolving (or creating) the sender in the global graph.
/// Server/system messages (`steam_id` `"0"`) are stored with `player_id` NULL.
pub async fn ingest_chat(pool: &PgPool, pepper: &[u8], event: &ChatEvent) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;

    let player_id = if is_player_steam_id(&event.steam_id) {
        let steam_hash = hmac_sha256(event.steam_id.as_bytes(), pepper).to_vec();
        let id = resolve_or_create_player(&mut tx, &event.steam_id, &steam_hash, event.at).await?;
        if !event.name.is_empty() {
            sqlx::query(
                "INSERT INTO name_history (player_id, name, first_seen_at, last_seen_at) \
                 VALUES ($1, $2, $3, $3) \
                 ON CONFLICT (player_id, name) DO UPDATE SET last_seen_at = $3",
            )
            .bind(id)
            .bind(bound_text(&event.name))
            .bind(event.at)
            .execute(&mut *tx)
            .await?;
        }
        Some(id)
    } else {
        None
    };

    // Cross-source dedupe: with RCON *and* the plugin active, every message arrives
    // twice. Skip when the same player+message already landed from the OTHER source
    // within ±15s (covers plugin batching lag). Same-source repeats are real repeats;
    // legacy NULL-source rows never suppress.
    let source = event.source.map(|s| s.as_str());
    if let (Some(pid), Some(src)) = (player_id, source) {
        let duplicate: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM chat_messages \
             WHERE tenant_id = $1 AND server_id = $2 AND player_id = $3 \
               AND message = left($4, 2048) \
               AND source IS NOT NULL AND source <> $5 \
               AND sent_at BETWEEN $6 - interval '15 seconds' AND $6 + interval '15 seconds')",
        )
        .bind(event.tenant_id.0)
        .bind(event.server_id.0)
        .bind(pid)
        .bind(&event.message)
        .bind(src)
        .bind(event.at)
        .fetch_one(&mut *tx)
        .await?;
        if duplicate {
            tx.commit().await?;
            return Ok(());
        }
    }

    // Bound attacker-controlled text: Rust caps chat around 128 chars, but a hostile
    // server could claim anything over RCON.
    sqlx::query(
        "INSERT INTO chat_messages (tenant_id, server_id, player_id, channel, name, message, sent_at, source) \
         VALUES ($1, $2, $3, $4, left($5, 128), left($6, 2048), $7, $8)",
    )
    .bind(event.tenant_id.0)
    .bind(event.server_id.0)
    .bind(player_id)
    .bind(i32::try_from(event.channel).unwrap_or(-1))
    .bind(&event.name)
    .bind(&event.message)
    .bind(event.at)
    .bind(source)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

/// Store one F7 report, resolving (or creating) both sides in the global graph. The
/// target may never have been observed directly — they still get a player so repeated
/// reports against them aggregate.
pub async fn ingest_report(
    pool: &PgPool,
    pepper: &[u8],
    event: &ReportEvent,
) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;

    let reporter_id = if is_player_steam_id(&event.reporter_steam_id) {
        let hash = hmac_sha256(event.reporter_steam_id.as_bytes(), pepper).to_vec();
        Some(resolve_or_create_player(&mut tx, &event.reporter_steam_id, &hash, event.at).await?)
    } else {
        None
    };
    let target_id = if is_player_steam_id(&event.target_steam_id) {
        let hash = hmac_sha256(event.target_steam_id.as_bytes(), pepper).to_vec();
        Some(resolve_or_create_player(&mut tx, &event.target_steam_id, &hash, event.at).await?)
    } else {
        None
    };

    // Replay guard: the push path is at-least-once (a mid-batch 503 makes the plugin
    // re-send the whole batch), and a replayed report is byte-identical — same parties,
    // same server-clock `reported_at`. Skip an exact match so duplicates don't inflate
    // the "repeated reports against this player" moderation signal. Two genuinely
    // distinct reports never collide (different reporter, message, or timestamp).
    let duplicate: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM player_reports \
         WHERE tenant_id = $1 AND server_id = $2 AND reported_at = $3 \
           AND reporter_player_id IS NOT DISTINCT FROM $4 \
           AND target_player_id IS NOT DISTINCT FROM $5 \
           AND message = left($6, 2048))",
    )
    .bind(event.tenant_id.0)
    .bind(event.server_id.0)
    .bind(event.at)
    .bind(reporter_id)
    .bind(target_id)
    .bind(&event.message)
    .fetch_one(&mut *tx)
    .await?;
    if duplicate {
        tx.commit().await?;
        return Ok(());
    }

    sqlx::query(
        "INSERT INTO player_reports \
         (tenant_id, server_id, reporter_player_id, target_player_id, reporter_name, \
          target_name, subject, message, report_type, reported_at) \
         VALUES ($1, $2, $3, $4, left($5, 128), left($6, 128), left($7, 256), \
                 left($8, 2048), left($9, 64), $10)",
    )
    .bind(event.tenant_id.0)
    .bind(event.server_id.0)
    .bind(reporter_id)
    .bind(target_id)
    .bind(&event.reporter_name)
    .bind(&event.target_name)
    .bind(&event.subject)
    .bind(&event.message)
    .bind(&event.report_type)
    .bind(event.at)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

/// Find the player owning this Steam identifier, or create a fresh Cupboard Player ID +
/// the identifier. Refreshes `players.last_seen_at` either way.
///
/// Race-safe: the roster/session/chat consumers run concurrently and can all see the
/// same brand-new player in the same instant. Creation is claimed through
/// `ON CONFLICT (type, value_hash) DO UPDATE … RETURNING player_id` — the loser blocks
/// until the winner commits, adopts the winner's player, and deletes its own orphan row.
pub(crate) async fn resolve_or_create_player(
    tx: &mut Transaction<'_, Postgres>,
    steam_id: &str,
    steam_hash: &[u8],
    obs: chrono::DateTime<chrono::Utc>,
) -> anyhow::Result<Uuid> {
    let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT player_id FROM player_identifiers WHERE type='steam' AND value_hash=$1",
    )
    .bind(steam_hash)
    .fetch_optional(&mut **tx)
    .await?;

    if let Some(id) = existing {
        sqlx::query(
            "UPDATE players SET last_seen_at = $2, \
             first_seen_at = COALESCE(first_seen_at, $2), updated_at = now() WHERE id = $1",
        )
        .bind(id)
        .bind(obs)
        .execute(&mut **tx)
        .await?;
        return Ok(id);
    }

    let fresh: Uuid = sqlx::query_scalar(
        "INSERT INTO players (first_seen_at, last_seen_at) VALUES ($1, $1) RETURNING id",
    )
    .bind(obs)
    .fetch_one(&mut **tx)
    .await?;
    // Claim the identifier. On a lost race this returns the WINNER's player_id (and
    // bumps its last_seen), not ours.
    let claimed: Uuid = sqlx::query_scalar(
        "INSERT INTO player_identifiers (player_id, type, value, value_hash, first_seen_at, last_seen_at) \
         VALUES ($1, 'steam', $2, $3, $4, $4) \
         ON CONFLICT (type, value_hash) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at \
         RETURNING player_id",
    )
    .bind(fresh)
    .bind(steam_id)
    .bind(steam_hash)
    .bind(obs)
    .fetch_one(&mut **tx)
    .await?;
    if claimed != fresh {
        // Lost the creation race: drop our orphan player row and use the winner's.
        sqlx::query("DELETE FROM players WHERE id = $1")
            .bind(fresh)
            .execute(&mut **tx)
            .await?;
    }

    // Backfill any pre-emptive bans on this Steam ID (created before the player was ever
    // seen, so their player_id was left NULL) — otherwise evasion detection, which keys off
    // bans.player_id, would never fire for them. Idempotent, so safe on both race outcomes.
    sqlx::query(
        "UPDATE bans SET player_id = $1 \
         WHERE subject_type = 'steam' AND subject_hash = $2 AND player_id IS NULL",
    )
    .bind(claimed)
    .bind(steam_hash)
    .execute(&mut **tx)
    .await?;
    Ok(claimed)
}

async fn upsert_signal(
    tx: &mut Transaction<'_, Postgres>,
    player_id: Uuid,
    kind: &str,
    value: Option<&str>,
    hash: &[u8],
    obs: chrono::DateTime<chrono::Utc>,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO identity_signals \
         (player_id, type, value, value_hash, sighting_count, first_seen_at, last_seen_at) \
         VALUES ($1, $2, $3, $4, 1, $5, $5) \
         ON CONFLICT (player_id, type, value_hash) \
         DO UPDATE SET sighting_count = identity_signals.sighting_count + 1, last_seen_at = $5",
    )
    .bind(player_id)
    .bind(kind)
    .bind(value)
    .bind(hash)
    .bind(obs)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn upsert_session(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    server: Uuid,
    player_id: Uuid,
    p: &cupboard_domain::ObservedPlayer,
    ip_hash: Option<&[u8]>,
    obs: chrono::DateTime<chrono::Utc>,
) -> anyhow::Result<()> {
    // Clamp reported playtime to a sane ceiling: it's attacker-controllable on the push
    // path (the collector only clamps negatives), and `obs - Duration::seconds(raw)`
    // panics chrono for absurd values, which would kill the consumer task. A session
    // can't realistically exceed the cap.
    let connected_secs = p.connected_seconds.clamp(0, MAX_CONNECTED_SECS);
    let playtime = connected_secs as i32; // cap fits in i32
    let connected_at = obs - chrono::Duration::seconds(connected_secs);
    let name = if p.name.is_empty() {
        None
    } else {
        Some(bound_text(&p.name))
    };

    // Atomic open-or-refresh: a partial unique index on open sessions (see migration
    // 0008) lets ON CONFLICT collapse the old SELECT-then-INSERT, so two consumers
    // (roster + session edge) observing the same connect concurrently can't both insert.
    // On conflict we keep the original connected_at and refresh the live columns.
    sqlx::query(
        "INSERT INTO player_sessions \
         (tenant_id, server_id, player_id, connected_at, last_seen_at, ip, ip_hash, name, playtime_secs) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) \
         ON CONFLICT (tenant_id, server_id, player_id) WHERE disconnected_at IS NULL \
         DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, ip = EXCLUDED.ip, \
             ip_hash = EXCLUDED.ip_hash, name = EXCLUDED.name, \
             playtime_secs = EXCLUDED.playtime_secs",
    )
    .bind(tenant)
    .bind(server)
    .bind(player_id)
    .bind(connected_at)
    .bind(obs)
    // Keep the stored IP consistent with ip_hash (both drop the empty sentinel).
    .bind(p.ip.as_deref().filter(|ip| !ip.is_empty()))
    .bind(ip_hash)
    .bind(name)
    .bind(playtime)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, Utc};
    use cupboard_domain::{ObservedPlayer, RosterEvent, ServerId, TenantId};
    use sqlx::PgPool;
    use tokio::sync::OnceCell;

    static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
    static MIGRATED: OnceCell<()> = OnceCell::const_new();

    async fn setup() -> Option<PgPool> {
        let url = std::env::var("TEST_DATABASE_URL").ok()?;
        let pool = cupboard_db::connect_scoped(&url, 5, "identity,public")
            .await
            .expect("connect owner");
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

    fn player(steam: &str, owner: Option<&str>, ip: Option<&str>, secs: i64) -> ObservedPlayer {
        ObservedPlayer {
            steam_id: steam.into(),
            owner_steam_id: owner.map(Into::into),
            name: format!("name-{steam}"),
            ip: ip.map(Into::into),
            eac_id: None,
            connected_seconds: secs,
        }
    }

    // Unique-ish, ALL-DIGIT steam ids per test run so the shared global tables don't
    // collide. Digit-only because roster/edge/chat ingestion now validates SteamID64
    // shape (rejects non-digits); the `tag` is folded into digits for readable call
    // sites, and an atomic counter guarantees uniqueness across rapid same-tag calls.
    fn uniq(tag: &str) -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let tag_num: u64 = tag.bytes().map(u64::from).sum();
        format!(
            "76561{tag_num}{n}{}",
            Utc::now()
                .timestamp_nanos_opt()
                .unwrap_or_default()
                .unsigned_abs()
        )
    }

    // All-digit variant for the edge/chat paths, which validate SteamID64 shape.
    fn uniq_digits(tag: u32) -> String {
        format!(
            "76561{tag}{}",
            Utc::now()
                .timestamp_nanos_opt()
                .unwrap_or_default()
                .unsigned_abs()
                % 1_000_000_000
        )
    }

    #[tokio::test]
    async fn ingests_players_signals_and_sessions() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP ingests_players_signals_and_sessions: TEST_DATABASE_URL unset");
            return;
        };
        let pepper = b"test-pepper";
        let tenant = Uuid::new_v4();
        let server = Uuid::new_v4();
        let steam_a = uniq("a");
        let steam_b = uniq("b");
        let owner = uniq("o");

        let ev = RosterEvent {
            server_id: ServerId(server),
            tenant_id: TenantId(tenant),
            observed_at: Utc::now(),
            players: vec![
                player(&steam_a, None, Some("203.0.113.10"), 120),
                player(&steam_b, Some(&owner), Some("203.0.113.11"), 30), // family share
            ],
        };
        ingest_roster(&pool, pepper, &ev).await.expect("ingest");

        // Two open sessions on this server, both with an IP.
        let (open, with_ip): (i64, i64) = sqlx::query_as(
            "SELECT count(*), count(ip) FROM player_sessions \
             WHERE tenant_id=$1 AND server_id=$2 AND disconnected_at IS NULL",
        )
        .bind(tenant)
        .bind(server)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(open, 2, "two open sessions");
        assert_eq!(with_ip, 2, "both sessions carry an IP");

        // Player B has a steam_owner signal (family share); A does not.
        let a_hash = hmac_sha256(steam_a.as_bytes(), pepper).to_vec();
        let b_hash = hmac_sha256(steam_b.as_bytes(), pepper).to_vec();
        let a_id: Uuid =
            sqlx::query_scalar("SELECT player_id FROM player_identifiers WHERE value_hash=$1")
                .bind(&a_hash)
                .fetch_one(&pool)
                .await
                .unwrap();
        let b_id: Uuid =
            sqlx::query_scalar("SELECT player_id FROM player_identifiers WHERE value_hash=$1")
                .bind(&b_hash)
                .fetch_one(&pool)
                .await
                .unwrap();
        let a_owner: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM identity_signals WHERE player_id=$1 AND type='steam_owner'",
        )
        .bind(a_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        let b_owner: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM identity_signals WHERE player_id=$1 AND type='steam_owner'",
        )
        .bind(b_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(a_owner, 0, "no family share for A");
        assert_eq!(b_owner, 1, "family share recorded for B");
    }

    #[tokio::test]
    async fn is_idempotent_and_closes_absent_players() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP is_idempotent_and_closes_absent_players: TEST_DATABASE_URL unset");
            return;
        };
        let pepper = b"test-pepper";
        let tenant = Uuid::new_v4();
        let server = Uuid::new_v4();
        let steam_a = uniq("x");
        let steam_b = uniq("y");
        let t0 = Utc::now();

        let ev = |players, at| RosterEvent {
            server_id: ServerId(server),
            tenant_id: TenantId(tenant),
            observed_at: at,
            players,
        };

        // Poll 1: A and B online.
        ingest_roster(
            &pool,
            pepper,
            &ev(
                vec![
                    player(&steam_a, None, Some("198.51.100.1"), 10),
                    player(&steam_b, None, Some("198.51.100.2"), 10),
                ],
                t0,
            ),
        )
        .await
        .unwrap();

        // Poll 2 (same roster, later): idempotent — still exactly two open sessions.
        ingest_roster(
            &pool,
            pepper,
            &ev(
                vec![
                    player(&steam_a, None, Some("198.51.100.1"), 40),
                    player(&steam_b, None, Some("198.51.100.2"), 40),
                ],
                t0 + Duration::seconds(30),
            ),
        )
        .await
        .unwrap();
        let open: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM player_sessions \
             WHERE tenant_id=$1 AND server_id=$2 AND disconnected_at IS NULL",
        )
        .bind(tenant)
        .bind(server)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            open, 2,
            "re-applying the same roster must not duplicate sessions"
        );

        // Poll 3: only A online → B's session is closed.
        ingest_roster(
            &pool,
            pepper,
            &ev(
                vec![player(&steam_a, None, Some("198.51.100.1"), 70)],
                t0 + Duration::seconds(60),
            ),
        )
        .await
        .unwrap();
        let open_after: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM player_sessions \
             WHERE tenant_id=$1 AND server_id=$2 AND disconnected_at IS NULL",
        )
        .bind(tenant)
        .bind(server)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(open_after, 1, "B should be closed, A still open");
    }

    #[tokio::test]
    async fn session_edges_open_and_close_exactly() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP session_edges_open_and_close_exactly: TEST_DATABASE_URL unset");
            return;
        };
        let pepper = b"edge-pepper";
        let tenant = Uuid::new_v4();
        let server = Uuid::new_v4();
        let steam = uniq_digits(41);
        let t0 = Utc::now();

        let edge = |edge, at| cupboard_domain::SessionEvent {
            server_id: ServerId(server),
            tenant_id: TenantId(tenant),
            at,
            edge,
            steam_id: steam.clone(),
            name: "EdgeCase".into(),
            ip: Some("203.0.113.99".into()),
            owner_steam_id: None,
            eac_id: None,
            reason: None,
        };

        // Connect: player is created, a session opens with the exact timestamp + IP.
        ingest_session_edge(
            &pool,
            pepper,
            &edge(cupboard_domain::SessionEdge::Connected, t0),
        )
        .await
        .unwrap();
        let (open, ip): (i64, Option<String>) = sqlx::query_as(
            "SELECT count(*), max(ip) FROM player_sessions \
             WHERE tenant_id=$1 AND server_id=$2 AND disconnected_at IS NULL",
        )
        .bind(tenant)
        .bind(server)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(open, 1, "connect edge opens a session");
        assert_eq!(ip.as_deref(), Some("203.0.113.99"));

        // A replayed connect refreshes rather than duplicating.
        ingest_session_edge(
            &pool,
            pepper,
            &edge(
                cupboard_domain::SessionEdge::Connected,
                t0 + Duration::seconds(5),
            ),
        )
        .await
        .unwrap();
        let open: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM player_sessions \
             WHERE tenant_id=$1 AND server_id=$2 AND disconnected_at IS NULL",
        )
        .bind(tenant)
        .bind(server)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(open, 1, "replayed connect must not duplicate the session");

        // Disconnect closes it with the exact timestamp.
        let t_end = t0 + Duration::seconds(90);
        ingest_session_edge(
            &pool,
            pepper,
            &edge(cupboard_domain::SessionEdge::Disconnected, t_end),
        )
        .await
        .unwrap();
        let (open, closed_at): (i64, Option<chrono::DateTime<Utc>>) = sqlx::query_as(
            "SELECT count(*) FILTER (WHERE disconnected_at IS NULL), max(disconnected_at) \
             FROM player_sessions WHERE tenant_id=$1 AND server_id=$2",
        )
        .bind(tenant)
        .bind(server)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(open, 0, "disconnect edge closes the session");
        assert_eq!(closed_at.unwrap().timestamp(), t_end.timestamp());

        // A disconnect for someone with no open session is a harmless no-op.
        ingest_session_edge(
            &pool,
            pepper,
            &edge(
                cupboard_domain::SessionEdge::Disconnected,
                t_end + Duration::seconds(1),
            ),
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn chat_ingest_stores_messages_and_resolves_players() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP chat_ingest_stores_messages_and_resolves_players: unset");
            return;
        };
        let pepper = b"chat-pepper";
        let tenant = Uuid::new_v4();
        let server = Uuid::new_v4();
        let steam = uniq_digits(42);

        let chat = |steam_id: &str, name: &str, msg: &str| cupboard_domain::ChatEvent {
            server_id: ServerId(server),
            tenant_id: TenantId(tenant),
            at: Utc::now(),
            channel: 0,
            steam_id: steam_id.into(),
            name: name.into(),
            message: msg.into(),
            source: None,
        };

        // A player message creates the player and links the row to it.
        ingest_chat(&pool, pepper, &chat(&steam, "Chatty", "hello world"))
            .await
            .unwrap();
        // A server/system message stores with player_id NULL.
        ingest_chat(
            &pool,
            pepper,
            &chat("0", "SERVER", "Restarting in 5 minutes"),
        )
        .await
        .unwrap();
        // An oversized message is stored truncated, not rejected.
        ingest_chat(&pool, pepper, &chat(&steam, "Chatty", &"x".repeat(5000)))
            .await
            .unwrap();

        let (total, linked): (i64, i64) = sqlx::query_as(
            "SELECT count(*), count(player_id) FROM chat_messages \
             WHERE tenant_id=$1 AND server_id=$2",
        )
        .bind(tenant)
        .bind(server)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(total, 3);
        assert_eq!(linked, 2, "server message must not be linked to a player");

        let longest: i32 = sqlx::query_scalar(
            "SELECT max(length(message))::int4 FROM chat_messages WHERE tenant_id=$1",
        )
        .bind(tenant)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(longest, 2048, "oversized message is bounded");

        // The chatty player exists in the graph with the chat name recorded.
        let hash = hmac_sha256(steam.as_bytes(), pepper).to_vec();
        let player: Uuid =
            sqlx::query_scalar("SELECT player_id FROM player_identifiers WHERE value_hash=$1")
                .bind(&hash)
                .fetch_one(&pool)
                .await
                .unwrap();
        let names: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM name_history WHERE player_id=$1 AND name='Chatty'",
        )
        .bind(player)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(names, 1);
    }

    #[tokio::test]
    async fn absurd_connected_seconds_does_not_panic() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP absurd_connected_seconds_does_not_panic: TEST_DATABASE_URL unset");
            return;
        };
        let pepper = b"clamp-pepper";
        let tenant = Uuid::new_v4();
        let server = Uuid::new_v4();
        let steam = uniq_digits(70);
        // A hostile plugin claims a ~3-million-year session; must clamp, not panic.
        let ev = RosterEvent {
            server_id: ServerId(server),
            tenant_id: TenantId(tenant),
            observed_at: Utc::now(),
            players: vec![player(
                &steam,
                None,
                Some("203.0.113.1"),
                100_000_000_000_000,
            )],
        };
        ingest_roster(&pool, pepper, &ev)
            .await
            .expect("absurd connected_seconds must clamp, not panic the consumer");
        let open: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM player_sessions WHERE tenant_id=$1 AND disconnected_at IS NULL",
        )
        .bind(tenant)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(open, 1);
    }

    #[tokio::test]
    async fn roster_skips_non_player_steam_ids() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP roster_skips_non_player_steam_ids: TEST_DATABASE_URL unset");
            return;
        };
        let pepper = b"phantom-pepper";
        let tenant = Uuid::new_v4();
        let server = Uuid::new_v4();
        let real = uniq_digits(71);
        let ev = RosterEvent {
            server_id: ServerId(server),
            tenant_id: TenantId(tenant),
            observed_at: Utc::now(),
            players: vec![
                player("0", None, Some("203.0.113.2"), 10), // bot/NPC sentinel
                player("", None, Some("203.0.113.3"), 10),  // junk
                player(&real, None, Some("203.0.113.4"), 10),
            ],
        };
        ingest_roster(&pool, pepper, &ev).await.expect("ingest");
        // Only the real player opened a session; no phantom "0"/empty players created.
        let open: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM player_sessions WHERE tenant_id=$1 AND server_id=$2 \
             AND disconnected_at IS NULL",
        )
        .bind(tenant)
        .bind(server)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(open, 1, "only the valid steam_id becomes a session");
        let phantom: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM player_identifiers WHERE value_hash = $1 OR value_hash = $2",
        )
        .bind(hmac_sha256(b"0", pepper).to_vec())
        .bind(hmac_sha256(b"", pepper).to_vec())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(phantom, 0, "no phantom players for 0/empty steam ids");
    }

    #[tokio::test]
    async fn connect_edge_racing_roster_opens_one_session() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP connect_edge_racing_roster_opens_one_session: TEST_DATABASE_URL unset");
            return;
        };
        let pepper = b"session-race-pepper";
        let tenant = Uuid::new_v4();
        let server = Uuid::new_v4();
        let steam = uniq_digits(72);
        let at = Utc::now();

        let edge = cupboard_domain::SessionEvent {
            server_id: ServerId(server),
            tenant_id: TenantId(tenant),
            at,
            edge: cupboard_domain::SessionEdge::Connected,
            steam_id: steam.clone(),
            name: "Racer".into(),
            ip: Some("203.0.113.5".into()),
            owner_steam_id: None,
            eac_id: None,
            reason: None,
        };
        let roster = RosterEvent {
            server_id: ServerId(server),
            tenant_id: TenantId(tenant),
            observed_at: at,
            players: vec![player(&steam, None, Some("203.0.113.5"), 5)],
        };
        // The two consumers observe the same connect concurrently.
        let (a, b) = tokio::join!(
            ingest_session_edge(&pool, pepper, &edge),
            ingest_roster(&pool, pepper, &roster),
        );
        a.expect("edge");
        b.expect("roster");

        let open: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM player_sessions WHERE tenant_id=$1 AND server_id=$2 \
             AND disconnected_at IS NULL",
        )
        .bind(tenant)
        .bind(server)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(open, 1, "exactly one open session despite the race");
    }

    #[tokio::test]
    async fn report_replay_is_deduped() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP report_replay_is_deduped: TEST_DATABASE_URL unset");
            return;
        };
        let pepper = b"report-replay-pepper";
        let tenant = Uuid::new_v4();
        let server = Uuid::new_v4();
        let reporter = uniq_digits(73);
        let target = uniq_digits(74);
        let report = cupboard_domain::ReportEvent {
            server_id: ServerId(server),
            tenant_id: TenantId(tenant),
            at: Utc::now(),
            reporter_steam_id: reporter,
            reporter_name: "R".into(),
            target_steam_id: target,
            target_name: "T".into(),
            subject: "cheating".into(),
            message: "aimbot".into(),
            report_type: "cheat".into(),
        };
        // Same batch replayed after a mid-batch 503 → byte-identical report twice.
        ingest_report(&pool, pepper, &report).await.expect("first");
        ingest_report(&pool, pepper, &report).await.expect("replay");
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM player_reports WHERE tenant_id=$1")
                .bind(tenant)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 1, "a replayed report must not duplicate");
    }

    #[tokio::test]
    async fn report_ingest_resolves_both_sides() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP report_ingest_resolves_both_sides: TEST_DATABASE_URL unset");
            return;
        };
        let pepper = b"report-pepper";
        let tenant = Uuid::new_v4();
        let server = Uuid::new_v4();
        let reporter = uniq_digits(51);
        let target = uniq_digits(52);

        ingest_report(
            &pool,
            pepper,
            &cupboard_domain::ReportEvent {
                server_id: ServerId(server),
                tenant_id: TenantId(tenant),
                at: Utc::now(),
                reporter_steam_id: reporter.clone(),
                reporter_name: "GoodCitizen".into(),
                target_steam_id: target.clone(),
                target_name: "SusPlayer".into(),
                subject: "cheating".into(),
                message: "aimbot obvious".into(),
                report_type: "cheat".into(),
            },
        )
        .await
        .expect("report ingests");

        // Both sides resolved to players (the target was never otherwise observed).
        let (count, with_both): (i64, i64) = sqlx::query_as(
            "SELECT count(*), count(*) FILTER (WHERE reporter_player_id IS NOT NULL \
                 AND target_player_id IS NOT NULL) \
             FROM player_reports WHERE tenant_id = $1",
        )
        .bind(tenant)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 1);
        assert_eq!(with_both, 1, "reporter and target both resolved");
    }

    #[tokio::test]
    async fn chat_dedupes_across_sources_not_within() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP chat_dedupes_across_sources_not_within: TEST_DATABASE_URL unset");
            return;
        };
        let pepper = b"dedupe-pepper";
        let tenant = Uuid::new_v4();
        let server = Uuid::new_v4();
        let steam = uniq_digits(53);
        let t0 = Utc::now();

        let chat = |source, at| cupboard_domain::ChatEvent {
            server_id: ServerId(server),
            tenant_id: TenantId(tenant),
            at,
            channel: 0,
            steam_id: steam.clone(),
            name: "Dupe".into(),
            message: "hello world".into(),
            source: Some(source),
        };

        use cupboard_domain::EventSource::{Plugin, Rcon};
        // RCON sees it, then the plugin reports the same message 2s later → dedupe.
        ingest_chat(&pool, pepper, &chat(Rcon, t0)).await.unwrap();
        ingest_chat(&pool, pepper, &chat(Plugin, t0 + Duration::seconds(2)))
            .await
            .unwrap();
        // The player really repeats themselves (same source) → NOT deduped.
        ingest_chat(&pool, pepper, &chat(Rcon, t0 + Duration::seconds(5)))
            .await
            .unwrap();
        // …and the plugin echo of that repeat is deduped again.
        ingest_chat(&pool, pepper, &chat(Plugin, t0 + Duration::seconds(7)))
            .await
            .unwrap();

        let rows: i64 =
            sqlx::query_scalar("SELECT count(*) FROM chat_messages WHERE tenant_id = $1")
                .bind(tenant)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(rows, 2, "two real messages, two rows — echoes deduped");
    }

    #[tokio::test]
    async fn eac_identifier_attaches_without_stealing() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP eac_identifier_attaches_without_stealing: TEST_DATABASE_URL unset");
            return;
        };
        let pepper = b"eac-pepper";
        let tenant = Uuid::new_v4();
        let server = Uuid::new_v4();
        let steam_a = uniq_digits(54);
        let steam_b = uniq_digits(55);
        let eac = format!("eac-{steam_a}");

        let edge = |steam: &str| cupboard_domain::SessionEvent {
            server_id: ServerId(server),
            tenant_id: TenantId(tenant),
            at: Utc::now(),
            edge: cupboard_domain::SessionEdge::Connected,
            steam_id: steam.into(),
            name: "EacUser".into(),
            ip: None,
            owner_steam_id: None,
            eac_id: Some(eac.clone()),
            reason: None,
        };

        // A connects with the EAC id → identifier attaches to A.
        ingest_session_edge(&pool, pepper, &edge(&steam_a))
            .await
            .unwrap();
        // B connects claiming the SAME EAC id → must not steal it from A.
        ingest_session_edge(&pool, pepper, &edge(&steam_b))
            .await
            .unwrap();

        let eac_hash = hmac_sha256(eac.as_bytes(), pepper).to_vec();
        let a_id: Uuid = sqlx::query_scalar(
            "SELECT player_id FROM player_identifiers WHERE type='steam' AND value_hash=$1",
        )
        .bind(hmac_sha256(steam_a.as_bytes(), pepper).to_vec())
        .fetch_one(&pool)
        .await
        .unwrap();
        let eac_owner: Uuid = sqlx::query_scalar(
            "SELECT player_id FROM player_identifiers WHERE type='eac' AND value_hash=$1",
        )
        .bind(&eac_hash)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(eac_owner, a_id, "first observer keeps the EAC identifier");
    }

    #[tokio::test]
    async fn concurrent_consumers_create_one_player_without_failures() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP concurrent_consumers_create_one_player_without_failures: unset");
            return;
        };
        let pepper = b"race-pepper";
        let tenant = Uuid::new_v4();
        let server = Uuid::new_v4();
        let steam = uniq_digits(43);
        let at = Utc::now();

        // The exact production shape: one brand-new player arrives on the sessions,
        // chat, AND roster streams in the same instant (three concurrent consumers).
        let session_ev = cupboard_domain::SessionEvent {
            server_id: ServerId(server),
            tenant_id: TenantId(tenant),
            at,
            edge: cupboard_domain::SessionEdge::Connected,
            steam_id: steam.clone(),
            name: "Racer".into(),
            ip: Some("203.0.113.77".into()),
            owner_steam_id: None,
            eac_id: None,
            reason: None,
        };
        let chat_ev = cupboard_domain::ChatEvent {
            server_id: ServerId(server),
            tenant_id: TenantId(tenant),
            at,
            channel: 0,
            steam_id: steam.clone(),
            name: "Racer".into(),
            message: "first!".into(),
            source: None,
        };
        let roster_ev = RosterEvent {
            server_id: ServerId(server),
            tenant_id: TenantId(tenant),
            observed_at: at,
            players: vec![player(&steam, None, Some("203.0.113.77"), 5)],
        };
        let (a, b, c) = tokio::join!(
            ingest_session_edge(&pool, pepper, &session_ev),
            ingest_chat(&pool, pepper, &chat_ev),
            ingest_roster(&pool, pepper, &roster_ev),
        );
        a.expect("session edge must survive the creation race");
        b.expect("chat must survive the creation race");
        c.expect("roster must survive the creation race");

        // Exactly one player owns the identifier; no orphan players carry its name.
        let hash = hmac_sha256(steam.as_bytes(), pepper).to_vec();
        let ids: i64 =
            sqlx::query_scalar("SELECT count(*) FROM player_identifiers WHERE value_hash=$1")
                .bind(&hash)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(ids, 1, "one identifier row");
        let chat_rows: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM chat_messages WHERE tenant_id=$1 AND player_id IS NOT NULL",
        )
        .bind(tenant)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(chat_rows, 1, "the chat line survived and is linked");
    }

    #[tokio::test]
    async fn evasion_alert_when_alt_shares_ip_with_banned_player() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP evasion_alert_when_alt_shares_ip_with_banned_player: unset");
            return;
        };
        let pepper = b"ev-pepper";
        let tenant = Uuid::new_v4();
        let server = Uuid::new_v4();
        let ip = "203.0.113.200";
        let steam_a = uniq("ban");
        let steam_b = uniq("alt");

        let ev = |players| RosterEvent {
            server_id: ServerId(server),
            tenant_id: TenantId(tenant),
            observed_at: Utc::now(),
            players,
        };

        // 1) Banned-to-be player A is seen (creates player A + its IP signal).
        ingest_roster(
            &pool,
            pepper,
            &ev(vec![player(&steam_a, None, Some(ip), 60)]),
        )
        .await
        .unwrap();

        // 2) Ban A — player_id is resolved from the Steam identifier.
        crate::domain::bans::create(
            &pool,
            TenantId(tenant),
            pepper,
            crate::domain::bans::NewBan {
                subject_type: "steam".into(),
                subject_value: steam_a.clone(),
                player_id: None,
                scope: "network".into(),
                server_id: None,
                reason: Some("cheating".into()),
                issued_by: Uuid::new_v4(),
                expires_at: None,
            },
        )
        .await
        .unwrap();

        // 3) Alt B connects from the same IP → link forms, evasion alert raised.
        ingest_roster(
            &pool,
            pepper,
            &ev(vec![player(&steam_b, None, Some(ip), 5)]),
        )
        .await
        .unwrap();

        let b_id: Uuid =
            sqlx::query_scalar("SELECT player_id FROM player_identifiers WHERE value_hash = $1")
                .bind(hmac_sha256(steam_b.as_bytes(), pepper).to_vec())
                .fetch_one(&pool)
                .await
                .unwrap();
        let alerts: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM ban_evasion_alerts WHERE tenant_id = $1 AND suspect_player = $2",
        )
        .bind(tenant)
        .bind(b_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            alerts, 1,
            "an alt sharing the banned player's IP must raise one evasion alert"
        );
    }

    #[tokio::test]
    async fn preemptive_ban_backfills_player_and_still_flags_evasion() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP preemptive_ban_backfills_player_and_still_flags_evasion: unset");
            return;
        };
        let pepper = b"pre-pepper";
        let tenant = Uuid::new_v4();
        let server = Uuid::new_v4();
        let ip = "203.0.113.201";
        let steam_a = uniq("pre");
        let steam_b = uniq("prealt");

        let ev = |players| RosterEvent {
            server_id: ServerId(server),
            tenant_id: TenantId(tenant),
            observed_at: Utc::now(),
            players,
        };

        // 1) Ban A BEFORE it's ever observed → bans.player_id starts NULL.
        crate::domain::bans::create(
            &pool,
            TenantId(tenant),
            pepper,
            crate::domain::bans::NewBan {
                subject_type: "steam".into(),
                subject_value: steam_a.clone(),
                player_id: None,
                scope: "network".into(),
                server_id: None,
                reason: Some("pre-ban".into()),
                issued_by: Uuid::new_v4(),
                expires_at: None,
            },
        )
        .await
        .unwrap();

        // 2) A is seen for the first time → ingestion backfills bans.player_id.
        ingest_roster(
            &pool,
            pepper,
            &ev(vec![player(&steam_a, None, Some(ip), 60)]),
        )
        .await
        .unwrap();

        // 3) Alt B shares the IP → evasion alert fires despite the ban being pre-emptive.
        ingest_roster(
            &pool,
            pepper,
            &ev(vec![player(&steam_b, None, Some(ip), 5)]),
        )
        .await
        .unwrap();

        let b_id: Uuid =
            sqlx::query_scalar("SELECT player_id FROM player_identifiers WHERE value_hash = $1")
                .bind(hmac_sha256(steam_b.as_bytes(), pepper).to_vec())
                .fetch_one(&pool)
                .await
                .unwrap();
        let alerts: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM ban_evasion_alerts WHERE tenant_id = $1 AND suspect_player = $2",
        )
        .bind(tenant)
        .bind(b_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            alerts, 1,
            "pre-emptive ban must still catch the alt after backfill"
        );
    }
}
