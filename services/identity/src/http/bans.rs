//! Ban endpoints (tenant-scoped). Create requires `bans.create`, list `bans.view`,
//! revoke `bans.revoke`.

use crate::domain::bans;
use crate::error::AppError;
use crate::http::AuthClaims;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use cupboard_domain::{Permission, TenantId};
use serde::Deserialize;
use uuid::Uuid;

fn default_scope() -> String {
    "network".to_string()
}

#[derive(Deserialize)]
pub struct CreateBanRequest {
    #[serde(default = "default_steam")]
    pub subject_type: String,
    pub subject_value: String,
    #[serde(default)]
    pub player_id: Option<Uuid>,
    #[serde(default = "default_scope")]
    pub scope: String,
    #[serde(default)]
    pub server_id: Option<Uuid>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub expires_at: Option<DateTime<Utc>>,
}

fn default_steam() -> String {
    "steam".to_string()
}

pub async fn create(
    State(state): State<AppState>,
    claims: AuthClaims,
    Json(req): Json<CreateBanRequest>,
) -> Result<(StatusCode, Json<bans::Ban>), AppError> {
    let org = claims.require(Permission::BansCreate)?;

    let subject_value = req.subject_value.trim().to_string();
    if subject_value.is_empty() {
        return Err(AppError::BadRequest("subject_value is required".into()));
    }
    if !matches!(req.subject_type.as_str(), "steam" | "eac") {
        return Err(AppError::BadRequest(
            "subject_type must be steam or eac".into(),
        ));
    }
    // A steam subject flows verbatim into BM's search URL on an outbound verify; only
    // digit ids are valid, and rejecting others here keeps a stray `#`/`&` from ever
    // corrupting that query (belt-and-braces with the search-term encoding).
    if req.subject_type == "steam"
        && (subject_value.len() > 32 || !subject_value.chars().all(|c| c.is_ascii_digit()))
    {
        return Err(AppError::BadRequest(
            "steam subject_value must be 1-32 digits".into(),
        ));
    }
    match req.scope.as_str() {
        "network" => {}
        "server" => {
            if req.server_id.is_none() {
                return Err(AppError::BadRequest(
                    "server_id is required for a server-scoped ban".into(),
                ));
            }
        }
        _ => {
            return Err(AppError::BadRequest(
                "scope must be network or server".into(),
            ))
        }
    }

    let ban = bans::create(
        &state.app_pool,
        TenantId::from(org),
        state.config.value_pepper.as_bytes(),
        bans::NewBan {
            subject_type: req.subject_type,
            subject_value,
            player_id: req.player_id,
            scope: req.scope,
            server_id: req.server_id,
            reason: req.reason.filter(|s| !s.trim().is_empty()),
            issued_by: claims.0.sub.0,
            expires_at: req.expires_at,
        },
    )
    .await?;
    Ok((StatusCode::CREATED, Json(ban)))
}

pub async fn list(
    State(state): State<AppState>,
    claims: AuthClaims,
) -> Result<Json<Vec<bans::Ban>>, AppError> {
    let org = claims.require(Permission::BansView)?;
    Ok(Json(
        bans::list(&state.app_pool, TenantId::from(org)).await?,
    ))
}

#[derive(Deserialize, Default)]
pub struct RevokeBanRequest {
    #[serde(default)]
    pub reason: Option<String>,
}

pub async fn revoke(
    State(state): State<AppState>,
    claims: AuthClaims,
    Path(id): Path<Uuid>,
    body: Option<Json<RevokeBanRequest>>,
) -> Result<Json<bans::Ban>, AppError> {
    let org = claims.require(Permission::BansRevoke)?;
    let reason = body
        .and_then(|b| b.0.reason)
        .filter(|s| !s.trim().is_empty());
    bans::revoke(
        &state.app_pool,
        TenantId::from(org),
        id,
        claims.0.sub.0,
        reason.as_deref(),
    )
    .await?
    .map(Json)
    .ok_or_else(|| AppError::NotFound("active ban not found".into()))
}
