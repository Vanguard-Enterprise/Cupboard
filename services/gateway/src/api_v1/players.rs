//! `/api/v1/players` facade endpoints (Phase 6 decisions O/P): typed read-throughs to
//! identity's player list and profile. Scope: `players.view`; PII fields additionally
//! require `players.view_pii` (decision P: "PII fields only with players.view_pii").
//!
//! PII gating happens HERE, at the facade, because the facade is the public contract
//! boundary. What each gate is worth, precisely: identity already nulls the list `ip`
//! AND the profile's `recent_sessions[].ip` downstream without `players.view_pii`, so
//! the facade's nulling of those is redundant defense in depth. The LOAD-BEARING
//! facade gate is `identifiers[].value` (raw identifiers): identity does NOT gate it
//! in its profile response (that is its internal surface, consumed by the trusted
//! dashboard), so without the facade nulling here the v1 contract's "IPs, raw
//! identifiers only with players.view_pii" promise would be broken. Identity is
//! unchanged.
//!
//! Scope-boundary tradeoff, deliberate: this gate governs the PLAYERS surface only.
//! The bans and entitlements surfaces expose raw identifiers (`subject_value`,
//! `steam_id`) under their own scopes by design (BM-parity ban management operates on
//! steam ids); those scopes are documented as PII-bearing in the OpenAPI doc rather
//! than nulled (see bans.rs and entitlements.rs).

use crate::AppState;
use axum::extract::{Path, State};
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

/// A player as seen in the list view: one row per current-or-last session. Mirrors
/// identity's `PlayerRow`.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct PlayerDto {
    /// Player id (stable across sessions and servers).
    pub player_id: Uuid,
    /// Human-facing short id.
    pub display_id: i64,
    /// Last known name.
    pub name: Option<String>,
    /// Last known IP. PII: null unless the key has `players.view_pii`.
    pub ip: Option<String>,
    pub online: bool,
    /// The server of the current (or most recent) session.
    pub server_id: Uuid,
    pub connected_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
}

/// Core identity of a player (profile header).
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct PlayerHeaderDto {
    pub id: Uuid,
    /// Human-facing short id.
    pub display_id: i64,
    /// `active` or `merged`.
    pub status: String,
    pub first_seen_at: Option<DateTime<Utc>>,
    pub last_seen_at: Option<DateTime<Utc>>,
}

/// A known identifier for the player (steam id, EAC id, ...).
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct PlayerIdentifierDto {
    /// Identifier kind (`steam`, `eac`, ...).
    #[serde(rename = "type")]
    pub kind: String,
    /// The raw identifier value. PII: null unless the key has `players.view_pii`.
    pub value: Option<String>,
    pub last_seen_at: DateTime<Utc>,
}

/// A name the player has used.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct PlayerNameDto {
    pub name: Option<String>,
    pub last_seen_at: DateTime<Utc>,
}

/// A recent play session.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct PlayerSessionDto {
    pub server_id: Uuid,
    /// Name used during the session.
    pub name: Option<String>,
    /// Session IP. PII: null unless the key has `players.view_pii`.
    pub ip: Option<String>,
    pub connected_at: DateTime<Utc>,
    /// Absent while the session is live.
    pub disconnected_at: Option<DateTime<Utc>>,
}

/// A probable alt-account link to another player.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct PlayerLinkDto {
    pub other_player_id: Uuid,
    pub other_display_id: i64,
    /// Link confidence, 0..1.
    pub confidence: f32,
    /// The shared-signals summary, as JSON text.
    pub signals: String,
}

/// Time played on one server.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct PlaytimeDto {
    pub server_id: Uuid,
    pub total_secs: i64,
    pub sessions: i64,
}

/// An in-game (F7) report filed against the player. Mirrors identity's `ReportRow`
/// in full: every field is already non-PII by the v1 definition (names are shown
/// without `players.view_pii` everywhere; IPs and raw identifiers are the gated
/// fields), so nothing needed trimming.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct PlayerReportDto {
    pub id: Uuid,
    pub server_id: Uuid,
    pub reporter_player_id: Option<Uuid>,
    pub target_player_id: Option<Uuid>,
    pub reporter_name: Option<String>,
    pub target_name: Option<String>,
    pub subject: Option<String>,
    pub message: Option<String>,
    pub report_type: Option<String>,
    pub reported_at: DateTime<Utc>,
}

/// A full player profile.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct PlayerProfileDto {
    pub player: PlayerHeaderDto,
    pub identifiers: Vec<PlayerIdentifierDto>,
    /// Name history, most recent first.
    pub names: Vec<PlayerNameDto>,
    pub recent_sessions: Vec<PlayerSessionDto>,
    /// Probable alt-account links.
    pub links: Vec<PlayerLinkDto>,
    /// Per-server playtime, largest first; sum for the tenant-wide total.
    pub playtime: Vec<PlaytimeDto>,
    /// Recent reports filed against this player.
    pub reports_against: Vec<PlayerReportDto>,
}

