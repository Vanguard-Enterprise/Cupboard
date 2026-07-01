//! Roster ingestion: turn one [`RosterEvent`] into upserts across the global identity
//! graph and the tenant's sessions (docs/identity-schema.md "Ingestion upsert").
//!
//! Runs on the owner pool: it writes the no-RLS global tables and sets `tenant_id`
//! explicitly on `player_sessions`. One transaction per roster snapshot. Idempotent — the
//! same snapshot re-applied is a no-op beyond bumping `last_seen`/`sighting_count`, so
//! at-most-once delivery is fine (the next poll re-reports the full roster).

use cupboard_crypto::hmac_sha256;
use cupboard_domain::RosterEvent;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

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
        let steam_hash = hmac_sha256(p.steam_id.as_bytes(), pepper).to_vec();
        let player_id = resolve_or_create_player(&mut tx, &p.steam_id, &steam_hash, obs).await?;
        present.push(player_id);

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
            .execute(&mut *tx)
            .await?;
        }

        // IP signal (linking + the session's stored IP).
        let ip_hash =
            p.ip.as_ref()
                .map(|ip| hmac_sha256(ip.as_bytes(), pepper).to_vec());
        if let (Some(ip), Some(h)) = (&p.ip, &ip_hash) {
            upsert_signal(&mut tx, player_id, "ip", Some(ip), h, obs).await?;
        }

        // Steam-owner signal (family share — a strong alt signal).
        if let Some(owner) = &p.owner_steam_id {
            let owner_hash = hmac_sha256(owner.as_bytes(), pepper).to_vec();
            upsert_signal(
                &mut tx,
                player_id,
                "steam_owner",
                Some(owner),
                &owner_hash,
                obs,
            )
            .await?;
        }

        upsert_session(
            &mut tx,
            tenant,
            server,
            player_id,
            p,
            ip_hash.as_deref(),
            obs,
        )
        .await?;
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

    tx.commit().await?;
    Ok(())
}

/// Find the player owning this Steam identifier, or create a fresh Cupboard Player ID +
/// the identifier. Refreshes `players.last_seen_at` either way.
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

    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO players (first_seen_at, last_seen_at) VALUES ($1, $1) RETURNING id",
    )
    .bind(obs)
    .fetch_one(&mut **tx)
    .await?;
    sqlx::query(
        "INSERT INTO player_identifiers (player_id, type, value, value_hash, first_seen_at, last_seen_at) \
         VALUES ($1, 'steam', $2, $3, $4, $4)",
    )
    .bind(id)
    .bind(steam_id)
    .bind(steam_hash)
    .bind(obs)
    .execute(&mut **tx)
    .await?;
    Ok(id)
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
}
