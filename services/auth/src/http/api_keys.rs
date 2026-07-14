//! API-key endpoints: management (create/list/revoke, require `api.manage`) and the
//! cluster-internal exchange the gateway calls to turn a presented `cb_...` token into
//! a short-lived operator JWT (Phase 6 decisions L/M).
//!
//! The raw token appears in exactly one place: the create response. It is never
//! logged, never listed, and only its keyed hash is stored.

use crate::domain::{api_keys, audit, rbac};
use crate::error::AppError;
use crate::http::AuthClaims;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use chrono::{DateTime, Utc};
use cupboard_domain::Permission;
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

const INTERNAL_TOKEN_HEADER: &str = "x-internal-token";

/// Guard for auth's own `/internal/*` routes (the identity-service pattern): shared
/// secret in `x-internal-token`, constant-time compare, fail closed when unconfigured.
///
/// Deliberately 403, NOT the 401 identity/tenant use for this guard: on the exchange,
/// 401 means exactly "this API key is invalid" and the gateway negative-caches it per
/// key for ~60s. A guard failure (unset or rotated INTERNAL_API_TOKEN) says nothing
/// about the key, so it must be distinguishable: 403 here, which the gateway maps to
/// 503 and never caches. Otherwise a token rotation hitting auth before the gateway
/// would negative-cache perfectly valid keys as 401s.
fn check_internal_token(state: &AppState, headers: &HeaderMap) -> Result<(), AppError> {
    let expected = state
        .config
        .internal_api_token
        .as_deref()
        .ok_or_else(|| AppError::Forbidden("internal API disabled".into()))?;
    let presented = headers
        .get(INTERNAL_TOKEN_HEADER)
        .and_then(|h| h.to_str().ok())
        .unwrap_or_default();
    if presented.is_empty()
        || !cupboard_crypto::constant_time_eq(presented.as_bytes(), expected.as_bytes())
    {
        return Err(AppError::Forbidden("invalid internal token".into()));
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct CreateApiKeyRequest {
    pub name: String,
    pub scopes: Vec<String>,
    /// RFC 3339 timestamp; omitted = the key never expires.
    #[serde(default)]
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Serialize)]
pub struct CreateApiKeyResponse {
    pub key: api_keys::ApiKey,
    /// The raw token, returned here EXACTLY ONCE; only its keyed hash is stored.
    pub token: String,
}

pub async fn create(
    State(state): State<AppState>,
    claims: AuthClaims,
    Json(req): Json<CreateApiKeyRequest>,
) -> Result<(StatusCode, Json<CreateApiKeyResponse>), AppError> {
    let org = claims.require(Permission::ApiManage)?;

    let name = req.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("name is required".into()));
    }
    if req.scopes.is_empty() {
        return Err(AppError::BadRequest(
            "at least one scope is required".into(),
        ));
    }
    if let Some(expires_at) = req.expires_at {
        if expires_at <= Utc::now() {
            return Err(AppError::BadRequest(
                "expires_at must be in the future".into(),
            ));
        }
    }
    // Dedupe while preserving order (duplicates would inflate the minted perms list).
    let mut scopes: Vec<String> = Vec::with_capacity(req.scopes.len());
    for s in req.scopes {
        if !scopes.contains(&s) {
            scopes.push(s);
        }
    }
    rbac::validate_permissions(&scopes)?;

    // No-escalation cap (decision L): scopes must be a subset of the creator's CURRENT
    // resolved permissions, checked against the database rather than the (possibly
    // stale) token perms.
    let own = rbac::resolve_permissions(&state.owner_pool, claims.0.sub.0, org.0)
        .await?
        .ok_or_else(|| {
            AppError::Forbidden("you are not an active member of this organization".into())
        })?;
    if let Some(escalated) = scopes.iter().find(|s| !own.contains(s)) {
        return Err(AppError::Forbidden(format!(
            "scope exceeds your own permissions: {escalated}"
        )));
    }

    let new = api_keys::create_key(
        &state.app_pool,
        org.into(),
        name,
        &scopes,
        claims.0.sub.0,
        req.expires_at,
        state.pepper(),
    )
    .await?;

    audit::record(
        &state.owner_pool,
        Some(org.0),
        Some(claims.0.sub.0),
        "api_key.create",
        Some("api_key"),
        Some(new.key.id),
        Some(json!({ "name": new.key.name, "scopes": new.key.scopes })),
    )
    .await;

    Ok((
        StatusCode::CREATED,
        Json(CreateApiKeyResponse {
            key: new.key,
            token: new.token,
        }),
    ))
}

pub async fn list(
    State(state): State<AppState>,
    claims: AuthClaims,
) -> Result<Json<Vec<api_keys::ApiKey>>, AppError> {
    let org = claims.require(Permission::ApiManage)?;
    Ok(Json(
        api_keys::list_keys(&state.app_pool, org.into()).await?,
    ))
}

pub async fn revoke(
    State(state): State<AppState>,
    claims: AuthClaims,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, AppError> {
    let org = claims.require(Permission::ApiManage)?;
    api_keys::revoke_key(&state.app_pool, org.into(), id).await?;

    audit::record(
        &state.owner_pool,
        Some(org.0),
        Some(claims.0.sub.0),
        "api_key.revoke",
        Some("api_key"),
        Some(id),
        None,
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct ExchangeRequest {
    pub token: String,
}

#[derive(Serialize)]
pub struct ExchangeResponse {
    /// A 5-minute operator-signed JWT (sub/sid = the key id, perms = effective scopes).
    pub token: String,
}

/// Cluster-internal (gateway-only, never routed through the public proxy): exchange a
/// presented raw API key for a short-lived operator JWT. See [`api_keys::exchange`]
/// for the verification and capping semantics.
pub async fn exchange(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ExchangeRequest>,
) -> Result<Json<ExchangeResponse>, AppError> {
    check_internal_token(&state, &headers)?;
    let jwt =
        api_keys::exchange(&state.owner_pool, &state.keys, state.pepper(), &req.token).await?;
    Ok(Json(ExchangeResponse { token: jwt }))
}
