//! `GET /api/v1/servers` (Phase 6 decisions O/P): a typed read-through to fleet's
//! `GET /fleet/servers`, trimmed to the public shape. Scope: `servers.view`.
//!
//! [`ServerDto`] deliberately EXCLUDES fields fleet returns to the dashboard:
//! `tenant_id` (redundant, the response is already keyed by the token's org),
//! `rcon_host`, `rcon_port`, `query_port`, `last_error`, `has_ingest_token`, and
//! `ingest_token_created_at` (operational internals; connection endpoints and ingest
//! plumbing do not belong in a public integration API). Additive changes are fair
//! game, re-adding an excluded field later is additive too; anything breaking means
//! `/api/v2`.

use crate::AppState;
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::Response;
use axum::{Extension, Json};
use chrono::{DateTime, Utc};
use cupboard_auth_core::Claims;
use cupboard_domain::Permission;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use super::{forwarded_bearer, passthrough, ApiError, ErrorBody, DOWNSTREAM_TIMEOUT};

/// A game server, public shape. The `info_*` fields are the latest A2S_INFO snapshot,
/// null until the first query lands.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ServerDto {
    /// Server id.
    pub id: Uuid,
    /// Operator-facing name.
    pub name: String,
    /// Game key (`rust`, ...).
    pub game: String,
    pub enabled: bool,
    /// `connected`, `disconnected`, ... as seen by the collector.
    pub connection_status: String,
    pub last_seen_at: Option<DateTime<Utc>>,
    /// Server-reported hostname.
    pub info_hostname: Option<String>,
    pub info_map: Option<String>,
    pub info_players: Option<i32>,
    pub info_max_players: Option<i32>,
    pub info_queued: Option<i32>,
    /// When the info snapshot was last refreshed.
    pub info_updated_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// List the organization's game servers.
#[utoipa::path(
    get,
    path = "/servers",
    tag = "servers",
    security(("api_key" = [])),
    responses(
        (status = 200, description = "Servers for the organization", body = [ServerDto]),
        (status = 401, description = "Missing or invalid API key", body = ErrorBody),
        (status = 403, description = "The key lacks the servers.view scope", body = ErrorBody),
        (status = 429, description = "Rate limit exceeded; see Retry-After", body = ErrorBody),
        (status = 502, description = "The fleet service failed mid-call", body = ErrorBody),
        (status = 503, description = "A dependency is unavailable; retry later", body = ErrorBody),
    )
)]
pub async fn list_servers(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    headers: HeaderMap,
) -> Result<Json<Vec<ServerDto>>, Response> {
    if !claims.has_permission(Permission::ServersView) {
        return Err(ApiError::Forbidden("this key lacks the servers.view scope".into()).into());
    }
    let bearer = forwarded_bearer(&headers)?;

    let url = format!(
        "{}/fleet/servers",
        state.fleet_service_url.trim_end_matches('/')
    );
    let resp = state
        .http
        .get(&url)
        .timeout(DOWNSTREAM_TIMEOUT)
        .header(header::AUTHORIZATION, bearer)
        .send()
        .await
        .map_err(|e| {
            tracing::warn!(error = %e, "fleet /fleet/servers request failed");
            Response::from(ApiError::BadGateway(
                "cannot reach the fleet service".into(),
            ))
        })?;

    if resp.status() != StatusCode::OK {
        return Err(passthrough(resp).await);
    }

    // Deserializing into the trimmed DTO drops the excluded fields (serde ignores
    // unknown fields); re-serialization pins the public shape.
    let servers: Vec<ServerDto> = resp.json().await.map_err(|e| {
        tracing::warn!(error = %e, "fleet /fleet/servers returned an unexpected body");
        Response::from(ApiError::BadGateway(
            "fleet service returned an unexpected response".into(),
        ))
    })?;
    Ok(Json(servers))
}
