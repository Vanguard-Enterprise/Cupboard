//! The dashboard-facing perf API (behind the gateway's `/perf/*` route). JWT-verified
//! here as well (safe when reached directly), `servers.view` gated, and tenant-scoped
//! through the window store — a server owned by another tenant 404s identically to a
//! nonexistent one.

use axum::extract::{FromRequestParts, Path, Query, State};
use axum::http::request::Parts;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use chrono::Utc;
use cupboard_auth_core::{Claims, Keys};
use cupboard_domain::Permission;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use uuid::Uuid;

use crate::rules;
use crate::window::{Sample, WindowStore};

#[derive(Clone)]
pub struct ApiState {
    pub window: WindowStore,
    pub keys: Arc<Keys>,
}

/// The perf sub-router (mounted next to the health routes).
pub fn router(state: ApiState) -> Router {
    Router::new()
        .route("/perf/servers", get(list_servers))
        .route("/perf/servers/{id}", get(server_detail))
        .with_state(state)
}

/// `GET /perf/servers` — the tenant's reporting servers with their latest sample.
async fn list_servers(State(state): State<ApiState>, claims: AuthClaims) -> Response {
    let tenant = match claims.require(Permission::ServersView) {
        Ok(org) => org,
        Err(resp) => return resp,
    };
    let rows: Vec<serde_json::Value> = state
        .window
        .latest_for_tenant(tenant)
        .into_iter()
        .map(|(server_id, latest)| json!({ "server_id": server_id, "latest": latest }))
        .collect();
    Json(rows).into_response()
}

#[derive(Deserialize)]
struct SeriesParams {
    #[serde(default)]
    minutes: Option<i64>,
}

/// `GET /perf/servers/{id}?minutes=60` — recent series + latest + recommendations.
async fn server_detail(
    State(state): State<ApiState>,
    claims: AuthClaims,
    Path(id): Path<Uuid>,
    Query(params): Query<SeriesParams>,
) -> Response {
    let tenant = match claims.require(Permission::ServersView) {
        Ok(org) => org,
        Err(resp) => return resp,
    };
    let minutes = params.minutes.unwrap_or(60);
    let Some(series) = state.window.series(tenant, id, minutes) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "no perf data for this server" })),
        )
            .into_response();
    };
    // Rules always look at the widest retained window, not just the charted range.
    let full = state
        .window
        .series(tenant, id, crate::window::RETENTION.num_minutes())
        .unwrap_or_default();
    let recommendations = rules::evaluate(&full, Utc::now());
    let latest: Option<&Sample> = full.last();
    Json(json!({
        "latest": latest,
        "series": series,
        "recommendations": recommendations,
    }))
    .into_response()
}

/// Verifies the `Authorization: Bearer <jwt>` access token and yields its claims
/// (same shape as fleet/identity; metrics just answers with plain `Response`s).
pub struct AuthClaims(pub Claims);

impl AuthClaims {
    /// Require `perm` in the token's active org; returns the tenant uuid.
    // A `Response` Err is bulky but this runs once per request, not in a hot loop.
    #[allow(clippy::result_large_err)]
    fn require(&self, perm: Permission) -> Result<Uuid, Response> {
        let Some(org) = self.0.org else {
            return Err(error(
                StatusCode::BAD_REQUEST,
                "no organization selected; obtain an org-scoped token first",
            ));
        };
        if self.0.has_permission(perm) {
            Ok(org.0)
        } else {
            Err(error(
                StatusCode::FORBIDDEN,
                &format!("missing permission: {perm}"),
            ))
        }
    }
}

impl FromRequestParts<ApiState> for AuthClaims {
    type Rejection = Response;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &ApiState,
    ) -> Result<Self, Self::Rejection> {
        let token = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.strip_prefix("Bearer "))
            .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "missing bearer token"))?;
        let claims = state
            .keys
            .decode(token)
            .map_err(|_| error(StatusCode::UNAUTHORIZED, "invalid or expired token"))?;
        Ok(AuthClaims(claims))
    }
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}
