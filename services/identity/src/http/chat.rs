//! Chat-log read endpoint. Chat is moderation context, so `players.view` gates it (the
//! same permission as profiles, which already expose names/sessions).

use crate::domain::chat;
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
pub struct ChatParams {
    #[serde(default)]
    pub server_id: Option<Uuid>,
    #[serde(default)]
    pub player_id: Option<Uuid>,
    /// Return messages strictly older than this (keyset pagination).
    #[serde(default)]
    pub before: Option<DateTime<Utc>>,
    #[serde(default)]
    pub limit: Option<i64>,
}

pub async fn list(
    State(state): State<AppState>,
    claims: AuthClaims,
    Query(params): Query<ChatParams>,
) -> Result<Json<Vec<chat::ChatRow>>, AppError> {
    let org = claims.require(Permission::PlayersView)?;
    let rows = chat::list(
        &state.app_pool,
        TenantId::from(org),
        &chat::ChatQuery {
            server_id: params.server_id,
            player_id: params.player_id,
            before: params.before,
            limit: params.limit.unwrap_or(50),
        },
    )
    .await?;
    Ok(Json(rows))
}
