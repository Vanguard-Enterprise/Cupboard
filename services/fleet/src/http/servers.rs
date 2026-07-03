//! Server-connection endpoints (tenant-scoped). Reads require `servers.view`; writes
//! require `servers.manage`. RCON passwords are accepted here and never returned.

use crate::domain::servers;
use crate::error::AppError;
use crate::http::AuthClaims;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use cupboard_domain::{Permission, TenantId};
use serde::Deserialize;
use uuid::Uuid;

fn default_game() -> String {
    "rust".to_string()
}
fn default_true() -> bool {
    true
}

#[derive(Deserialize)]
pub struct CreateServerRequest {
    pub name: String,
    #[serde(default = "default_game")]
    pub game: String,
    pub rcon_host: String,
    pub rcon_port: i32,
    pub rcon_password: String,
    #[serde(default)]
    pub query_port: Option<i32>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Deserialize, Default)]
pub struct UpdateServerRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub rcon_host: Option<String>,
    #[serde(default)]
    pub rcon_port: Option<i32>,
    #[serde(default)]
    pub query_port: Option<i32>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub rcon_password: Option<String>,
}

/// Validate a port is in range; used for both create and update.
fn check_port(port: i32, field: &str) -> Result<(), AppError> {
    if (1..=65535).contains(&port) {
        Ok(())
    } else {
        Err(AppError::BadRequest(format!("{field} must be 1–65535")))
    }
}

/// Issue (or rotate) the push-ingest token for a server. The plaintext is returned
/// exactly once — it is never stored or re-shown.
pub async fn issue_ingest_token(
    State(state): State<AppState>,
    claims: AuthClaims,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    let org = claims.require(Permission::ServersManage)?;
    match servers::issue_ingest_token(&state.app_pool, TenantId::from(org), id).await? {
        Some(token) => Ok(Json(serde_json::json!({ "token": token }))),
        None => Err(AppError::NotFound("server not found".into())),
    }
}

/// Revoke a server's push-ingest token (push ingestion stops on the Collector's next
/// config refresh).
pub async fn revoke_ingest_token(
    State(state): State<AppState>,
    claims: AuthClaims,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, AppError> {
    let org = claims.require(Permission::ServersManage)?;
    if servers::revoke_ingest_token(&state.app_pool, TenantId::from(org), id).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::NotFound("server not found".into()))
    }
}

pub async fn create(
    State(state): State<AppState>,
    claims: AuthClaims,
    Json(req): Json<CreateServerRequest>,
) -> Result<(StatusCode, Json<servers::Server>), AppError> {
    let org = claims.require(Permission::ServersManage)?;

    let name = req.name.trim();
    let rcon_host = req.rcon_host.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("server name is required".into()));
    }
    if rcon_host.is_empty() {
        return Err(AppError::BadRequest("rcon_host is required".into()));
    }
    if req.rcon_password.is_empty() {
        return Err(AppError::BadRequest("rcon_password is required".into()));
    }
    check_port(req.rcon_port, "rcon_port")?;
    if let Some(qp) = req.query_port {
        check_port(qp, "query_port")?;
    }

    let server = servers::create(
        &state.app_pool,
        TenantId::from(org),
        state.master_key(),
        servers::NewServer {
            name: name.to_string(),
            game: req.game.trim().to_string(),
            rcon_host: rcon_host.to_string(),
            rcon_port: req.rcon_port,
            rcon_password: req.rcon_password,
            query_port: req.query_port,
            enabled: req.enabled,
        },
    )
    .await?;
    Ok((StatusCode::CREATED, Json(server)))
}

pub async fn list(
    State(state): State<AppState>,
    claims: AuthClaims,
) -> Result<Json<Vec<servers::Server>>, AppError> {
    let org = claims.require(Permission::ServersView)?;
    Ok(Json(
        servers::list(&state.app_pool, TenantId::from(org)).await?,
    ))
}

pub async fn get(
    State(state): State<AppState>,
    claims: AuthClaims,
    Path(id): Path<Uuid>,
) -> Result<Json<servers::Server>, AppError> {
    let org = claims.require(Permission::ServersView)?;
    servers::get(&state.app_pool, TenantId::from(org), id)
        .await?
        .map(Json)
        .ok_or_else(|| AppError::NotFound("server not found".into()))
}

pub async fn update(
    State(state): State<AppState>,
    claims: AuthClaims,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateServerRequest>,
) -> Result<Json<servers::Server>, AppError> {
    let org = claims.require(Permission::ServersManage)?;

    if let Some(name) = &req.name {
        if name.trim().is_empty() {
            return Err(AppError::BadRequest("name cannot be blank".into()));
        }
    }
    if let Some(port) = req.rcon_port {
        check_port(port, "rcon_port")?;
    }
    if let Some(qp) = req.query_port {
        check_port(qp, "query_port")?;
    }

    servers::update(
        &state.app_pool,
        TenantId::from(org),
        state.master_key(),
        id,
        servers::ServerUpdate {
            name: req.name.map(|s| s.trim().to_string()),
            rcon_host: req.rcon_host.map(|s| s.trim().to_string()),
            rcon_port: req.rcon_port,
            query_port: req.query_port,
            enabled: req.enabled,
            rcon_password: req.rcon_password.filter(|s| !s.is_empty()),
        },
    )
    .await?
    .map(Json)
    .ok_or_else(|| AppError::NotFound("server not found".into()))
}

pub async fn delete(
    State(state): State<AppState>,
    claims: AuthClaims,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, AppError> {
    let org = claims.require(Permission::ServersManage)?;
    if servers::delete(&state.app_pool, TenantId::from(org), id).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::NotFound("server not found".into()))
    }
}
