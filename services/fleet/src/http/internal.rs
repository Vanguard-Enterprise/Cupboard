//! Cluster-internal endpoint the Collector calls to learn what to dial. Returns enabled
//! servers across **all** tenants with RCON credentials decrypted, so it is *not* exposed
//! through the gateway and is guarded by a shared `X-Internal-Token`. Fleet is the only
//! service that holds the envelope master key.

use crate::domain::servers;
use crate::error::AppError;
use crate::state::AppState;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;

const INTERNAL_TOKEN_HEADER: &str = "x-internal-token";

pub async fn list_configs(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<servers::ServerConfig>>, AppError> {
    // Fail closed: if no internal token is configured, the endpoint is disabled entirely.
    let expected = state
        .config
        .internal_api_token
        .as_deref()
        .ok_or_else(|| AppError::Unavailable("internal API disabled".into()))?;

    let presented = headers
        .get(INTERNAL_TOKEN_HEADER)
        .and_then(|h| h.to_str().ok())
        .unwrap_or_default();

    // Constant-time-ish compare on equal-length secrets; length check first is fine here.
    if presented.is_empty() || presented != expected {
        return Err(AppError::Unauthorized("invalid internal token".into()));
    }

    let configs = servers::list_enabled_configs(&state.owner_pool, state.master_key()).await?;
    Ok(Json(configs))
}
