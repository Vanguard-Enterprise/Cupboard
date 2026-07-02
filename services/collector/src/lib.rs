//! Cupboard Collector — connection-heavy ingestion.
//!
//! Two ingestion shapes, one event firehose (ARCHITECTURE "Data ingestion"):
//!
//! - **Pull** (Phase 2): dials *out* to each enabled server's RCON (config from fleet's
//!   internal API), polls the roster, tails the console stream, and publishes to Redis
//!   Streams for Identity to consume. Plus a best-effort A2S_INFO poll per server.
//! - **Push** (Phase 3): serves `POST /ingest/v1/events` for the gameplay plugin / perf
//!   mod, authenticated by per-server ingest tokens (hashes come with the fleet config
//!   feed), with rate limits and Redis-side stream caps as backpressure.
//!
//! The Collector holds no business logic — it authenticates, normalizes, and publishes.
//! It is the one service designed to scale horizontally; today a single replica runs
//! every connection.

pub mod a2s_task;
pub mod config;
pub mod fleet_client;
pub mod identity_client;
pub mod ingest;
pub mod manager;
pub mod mapping;
pub mod rcon_task;
pub mod registry;
