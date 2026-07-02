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

/// The Redis Stream key for F7 player reports (plugin push only — RCON can't see them).
pub const REPORT_STREAM: &str = "cupboard:reports";

/// The Redis Stream key for perf samples (plugin sampler / perf mod → Metrics → Mimir).
pub const PERF_STREAM: &str = "cupboard:perf";

/// Which ingestion mechanism observed an event. Chat needs this for cross-source
/// dedupe (a server with RCON *and* the plugin reports every message twice).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventSource {
    Rcon,
    Plugin,
}

impl EventSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            EventSource::Rcon => "rcon",
            EventSource::Plugin => "plugin",
        }
    }
}

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
    /// Anti-cheat (EAC) identifier — a strong identity key the plugin captures; RCON
    /// rosters don't expose it.
    #[serde(default)]
    pub eac_id: Option<String>,
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
    /// Which mechanism saw it (drives cross-source dedupe on ingest).
    #[serde(default)]
    pub source: Option<EventSource>,
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
    /// Anti-cheat (EAC) identifier (plugin connects only).
    #[serde(default)]
    pub eac_id: Option<String>,
    /// Disconnect reason, on `Disconnected` edges that reported one.
    pub reason: Option<String>,
}

/// One server performance sample (Metrics consumes these into Mimir; ARCHITECTURE
/// Decision 5). Sampled every ~30s by the plugin's timer (cheap tier) or the Harmony
/// perf mod (deep tier: adds frame-time distribution).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PerfEvent {
    pub server_id: ServerId,
    pub tenant_id: TenantId,
    pub at: DateTime<Utc>,
    /// Server framerate at sample time.
    pub fps: f64,
    /// Networked entity count (the main long-term FPS driver on Rust servers).
    pub entities: i64,
    pub players: i64,
    /// Managed-heap megabytes.
    pub memory_mb: f64,
    /// Cumulative GC collection counts per generation (counters — rate them).
    pub gc_gen0: i64,
    pub gc_gen1: i64,
    pub gc_gen2: i64,
    /// Frame-time stats over the sample window (perf-mod tier; the plugin sampler
    /// leaves them unset).
    #[serde(default)]
    pub frame_ms_avg: Option<f64>,
    #[serde(default)]
    pub frame_ms_max: Option<f64>,
    /// Per-plugin cumulative hook time (top-N by cost; bounded for Mimir cardinality).
    #[serde(default)]
    pub hooks: Vec<HookTiming>,
}

/// One plugin's cumulative hook-time total (a counter — dashboards rate it).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookTiming {
    pub plugin: String,
    pub total_ms: f64,
}

/// One F7 report: a player reporting another for cheating/abuse. Plugin-only fidelity;
/// key moderation context (repeated reports against one player surface in the dashboard).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportEvent {
    pub server_id: ServerId,
    pub tenant_id: TenantId,
    pub at: DateTime<Utc>,
    pub reporter_steam_id: String,
    pub reporter_name: String,
    pub target_steam_id: String,
    pub target_name: String,
    pub subject: String,
    pub message: String,
    /// F7 category as the client sent it (cheat, abusive, spam, …). Kept raw.
    pub report_type: String,
}
