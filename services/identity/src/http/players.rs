//! Player read endpoints. `players.view` is required; IP fields are shown only with
//! `players.view_pii` (otherwise nulled), honoring the PII-gating in the RBAC catalog.

use crate::domain::players;
use crate::error::AppError;
use crate::http::AuthClaims;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::Json;
use cupboard_domain::{Permission, TenantId};
use uuid::Uuid;

pub async fn list(
    State(state): State<AppState>,
    claims: AuthClaims,
) -> Result<Json<Vec<players::PlayerRow>>, AppError> {
    let org = claims.require(Permission::PlayersView)?;
    let rows = players::list(&state.app_pool, TenantId::from(org), claims.can_view_pii()).await?;
    Ok(Json(rows))
}

pub async fn get(
    State(state): State<AppState>,
    claims: AuthClaims,
    Path(id): Path<Uuid>,
) -> Result<Json<players::PlayerProfile>, AppError> {
    let org = claims.require(Permission::PlayersView)?;
    let profile = players::profile(
        &state.app_pool,
        TenantId::from(org),
        id,
        claims.can_view_pii(),
    )
    .await?;
    Ok(Json(profile))
}
