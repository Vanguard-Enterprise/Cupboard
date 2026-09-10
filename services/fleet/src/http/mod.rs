//! HTTP surface: router assembly, health probes, and the access-token extractor.

mod internal;
mod servers;

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

/// Assemble the fleet service router.
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        // Server connections (tenant-scoped, JWT + RBAC).
        .route("/fleet/servers", get(servers::list).post(servers::create))
        .route(
            "/fleet/servers/{id}",
            get(servers::get)
                .patch(servers::update)
                .delete(servers::delete),
        )
        .route(
            "/fleet/servers/{id}/ingest-token",
            axum::routing::post(servers::issue_ingest_token).delete(servers::revoke_ingest_token),
        )
        // Cross-tenant, token-guarded endpoints for the Collector and the BattleMetrics
        // import runner (not via the gateway).
        .route("/internal/servers", get(internal::list_configs))
        .route(
            "/internal/servers/import",
            axum::routing::post(internal::import),
        )
        .route(
            "/internal/servers/{id}/status",
            axum::routing::post(internal::update_status),
        )
        .route(
            "/internal/servers/{id}/info",
            axum::routing::post(internal::update_info),
        )
        // `route_layer` so metrics see the matched-path template (bounded cardinality).
        .route_layer(axum::middleware::from_fn(cupboard_telemetry::http::track))
        .layer(cupboard_telemetry::http::http_trace_layer())
        .with_state(state)
}

/// Liveness — process is up.
async fn healthz(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "service": "cupboard-fleet",
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

/// SSRF boundary guard for a tenant-supplied `rcon_host`. Rejects a host that resolves to
/// a blocked (cluster-internal) address with an operator-facing 400, so operators get an
/// immediate error instead of a silent perpetual connect failure. On resolution FAILURE
/// (hosts may be DNS names that are transiently unresolvable) the write is allowed through;
/// the dial-time guard in `cupboard_gameconn` remains the backstop.
pub(crate) async fn reject_blocked_rcon_host(
    state: &AppState,
    host: &str,
    port: u16,
) -> Result<(), AppError> {
    if state.config.allow_private_game_servers {
        return Ok(());
    }
    match cupboard_gameconn::guard::resolves_to_blocked(host, port).await {
        Ok(true) => Err(AppError::BadRequest(format!(
            "rcon_host '{host}' resolves to a blocked private/loopback/link-local address"
        ))),
        Ok(false) | Err(_) => Ok(()),
    }
}

/// Extractor that verifies the `Authorization: Bearer <jwt>` access token and yields its
/// claims. Fleet validates tokens itself (not just the gateway) so its endpoints are safe
/// even when reached directly.
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
