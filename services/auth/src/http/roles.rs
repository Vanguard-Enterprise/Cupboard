//! Permission-catalog and custom-role endpoints. Mutations require `roles.manage` in the
//! caller's active org; the catalog and role list need only org-scoped membership.

use crate::domain::{audit, rbac};
use crate::error::AppError;
use crate::http::AuthClaims;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use cupboard_domain::Permission;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Serialize)]
pub struct PermissionDto {
    pub permission: &'static str,
    pub area: &'static str,
    pub description: &'static str,
}

/// The full permission catalog (code source of truth) for building role editors.
pub async fn permission_catalog(_claims: AuthClaims) -> Json<Vec<PermissionDto>> {
    Json(
        Permission::ALL
            .iter()
            .map(|p| PermissionDto {
                permission: p.as_str(),
                area: p.area(),
                description: p.description(),
            })
            .collect(),
    )
}

/// List the org's roles with their permissions.
pub async fn list(
    State(state): State<AppState>,
    claims: AuthClaims,
) -> Result<Json<Vec<rbac::Role>>, AppError> {
    let org = claims.org()?;
    Ok(Json(rbac::list_roles(&state.app_pool, org.into()).await?))
}

#[derive(Deserialize)]
pub struct CreateRoleRequest {
    pub name: String,
    #[serde(default)]
    pub permissions: Vec<String>,
}

pub async fn create(
    State(state): State<AppState>,
    claims: AuthClaims,
    Json(req): Json<CreateRoleRequest>,
) -> Result<(StatusCode, Json<rbac::Role>), AppError> {
    let org = claims.require(Permission::RolesManage)?;
    let role = rbac::create_role(&state.app_pool, org.into(), &req.name, &req.permissions).await?;
    audit::record(
        &state.owner_pool,
        Some(org.0),
        Some(claims.0.sub.0),
        "role.create",
        Some("role"),
        Some(role.id),
        None,
    )
    .await;
    Ok((StatusCode::CREATED, Json(role)))
}

#[derive(Deserialize)]
pub struct UpdateRoleRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub permissions: Option<Vec<String>>,
}

pub async fn update(
    State(state): State<AppState>,
    claims: AuthClaims,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateRoleRequest>,
) -> Result<StatusCode, AppError> {
    let org = claims.require(Permission::RolesManage)?;
    rbac::update_role(
        &state.app_pool,
        org.into(),
        id,
        req.name.as_deref(),
        req.permissions.as_deref(),
    )
    .await?;
    audit::record(
        &state.owner_pool,
        Some(org.0),
        Some(claims.0.sub.0),
        "role.update",
        Some("role"),
        Some(id),
        None,
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete(
    State(state): State<AppState>,
    claims: AuthClaims,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, AppError> {
    let org = claims.require(Permission::RolesManage)?;
    rbac::delete_role(&state.app_pool, org.into(), id).await?;
    audit::record(
        &state.owner_pool,
        Some(org.0),
        Some(claims.0.sub.0),
        "role.delete",
        Some("role"),
        Some(id),
        None,
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}
