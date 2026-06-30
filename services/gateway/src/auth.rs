//! Access-token validation at the front door. Verifies the EdDSA JWT with the auth
//! service's public key (no DB, no network) and injects the [`Claims`] into request
//! extensions for downstream handlers. The RBAC permission gate layers on in step 3.

use crate::AppState;
use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::Response;

/// Middleware: require a valid `Authorization: Bearer <jwt>`; 401 otherwise. On success
/// the verified [`cupboard_auth_core::Claims`] are available via `Extension<Claims>`.
pub async fn require_auth(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    // Fail closed if no verifier is configured — protected routes are unavailable, never
    // unprotected.
    let Some(keys) = state.keys.as_ref() else {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    };

    let token = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .ok_or(StatusCode::UNAUTHORIZED)?;

    match keys.decode(token) {
        Ok(claims) => {
            req.extensions_mut().insert(claims);
            Ok(next.run(req).await)
        }
        Err(_) => Err(StatusCode::UNAUTHORIZED),
    }
}

// The gateway's RBAC gate for `/api/*` routes is applied per-route as a small
// permission-checking middleware that reads the validated `cupboard_auth_core::Claims`
// (injected by `require_auth`) — see `require_org_manage` in `main.rs` for the pattern
// downstream routes replicate.
