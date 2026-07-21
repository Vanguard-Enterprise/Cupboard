//! `GET /api/v1/entitlements` (Phase 6 decisions O/P): a typed read-through to
//! tenant's `GET /store/entitlements`. Scope: `store.manage`.
//!
//! Normalization: tenant wraps its response as `{"entitlements": [...]}`; the v1
//! convention (uniform across this API) is that list endpoints return BARE ARRAYS,
//! so the facade unwraps the envelope and returns the array.
//!
//! Deliberate PII boundary (documented, not nulled): `steam_id` is exposed under
//! `store.manage`; entitlements are keyed by steam id, so the OpenAPI tag states the
//! scope is PII-bearing instead (see the players.rs module doc for the tradeoff).

use crate::AppState;
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::Response;
use axum::{Extension, Json};
use chrono::{DateTime, Utc};
use cupboard_auth_core::Claims;
use cupboard_domain::Permission;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use super::{forwarded_bearer, passthrough, ApiError, ErrorBody, DOWNSTREAM_TIMEOUT};

/// A store entitlement (a player's granted product), newest first. Mirrors tenant's
/// admin view of `entitlements`.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct EntitlementDto {
    /// The player's SteamID64.
    pub steam_id: Option<String>,
    /// Product display name.
    pub product_name: Option<String>,
    /// Product kind (`onetime`, `subscription`, ...).
    pub kind: String,
    /// `active`, `expired`, `revoked`, ...
    pub status: String,
    pub granted_at: Option<DateTime<Utc>>,
    /// Absent = does not expire.
    pub expires_at: Option<DateTime<Utc>>,
    /// Where the entitlement came from (`webhook`, `reconcile`, `manual`, ...).
    pub source: String,
    pub updated_at: DateTime<Utc>,
}

/// Query filters for the entitlements list.
#[derive(Debug, Deserialize, IntoParams)]
pub struct EntitlementsQuery {
    /// Filter to one player's entitlements by SteamID64.
    #[serde(default)]
    pub steam_id: Option<String>,
}

/// Tenant's wire shape; the facade unwraps it (v1 lists are bare arrays).
#[derive(Deserialize)]
struct EntitlementsEnvelope {
    entitlements: Vec<EntitlementDto>,
}

/// List recent store entitlements for the key's organization, newest first;
/// optionally filtered to one player.
#[utoipa::path(
    get,
    path = "/entitlements",
    tag = "entitlements",
    security(("api_key" = [])),
    params(EntitlementsQuery),
    responses(
        (status = 200, description = "Entitlements for the organization", body = [EntitlementDto]),
        (status = 400, description = "Malformed query string", body = ErrorBody),
        (status = 401, description = "Missing or invalid API key", body = ErrorBody),
        (status = 403, description = "The key lacks the store.manage scope", body = ErrorBody),
        (status = 429, description = "Rate limit exceeded; see Retry-After", body = ErrorBody),
        (status = 502, description = "The tenant service failed mid-call", body = ErrorBody),
        (status = 503, description = "A dependency is unavailable; retry later", body = ErrorBody),
    )
)]
pub async fn list_entitlements(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    // Result-wrapped so a malformed query string gets the v1 envelope after the
    // scope gate, not axum's pre-handler plain-text rejection (see bans::revoke_ban).
    query: Result<Query<EntitlementsQuery>, axum::extract::rejection::QueryRejection>,
    headers: HeaderMap,
) -> Result<Json<Vec<EntitlementDto>>, Response> {
    if !claims.has_permission(Permission::StoreManage) {
        return Err(ApiError::Forbidden("this key lacks the store.manage scope".into()).into());
    }
    let bearer = forwarded_bearer(&headers)?;
    let Query(query) = query.map_err(|e| Response::from(ApiError::BadRequest(e.body_text())))?;

    let url = format!(
        "{}/store/entitlements",
        state.tenant_service_url.trim_end_matches('/')
    );
    let mut req = state
        .http
        .get(&url)
        .timeout(DOWNSTREAM_TIMEOUT)
        .header(header::AUTHORIZATION, bearer);
    if let Some(steam_id) = query
        .steam_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        req = req.query(&[("steam_id", steam_id)]);
    }
    let resp = req.send().await.map_err(|e| {
        tracing::warn!(error = %e, "tenant /store/entitlements request failed");
        Response::from(ApiError::BadGateway(
            "cannot reach the tenant service".into(),
        ))
    })?;

    if resp.status() != StatusCode::OK {
        return Err(passthrough(resp).await);
    }

    let envelope: EntitlementsEnvelope = resp.json().await.map_err(|e| {
        tracing::warn!(error = %e, "tenant /store/entitlements returned an unexpected body");
        Response::from(ApiError::BadGateway(
            "tenant service returned an unexpected response".into(),
        ))
    })?;
    Ok(Json(envelope.entitlements))
}
