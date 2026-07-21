//! HTTP surface: router assembly, health probes, and the access-token extractor.

mod api_keys;
mod auth;
mod invites;
mod members;
mod oauth_discord;
mod orgs;
mod plans;
mod player;
mod player_discord;
mod roles;
mod steam_openid;

use crate::error::AppError;
use crate::state::AppState;
use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::{header, StatusCode};
use axum::routing::{get, patch, post, put};
use axum::{Json, Router};
use cupboard_auth_core::Claims;
use cupboard_domain::{OrgId, Permission};
use serde_json::json;
use tower_http::trace::{DefaultMakeSpan, TraceLayer};
use tracing::Level;

/// Assemble the auth service router.
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/auth/signup", post(auth::signup))
        .route("/auth/login", post(auth::login))
        .route("/auth/token", post(auth::token))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/me", get(auth::me))
        // Orgs + tenant switcher
        .route("/auth/orgs", post(orgs::create).get(orgs::list))
        // Custom RBAC
        .route("/auth/permissions", get(roles::permission_catalog))
        .route("/auth/roles", get(roles::list).post(roles::create))
        .route(
            "/auth/roles/{id}",
            patch(roles::update).delete(roles::delete),
        )
        // Members + role assignment
        .route("/auth/members", get(members::list))
        .route("/auth/members/{id}/roles", put(members::set_roles))
        // Staff invites (accept is public — no token yet)
        .route("/auth/invites", post(invites::create).get(invites::list))
        .route("/auth/invites/accept", post(invites::accept))
        // Public API keys (management requires `api.manage`)
        .route("/auth/api-keys", get(api_keys::list).post(api_keys::create))
        .route("/auth/api-keys/{id}/revoke", post(api_keys::revoke))
        // Cluster-internal (shared-token guarded, never exposed via the gateway's
        // /auth passthrough): the gateway exchanges a raw API key for a short JWT,
        // and the tenant service pushes the resolved plan mirror (distinct token).
        .route("/internal/api-keys/exchange", post(api_keys::exchange))
        .route("/internal/orgs/{id}/plan", put(plans::put_org_plan))
        // Discord OAuth (browser redirect flow)
        .route("/auth/discord/start", get(oauth_discord::start))
        .route("/auth/discord/callback", get(oauth_discord::callback))
        // Player (storefront customer) login: Steam OpenID + one-time-code handoff.
        // `start` is called cluster-internally by the web BFF; `callback` is public on
        // the central login host; the rest are BFF-driven session management. Player
        // tokens use a separate keypair, so these never grant operator access.
        .route("/auth/player/steam/start", get(steam_openid::start))
        .route("/auth/player/steam/callback", get(steam_openid::callback))
        .route(
            "/auth/player/discord/link",
            post(player_discord::link_start),
        )
        .route(
            "/auth/player/discord/callback",
            get(player_discord::callback),
        )
        .route(
            "/auth/player/discord/complete",
            post(player_discord::complete),
        )
        .route("/auth/player/exchange", post(player::exchange))
        .route("/auth/player/refresh", post(player::refresh))
        .route("/auth/player/logout", post(player::logout))
        .route("/auth/player/me", get(player::me))
        // `route_layer` so metrics see the matched-path template (bounded cardinality).
        .route_layer(axum::middleware::from_fn(cupboard_telemetry::http::track))
        .layer(TraceLayer::new_for_http().make_span_with(DefaultMakeSpan::new().level(Level::INFO)))
        .with_state(state)
}

/// Liveness — process is up.
async fn healthz(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "service": "cupboard-auth",
        "environment": state.config.environment,
    }))
}

/// Readiness — the (owner) database answers.
async fn readyz(State(state): State<AppState>) -> (StatusCode, Json<serde_json::Value>) {
    match sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.owner_pool)
        .await
    {
        Ok(_) => (StatusCode::OK, Json(json!({"status": "ready"}))),
        Err(e) => {
            tracing::warn!(error = %e, "readiness check failed");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"status": "not_ready", "reason": "database"})),
            )
        }
    }
}

/// Extractor that verifies the `Authorization: Bearer <jwt>` access token and yields its
/// claims. The auth service validates tokens itself (not just the gateway) so protected
/// endpoints are safe even when called directly, e.g. in tests.
pub struct AuthClaims(pub Claims);

impl AuthClaims {
    /// The org the token is scoped to, or 400 if the caller holds an org-less token
    /// (they must select an org via `POST /auth/token` first).
    pub fn org(&self) -> Result<OrgId, AppError> {
        self.0.org.ok_or_else(|| {
            AppError::BadRequest(
                "no organization selected; obtain an org-scoped token first".into(),
            )
        })
    }

    /// Require `perm` in the token's active org, returning that org on success. 400 if
    /// no org is selected, 403 if the permission is missing.
    pub fn require(&self, perm: Permission) -> Result<OrgId, AppError> {
        let org = self.org()?;
        if self.0.has_permission(perm) {
            Ok(org)
        } else {
            Err(AppError::Forbidden(format!("missing permission: {perm}")))
        }
    }
}

impl FromRequestParts<AppState> for AuthClaims {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.strip_prefix("Bearer "))
            .ok_or_else(|| AppError::Unauthorized("missing bearer token".into()))?;
        let claims = state
            .keys
            .decode(token)
            .map_err(|_| AppError::Unauthorized("invalid or expired token".into()))?;
        Ok(AuthClaims(claims))
    }
}

/// Pull the client User-Agent and originating IP (X-Forwarded-For, set by the gateway/
/// ingress) from request headers, for session bookkeeping.
pub(crate) fn client_info(headers: &axum::http::HeaderMap) -> (Option<String>, Option<String>) {
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|h| h.to_str().ok())
        .map(str::to_owned);
    let ip = headers
        .get("x-forwarded-for")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.split(',').next())
        .map(|s| s.trim().to_owned());
    (user_agent, ip)
}
