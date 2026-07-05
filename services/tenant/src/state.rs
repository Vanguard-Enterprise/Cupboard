//! Shared, cheaply-cloneable application state handed to every handler.

use crate::cache::SiteCache;
use crate::config::Config;
use crate::http::public::MissBudget;
use cupboard_auth_core::Keys;
use sqlx::PgPool;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    /// Owner-role pool: migrations + cross-tenant public reads (RLS-exempt).
    pub owner_pool: PgPool,
    /// `cupboard_app` pool: request-scoped tenant CRUD (RLS-enforced). Use via
    /// [`cupboard_db::begin_tenant_tx`].
    pub app_pool: PgPool,
    /// Verify-only key set for operator access tokens (auth holds the private key).
    pub keys: Arc<Keys>,
    /// Best-effort Redis cache for public site resolution (misses fall back to Postgres).
    pub cache: SiteCache,
    /// Per-pod budgets for public cache-misses reaching Postgres (flood damping),
    /// one per query class so a flood on one endpoint cannot starve the other.
    pub site_miss_budget: Arc<MissBudget>,
    pub catalog_miss_budget: Arc<MissBudget>,
    pub config: Arc<Config>,
}
