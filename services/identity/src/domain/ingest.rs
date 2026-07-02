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
use cupboard_domain::{ChatEvent, RosterEvent, SessionEdge, SessionEvent};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

/// A SteamID64 the graph should track — digits, not the `"0"`/empty server sentinel.
fn is_player_steam_id(s: &str) -> bool {
    !s.is_empty() && s != "0" && s.bytes().all(|b| b.is_ascii_digit())
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

    // Name history.
    if !p.name.is_empty() {
        sqlx::query(
            "INSERT INTO name_history (player_id, name, first_seen_at, last_seen_at) \
             VALUES ($1, $2, $3, $3) \
             ON CONFLICT (player_id, name) DO UPDATE SET last_seen_at = $3",
        )
        .bind(player_id)
        .bind(&p.name)
        .bind(obs)
        .execute(&mut **tx)
        .await?;
    }

    // IP signal (linking + the session's stored IP).
    let ip_hash =
        p.ip.as_ref()
            .map(|ip| hmac_sha256(ip.as_bytes(), pepper).to_vec());
    if let (Some(ip), Some(h)) = (&p.ip, &ip_hash) {
        upsert_signal(tx, player_id, "ip", Some(ip), h, obs).await?;
    }

    // Steam-owner signal (family share — a strong alt signal).
    if let Some(owner) = &p.owner_steam_id {
        let owner_hash = hmac_sha256(owner.as_bytes(), pepper).to_vec();
        upsert_signal(tx, player_id, "steam_owner", Some(owner), &owner_hash, obs).await?;
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
            .bind(&event.name)
            .bind(event.at)
            .execute(&mut *tx)
            .await?;
        }
        Some(id)
    } else {
        None
    };

    // Bound attacker-controlled text: Rust caps chat around 128 chars, but a hostile
    // server could claim anything over RCON.
    sqlx::query(
        "INSERT INTO chat_messages (tenant_id, server_id, player_id, channel, name, message, sent_at) \
         VALUES ($1, $2, $3, $4, left($5, 128), left($6, 2048), $7)",
    )
    .bind(event.tenant_id.0)
    .bind(event.server_id.0)
    .bind(player_id)
    .bind(i32::try_from(event.channel).unwrap_or(-1))
    .bind(&event.name)
    .bind(&event.message)
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
async fn resolve_or_create_player(
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
    let playtime = i32::try_from(p.connected_seconds.max(0)).unwrap_or(i32::MAX);
    let name = if p.name.is_empty() {
        None
    } else {
        Some(p.name.as_str())
    };

    let open: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM player_sessions \
         WHERE tenant_id = $1 AND server_id = $2 AND player_id = $3 AND disconnected_at IS NULL",
    )
    .bind(tenant)
    .bind(server)
    .bind(player_id)
    .fetch_optional(&mut **tx)
    .await?;

    match open {
        Some(sid) => {
            sqlx::query(
                "UPDATE player_sessions \
                 SET last_seen_at = $2, ip = $3, ip_hash = $4, name = $5, playtime_secs = $6 \
                 WHERE id = $1",
            )
            .bind(sid)
            .bind(obs)
            .bind(p.ip.as_deref())
            .bind(ip_hash)
            .bind(name)
            .bind(playtime)
            .execute(&mut **tx)
            .await?;
        }
        None => {
            let connected_at = obs - chrono::Duration::seconds(p.connected_seconds.max(0));
            sqlx::query(
                "INSERT INTO player_sessions \
                 (tenant_id, server_id, player_id, connected_at, last_seen_at, ip, ip_hash, name, playtime_secs) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
            )
            .bind(tenant)
            .bind(server)
            .bind(player_id)
            .bind(connected_at)
            .bind(obs)
            .bind(p.ip.as_deref())
            .bind(ip_hash)
            .bind(name)
            .bind(playtime)
            .execute(&mut **tx)
            .await?;
        }
    }
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
            connected_seconds: secs,
        }
    }

    // Unique-ish steam ids per test run so the shared global tables don't collide.
    fn uniq(tag: &str) -> String {
        format!(
            "7656{}{}",
            tag,
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
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
