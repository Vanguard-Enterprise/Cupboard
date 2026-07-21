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
pub mod entitlements;
pub mod key_auth;
pub mod players;
pub mod rate_limit;
pub mod servers;

#[cfg(test)]
mod tests;

use crate::AppState;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use serde_json::json;
use utoipa::{OpenApi, ToSchema};
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;
use utoipa_scalar::{Scalar, Servable};

/// Bound on typed downstream calls: larger than the exchange timeout (these calls
/// carry real payloads) but still prompt when a downstream service blackholes; a hung
/// pod yields a fast 502 instead of a hung /api/v1 request. The shared client is
/// untimed (the blind streaming proxies need that), so this is applied per request.
pub(crate) const DOWNSTREAM_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// The minted operator JWT that `require_api_key` attached; downstream services
/// re-verify the signature and apply RLS themselves, unchanged.
pub(crate) fn forwarded_bearer(headers: &HeaderMap) -> Result<String, ApiError> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .map(str::to_owned)
        .ok_or_else(|| ApiError::Internal("bearer missing after require_api_key".into()))
}

/// Pass a downstream non-success response through with its status. Downstream error
/// bodies already carry the `{"error","message"}` envelope (the identity/tenant/fleet
/// `AppError` shape), so they cross the v1 boundary unchanged.
pub(crate) async fn passthrough(resp: reqwest::Response) -> Response {
    let status = resp.status();
    // Forward the downstream Content-Type when present (it is authoritative for its
    // own body); default to JSON, which is what every downstream envelope is.
    let content_type = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .cloned()
        .unwrap_or_else(|| axum::http::HeaderValue::from_static("application/json"));
    let body = resp.bytes().await.unwrap_or_default();
    (status, [(header::CONTENT_TYPE, content_type)], body).into_response()
}

/// The v1 error envelope, mirrored from the downstream services' `AppError` shape.
/// Referenced by the OpenAPI doc; gateway-originated errors serialize to exactly this.
#[derive(Debug, Serialize, ToSchema)]
pub struct ErrorBody {
    /// Stable machine-readable code (`bad_request`, `unauthorized`, `forbidden`,
    /// `too_many_requests`, `unavailable`, `bad_gateway`, `internal`).
    pub error: String,
    /// Human-readable detail.
    pub message: String,
}

/// Facade-originated errors in the `{"error","message"}` envelope. 429 responses are
/// built inline by the rate limiter because they carry `Retry-After` /
/// `X-RateLimit-*` headers alongside the envelope.
#[derive(Debug)]
pub enum ApiError {
    /// The request body failed facade-side deserialization (axum's default rejection
    /// would be plain text; the v1 envelope applies to every facade-originated
    /// response, decision P).
    BadRequest(String),
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
            ApiError::BadRequest(m) => (StatusCode::BAD_REQUEST, "bad_request", m),
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
    tags(
        (name = "bans", description = "Ban management. PII-bearing: the bans.* scopes \
            expose banned players' raw identifiers (subject_value) and player_id; \
            creating a ban resolves and echoes the steam_id-to-player_id linkage. \
            Issue these scopes accordingly."),
        (name = "players", description = "Player list and profiles. IPs and raw \
            identifier values require the players.view_pii scope and are null \
            otherwise."),
        (name = "servers", description = "Game server fleet, read-only"),
        (name = "entitlements", description = "Store entitlements. PII-bearing: \
            store.manage exposes players' steam_id values."),
    ),
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
            OpenApiRouter::new()
                .routes(routes!(bans::list_bans, bans::create_ban))
                .routes(routes!(bans::revoke_ban))
                .routes(routes!(players::list_players))
                .routes(routes!(players::get_player))
                .routes(routes!(servers::list_servers))
                .routes(routes!(entitlements::list_entitlements)),
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
