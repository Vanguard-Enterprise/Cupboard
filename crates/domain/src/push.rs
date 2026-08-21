//! The push-ingestion contract: what the gameplay plugin and perf mod POST to
//! `POST /ingest/v1/events`, authenticated by a per-server ingest token.
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

/// Per-plugin hook timings kept per perf sample (top-N by cost; the rest truncate).
/// Bounds the `plugin` label's cardinality in Mimir.
pub const MAX_HOOK_TIMINGS: usize = 20;
/// Bounds named timing labels and network message labels in telemetry.
pub const MAX_TIMING_ENTRIES: usize = 100;
pub const MAX_NETWORK_UPDATE_ENTRIES: usize = 128;
/// A high-pop server can legitimately have hundreds of players, but this prevents a
/// malformed push from turning one sample into an unbounded payload.
pub const MAX_PLAYER_METRICS: usize = 1000;

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
        /// Anti-cheat (EAC) identifier.
        #[serde(default)]
        eac_id: Option<String>,
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
    /// An F7 report filed in-game against another player.
    Report {
        at: DateTime<Utc>,
        reporter_steam_id: String,
        #[serde(default)]
        reporter_name: String,
        target_steam_id: String,
        #[serde(default)]
        target_name: String,
        #[serde(default)]
        subject: String,
        #[serde(default)]
        message: String,
        #[serde(default)]
        report_type: String,
    },
    /// A server performance sample from the perf mod. Field semantics match
    /// [`crate::PerfEvent`]; hooks beyond [`MAX_HOOK_TIMINGS`] are truncated, not
    /// rejected (Mimir cardinality discipline).
    Perf {
        at: DateTime<Utc>,
        fps: f64,
        #[serde(default)]
        fps_avg: Option<f64>,
        entities: i64,
        players: i64,
        memory_mb: f64,
        #[serde(default)]
        managed_memory_mb: Option<f64>,
        gc_gen0: i64,
        gc_gen1: i64,
        gc_gen2: i64,
        #[serde(default)]
        memory_collections: Option<i64>,
        #[serde(default)]
        memory_allocations: Option<i64>,
        #[serde(default)]
        gc_triggered: Option<i64>,
        #[serde(default)]
        task_load_balancer: Option<i64>,
        #[serde(default)]
        task_invoke_handler: Option<i64>,
        #[serde(default)]
        task_workshop_skins_queue: Option<i64>,
        #[serde(default)]
        network_bytes_received: Option<i64>,
        #[serde(default)]
        network_bytes_sent: Option<i64>,
        #[serde(default)]
        network_packet_loss: Option<i64>,
        #[serde(default)]
        players_joining: Option<i64>,
        #[serde(default)]
        players_queued: Option<i64>,
        #[serde(default)]
        frame_ms: Option<f64>,
        frame_ms_avg: Option<f64>,
        #[serde(default)]
        frame_ms_max: Option<f64>,
        #[serde(default)]
        hooks: Vec<crate::HookTiming>,
        #[serde(default)]
        timings: crate::PerfTimings,
        #[serde(default)]
        network_updates: Vec<crate::NetworkUpdate>,
        #[serde(default)]
        player_metrics: Vec<crate::PlayerPerf>,
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
    /// Anti-cheat (EAC) identifier.
    #[serde(default)]
    pub eac_id: Option<String>,
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

    #[test]
    fn full_perf_event_deserializes_with_breakdowns() {
        let batch: PushBatch = serde_json::from_value(serde_json::json!({
            "schema": 1,
            "events": [{
                "type": "perf",
                "at": "2026-08-12T12:00:00Z",
                "fps": 220.0,
                "fps_avg": 210.0,
                "frame_ms": 4.5,
                "frame_ms_avg": 4.8,
                "frame_ms_max": 32.0,
                "entities": 42000,
                "players": 12,
                "memory_mb": 8192.0,
                "managed_memory_mb": 1800.0,
                "gc_gen0": 100,
                "gc_gen1": 20,
                "gc_gen2": 2,
                "memory_collections": 3,
                "memory_allocations": 4,
                "gc_triggered": 5,
                "task_load_balancer": 1,
                "task_invoke_handler": 2,
                "task_workshop_skins_queue": 0,
                "network_bytes_received": 1000,
                "network_bytes_sent": 2000,
                "network_packet_loss": 0,
                "players_joining": 1,
                "players_queued": 0,
                "hooks": [{"plugin": "Example", "total_ms": 12.5}],
                "timings": {"server_update": [{"name": "ServerMgr.Update", "total_ms": 8.0}]},
                "network_updates": [{"message_type": "Entity", "count": 4, "bytes": 128}],
                "player_metrics": [{"steam_id": "76561198000000042", "ping_ms": 38}]
            }]
        }))
        .expect("full perf event should deserialize");
        let PushEvent::Perf {
            timings,
            network_updates,
            player_metrics,
            ..
        } = &batch.events[0]
        else {
            panic!("expected perf event");
        };
        assert_eq!(timings.server_update[0].name, "ServerMgr.Update");
        assert_eq!(network_updates[0].bytes, 128);
        assert_eq!(player_metrics[0].ping_ms, Some(38));
    }
}
