//! `/api/v1/bans` facade endpoints (Phase 6 decisions O/P): explicit typed
//! read/write-throughs to identity's ban routes, not blind proxies. Responses are
//! deserialized from identity and re-serialized through [`BanDto`], so the v1 wire
//! contract is pinned here (and documented by utoipa) independently of identity's
//! internal shape. Scopes: `bans.view` / `bans.create` / `bans.revoke`.
//!
//! Deliberate PII boundary (documented, not nulled): the bans surface exposes
//! `subject_value` (raw steam/EAC ids) and `player_id` under the `bans.*` scopes.
//! BM-parity ban management operates on steam ids; nulling them here would cripple
//! the headline integration. The OpenAPI tag and operation descriptions state this
//! plainly so key issuers treat `bans.*` as PII-bearing scopes.

use crate::AppState;
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::Response;
use axum::{Extension, Json};
use chrono::{DateTime, Utc};
use cupboard_auth_core::Claims;
use cupboard_domain::Permission;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use super::{forwarded_bearer, passthrough, ApiError, ErrorBody, DOWNSTREAM_TIMEOUT};

/// A ban record. Mirrors identity's `Ban` field for field; additive changes are fair
/// game, anything breaking means `/api/v2`.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct BanDto {
    /// Ban id.
    pub id: Uuid,
    /// Banned identifier kind (`steam`, `eac`).
    pub subject_type: String,
    /// The banned identifier value, when stored in the clear.
    pub subject_value: Option<String>,
    /// The linked player, when the identifier resolved to one.
    pub player_id: Option<Uuid>,
    /// `network` (all servers) or `server`.
    pub scope: String,
    /// The server a `server`-scoped ban applies to.
    pub server_id: Option<Uuid>,
    /// Operator-supplied reason.
    pub reason: Option<String>,
    /// The operator (or API key id, for API-minted bans) that issued the ban.
    pub issued_by: Option<Uuid>,
    pub issued_at: DateTime<Utc>,
    /// Absent = permanent.
    pub expires_at: Option<DateTime<Utc>>,
    /// `active`, `expired`, or `revoked`.
    pub status: String,
    pub revoked_at: Option<DateTime<Utc>>,
    pub revoke_reason: Option<String>,
    /// Where the ban originated (`manual`, `import`, ...).
    pub origin: String,
}

fn default_subject_type() -> String {
    "steam".to_string()
}

fn default_ban_scope() -> String {
    "network".to_string()
}

/// Request body for creating a ban. Serde defaults mirror identity's
/// `CreateBanRequest` exactly, so the defaults the doc promises are the ones the
/// facade resolves and forwards; `issued_by` is server-side (the API key id).
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct CreateBanRequestDto {
    /// Identifier kind to ban: `steam` or `eac`.
    #[serde(default = "default_subject_type")]
    #[schema(default = "steam")]
    pub subject_type: String,
    /// The identifier value to ban (for `steam`: a 1-32 digit SteamID64).
    pub subject_value: String,
    /// Optionally link the ban to a known player.
    #[serde(default)]
    pub player_id: Option<Uuid>,
    /// `network` (all servers) or `server` (requires `server_id`).
    #[serde(default = "default_ban_scope")]
    #[schema(default = "network")]
    pub scope: String,
    /// Required when `scope` is `server`.
    #[serde(default)]
    pub server_id: Option<Uuid>,
    /// Operator-supplied reason.
    #[serde(default)]
    pub reason: Option<String>,
    /// Omit for a permanent ban.
    #[serde(default)]
    pub expires_at: Option<DateTime<Utc>>,
}

/// Optional request body for revoking a ban.
#[derive(Debug, Default, Serialize, Deserialize, ToSchema)]
pub struct RevokeBanRequestDto {
    /// Why the ban is being revoked.
    #[serde(default)]
    pub reason: Option<String>,
}

