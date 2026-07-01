//! Player read endpoints. `players.view` is required; IP fields are shown only with
//! `players.view_pii` (otherwise nulled), honoring the PII-gating in the RBAC catalog.

use crate::domain::{merge, players};
use crate::error::AppError;
use crate::http::AuthClaims;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::Json;
use cupboard_domain::{Permission, TenantId};
use serde::Deserialize;
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

#[derive(Deserialize)]
pub struct MergeRequest {
    pub into_player_id: Uuid,
    #[serde(default)]
    pub reason: Option<String>,
}

/// Merge player `{id}` (source) into `into_player_id`. A destructive, global-graph
/// operation gated behind `org.manage`; runs on the owner pool and is fully audited.
pub async fn merge(
    State(state): State<AppState>,
    claims: AuthClaims,
    Path(id): Path<Uuid>,
    Json(req): Json<MergeRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    claims.require(Permission::OrgManage)?;
    let snapshot = merge::merge_players(
        &state.owner_pool,
        id,
        req.into_player_id,
        Some(claims.0.sub.0),
        req.reason.as_deref(),
    )
    .await?;
    Ok(Json(snapshot))
}
