//! Player merge: collapse `from_player` into `into_player` when they're truly the same
//! account (docs/identity-schema.md "Merge"). Repoints owned rows, marks the source
//! `merged`, and writes a `merge_log` snapshot for best-effort un-merge. Runs on the owner
//! pool (global graph). Fully audited.
//!
//! Auto-links involving the source are dropped (they recompute from signals on the next
//! sighting). Manual links (per-tenant private assertions that never recompute) are
//! repointed onto the target for every tenant, preserving `player_a < player_b`.

use crate::error::AppError;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

pub async fn merge_players(
    owner_pool: &PgPool,
    from: Uuid,
    into: Uuid,
    performed_by: Option<Uuid>,
    reason: Option<&str>,
) -> Result<serde_json::Value, AppError> {
    if from == into {
        return Err(AppError::BadRequest(
            "cannot merge a player into itself".into(),
        ));
    }

    let mut tx = owner_pool.begin().await?;

    // Both must exist; the source must still be active.
    let from_status: Option<String> =
        sqlx::query_scalar("SELECT status FROM players WHERE id = $1")
            .bind(from)
            .fetch_optional(&mut *tx)
            .await?;
    let into_status: Option<String> =
        sqlx::query_scalar("SELECT status FROM players WHERE id = $1")
            .bind(into)
            .fetch_optional(&mut *tx)
            .await?;
    match from_status.as_deref() {
        None => return Err(AppError::NotFound("source player not found".into())),
        Some("merged") => {
            return Err(AppError::BadRequest(
                "source player is already merged".into(),
            ))
        }
        _ => {}
    }
    // The target must exist and be active — never merge into a tombstoned (merged/erased)
    // player, or resolve_or_create_player would later hand out a dead id.
    match into_status.as_deref() {
        None => return Err(AppError::NotFound("target player not found".into())),
        Some("active") => {}
        Some(other) => {
            return Err(AppError::BadRequest(format!(
                "target player is not active (status: {other})"
            )))
        }
    }

    // Identifiers can't collide across players (globally unique per type) — plain repoint.
    let identifiers =
        sqlx::query("UPDATE player_identifiers SET player_id = $2 WHERE player_id = $1")
            .bind(from)
            .bind(into)
            .execute(&mut *tx)
            .await?
            .rows_affected();

    // Signals + names are unique per (player, …) — drop the source's duplicates first.
    sqlx::query(
        "DELETE FROM identity_signals s WHERE s.player_id = $1 AND EXISTS ( \
             SELECT 1 FROM identity_signals t \
             WHERE t.player_id = $2 AND t.type = s.type AND t.value_hash = s.value_hash)",
    )
    .bind(from)
    .bind(into)
    .execute(&mut *tx)
    .await?;
    let signals = sqlx::query("UPDATE identity_signals SET player_id = $2 WHERE player_id = $1")
        .bind(from)
        .bind(into)
        .execute(&mut *tx)
        .await?
        .rows_affected();

    sqlx::query(
        "DELETE FROM name_history n WHERE n.player_id = $1 AND EXISTS ( \
             SELECT 1 FROM name_history m WHERE m.player_id = $2 AND m.name = n.name)",
    )
    .bind(from)
    .bind(into)
    .execute(&mut *tx)
    .await?;
    let names = sqlx::query("UPDATE name_history SET player_id = $2 WHERE player_id = $1")
        .bind(from)
        .bind(into)
        .execute(&mut *tx)
        .await?
        .rows_affected();

    // Sessions + bans: plain repoint (no per-player uniqueness).
    let sessions = sqlx::query("UPDATE player_sessions SET player_id = $2 WHERE player_id = $1")
        .bind(from)
        .bind(into)
        .execute(&mut *tx)
        .await?
        .rows_affected();

    // Chat + F7 reports (Phase 3) hang off player_id — repoint them too, or the merged
    // player's moderation history (chat log, reports filed and reports received) would
    // vanish from the surviving profile. No per-player uniqueness, so plain repoint.
    sqlx::query("UPDATE chat_messages SET player_id = $2 WHERE player_id = $1")
        .bind(from)
        .bind(into)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE player_reports SET target_player_id = $2 WHERE target_player_id = $1")
        .bind(from)
        .bind(into)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE player_reports SET reporter_player_id = $2 WHERE reporter_player_id = $1")
        .bind(from)
        .bind(into)
        .execute(&mut *tx)
        .await?;
    let bans = sqlx::query("UPDATE bans SET player_id = $2 WHERE player_id = $1")
        .bind(from)
        .bind(into)
        .execute(&mut *tx)
        .await?
        .rows_affected();

    // Evasion alerts (unique per tenant/ban/suspect) — dedup then repoint.
    sqlx::query(
        "DELETE FROM ban_evasion_alerts a WHERE a.suspect_player = $1 AND EXISTS ( \
             SELECT 1 FROM ban_evasion_alerts b \
             WHERE b.suspect_player = $2 AND b.tenant_id = a.tenant_id AND b.ban_id = a.ban_id)",
    )
    .bind(from)
    .bind(into)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE ban_evasion_alerts SET suspect_player = $2 WHERE suspect_player = $1")
        .bind(from)
        .bind(into)
        .execute(&mut *tx)
        .await?;

    // Links recompute from signals — drop the source's.
    let links_dropped =
        sqlx::query("DELETE FROM player_links WHERE player_a = $1 OR player_b = $1")
            .bind(from)
            .execute(&mut *tx)
            .await?
            .rows_affected();
    // Manual links never recompute, so repoint them (across every tenant) rather than
    // delete. Drop any that would become a self-link, then rewrite the source endpoint to
    // the target keeping player_a < player_b.
    sqlx::query(
        "DELETE FROM manual_links \
         WHERE (player_a = $1 AND player_b = $2) OR (player_a = $2 AND player_b = $1)",
    )
    .bind(from)
    .bind(into)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE manual_links SET player_a = LEAST($2, player_b), player_b = GREATEST($2, player_b) \
         WHERE player_a = $1",
    )
    .bind(from)
    .bind(into)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE manual_links SET player_a = LEAST(player_a, $2), player_b = GREATEST(player_a, $2) \
         WHERE player_b = $1",
    )
    .bind(from)
    .bind(into)
    .execute(&mut *tx)
    .await?;

    // Mark the source merged.
    sqlx::query(
        "UPDATE players SET status = 'merged', merged_into = $2, updated_at = now() WHERE id = $1",
    )
    .bind(from)
    .bind(into)
    .execute(&mut *tx)
    .await?;

    let snapshot = json!({
        "identifiers": identifiers, "signals": signals, "names": names,
        "sessions": sessions, "bans": bans, "links_dropped": links_dropped,
    });

    sqlx::query(
        "INSERT INTO merge_log (from_player, into_player, performed_by, reason, snapshot) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(from)
    .bind(into)
    .bind(performed_by)
    .bind(reason)
    .bind(&snapshot)
    .execute(&mut *tx)
    .await?;

    // System/global audit entry (tenant NULL).
    crate::domain::audit::record_in_tx(
        &mut tx,
        None,
        performed_by,
        "player.merge",
        Some("player"),
        Some(from),
        Some(json!({ "into": into, "counts": snapshot })),
    )
    .await?;

    tx.commit().await?;
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use cupboard_domain::{ObservedPlayer, RosterEvent, ServerId, TenantId};
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

    #[tokio::test]
    async fn merge_repoints_identifiers_and_marks_source() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP merge_repoints_identifiers_and_marks_source: unset");
            return;
        };
        let pepper = b"merge-pepper";
        let tenant = Uuid::new_v4();
        let server = Uuid::new_v4();
        // All-digit (roster ingestion validates SteamID64 shape); distinct prefixes.
        let steam_a = format!("76561{}", Utc::now().timestamp_nanos_opt().unwrap());
        let steam_b = format!("76562{}", Utc::now().timestamp_nanos_opt().unwrap());

        let ev = |sid: &str| RosterEvent {
            server_id: ServerId(server),
            tenant_id: TenantId(tenant),
            observed_at: Utc::now(),
            players: vec![ObservedPlayer {
                steam_id: sid.into(),
                owner_steam_id: None,
                name: "n".into(),
                ip: Some("203.0.113.9".into()),
                eac_id: None,
                connected_seconds: 5,
            }],
        };
        crate::domain::ingest::ingest_roster(&pool, pepper, &ev(&steam_a))
            .await
            .unwrap();
        crate::domain::ingest::ingest_roster(&pool, pepper, &ev(&steam_b))
            .await
            .unwrap();

        let id_of = |hash: Vec<u8>| {
            let pool = pool.clone();
            async move {
                sqlx::query_scalar::<_, Uuid>(
                    "SELECT player_id FROM player_identifiers WHERE value_hash = $1",
                )
                .bind(hash)
                .fetch_one(&pool)
                .await
                .unwrap()
            }
        };
        let a = id_of(cupboard_crypto::hmac_sha256(steam_a.as_bytes(), pepper).to_vec()).await;
        let b = id_of(cupboard_crypto::hmac_sha256(steam_b.as_bytes(), pepper).to_vec()).await;

        merge_players(&pool, b, a, None, Some("same person"))
            .await
            .expect("merge");

        // B's identifier now points to A.
        let owner: Uuid =
            sqlx::query_scalar("SELECT player_id FROM player_identifiers WHERE value_hash = $1")
                .bind(cupboard_crypto::hmac_sha256(steam_b.as_bytes(), pepper).to_vec())
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(owner, a, "B's Steam identifier repointed to A");

        // B is marked merged into A.
        let (status, merged_into): (String, Option<Uuid>) =
            sqlx::query_as("SELECT status, merged_into FROM players WHERE id = $1")
                .bind(b)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "merged");
        assert_eq!(merged_into, Some(a));

        // A merge_log row was written.
        let logs: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM merge_log WHERE from_player = $1 AND into_player = $2",
        )
        .bind(b)
        .bind(a)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(logs, 1);
    }
}
