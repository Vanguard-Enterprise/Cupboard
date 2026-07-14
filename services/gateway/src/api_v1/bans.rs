//! `GET /api/v1/bans`, the seed facade endpoint (Phase 6 decisions O/P): an explicit
//! typed read-through to identity's `GET /bans`, not a blind proxy. The response is
//! deserialized from identity and re-serialized through [`BanDto`], so the v1 wire
//! contract is pinned here (and documented by utoipa) independently of identity's
//! internal shape. Scope required: `bans.view`.

use crate::AppState;
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use chrono::{DateTime, Utc};
use cupboard_auth_core::Claims;
use cupboard_domain::Permission;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use super::{ApiError, ErrorBody};

/// Bound on the downstream read: larger than the exchange timeout (this call carries
/// a real payload) but still prompt when identity blackholes.
const DOWNSTREAM_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

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

/// List bans for the key's organization, active first then most recent.
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
    headers: HeaderMap,
) -> Result<Json<Vec<BanDto>>, Response> {
    // Scope gate at the facade (identity enforces bans.view again downstream; failing
    // here gives the caller the v1 envelope without a wasted hop).
    if !claims.has_permission(Permission::BansView) {
        return Err(ApiError::Forbidden("this key lacks the bans.view scope".into()).into());
    }

    // The minted operator JWT that require_api_key attached; identity re-verifies the
    // signature and applies RLS itself, unchanged.
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .ok_or_else(|| ApiError::Internal("bearer missing after require_api_key".into()))?
        .to_owned();

    let url = format!("{}/bans", state.identity_service_url.trim_end_matches('/'));
    let resp = state
        .http
        .get(&url)
        // The shared client is untimed (the blind streaming proxies need that); typed
        // facade calls are bounded per-request so a blackholed identity pod yields a
        // prompt 502 instead of a hung /api/v1 request.
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
        // Identity's error bodies already carry the {"error","message"} envelope;
        // pass them through with their status.
        let status = resp.status();
        let body = resp.bytes().await.unwrap_or_default();
        return Err((status, [(header::CONTENT_TYPE, "application/json")], body).into_response());
    }

    let bans: Vec<BanDto> = resp.json().await.map_err(|e| {
        tracing::warn!(error = %e, "identity /bans returned an unexpected body");
        Response::from(ApiError::BadGateway(
            "identity service returned an unexpected response".into(),
        ))
    })?;
    Ok(Json(bans))
}
