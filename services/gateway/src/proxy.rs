//! Reverse-proxy from the gateway to internal services. `/auth/*` is unauthenticated
//! (login/signup precede a token); `/fleet/*` sits behind the JWT gate but the downstream
//! service re-validates the forwarded bearer token and enforces its own RBAC. In all
//! cases the gateway forwards method, path, query, headers, and body unchanged. Bodies
//! are small, so they're buffered rather than streamed.

use crate::AppState;
use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, Response, StatusCode};

/// Max proxied body size (1 MiB) — API payloads are small; this caps abuse.
const MAX_BODY_BYTES: usize = 1024 * 1024;

/// Reverse-proxy `/auth/*` to the auth service (unauthenticated passthrough).
pub async fn proxy_auth(
    State(state): State<AppState>,
    req: Request<Body>,
) -> Result<Response<Body>, StatusCode> {
    let base = state.auth_service_url.clone();
    proxy_to(&base, state, req).await
}

/// Reverse-proxy `/fleet/*` to the fleet service. The `require_auth` layer validates the
/// token first; fleet re-validates it and enforces `servers.*` permissions.
pub async fn proxy_fleet(
    State(state): State<AppState>,
    req: Request<Body>,
) -> Result<Response<Body>, StatusCode> {
    let base = state.fleet_service_url.clone();
    proxy_to(&base, state, req).await
}

/// Shared reverse-proxy: forward the request to `base_url` + original path/query.
async fn proxy_to(
    base_url: &str,
    state: AppState,
    req: Request<Body>,
) -> Result<Response<Body>, StatusCode> {
    let path = req.uri().path();
    let query = req
        .uri()
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let url = format!("{}{}{}", base_url.trim_end_matches('/'), path, query);

    let method = req.method().clone();
    // Drop hop-by-hop / length headers; reqwest sets its own.
    let mut headers = req.headers().clone();
    headers.remove(axum::http::header::HOST);
    headers.remove(axum::http::header::CONTENT_LENGTH);

    let body = axum::body::to_bytes(req.into_body(), MAX_BODY_BYTES)
        .await
        .map_err(|_| StatusCode::PAYLOAD_TOO_LARGE)?;

    // axum and reqwest share the `http` crate types, so Method/HeaderMap pass through.
    let upstream = state
        .http
        .request(method, &url)
        .headers(headers)
        .body(body)
        .send()
        .await
        .map_err(|e| {
            tracing::error!(error = %e, %url, "proxy upstream request failed");
            StatusCode::BAD_GATEWAY
        })?;

    let status = upstream.status();
    let resp_headers = upstream.headers().clone();
    let resp_body = upstream
        .bytes()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;

    let mut builder = Response::builder().status(status);
    for (name, value) in resp_headers.iter() {
        // Let the server layer recompute framing headers.
        if name == axum::http::header::CONTENT_LENGTH
            || name == axum::http::header::TRANSFER_ENCODING
        {
            continue;
        }
        builder = builder.header(name, value);
    }
    builder
        .body(Body::from(resp_body))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}
