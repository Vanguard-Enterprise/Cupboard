//! The cross-service event contract carried over Redis Streams. The Collector produces
//! these; Identity (and later Metrics) consume them. Kept in `domain` so producer and
//! consumers share one definition.

use crate::{ServerId, TenantId};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// The Redis Stream key for roster snapshots (`XADD`ed by the Collector).
pub const ROSTER_STREAM: &str = "cupboard:roster";

/// The Redis Stream key for chat messages (console stream now; plugin push later).
pub const CHAT_STREAM: &str = "cupboard:chat";

/// The Redis Stream key for real-time connect/disconnect edges (console stream now;
/// plugin push later). Roster polls remain the self-healing baseline; these edges give
/// exact session boundaries between polls.
pub const SESSION_STREAM: &str = "cupboard:sessions";

/// One player observed on a server during a single RCON poll.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObservedPlayer {
    /// The player's own Steam ID (SteamID64 as a string).
    pub steam_id: String,
    /// The Steam ID that *owns* the game copy, when different from `steam_id`
    /// (family-share — a strong alt signal). `None` when not shared/unknown.
    pub owner_steam_id: Option<String>,
    pub name: String,
    /// Connecting IP as the server sees it. `None` if the mechanism didn't expose it.
    pub ip: Option<String>,
    /// Seconds connected at observation time (from the roster).
    pub connected_seconds: i64,
}

/// A roster snapshot: every player seen on one server at one poll. Identity fans this out
/// into per-player upserts (players, identifiers, IP signals, name history, sessions).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RosterEvent {
    pub server_id: ServerId,
    pub tenant_id: TenantId,
    /// When the Collector took this snapshot.
    pub observed_at: DateTime<Utc>,
    pub players: Vec<ObservedPlayer>,
}

/// One chat message observed on a server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatEvent {
    pub server_id: ServerId,
    pub tenant_id: TenantId,
    /// When the message was sent (server-reported when available, else observation time).
    pub at: DateTime<Utc>,
    /// Game chat channel (Rust: 0 = global, 1 = team, …). Kept raw — new channels must
    /// not break the contract.
    pub channel: i64,
    /// Sender's SteamID64. `"0"` (or empty) = a server/system message.
    pub steam_id: String,
    /// Sender's display name at send time.
    pub name: String,
    pub message: String,
}

/// Which edge of a session was observed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionEdge {
    Connected,
    Disconnected,
}

/// A real-time connect/disconnect edge for one player on one server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionEvent {
    pub server_id: ServerId,
    pub tenant_id: TenantId,
    pub at: DateTime<Utc>,
    pub edge: SessionEdge,
    pub steam_id: String,
    pub name: String,
    /// Connecting IP, when the mechanism exposed it (console join lines carry it).
    pub ip: Option<String>,
    /// The Steam ID owning the game copy when family-shared (plugin connects carry it;
    /// console join lines don't).
    #[serde(default)]
    pub owner_steam_id: Option<String>,
    /// Disconnect reason, on `Disconnected` edges that reported one.
    pub reason: Option<String>,
}
