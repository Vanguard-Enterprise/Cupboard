//! HTTP surface: router assembly, health probes, and the access-token extractor.

mod bans;
mod evasion;
mod internal;
mod players;

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

/// Assemble the identity service router (read path; ingestion runs as a background task).
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/players", get(players::list))
        .route("/players/{id}", get(players::get))
        .route("/players/{id}/merge", axum::routing::post(players::merge))
        // Bans (tenant-scoped, JWT + RBAC).
        .route("/bans", get(bans::list).post(bans::create))
        .route("/bans/{id}/revoke", axum::routing::post(bans::revoke))
        // Ban-evasion alerts (tenant-scoped).
        .route("/evasion", get(evasion::list))
        .route(
            "/evasion/{id}/dismiss",
            axum::routing::post(evasion::dismiss),
        )
        .route("/evasion/{id}/action", axum::routing::post(evasion::action))
        // Cluster-internal enforcement lookup for the Collector (token-guarded).
        .route("/internal/enforce", axum::routing::post(internal::enforce))
        .route_layer(axum::middleware::from_fn(cupboard_telemetry::http::track))
        .layer(TraceLayer::new_for_http().make_span_with(DefaultMakeSpan::new().level(Level::INFO)))
        .with_state(state)
}

async fn healthz(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "service": "cupboard-identity",
        "environment": state.config.environment,
    }))
}

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

/// Verifies the `Authorization: Bearer <jwt>` access token and yields its claims.
pub struct AuthClaims(pub Claims);

impl AuthClaims {
    pub fn org(&self) -> Result<OrgId, AppError> {
        self.0.org.ok_or_else(|| {
            AppError::BadRequest(
                "no organization selected; obtain an org-scoped token first".into(),
            )
        })
    }

    pub fn require(&self, perm: Permission) -> Result<OrgId, AppError> {
        let org = self.org()?;
        if self.0.has_permission(perm) {
            Ok(org)
        } else {
            Err(AppError::Forbidden(format!("missing permission: {perm}")))
        }
    }

    /// Whether the token may see PII (IP addresses).
    pub fn can_view_pii(&self) -> bool {
        self.0.has_permission(Permission::PlayersViewPii)
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
