//! Member listing and role assignment. Requires `staff.manage` in the active org.

use crate::domain::{audit, members};
use crate::error::AppError;
use crate::http::AuthClaims;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use cupboard_domain::Permission;
use serde::Deserialize;
use uuid::Uuid;

pub async fn list(
    State(state): State<AppState>,
    claims: AuthClaims,
) -> Result<Json<Vec<members::Member>>, AppError> {
    let org = claims.require(Permission::StaffManage)?;
    Ok(Json(
        members::list_members(&state.app_pool, org.into()).await?,
    ))
}

#[derive(Deserialize)]
pub struct SetRolesRequest {
    pub role_ids: Vec<Uuid>,
}

pub async fn set_roles(
    State(state): State<AppState>,
    claims: AuthClaims,
    Path(membership_id): Path<Uuid>,
    Json(req): Json<SetRolesRequest>,
) -> Result<StatusCode, AppError> {
    let org = claims.require(Permission::StaffManage)?;
    members::set_member_roles(&state.app_pool, org.into(), membership_id, &req.role_ids).await?;
    audit::record(
        &state.owner_pool,
        Some(org.0),
        Some(claims.0.sub.0),
        "member.roles.set",
        Some("membership"),
        Some(membership_id),
        None,
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}
