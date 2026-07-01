//! Pure translation from an RCON roster to the bus event contract. Kept separate so it's
//! unit-testable without a live server or Redis.

use chrono::{DateTime, Utc};
use cupboard_domain::{ObservedPlayer, RosterEvent, ServerId, TenantId};
use cupboard_gameconn::PlayerEntry;
use uuid::Uuid;

/// Build a [`RosterEvent`] from one server's `playerlist` result.
pub fn to_roster_event(
    server_id: Uuid,
    tenant_id: Uuid,
    players: &[PlayerEntry],
    observed_at: DateTime<Utc>,
) -> RosterEvent {
    let players = players
        .iter()
        .map(|p| ObservedPlayer {
            steam_id: p.steam_id.clone(),
            owner_steam_id: if p.is_family_share() {
                Some(p.owner_steam_id.clone())
            } else {
                None
            },
            name: p.display_name.clone(),
            ip: {
                let ip = p.ip();
                if ip.is_empty() {
                    None
                } else {
                    Some(ip.to_string())
                }
            },
            connected_seconds: p.connected_seconds,
        })
        .collect();

    RosterEvent {
        server_id: ServerId(server_id),
        tenant_id: TenantId(tenant_id),
        observed_at,
        players,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(steam: &str, owner: &str, addr: &str) -> PlayerEntry {
        PlayerEntry {
            steam_id: steam.into(),
            owner_steam_id: owner.into(),
            display_name: "P".into(),
            ping: 10,
            address: addr.into(),
            connected_seconds: 42,
            health: 100.0,
        }
    }

    #[test]
    fn maps_ip_owner_and_ids() {
        let players = vec![
            entry("111", "0", "1.2.3.4:5000"),   // not shared
            entry("222", "111", "5.6.7.8:6000"), // family-shared
        ];
        let ev = to_roster_event(Uuid::nil(), Uuid::nil(), &players, Utc::now());
        assert_eq!(ev.players.len(), 2);
        assert_eq!(ev.players[0].ip.as_deref(), Some("1.2.3.4"));
        assert_eq!(
            ev.players[0].owner_steam_id, None,
            "owner \"0\" → not a share"
        );
        assert_eq!(ev.players[1].owner_steam_id.as_deref(), Some("111"));
        assert_eq!(ev.players[1].connected_seconds, 42);
    }

    #[test]
    fn empty_address_becomes_none() {
        let players = vec![entry("111", "0", "")];
        let ev = to_roster_event(Uuid::nil(), Uuid::nil(), &players, Utc::now());
        assert_eq!(ev.players[0].ip, None);
    }
}
