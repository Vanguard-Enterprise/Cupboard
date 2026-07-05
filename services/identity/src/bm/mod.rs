//! BattleMetrics import/sync background machinery (Phase 4).
//!
//! Shape: a supervisor reconcile loop (collector pattern) claims tenant connections
//! that have runnable work, spawning one runner task per claimed connection. The
//! runner owns all BM I/O for its connection: token decrypt, the rate-limited client,
//! import job execution (and, from PR2 on, the sync loops + outbox drain). Exactly one
//! runner holds a connection at a time (DB lease with heartbeat), which is what makes
//! the client's process-local rate limiter globally correct per token.
//!
//! Data access lives in `crate::domain::bm`; nothing here touches HTTP.

mod fleet_client;
mod import;
mod mapping;
mod outbox;
mod runner;
pub mod supervisor;
mod sync;
