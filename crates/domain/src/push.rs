//! The push-ingestion contract: what the gameplay plugin (and later the perf mod) POSTs
//! to `POST /ingest/v1/events`, authenticated by a per-server ingest token.
//!
//! Versioned and forward-compatible by construction:
//! - `schema` gates breaking envelope changes (the Collector rejects unknown majors);
//! - unknown *event types* deserialize to [`PushEvent::Unknown`] and are counted +
//!   dropped, so an updated plugin can ship new event kinds before the backend consumes
//!   them (and an old backend never 400s a newer plugin).
//!
//! The Collector translates accepted events onto the same Redis streams the RCON path
//! feeds (`cupboard:sessions`, `cupboard:chat`, …) — one firehose, two sources.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// The current (and only) envelope schema version.
pub const PUSH_SCHEMA_VERSION: u32 = 1;

/// Hard cap on events per batch; bigger batches are rejected outright (413).
pub const MAX_EVENTS_PER_BATCH: usize = 500;

/// One POST body: a batch of events from one server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushBatch {
    /// Envelope schema version ([`PUSH_SCHEMA_VERSION`]).
    pub schema: u32,
    pub events: Vec<PushEvent>,
}

/// One pushed event. `at` is the server-side timestamp of the underlying moment (the
/// plugin batches, so receive time can lag by seconds).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PushEvent {
    /// Periodic liveness signal; also the guaranteed command-flush path on idle servers
    /// (every push response carries pending commands).
    Heartbeat { at: DateTime<Utc> },
    PlayerConnected {
        at: DateTime<Utc>,
        steam_id: String,
        name: String,
        #[serde(default)]
        ip: Option<String>,
        /// Owning Steam ID when the copy is family-shared.
        #[serde(default)]
        owner_steam_id: Option<String>,
    },
    PlayerDisconnected {
        at: DateTime<Utc>,
        steam_id: String,
        name: String,
        #[serde(default)]
        reason: Option<String>,
    },
    Chat {
        at: DateTime<Utc>,
        /// Game chat channel (Rust: 0 global, 1 team, …).
        channel: i64,
        steam_id: String,
        name: String,
        message: String,
    },
    /// A full online-roster snapshot (the plugin sends one periodically). The push-tier
    /// equivalent of the RCON `playerlist` poll: self-healing session baseline for
    /// plugin-only servers, and the enforcement sweep — the response carries kick
    /// commands for any banned player in it.
    Roster {
        at: DateTime<Utc>,
        players: Vec<PushedPlayer>,
    },
    /// The plugin's acknowledgement of an executed (or failed) inbound command.
    CommandResult {
        at: DateTime<Utc>,
        command_id: String,
        ok: bool,
        #[serde(default)]
        output: Option<String>,
    },
    /// Any event type this backend doesn't know yet — accepted and dropped (counted).
    #[serde(other)]
    Unknown,
}

/// One player in a pushed roster snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushedPlayer {
    pub steam_id: String,
    pub name: String,
    #[serde(default)]
    pub ip: Option<String>,
    /// Owning Steam ID when the copy is family-shared.
    #[serde(default)]
    pub owner_steam_id: Option<String>,
    #[serde(default)]
    pub connected_seconds: i64,
}

/// The response to every accepted push: how much was taken, plus pending commands for
/// the plugin to execute (bans/kicks now; entitlement grants in a later phase).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushResponse {
    pub accepted: usize,
    /// Events dropped because this backend didn't recognize their type.
    pub dropped_unknown: usize,
    pub commands: Vec<PushCommand>,
}

/// An inbound action for the plugin to execute on the game server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushCommand {
    /// Opaque id the plugin echoes back in a `command_result` event.
    pub id: String,
    #[serde(flatten)]
    pub action: PushAction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum PushAction {
    Kick { steam_id: String, reason: String },
    Ban { steam_id: String, reason: String },
    Unban { steam_id: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_event_types_deserialize_not_fail() {
        let batch: PushBatch = serde_json::from_str(
            r#"{"schema":1,"events":[
                {"type":"heartbeat","at":"2026-07-01T12:00:00Z"},
                {"type":"quantum_teleport","at":"2026-07-01T12:00:00Z","novel_field":42},
                {"type":"chat","at":"2026-07-01T12:00:01Z","channel":0,
                 "steam_id":"76561197960287930","name":"Alice","message":"hi"}
            ]}"#,
        )
        .expect("unknown types must not break the batch");
        assert_eq!(batch.events.len(), 3);
        assert!(matches!(batch.events[0], PushEvent::Heartbeat { .. }));
        assert!(matches!(batch.events[1], PushEvent::Unknown));
        assert!(matches!(batch.events[2], PushEvent::Chat { .. }));
    }

    #[test]
    fn commands_serialize_with_flat_action_tag() {
        let cmd = PushCommand {
            id: "c1".into(),
            action: PushAction::Kick {
                steam_id: "765".into(),
                reason: "banned".into(),
            },
        };
        let json = serde_json::to_value(&cmd).unwrap();
        assert_eq!(json["id"], "c1");
        assert_eq!(json["action"], "kick");
        assert_eq!(json["steam_id"], "765");
    }
}
