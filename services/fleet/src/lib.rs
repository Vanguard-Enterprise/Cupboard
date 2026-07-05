//! Cupboard Fleet: tenant-configured game-server connections (Phase 2) plus the
//! cross-tenant `/internal/*` surface the Collector and BattleMetrics import runner call
//! (Phase 3/4). Panel adapters (Pelican/Pterodactyl) follow later.

pub mod config;
pub mod domain;
pub mod error;
pub mod http;
pub mod state;
