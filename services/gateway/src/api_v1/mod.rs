//! The `/api/v1/*` public-API facade (Phase 6 decisions M/N/O/P): API-key
//! authenticated, per-org rate limited, **explicitly typed** endpoints with a
//! generated OpenAPI document. Unlike the blind `{*path}` proxies, every endpoint
//! here is a small annotated handler with its own DTOs that calls downstream and
//! re-shapes; that is what makes a stable versioned contract, a uniform error
//! envelope, and OpenAPI generation possible.
//!
//! Every response the gateway ORIGINATES on these routes uses the downstream
//! `{"error", "message"}` envelope (the identity/tenant/fleet `AppError` shape);
//! error bodies proxied from downstream already carry it and pass through unchanged.
//! The gateway's bare-StatusCode habit stops at this boundary; existing routes are
//! deliberately untouched.
//!
//! The docs routes (`/api/v1/openapi.json`, `/api/v1/docs`) are NOT behind
//! `require_api_key`: they document, they do not expose data, and the gateway's
//! IngressRoute is VPN-only, so they inherit that reachability (decision P).

pub mod bans;
pub mod key_auth;
pub mod rate_limit;

#[cfg(test)]
mod tests;

use crate::AppState;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use serde_json::json;
use utoipa::{OpenApi, ToSchema};
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;
use utoipa_scalar::{Scalar, Servable};

/// The v1 error envelope, mirrored from the downstream services' `AppError` shape.
/// Referenced by the OpenAPI doc; gateway-originated errors serialize to exactly this.
#[derive(Debug, Serialize, ToSchema)]
pub struct ErrorBody {
    /// Stable machine-readable code (`unauthorized`, `forbidden`, `too_many_requests`,
    /// `unavailable`, `bad_gateway`, `internal`).
    pub error: String,
    /// Human-readable detail.
    pub message: String,
}

/// Facade-originated errors in the `{"error","message"}` envelope. 429 responses are
/// built inline by the rate limiter because they carry `Retry-After` /
/// `X-RateLimit-*` headers alongside the envelope.
#[derive(Debug)]
pub enum ApiError {
    Unauthorized(String),
    Forbidden(String),
    /// A dependency needed to serve the request is unconfigured or unreachable
    /// (exchange down, verifier missing). 503 tells the caller to retry, not to fix
    /// its request.
    Unavailable(String),
    /// The downstream service failed mid-call.
    BadGateway(String),
    Internal(String),
}

impl ApiError {
    fn parts(&self) -> (StatusCode, &'static str, &str) {
        match self {
            ApiError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, "unauthorized", m),
            ApiError::Forbidden(m) => (StatusCode::FORBIDDEN, "forbidden", m),
            ApiError::Unavailable(m) => (StatusCode::SERVICE_UNAVAILABLE, "unavailable", m),
            ApiError::BadGateway(m) => (StatusCode::BAD_GATEWAY, "bad_gateway", m),
            ApiError::Internal(m) => (StatusCode::INTERNAL_SERVER_ERROR, "internal", m),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code, message) = self.parts();
        if status == StatusCode::INTERNAL_SERVER_ERROR {
            tracing::error!(error = ?self, "api v1 internal error");
        }
        (status, Json(json!({ "error": code, "message": message }))).into_response()
    }
}

impl From<ApiError> for Response {
    fn from(e: ApiError) -> Response {
        e.into_response()
    }
}

/// The v1 OpenAPI document root. Endpoint paths and schemas are collected by
/// `OpenApiRouter`/`routes!` at router build time; only doc-level metadata lives here.
#[derive(OpenApi)]
#[openapi(
    info(
        title = "Cupboard Public API",
        version = "1.0.0",
        description = "Cupboard's versioned public API. Authenticate with a per-tenant \
                       API key: `Authorization: Bearer cb_...`. Requests are rate \
                       limited per organization by plan tier; every response includes \
                       `X-RateLimit-Limit`/`Remaining`/`Reset` headers."
    ),
    tags((name = "bans", description = "Ban management")),
    modifiers(&ApiKeySecurity)
)]
struct ApiDoc;

/// Registers the `api_key` bearer security scheme the endpoint annotations reference.
struct ApiKeySecurity;

impl utoipa::Modify for ApiKeySecurity {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        use utoipa::openapi::security::{Http, HttpAuthScheme, SecurityScheme};
        let components = openapi
            .components
            .get_or_insert_with(utoipa::openapi::Components::default);
        components.add_security_scheme(
            "api_key",
            SecurityScheme::Http(Http::new(HttpAuthScheme::Bearer)),
        );
    }
}

/// Build the `/api/v1` router: the typed endpoints behind `require_api_key` then
/// `rate_limit`, plus the unauthenticated docs routes.
///
/// Middleware order as requests see it: `require_api_key` (outermost) exchanges and
/// validates the key, injecting [`cupboard_auth_core::Claims`]; `rate_limit` then reads
/// the claims' org and plan. `.layer` wraps bottom-up, so the limiter is added first.
pub fn router(state: AppState) -> Router<AppState> {
    let (api_routes, openapi) = OpenApiRouter::with_openapi(ApiDoc::openapi())
        .nest(
            "/api/v1",
            OpenApiRouter::new().routes(routes!(bans::list_bans)),
        )
        .split_for_parts();

    let api_routes = api_routes
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            rate_limit::rate_limit,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state,
            key_auth::require_api_key,
        ));

    let spec = openapi.clone();
    Router::new()
        .merge(api_routes)
        .route(
            "/api/v1/openapi.json",
            get(move || async move { Json(spec) }),
        )
        .merge(Scalar::with_url("/api/v1/docs", openapi))
}
