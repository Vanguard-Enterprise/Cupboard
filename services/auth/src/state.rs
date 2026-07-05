//! Shared, cheaply-cloneable application state handed to every handler.

use crate::config::Config;
use axum_extra::extract::cookie::Key;
use cupboard_auth_core::{Keys, PlayerKeys};
use sqlx::PgPool;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    /// Owner-role pool: migrations + cross-tenant/system operations (RLS-exempt).
    pub owner_pool: PgPool,
    /// `cupboard_app` pool: request-scoped tenant access (RLS-enforced). Use via
    /// [`cupboard_db::begin_tenant_tx`].
    pub app_pool: PgPool,
    /// EdDSA signing + verifying keys for operator access tokens.
    pub keys: Arc<Keys>,
    /// EdDSA signing keys for PLAYER access tokens (disjoint keypair). `None` when player
    /// auth is unconfigured.
    pub player_keys: Option<Arc<PlayerKeys>>,
    pub config: Arc<Config>,
    /// Outbound HTTP client for Discord token/userinfo and Steam OpenID/Web API calls.
    pub http: reqwest::Client,
    /// Signing key for OAuth state/PKCE cookies; `None` when Discord is unconfigured.
    pub cookie_key: Option<Key>,
}

impl AppState {
    /// The pepper bytes used to keyed-hash refresh and invite tokens.
    pub fn pepper(&self) -> &[u8] {
        self.config.token_pepper.as_bytes()
    }
}
