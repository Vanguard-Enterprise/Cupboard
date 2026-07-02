//! F7-report read endpoint. Reports are moderation context, so `players.view` gates
//! them (same as profiles and chat).

use crate::domain::reports;
use crate::error::AppError;
use crate::http::AuthClaims;
use crate::state::AppState;
use axum::extract::{Query, State};
use axum::Json;
use chrono::{DateTime, Utc};
use cupboard_domain::{Permission, TenantId};
use serde::Deserialize;
use uuid::Uuid;

#[derive(Deserialize)]
pub struct ReportParams {
    #[serde(default)]
    pub server_id: Option<Uuid>,
    /// Reports filed against this player.
    #[serde(default)]
    pub target_player_id: Option<Uuid>,
    /// Return reports strictly older than this (keyset pagination).
    #[serde(default)]
    pub before: Option<DateTime<Utc>>,
    #[serde(default)]
    pub limit: Option<i64>,
}

pub async fn list(
    State(state): State<AppState>,
    claims: AuthClaims,
    Query(params): Query<ReportParams>,
) -> Result<Json<Vec<reports::ReportRow>>, AppError> {
    let org = claims.require(Permission::PlayersView)?;
    let rows = reports::list(
        &state.app_pool,
        TenantId::from(org),
        &reports::ReportQuery {
            server_id: params.server_id,
            target_player_id: params.target_player_id,
            before: params.before,
            limit: params.limit.unwrap_or(50),
        },
    )
    .await?;
    Ok(Json(rows))
}
