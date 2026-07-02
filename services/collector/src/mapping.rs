//! Pure translation from RCON frames (roster, chat, console edges) to the bus event
//! contract. Kept separate so it's unit-testable without a live server or Redis.

use chrono::{DateTime, Utc};
use cupboard_domain::{
    ChatEvent, ObservedPlayer, RosterEvent, ServerId, SessionEdge, SessionEvent, TenantId,
};
use cupboard_gameconn::{ChatEntry, ConsoleEvent, PlayerEntry};
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

/// Build a [`ChatEvent`] from one broadcast chat frame. Uses the Collector's clock for
/// `at` (consistent with roster snapshots, immune to server clock skew).
pub fn to_chat_event(
    server_id: Uuid,
    tenant_id: Uuid,
    entry: &ChatEntry,
    at: DateTime<Utc>,
) -> ChatEvent {
    ChatEvent {
        server_id: ServerId(server_id),
        tenant_id: TenantId(tenant_id),
        at,
        channel: entry.channel,
        steam_id: entry.user_id.clone(),
        name: entry.username.clone(),
        message: entry.message.clone(),
    }
}

/// Build a [`SessionEvent`] from one parsed console join/disconnect line.
pub fn to_session_event(
    server_id: Uuid,
    tenant_id: Uuid,
    edge: &ConsoleEvent,
    at: DateTime<Utc>,
) -> SessionEvent {
    let (kind, steam_id, name, ip, reason) = match edge {
        ConsoleEvent::Joined { ip, steam_id, name } => (
            SessionEdge::Connected,
            steam_id.clone(),
            name.clone(),
            Some(ip.clone()),
            None,
        ),
        ConsoleEvent::Disconnected {
            ip,
            steam_id,
            name,
            reason,
        } => (
            SessionEdge::Disconnected,
            steam_id.clone(),
            name.clone(),
            Some(ip.clone()),
            Some(reason.clone()),
        ),
    };
    SessionEvent {
        server_id: ServerId(server_id),
        tenant_id: TenantId(tenant_id),
        at,
        edge: kind,
        steam_id,
        name,
        ip,
        reason,
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

    #[test]
    fn maps_chat_and_session_edges() {
        let chat = ChatEntry {
            channel: 1,
            message: "on my way".into(),
            user_id: "76561198000000001".into(),
            username: "Alice".into(),
            time: 0,
        };
        let ev = to_chat_event(Uuid::nil(), Uuid::nil(), &chat, Utc::now());
        assert_eq!(ev.channel, 1);
        assert_eq!(ev.steam_id, "76561198000000001");
        assert_eq!(ev.message, "on my way");

        let join = ConsoleEvent::Joined {
            ip: "1.2.3.4".into(),
            steam_id: "76561198000000001".into(),
            name: "Alice".into(),
        };
        let ev = to_session_event(Uuid::nil(), Uuid::nil(), &join, Utc::now());
        assert_eq!(ev.edge, SessionEdge::Connected);
        assert_eq!(ev.ip.as_deref(), Some("1.2.3.4"));
        assert_eq!(ev.reason, None);

        let leave = ConsoleEvent::Disconnected {
            ip: "1.2.3.4".into(),
            steam_id: "76561198000000001".into(),
            name: "Alice".into(),
            reason: "closing".into(),
        };
        let ev = to_session_event(Uuid::nil(), Uuid::nil(), &leave, Utc::now());
        assert_eq!(ev.edge, SessionEdge::Disconnected);
        assert_eq!(ev.reason.as_deref(), Some("closing"));
    }
}
