//! The cross-service event contract carried over Redis Streams. The Collector produces
//! these; Identity (and later Metrics) consume them. Kept in `domain` so producer and
//! consumers share one definition.

use crate::{ServerId, TenantId};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// The Redis Stream key for roster snapshots (`XADD`ed by the Collector).
pub const ROSTER_STREAM: &str = "cupboard:roster";

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
