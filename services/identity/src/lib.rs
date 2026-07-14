//! Cupboard Identity & Moderation: the global identity graph + per-tenant moderation
//! (Phase 2+). Ingests roster/session/chat snapshots from the bus into players /
//! identifiers / signals, serves the dashboard's read API, owns per-tenant bans and the
//! cross-tenant `/internal/*` surface the Collector and the tenant service call.
//!
//! The binary (`main.rs`) boots telemetry, opens the two Postgres pools, migrates the
//! `identity` schema, spawns the bus consumers + BM supervisor, then serves this router.

pub mod bm;
pub mod config;
pub mod consumer;
pub mod domain;
pub mod error;
pub mod http;
pub mod state;
