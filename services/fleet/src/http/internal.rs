//! Cluster-internal endpoint the Collector calls to learn what to dial. Returns enabled
//! servers across **all** tenants with RCON credentials decrypted, so it is *not* exposed
//! through the gateway and is guarded by a shared `X-Internal-Token`. Fleet is the only
//! service that holds the envelope master key.

use crate::domain::servers;
use crate::error::AppError;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Deserialize;
use uuid::Uuid;

const INTERNAL_TOKEN_HEADER: &str = "x-internal-token";

/// Verify the shared internal token. Fails closed when none is configured.
fn check_internal_token(state: &AppState, headers: &HeaderMap) -> Result<(), AppError> {
    let expected = state
        .config
        .internal_api_token
        .as_deref()
        .ok_or_else(|| AppError::Unavailable("internal API disabled".into()))?;
    let presented = headers
        .get(INTERNAL_TOKEN_HEADER)
        .and_then(|h| h.to_str().ok())
        .unwrap_or_default();
    if presented.is_empty()
        || !cupboard_crypto::constant_time_eq(presented.as_bytes(), expected.as_bytes())
    {
        return Err(AppError::Unauthorized("invalid internal token".into()));
    }
    Ok(())
}

pub async fn list_configs(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<servers::ServerConfig>>, AppError> {
    check_internal_token(&state, &headers)?;
    let configs = servers::list_enabled_configs(&state.owner_pool, state.master_key()).await?;
    Ok(Json(configs))
}

#[derive(Deserialize)]
pub struct StatusUpdate {
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
}

/// Collector heartbeat: update a server's connection liveness. `connected` also refreshes
/// `last_seen_at`.
pub async fn update_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<StatusUpdate>,
) -> Result<StatusCode, AppError> {
    check_internal_token(&state, &headers)?;
    if !servers::VALID_STATUSES.contains(&body.status.as_str()) {
        return Err(AppError::BadRequest(format!(
            "invalid status '{}'",
            body.status
        )));
    }
    let mark_seen = body.status == "connected";
    servers::update_status(
        &state.owner_pool,
        id,
        &body.status,
        body.error.as_deref(),
        mark_seen,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}