/// List bans for the key's organization, active first then most recent.
///
/// PII-bearing: ban records expose banned players' raw identifiers
/// (`subject_value`) and `player_id` to any key holding `bans.view`.
#[utoipa::path(
    get,
    path = "/bans",
    tag = "bans",
    security(("api_key" = [])),
    responses(
        (status = 200, description = "Bans for the organization", body = [BanDto]),
        (status = 401, description = "Missing or invalid API key", body = ErrorBody),
        (status = 403, description = "The key lacks the bans.view scope", body = ErrorBody),
        (status = 429, description = "Rate limit exceeded; see Retry-After", body = ErrorBody),
        (status = 502, description = "The identity service failed mid-call", body = ErrorBody),
        (status = 503, description = "A dependency is unavailable; retry later", body = ErrorBody),
    )
)]
pub async fn list_bans(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    headers: axum::http::HeaderMap,
) -> Result<Json<Vec<BanDto>>, Response> {
    // Scope gate at the facade (identity enforces bans.view again downstream; failing
    // here gives the caller the v1 envelope without a wasted hop).
    if !claims.has_permission(Permission::BansView) {
        return Err(ApiError::Forbidden("this key lacks the bans.view scope".into()).into());
    }
    let bearer = forwarded_bearer(&headers)?;

    let url = format!("{}/bans", state.identity_service_url.trim_end_matches('/'));
    let resp = state
        .http
        .get(&url)
        .timeout(DOWNSTREAM_TIMEOUT)
        .header(header::AUTHORIZATION, bearer)
        .send()
        .await
        .map_err(|e| {
            tracing::warn!(error = %e, "identity /bans request failed");
            Response::from(ApiError::BadGateway(
                "cannot reach the identity service".into(),
            ))
        })?;

    if resp.status() != StatusCode::OK {
        return Err(passthrough(resp).await);
    }

    let bans: Vec<BanDto> = resp.json().await.map_err(|e| {
        tracing::warn!(error = %e, "identity /bans returned an unexpected body");
        Response::from(ApiError::BadGateway(
            "identity service returned an unexpected response".into(),
        ))
    })?;
    Ok(Json(bans))
}

/// Create a ban. `issued_by` is set server-side to the API key id.
///
/// PII-bearing: the request carries a raw identifier (`subject_value`), and the
/// response echoes it along with the resolved `player_id` when the identifier links
/// to a known player (a steam_id-to-player_id linkage).
#[utoipa::path(
    post,
    path = "/bans",
    tag = "bans",
    security(("api_key" = [])),
    request_body = CreateBanRequestDto,
    responses(
        (status = 201, description = "The created ban", body = BanDto),
        (status = 400, description = "Invalid request (unknown subject_type or scope, missing subject_value or server_id)", body = ErrorBody),
        (status = 401, description = "Missing or invalid API key", body = ErrorBody),
        (status = 403, description = "The key lacks the bans.create scope", body = ErrorBody),
        (status = 429, description = "Rate limit exceeded; see Retry-After", body = ErrorBody),
        (status = 502, description = "The identity service failed mid-call", body = ErrorBody),
        (status = 503, description = "A dependency is unavailable; retry later", body = ErrorBody),
    )
)]
pub async fn create_ban(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    headers: axum::http::HeaderMap,
    // Facade-side deserialization: a malformed body gets the v1 envelope (not axum's
    // plain-text rejection), and the forwarded body is the resolved DTO, so the
    // defaults the doc promises are exactly what identity receives.
    body: Result<Json<CreateBanRequestDto>, axum::extract::rejection::JsonRejection>,
) -> Result<(StatusCode, Json<BanDto>), Response> {
    if !claims.has_permission(Permission::BansCreate) {
        return Err(ApiError::Forbidden("this key lacks the bans.create scope".into()).into());
    }
    let bearer = forwarded_bearer(&headers)?;
    let Json(req) = body.map_err(|e| Response::from(ApiError::BadRequest(e.body_text())))?;

    let url = format!("{}/bans", state.identity_service_url.trim_end_matches('/'));
    let resp = state
        .http
        .post(&url)
        .timeout(DOWNSTREAM_TIMEOUT)
        .header(header::AUTHORIZATION, bearer)
        .json(&req)
        .send()
        .await
        .map_err(|e| {
            tracing::warn!(error = %e, "identity POST /bans request failed");
            Response::from(ApiError::BadGateway(
                "cannot reach the identity service".into(),
            ))
        })?;

    if resp.status() != StatusCode::CREATED {
        return Err(passthrough(resp).await);
    }

    let ban: BanDto = resp.json().await.map_err(|e| {
        tracing::warn!(error = %e, "identity POST /bans returned an unexpected body");
        Response::from(ApiError::BadGateway(
            "identity service returned an unexpected response".into(),
        ))
    })?;
    Ok((StatusCode::CREATED, Json(ban)))
}

