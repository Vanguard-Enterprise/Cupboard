//! Reverse-proxy for `/auth/*` → the internal auth service. These routes are
//! unauthenticated (login/signup happen before a token exists); the gateway forwards
//! method, path, query, headers, and body unchanged. Auth bodies are tiny, so the body
//! is buffered rather than streamed.

use crate::AppState;
use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, Response, StatusCode};

/// Max proxied body size (1 MiB) — auth payloads are small; this caps abuse.
const MAX_BODY_BYTES: usize = 1024 * 1024;

pub async fn proxy_auth(
    State(state): State<AppState>,
    req: Request<Body>,
) -> Result<Response<Body>, StatusCode> {
    let path = req.uri().path();
    let query = req
        .uri()
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let url = format!(
        "{}{}{}",
        state.auth_service_url.trim_end_matches('/'),
        path,
        query
    );

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
            tracing::error!(error = %e, %url, "auth proxy upstream request failed");
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
