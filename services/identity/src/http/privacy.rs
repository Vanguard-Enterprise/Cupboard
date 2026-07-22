//! `/internal/privacy/*`: the identity privacy walkers the auth coordinator calls
//! (Phase 7 decisions A/A2/F). Guarded by the scoped PRIVACY_TOKEN, a plane deliberately
//! disjoint from the widely-shared INTERNAL_API_TOKEN: neither token works on the other's
//! routes. The guard is a `route_layer` middleware on the `/internal/privacy` nest (the
//! tenant `require_bot_token` precedent), so auth runs BEFORE body deserialization and
//! every route under the prefix is covered by construction. Raw identifiers ride the
//! POST body only (never a URI the TraceLayer records) and are hashed in here against
//! the identity pepper, the `/internal/bans/active` dance.

use crate::domain::privacy as walker;
use crate::error::AppError;
use crate::state::AppState;
use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

/// Route-layer guard for the `/internal/privacy` nest. Fail closed: 503 while the
/// deployment has no PRIVACY_TOKEN, 401 on any mismatch. A separate check from
/// `check_internal_token` so the two planes can never blur.
pub async fn check_privacy_token(
    State(state): State<AppState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Result<axum::response::Response, AppError> {
    let expected = state
        .config
        .privacy_token
        .as_deref()
        .ok_or_else(|| AppError::Unavailable("privacy API disabled".into()))?;
    let presented = req
        .headers()
        .get("x-internal-token")
        .and_then(|h| h.to_str().ok())
        .unwrap_or_default();
    if presented.is_empty()
        || !cupboard_crypto::constant_time_eq(presented.as_bytes(), expected.as_bytes())
    {
        return Err(AppError::Unauthorized("invalid privacy token".into()));
    }
    Ok(next.run(req).await)
}

fn parse_scope(scope_kind: &str, tenant_id: Option<&str>) -> Result<walker::Scope, AppError> {
    match scope_kind {
        "platform" => Ok(walker::Scope::Platform),
        "tenant" => {
            let raw = tenant_id
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    AppError::BadRequest("tenant_id is required for tenant scope".into())
                })?;
            let id = Uuid::parse_str(raw)
                .map_err(|_| AppError::BadRequest("tenant_id must be a valid uuid".into()))?;
            Ok(walker::Scope::Tenant(id))
        }
        _ => Err(AppError::BadRequest(
            "scope_kind must be 'platform' or 'tenant'".into(),
        )),
    }
}

fn parse_subject(
    steam_id: Option<&str>,
    discord_id: Option<&str>,
) -> Result<walker::Subject, AppError> {
    let steam_id = steam_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    let discord_id = discord_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    if steam_id.is_none() && discord_id.is_none() {
        return Err(AppError::BadRequest(
            "at least one of steam_id/discord_id is required".into(),
        ));
    }
    Ok(walker::Subject {
        steam_id,
        discord_id,
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExportRequest {
    scope_kind: String,
    #[serde(default)]
    tenant_id: Option<String>,
    #[serde(default)]
    steam_id: Option<String>,
    #[serde(default)]
    discord_id: Option<String>,
    /// Accepted and deliberately ignored: identity has no account concept, but the
    /// coordinator sends ONE payload shape to both walkers (decision A).
    #[serde(default, rename = "player_account_id")]
    _player_account_id: Option<Uuid>,
}

#[derive(Serialize)]
pub struct ExportResponse {
    pub player_ids: Vec<Uuid>,
    pub data: serde_json::Map<String, serde_json::Value>,
}

pub async fn export(
    State(state): State<AppState>,
    Json(req): Json<ExportRequest>,
) -> Result<Json<ExportResponse>, AppError> {
    let scope = parse_scope(&req.scope_kind, req.tenant_id.as_deref())?;
    let subject = parse_subject(req.steam_id.as_deref(), req.discord_id.as_deref())?;
    let (player_ids, data) = walker::export(
        &state.owner_pool,
        state.config.value_pepper.as_bytes(),
        scope,
        &subject,
    )
    .await?;
    Ok(Json(ExportResponse { player_ids, data }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EraseRequest {
    scope_kind: String,
    #[serde(default)]
    tenant_id: Option<String>,
    #[serde(default)]
    steam_id: Option<String>,
    #[serde(default)]
    discord_id: Option<String>,
    /// Accepted and deliberately ignored: identity has no account concept, but the
    /// coordinator sends ONE payload shape to both walkers (decision A).
    #[serde(default, rename = "player_account_id")]
    _player_account_id: Option<Uuid>,
    #[serde(default)]
    dry_run: bool,
}

#[derive(Serialize)]
pub struct EraseResponse {
    pub counts: BTreeMap<String, i64>,
}

pub async fn erase(
    State(state): State<AppState>,
    Json(req): Json<EraseRequest>,
) -> Result<Json<EraseResponse>, AppError> {
    let scope = parse_scope(&req.scope_kind, req.tenant_id.as_deref())?;
    let subject = parse_subject(req.steam_id.as_deref(), req.discord_id.as_deref())?;
    let counts = walker::erase(
        &state.owner_pool,
        state.config.value_pepper.as_bytes(),
        scope,
        &subject,
        req.dry_run,
    )
    .await?;
    Ok(Json(EraseResponse { counts }))
}
