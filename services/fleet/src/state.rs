//! Shared, cheaply-cloneable application state handed to every handler.

use crate::config::Config;
use cupboard_auth_core::Keys;
use sqlx::PgPool;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    /// Owner-role pool: migrations + the cross-tenant internal endpoint (RLS-exempt).
    pub owner_pool: PgPool,
    /// `cupboard_app` pool: request-scoped tenant CRUD (RLS-enforced). Use via
    /// [`cupboard_db::begin_tenant_tx`].
    pub app_pool: PgPool,
    /// Verify-only key set for access tokens (auth holds the private signing key).
    pub keys: Arc<Keys>,
    pub config: Arc<Config>,
}

impl AppState {
    /// The envelope master key that wraps per-server RCON-credential data keys.
    pub fn master_key(&self) -> &[u8; 32] {
        &self.config.master_key
    }
}
