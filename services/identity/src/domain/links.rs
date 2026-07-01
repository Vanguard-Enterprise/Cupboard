//! Automatic link detection + ban-evasion detection, run per player during ingestion
//! (inside the roster transaction, on the owner pool).
//!
//! Link detection scores shared signals: `confidence = 1 − Π(1 − wᵢ)` over matched signal
//! types (docs/identity-schema.md). Links are advisory — they only drive evasion alerts,
//! never auto-bans. Evasion detection: if a connecting player is linked (global auto-graph
//! or the tenant's manual links) to a player with an active ban on this tenant, raise a
//! `ban_evasion_alerts` row (default response = alert, not auto-ban).

use std::collections::{HashMap, HashSet};

use sqlx::{Postgres, Transaction};
use uuid::Uuid;

// Signal weights (docs/identity-schema.md example weights).
const W_IP: f64 = 0.3; // shared IP — down-weighted (CGNAT/shared houses/VPN)
const W_STEAM_OWNER: f64 = 0.6; // family-share owner — strong
/// Minimum confidence to surface a link (a single shared IP just clears it).
const SURFACE_THRESHOLD: f64 = 0.3;

fn weight(signal_type: &str) -> f64 {
    match signal_type {
        "ip" => W_IP,
        "steam_owner" => W_STEAM_OWNER,
        _ => 0.0,
    }
}

/// Combine matched signal weights into a single confidence in 0..1.
fn confidence(types: &HashSet<String>) -> f64 {
    let product: f64 = types.iter().map(|t| 1.0 - weight(t)).product();
    1.0 - product
}

/// Re-evaluate auto-links for `player_id` against everyone sharing a signal with them, and
/// upsert `player_links` above the surfacing threshold.
pub async fn evaluate_links(
    tx: &mut Transaction<'_, Postgres>,
    player_id: Uuid,
    obs: chrono::DateTime<chrono::Utc>,
) -> anyhow::Result<()> {
    // Every (other_player, shared_signal_type) pair for this player.
    let rows: Vec<(Uuid, String)> = sqlx::query_as(
        "SELECT s2.player_id, s1.type FROM identity_signals s1 \
         JOIN identity_signals s2 ON s1.type = s2.type AND s1.value_hash = s2.value_hash \
         WHERE s1.player_id = $1 AND s2.player_id <> $1",
    )
    .bind(player_id)
    .fetch_all(&mut **tx)
    .await?;

    let mut shared: HashMap<Uuid, HashSet<String>> = HashMap::new();
    for (other, signal_type) in rows {
        shared.entry(other).or_default().insert(signal_type);
    }

    for (other, types) in shared {
        let conf = confidence(&types);
        if conf < SURFACE_THRESHOLD {
            continue;
        }
        let (a, b) = if player_id < other {
            (player_id, other)
        } else {
            (other, player_id)
        };
        let mut shared_sorted: Vec<&String> = types.iter().collect();
        shared_sorted.sort();
        let signals = serde_json::json!({ "shared": shared_sorted });
        sqlx::query(
            "INSERT INTO player_links \
             (player_a, player_b, confidence, signals, first_detected_at, last_evaluated_at) \
             VALUES ($1, $2, $3, $4, $5, $5) \
             ON CONFLICT (player_a, player_b) \
             DO UPDATE SET confidence = $3, signals = $4, last_evaluated_at = $5",
        )
        .bind(a)
        .bind(b)
        .bind(conf as f32)
        .bind(signals)
        .bind(obs)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

/// If `player_id` is linked to any player with an active ban on `tenant`, raise an evasion
/// alert (idempotent per tenant/ban/suspect). Returns the number of new alerts created.
pub async fn check_evasion(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    player_id: Uuid,
    _obs: chrono::DateTime<chrono::Utc>,
) -> anyhow::Result<u64> {
    // Linked players: global auto-links + this tenant's manual links.
    let links: Vec<(Uuid, Uuid, String)> = sqlx::query_as(
        "SELECT (CASE WHEN player_a = $1 THEN player_b ELSE player_a END), id, 'auto' \
         FROM player_links WHERE player_a = $1 OR player_b = $1 \
         UNION ALL \
         SELECT (CASE WHEN player_a = $1 THEN player_b ELSE player_a END), id, 'manual' \
         FROM manual_links WHERE tenant_id = $2 AND (player_a = $1 OR player_b = $1)",
    )
    .bind(player_id)
    .bind(tenant)
    .fetch_all(&mut **tx)
    .await?;

    let mut created = 0u64;
    for (linked_player, link_id, kind) in links {
        // Does the linked player have an active ban on this tenant?
        let ban_id: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM bans WHERE tenant_id = $1 AND player_id = $2 AND status = 'active' \
             AND (expires_at IS NULL OR expires_at > now()) LIMIT 1",
        )
        .bind(tenant)
        .bind(linked_player)
        .fetch_optional(&mut **tx)
        .await?;

        if let Some(ban_id) = ban_id {
            let res = sqlx::query(
                "INSERT INTO ban_evasion_alerts \
                 (tenant_id, ban_id, suspect_player, via_link, via_kind) \
                 VALUES ($1, $2, $3, $4, $5) \
                 ON CONFLICT (tenant_id, ban_id, suspect_player) DO NOTHING",
            )
            .bind(tenant)
            .bind(ban_id)
            .bind(player_id)
            .bind(link_id)
            .bind(&kind)
            .execute(&mut **tx)
            .await?;
            created += res.rows_affected();
        }
    }
    Ok(created)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confidence_combines_weights() {
        let ip = HashSet::from(["ip".to_string()]);
        assert!((confidence(&ip) - 0.3).abs() < 1e-6);
        let both = HashSet::from(["ip".to_string(), "steam_owner".to_string()]);
        // 1 - (0.7 * 0.4) = 0.72
        assert!((confidence(&both) - 0.72).abs() < 1e-6);
        let owner = HashSet::from(["steam_owner".to_string()]);
        assert!(confidence(&owner) >= SURFACE_THRESHOLD);
    }
}
