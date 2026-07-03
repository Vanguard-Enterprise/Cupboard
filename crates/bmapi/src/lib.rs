//! BattleMetrics API client (Phase 4, `docs/phase4-plan.md` decisions A/B/K).
//!
//! One consumer: the identity service's BM import/sync runner. The crate owns the
//! three pieces that must be correct in isolation:
//!
//!   * [`BmClient`]: bearer auth, retry/backoff, JSON:API page fetches with an
//!     injectable base URL (tests run against a local stub server).
//!   * [`RateLimiter`]: dual fixed-window budget under BM's 45 req/s + 300 req/min.
//!   * [`ban_content_hash`]: the canonical content hash used as echo guard, no-op
//!     skip, and edit detector by the sync loops.
//!
//! The BM API exposes no last-modified field on bans and no ban webhooks, which is why
//! hashing is load-bearing here rather than an optimization.

mod client;
mod hash;
mod limiter;
#[cfg(feature = "stub")]
pub mod stub;
pub mod types;

pub use client::{BmClient, BmError, DEFAULT_BASE, PAGE_SIZE};
pub use hash::ban_content_hash;
pub use limiter::RateLimiter;
