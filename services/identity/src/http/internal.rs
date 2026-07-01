//! Cluster-internal endpoint the Collector calls at poll time to learn which players to
//! kick. Token-guarded and not exposed via the gateway. Runs the enforcement lookup on the
//! owner pool (cross-tenant path; tenant filtered explicitly from the request body).

use crate::domain::bans;
use crate::error::AppError;
use crate::state::AppState;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;
use serde::Deserialize;
use uuid::Uuid;

const INTERNAL_TOKEN_HEADER: &str = "x-internal-token";

fn check_internal_token(state: &AppState, headers: &HeaderMap) -> Result<(), AppError> {
    let expected = state
        .config
        .internal_api_token
        .as_deref()
        .ok_or_else(|| AppError::Unauthorized("internal API disabled".into()))?;
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

#[derive(Deserialize)]
pub struct EnforceRequest {
    pub tenant_id: Uuid,
    pub server_id: Uuid,
    pub steam_ids: Vec<String>,
}

/// Return the subset of `steam_ids` that are currently banned (with reasons).
pub async fn enforce(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<EnforceRequest>,
) -> Result<Json<Vec<bans::EnforcementHit>>, AppError> {
    check_internal_token(&state, &headers)?;
    let hits = bans::enforce(
        &state.owner_pool,
        state.config.value_pepper.as_bytes(),
        req.tenant_id,
        req.server_id,
        &req.steam_ids,
    )
    .await?;
    Ok(Json(hits))
}