/// List players observed by the key's organization, online first then most recently
/// seen (capped at 1000).
#[utoipa::path(
    get,
    path = "/players",
    tag = "players",
    security(("api_key" = [])),
    responses(
        (status = 200, description = "Players for the organization", body = [PlayerDto]),
        (status = 401, description = "Missing or invalid API key", body = ErrorBody),
        (status = 403, description = "The key lacks the players.view scope", body = ErrorBody),
        (status = 429, description = "Rate limit exceeded; see Retry-After", body = ErrorBody),
        (status = 502, description = "The identity service failed mid-call", body = ErrorBody),
        (status = 503, description = "A dependency is unavailable; retry later", body = ErrorBody),
    )
)]
pub async fn list_players(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    headers: HeaderMap,
) -> Result<Json<Vec<PlayerDto>>, Response> {
    if !claims.has_permission(Permission::PlayersView) {
        return Err(ApiError::Forbidden("this key lacks the players.view scope".into()).into());
    }
    let bearer = forwarded_bearer(&headers)?;

    let url = format!(
        "{}/players",
        state.identity_service_url.trim_end_matches('/')
    );
    let resp = state
        .http
        .get(&url)
        .timeout(DOWNSTREAM_TIMEOUT)
        .header(header::AUTHORIZATION, bearer)
        .send()
        .await
        .map_err(|e| {
            tracing::warn!(error = %e, "identity /players request failed");
            Response::from(ApiError::BadGateway(
                "cannot reach the identity service".into(),
            ))
        })?;

    if resp.status() != StatusCode::OK {
        return Err(passthrough(resp).await);
    }

    let mut players: Vec<PlayerDto> = resp.json().await.map_err(|e| {
        tracing::warn!(error = %e, "identity /players returned an unexpected body");
        Response::from(ApiError::BadGateway(
            "identity service returned an unexpected response".into(),
        ))
    })?;

    if !claims.has_permission(Permission::PlayersViewPii) {
        for p in &mut players {
            p.ip = None;
        }
    }
    Ok(Json(players))
}

/// Fetch a player's full profile: identifiers, name history, recent sessions,
/// alt-account links, playtime, and reports against them.
#[utoipa::path(
    get,
    path = "/players/{id}",
    tag = "players",
    security(("api_key" = [])),
    params(("id" = Uuid, Path, description = "Player id")),
    responses(
        (status = 200, description = "The player's profile", body = PlayerProfileDto),
        (status = 400, description = "Malformed player id", body = ErrorBody),
        (status = 401, description = "Missing or invalid API key", body = ErrorBody),
        (status = 403, description = "The key lacks the players.view scope", body = ErrorBody),
        (status = 404, description = "Player not found (never observed by this organization)", body = ErrorBody),
        (status = 429, description = "Rate limit exceeded; see Retry-After", body = ErrorBody),
        (status = 502, description = "The identity service failed mid-call", body = ErrorBody),
        (status = 503, description = "A dependency is unavailable; retry later", body = ErrorBody),
    )
)]
pub async fn get_player(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    // Result-wrapped so a malformed id gets the v1 envelope after the scope gate,
    // not axum's pre-handler plain-text rejection (see revoke_ban).
    path: Result<Path<Uuid>, axum::extract::rejection::PathRejection>,
    headers: HeaderMap,
) -> Result<Json<PlayerProfileDto>, Response> {
    if !claims.has_permission(Permission::PlayersView) {
        return Err(ApiError::Forbidden("this key lacks the players.view scope".into()).into());
    }
    let bearer = forwarded_bearer(&headers)?;
    let Path(id) = path.map_err(|e| Response::from(ApiError::BadRequest(e.body_text())))?;

    let url = format!(
        "{}/players/{id}",
        state.identity_service_url.trim_end_matches('/')
    );
    let resp = state
        .http
        .get(&url)
        .timeout(DOWNSTREAM_TIMEOUT)
        .header(header::AUTHORIZATION, bearer)
        .send()
        .await
        .map_err(|e| {
            tracing::warn!(error = %e, "identity /players/{{id}} request failed");
            Response::from(ApiError::BadGateway(
                "cannot reach the identity service".into(),
            ))
        })?;

    if resp.status() != StatusCode::OK {
        // Includes identity's 404 for a player this tenant has never observed.
        return Err(passthrough(resp).await);
    }

    let mut profile: PlayerProfileDto = resp.json().await.map_err(|e| {
        tracing::warn!(error = %e, "identity /players/{{id}} returned an unexpected body");
        Response::from(ApiError::BadGateway(
            "identity service returned an unexpected response".into(),
        ))
    })?;

    // The facade-side PII gate (see the module doc): the identifier-value nulling is
    // load-bearing (identity does not gate it); the session-ip nulling is redundant
    // defense in depth (identity already nulls it downstream).
    if !claims.has_permission(Permission::PlayersViewPii) {
        for s in &mut profile.recent_sessions {
            s.ip = None;
        }
        for i in &mut profile.identifiers {
            i.value = None;
        }
    }
    Ok(Json(profile))
}
