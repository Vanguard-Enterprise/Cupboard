//! Shared, cheaply-cloneable application state for the HTTP read path.

use crate::config::Config;
use cupboard_auth_core::Keys;
use sqlx::PgPool;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    /// Owner-role pool: readiness + (via the consumer) ingestion. RLS-exempt.
    pub owner_pool: PgPool,
    /// `cupboard_app` pool: request-scoped dashboard reads (RLS-enforced).
    pub app_pool: PgPool,
    /// Verify-only key set for access tokens.
    pub keys: Arc<Keys>,
    pub config: Arc<Config>,
}
