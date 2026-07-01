//! Ban-evasion alert endpoints (tenant-scoped). Listing requires `bans.view`; triaging
//! (dismiss/action) requires `bans.create` (acting on an alt is a moderation decision).

use crate::domain::evasion;
use crate::error::AppError;
use crate::http::AuthClaims;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use cupboard_domain::{Permission, TenantId};
use uuid::Uuid;

pub async fn list(
    State(state): State<AppState>,
    claims: AuthClaims,
) -> Result<Json<Vec<evasion::EvasionAlert>>, AppError> {
    let org = claims.require(Permission::BansView)?;
    Ok(Json(
        evasion::list(&state.app_pool, TenantId::from(org)).await?,
    ))
}

pub async fn dismiss(
    State(state): State<AppState>,
    claims: AuthClaims,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, AppError> {
    set_status(&state, &claims, id, "dismissed").await
}

pub async fn action(
    State(state): State<AppState>,
    claims: AuthClaims,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, AppError> {
    set_status(&state, &claims, id, "actioned").await
}

async fn set_status(
    state: &AppState,
    claims: &AuthClaims,
    id: Uuid,
    status: &str,
) -> Result<StatusCode, AppError> {
    let org = claims.require(Permission::BansCreate)?;
    if evasion::set_status(&state.app_pool, TenantId::from(org), id, status).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::NotFound("evasion alert not found".into()))
    }
}
