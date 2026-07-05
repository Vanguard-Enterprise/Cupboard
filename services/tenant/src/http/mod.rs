//! HTTP surface: router assembly, health probes, and the access-token extractor.

pub mod public;
mod sites;

use crate::error::AppError;
use crate::state::AppState;
use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::{header, StatusCode};
use axum::routing::get;
use axum::{Json, Router};
use cupboard_auth_core::Claims;
use cupboard_domain::{OrgId, Permission};
use serde_json::json;
use tower_http::trace::{DefaultMakeSpan, TraceLayer};
use tracing::Level;

/// Assemble the tenant service router.
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        // Operator site management (tenant-scoped, JWT + RBAC via the gateway's
        // `/sites/*` route; this service re-validates and enforces `sites.edit`).
        .route(
            "/sites",
            get(sites::get_site)
                .post(sites::create)
                .patch(sites::update),
        )
        // Public, unauthenticated reads for the storefront SSR path (via the gateway's
        // `/public/*` route; cluster-internal callers only, never internet-exposed).
        .route("/public/sites/resolve", get(public::resolve))
        // `route_layer` so metrics see the matched-path template (bounded cardinality).
        .route_layer(axum::middleware::from_fn(cupboard_telemetry::http::track))
        .layer(TraceLayer::new_for_http().make_span_with(DefaultMakeSpan::new().level(Level::INFO)))
        .with_state(state)
}

/// Liveness: process is up.
async fn healthz(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "service": "cupboard-tenant",
        "environment": state.config.environment,
    }))
}

/// Readiness: the (owner) database answers.
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

/// Extractor that verifies the `Authorization: Bearer <jwt>` operator access token and
/// yields its claims. The tenant service validates tokens itself (not just the gateway)
/// so its endpoints are safe even when reached directly. Player tokens (Phase 5 PR3+) are
/// signed with a different keypair and therefore fail verification here by construction.
pub struct AuthClaims(pub Claims);

impl AuthClaims {
    /// The org the token is scoped to, or 400 if the caller holds an org-less token.
    pub fn org(&self) -> Result<OrgId, AppError> {
        self.0.org.ok_or_else(|| {
            AppError::BadRequest(
                "no organization selected; obtain an org-scoped token first".into(),
            )
        })
    }

    /// Require `perm` in the token's active org, returning that org on success.
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
