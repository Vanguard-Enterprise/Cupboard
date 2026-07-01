//! Game-server connection clients shared by the Collector (and Fleet, for probing).
//!
//! Phase 2's zero-install ingestion baseline is **RCON pull**: Cupboard dials *out* to a
//! server's RCON endpoint and queries the roster. For Rust (the game) this is a
//! WebSocket carrying JSON frames ("WebRcon"), *not* the Source TCP RCON protocol — so
//! this crate speaks that dialect (see [`rcon`]).
//!
//! The client here is a synchronous request/response poller: send a command, read until
//! the reply with the matching identifier comes back. That is exactly the shape the
//! Collector needs for cadence-based `playerlist` polling. Unsolicited console/chat
//! frames (a separate, push-shaped concern) are ignored by [`rcon::RconClient::command`]
//! and will get a dedicated reader loop when console tailing lands with the Collector.

pub mod rcon;

pub use rcon::{GameconnError, PlayerEntry, RconClient};
