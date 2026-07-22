//! Privacy walker endpoints (Phase 7 PR2, decisions A/A2/D/F): `POST
//! /internal/privacy/{export,erase}`, called only by the auth-owned coordinator.
//! Guarded by the DISTINCT `PRIVACY_TOKEN` (decision F): a destructive,
//! cross-tenant primitive never rides the widely-shared `INTERNAL_API_TOKEN` (nor
//! the bot's token). The guard is a `route_layer` on the whole `/internal/privacy`
//! group (the `require_bot_token` precedent): every route under the prefix is
//! covered by construction.

use crate::domain::privacy::{self, Scope, Subject};
use crate::error::AppError;
use crate::state::AppState;
use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

/// Fail closed, exactly like `check_internal_token` but against the SEPARATE
/// `PRIVACY_TOKEN`: 503 when unconfigured, 401 on mismatch. Neither the shared
/// internal token nor the bot token is accepted here (and this token is accepted
/// nowhere else).
pub async fn check_privacy_token(
    State(state): State<AppState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Result<axum::response::Response, AppError> {
    let expected = state
        .config
        .privacy_token
        .as_deref()
        .ok_or_else(|| AppError::Unavailable("privacy internal API disabled".into()))?;
    let presented = req
        .headers()
        .get("x-internal-token")
        .and_then(|h| h.to_str().ok())
        .unwrap_or_default();
    if cupboard_crypto::constant_time_eq(presented.as_bytes(), expected.as_bytes()) {
        Ok(next.run(req).await)
    } else {
        Err(AppError::Unauthorized("invalid privacy token".into()))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExportRequest {
    pub scope_kind: String,
    #[serde(default)]
    pub tenant_id: Option<Uuid>,
    #[serde(default)]
    pub steam_id: Option<String>,
    #[serde(default)]
    pub discord_id: Option<String>,
    #[serde(default)]
    pub player_account_id: Option<Uuid>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EraseRequest {
    pub scope_kind: String,
    #[serde(default)]
    pub tenant_id: Option<Uuid>,
    #[serde(default)]
    pub steam_id: Option<String>,
    #[serde(default)]
    pub discord_id: Option<String>,
    #[serde(default)]
    pub player_account_id: Option<Uuid>,
    #[serde(default)]
    pub dry_run: bool,
}

fn resolve_scope(scope_kind: &str, tenant_id: Option<Uuid>) -> Result<Scope, AppError> {
    match scope_kind {
        "platform" => Ok(Scope::Platform),
        "tenant" => tenant_id
            .map(Scope::Tenant)
            .ok_or_else(|| AppError::BadRequest("tenant_id is required for tenant scope".into())),
        _ => Err(AppError::BadRequest(
            "scope_kind must be \"platform\" or \"tenant\"".into(),
        )),
    }
}

fn resolve_subject(
    steam_id: Option<String>,
    discord_id: Option<String>,
    player_account_id: Option<Uuid>,
) -> Result<Subject, AppError> {
    // Trim before matching (mirrors identity's parse_subject): the walkers compare
    // these against stored values verbatim, so stray whitespace from the coordinator
    // payload must never silently unmatch a subject. All-whitespace is still absent.
    let steam_id = steam_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let discord_id = discord_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if steam_id.is_none() && discord_id.is_none() && player_account_id.is_none() {
        return Err(AppError::BadRequest(
            "at least one of steam_id, discord_id, player_account_id is required".into(),
        ));
    }
    Ok(Subject {
        steam_id,
        discord_id,
        player_account_id,
    })
}

/// POST /internal/privacy/export: every in-scope row for the subject, per table.
pub async fn export(
    State(state): State<AppState>,
    Json(req): Json<ExportRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let scope = resolve_scope(&req.scope_kind, req.tenant_id)?;
    let subject = resolve_subject(req.steam_id, req.discord_id, req.player_account_id)?;
    let data = privacy::export(&state.owner_pool, scope, &subject).await?;
    Ok(Json(json!({ "data": data })))
}

/// POST /internal/privacy/erase: idempotent erasure (decision B semantics) in one
/// owner-pool transaction; `dry_run` reports would-be counts and writes nothing.
pub async fn erase(
    State(state): State<AppState>,
    Json(req): Json<EraseRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let scope = resolve_scope(&req.scope_kind, req.tenant_id)?;
    let subject = resolve_subject(req.steam_id, req.discord_id, req.player_account_id)?;
    let counts = privacy::erase(&state.owner_pool, scope, &subject, req.dry_run).await?;
    Ok(Json(json!({ "counts": counts })))
}
