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

/// The Redis Stream key for perf samples (perf mod → Metrics → Mimir).
pub const PERF_STREAM: &str = "cupboard:perf";

/// The Redis Stream key for ticket sync events (tenant → bot; Phase 6 decision E).
/// The tenant service publishes post-commit with `publish_capped`, best-effort; the
/// bot consumes via consumer group `bot` and relays into Discord threads.
pub const TICKET_STREAM: &str = "cupboard:tickets";

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
/// Decision 5). The sample is produced exclusively by the Harmony perf mod. It mirrors
/// the useful Rust.ServerMetrics measurements while keeping the raw breakdowns together
/// so the dashboard can render a server's complete recent sample.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PerfEvent {
    pub server_id: ServerId,
    pub tenant_id: TenantId,
    pub at: DateTime<Utc>,
    /// Server framerate at sample time.
    pub fps: f64,
    /// Rolling framerate average from the server's performance tick.
    #[serde(default)]
    pub fps_avg: Option<f64>,
    /// Instantaneous frame time in milliseconds.
    #[serde(default)]
    pub frame_ms: Option<f64>,
    /// Networked entity count (the main long-term FPS driver on Rust servers).
    pub entities: i64,
    pub players: i64,
    /// Process working-set megabytes, matching Rust.ServerMetrics' `memory.used`.
    pub memory_mb: f64,
    /// Managed-heap megabytes, retained as an additional diagnostic.
    #[serde(default)]
    pub managed_memory_mb: Option<f64>,
    /// Cumulative GC collection counts per generation (counters — rate them).
    pub gc_gen0: i64,
    pub gc_gen1: i64,
    pub gc_gen2: i64,
    /// Rust's performance-tick memory counters.
    #[serde(default)]
    pub memory_collections: Option<i64>,
    #[serde(default)]
    pub memory_allocations: Option<i64>,
    #[serde(default)]
    pub gc_triggered: Option<i64>,
    /// Frame-time stats over the sample window.
    #[serde(default)]
    pub frame_ms_avg: Option<f64>,
    #[serde(default)]
    pub frame_ms_max: Option<f64>,
    /// Per-plugin cumulative hook time (top-N by cost; bounded for Mimir cardinality).
    #[serde(default)]
    pub hooks: Vec<HookTiming>,
    /// Named server timing breakdowns from the Harmony patches.
    #[serde(default)]
    pub timings: PerfTimings,
    /// Per-message network update counts and bytes for the sample window.
    #[serde(default)]
    pub network_updates: Vec<NetworkUpdate>,
    /// Per-player client performance and connection latency samples.
    #[serde(default)]
    pub player_metrics: Vec<PlayerPerf>,
    /// Server task queues from the performance tick.
    #[serde(default)]
    pub task_load_balancer: Option<i64>,
    #[serde(default)]
    pub task_invoke_handler: Option<i64>,
    #[serde(default)]
    pub task_workshop_skins_queue: Option<i64>,
    /// Server-wide network counters for the sample window.
    #[serde(default)]
    pub network_bytes_received: Option<i64>,
    #[serde(default)]
    pub network_bytes_sent: Option<i64>,
    #[serde(default)]
    pub network_packet_loss: Option<i64>,
    /// Connection queue state at sample time.
    #[serde(default)]
    pub players_joining: Option<i64>,
    #[serde(default)]
    pub players_queued: Option<i64>,
}

/// One plugin's cumulative hook-time total (a counter — dashboards rate it).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookTiming {
    pub plugin: String,
    pub total_ms: f64,
}

/// The named timing families emitted by Rust.ServerMetrics-style Harmony patches.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PerfTimings {
    #[serde(default)]
    pub invoke_execution: Vec<NamedTiming>,
    #[serde(default)]
    pub server_update: Vec<NamedTiming>,
    #[serde(default)]
    pub rpc_calls: Vec<NamedTiming>,
    #[serde(default)]
    pub work_queue: Vec<NamedTiming>,
    #[serde(default)]
    pub console_commands: Vec<NamedTiming>,
    #[serde(default)]
    pub timewarnings: Vec<NamedTiming>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NamedTiming {
    pub name: String,
    pub total_ms: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkUpdate {
    pub message_type: String,
    pub count: i64,
    pub bytes: i64,
}

/// Per-player client performance and connection latency. The IP is included because
/// Rust.ServerMetrics uses it to distinguish connection paths; identity already owns
/// the canonical IP history and may redact it from future dashboard views.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerPerf {
    pub steam_id: String,
    #[serde(default)]
    pub ip: Option<String>,
    #[serde(default)]
    pub ping_ms: Option<i64>,
    #[serde(default)]
    pub packet_loss: Option<i64>,
    #[serde(default)]
    pub client_fps: Option<f64>,
    #[serde(default)]
    pub client_memory_mb: Option<f64>,
}

/// What a [`TicketEvent`] announces (Phase 6 decision E). Wire values match the plan's
/// dotted kind names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TicketEventKind {
    #[serde(rename = "ticket.created")]
    Created,
    #[serde(rename = "ticket.message")]
    Message,
    #[serde(rename = "ticket.status")]
    Status,
}

/// One ticket sync event on [`TICKET_STREAM`] (tenant → bot). A single struct with a
/// `kind` discriminator and per-kind optional fields (all `#[serde(default)]`, so kinds
/// can grow fields without breaking consumers). Carries only what the bot needs to
/// relay; the web store stays canonical and the bot backfills detail over
/// `GET /internal/tickets/{id}` (PR5).
///
/// Invariants the producer enforces (decisions E/F, in the tenant publish helper):
/// messages with `internal=true` are NEVER published, and `origin='discord'` messages
/// are NEVER published (the bot already has them; loop prevention).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TicketEvent {
    pub kind: TicketEventKind,
    pub tenant_id: TenantId,
    pub ticket_id: uuid::Uuid,

    /// `ticket.created`: the ticket type (`general` | `ban_appeal`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ticket_type: Option<String>,
    /// `ticket.created`: the ticket subject.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    /// `ticket.created`: the optional category.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// `ticket.created`: display name of whoever opened the ticket.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opener_display: Option<String>,

    /// `ticket.message`: the message id (uuidv7 = ordering key; also the bot's
    /// relay-fence key).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<uuid::Uuid>,
    /// `ticket.message`: `player` | `staff` | `system`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_kind: Option<String>,
    /// `ticket.message`: the author's display name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_display: Option<String>,
    /// `ticket.message`: the message body.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// `ticket.message`: `web` | `system` (never `discord`; see the invariants above).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,

    /// `ticket.status`: the new status (`open` | `pending` | `resolved` | `closed`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
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
