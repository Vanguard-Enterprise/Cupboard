//! Cluster-internal endpoints, guarded by a shared `X-Internal-Token` and *not* exposed
//! through the gateway (it only reverse-proxies `/fleet/*`, not `/internal/*`).
//!
//! - The Collector's config feed: enabled servers across **all** tenants with RCON
//!   credentials decrypted. Fleet is the only service that holds the envelope master key.
//! - The BattleMetrics import runner's `POST /internal/servers/import`: registers a
//!   server the tenant hasn't wired into Cupboard yet, without ever handling that
//!   tenant's RCON credentials.

use crate::domain::servers;
use crate::error::AppError;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Deserialize;
use uuid::Uuid;

const INTERNAL_TOKEN_HEADER: &str = "x-internal-token";

/// Verify the shared internal token. Fails closed when none is configured.
fn check_internal_token(state: &AppState, headers: &HeaderMap) -> Result<(), AppError> {
    let expected = state
        .config
        .internal_api_token
        .as_deref()
        .ok_or_else(|| AppError::Unavailable("internal API disabled".into()))?;
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

pub async fn list_configs(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<servers::ServerConfig>>, AppError> {
    check_internal_token(&state, &headers)?;
    let configs = servers::list_enabled_configs(&state.owner_pool, state.master_key()).await?;
    Ok(Json(configs))
}

#[derive(Deserialize)]
pub struct StatusUpdate {
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
}

/// Collector heartbeat: update a server's connection liveness. `connected` also refreshes
/// `last_seen_at`.
pub async fn update_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<StatusUpdate>,
) -> Result<StatusCode, AppError> {
    check_internal_token(&state, &headers)?;
    if !servers::VALID_STATUSES.contains(&body.status.as_str()) {
        return Err(AppError::BadRequest(format!(
            "invalid status '{}'",
            body.status
        )));
    }
    let mark_seen = body.status == "connected";
    servers::update_status(
        &state.owner_pool,
        id,
        &body.status,
        body.error.as_deref(),
        mark_seen,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct InfoUpdate {
    pub hostname: String,
    pub map: String,
    pub players: i32,
    pub max_players: i32,
    #[serde(default)]
    pub queued: Option<i32>,
}

/// Collector heartbeat: store a server's latest A2S_INFO snapshot (hostname, map, player
/// counts).
pub async fn update_info(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<InfoUpdate>,
) -> Result<StatusCode, AppError> {
    check_internal_token(&state, &headers)?;
    servers::update_info(
        &state.owner_pool,
        id,
        &servers::InfoUpdate {
            hostname: body.hostname,
            map: body.map,
            players: body.players,
            max_players: body.max_players,
            queued: body.queued,
        },
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

fn default_game() -> String {
    "rust".to_string()
}

/// Rust's conventional RCON port, used when BattleMetrics doesn't report one. The
/// `rcon_port` column is NOT NULL with a 1-65535 CHECK, so imports must never insert
/// null/0.
const DEFAULT_RCON_PORT: i32 = 28016;

#[derive(Deserialize)]
pub struct ImportRequest {
    pub tenant_id: Uuid,
    pub external_id: String,
    pub name: String,
    #[serde(default = "default_game")]
    pub game: String,
    pub rcon_host: String,
    #[serde(default)]
    pub rcon_port: Option<i32>,
    #[serde(default)]
    pub query_port: Option<i32>,
}

/// Validate a port is in range; used for both `rcon_port` and `query_port`.
fn check_port(port: i32, field: &str) -> Result<(), AppError> {
    if (1..=65535).contains(&port) {
        Ok(())
    } else {
        Err(AppError::BadRequest(format!("{field} must be 1-65535")))
    }
}

/// Import (or re-import) a server discovered on BattleMetrics. Upserted by
/// `(tenant_id, external_id)`, so calling this repeatedly for the same external server is
/// idempotent. The row lands disabled with no RCON credentials: the tenant configures
/// and enables it from the servers UI.
pub async fn import(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ImportRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    check_internal_token(&state, &headers)?;

    let external_id = body.external_id.trim();
    if external_id.is_empty() || external_id.len() > 64 {
        return Err(AppError::BadRequest(
            "external_id is required and must be at most 64 characters".into(),
        ));
    }
    let name = body.name.trim();
    if name.is_empty() || name.len() > 128 {
        return Err(AppError::BadRequest(
            "name is required and must be at most 128 characters".into(),
        ));
    }
    let rcon_host = body.rcon_host.trim();
    if rcon_host.is_empty() {
        return Err(AppError::BadRequest("rcon_host is required".into()));
    }
    let rcon_port = match body.rcon_port {
        Some(port) => {
            check_port(port, "rcon_port")?;
            port
        }
        None => DEFAULT_RCON_PORT,
    };
    if let Some(query_port) = body.query_port {
        check_port(query_port, "query_port")?;
    }

    let id = servers::upsert_imported(
        &state.owner_pool,
        servers::ImportServer {
            tenant_id: body.tenant_id,
            external_id: external_id.to_string(),
            name: name.to_string(),
            game: body.game.trim().to_string(),
            rcon_host: rcon_host.to_string(),
            rcon_port,
            query_port: body.query_port,
        },
    )
    .await?;
    Ok(Json(serde_json::json!({ "id": id })))
}
