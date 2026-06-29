//! Shared domain types and contracts used across Cupboard services.
//!
//! Kept deliberately small in Phase 0 — it grows as service boundaries firm up.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Identifies a tenant (a server-network organization). Scopes all per-tenant data
/// and drives row-level security (see `cupboard-db`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TenantId(pub Uuid);

/// The canonical, global Cupboard player identity (a surrogate key — *not* a Steam ID).
/// See `docs/identity-schema.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PlayerId(pub Uuid);

impl std::fmt::Display for TenantId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::fmt::Display for PlayerId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