/// Revoke an active ban. The body is optional; 404 when the ban does not exist or is
/// not active.
///
/// PII-bearing: the response is the full ban record, raw identifier included (see
/// the bans tag).
#[utoipa::path(
    post,
    path = "/bans/{id}/revoke",
    tag = "bans",
    security(("api_key" = [])),
    params(("id" = Uuid, Path, description = "Ban id")),
    request_body(content = Option<RevokeBanRequestDto>, description = "Optional revoke details"),
    responses(
        (status = 200, description = "The revoked ban", body = BanDto),
        (status = 400, description = "Malformed ban id or request body", body = ErrorBody),
        (status = 401, description = "Missing or invalid API key", body = ErrorBody),
        (status = 403, description = "The key lacks the bans.revoke scope", body = ErrorBody),
        (status = 404, description = "No active ban with this id", body = ErrorBody),
        (status = 429, description = "Rate limit exceeded; see Retry-After", body = ErrorBody),
        (status = 502, description = "The identity service failed mid-call", body = ErrorBody),
        (status = 503, description = "A dependency is unavailable; retry later", body = ErrorBody),
    )
)]
pub async fn revoke_ban(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    // Result-wrapped extractors: a bare Path/Option<Json> would reject malformed
    // requests BEFORE the handler runs, in axum's plain-text shape and ahead of the
    // scope gate. Wrapping defers the verdict so the scope check runs first and
    // rejections get the v1 envelope.
    path: Result<Path<Uuid>, axum::extract::rejection::PathRejection>,
    headers: axum::http::HeaderMap,
    body: Result<Option<Json<RevokeBanRequestDto>>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<BanDto>, Response> {
    if !claims.has_permission(Permission::BansRevoke) {
        return Err(ApiError::Forbidden("this key lacks the bans.revoke scope".into()).into());
    }
    let bearer = forwarded_bearer(&headers)?;
    let Path(id) = path.map_err(|e| Response::from(ApiError::BadRequest(e.body_text())))?;
    let body = body.map_err(|e| Response::from(ApiError::BadRequest(e.body_text())))?;

    let url = format!(
        "{}/bans/{id}/revoke",
        state.identity_service_url.trim_end_matches('/')
    );
    let mut req = state
        .http
        .post(&url)
        .timeout(DOWNSTREAM_TIMEOUT)
        .header(header::AUTHORIZATION, bearer);
    // The body is optional on both sides; forward it only when the caller sent one.
    if let Some(Json(revoke)) = body {
        req = req.json(&revoke);
    }
    let resp = req.send().await.map_err(|e| {
        tracing::warn!(error = %e, "identity /bans/{{id}}/revoke request failed");
        Response::from(ApiError::BadGateway(
            "cannot reach the identity service".into(),
        ))
    })?;

    if resp.status() != StatusCode::OK {
        // Includes identity's 404 for a missing or already-inactive ban.
        return Err(passthrough(resp).await);
    }

    let ban: BanDto = resp.json().await.map_err(|e| {
        tracing::warn!(error = %e, "identity /bans/{{id}}/revoke returned an unexpected body");
        Response::from(ApiError::BadGateway(
            "identity service returned an unexpected response".into(),
        ))
    })?;
    Ok(Json(ban))
}
