//! Cluster-internal endpoint the Collector calls at poll time to learn which players to
//! kick. Token-guarded and not exposed via the gateway. Runs the enforcement lookup on the
//! owner pool (cross-tenant path; tenant filtered explicitly from the request body).

use crate::domain::bans;
use crate::error::AppError;
use crate::state::AppState;
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const INTERNAL_TOKEN_HEADER: &str = "x-internal-token";

fn check_internal_token(state: &AppState, headers: &HeaderMap) -> Result<(), AppError> {
    let expected = state
        .config
        .internal_api_token
        .as_deref()
        .ok_or_else(|| AppError::Unauthorized("internal API disabled".into()))?;
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

#[derive(Deserialize)]
pub struct EnforceRequest {
    pub tenant_id: Uuid,
    pub server_id: Uuid,
    pub steam_ids: Vec<String>,
}

/// Return the subset of `steam_ids` that are currently banned (with reasons).
pub async fn enforce(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<EnforceRequest>,
) -> Result<Json<Vec<bans::EnforcementHit>>, AppError> {
    check_internal_token(&state, &headers)?;
    let hits = bans::enforce(
        &state.owner_pool,
        state.config.value_pepper.as_bytes(),
        req.tenant_id,
        req.server_id,
        &req.steam_ids,
    )
    .await?;
    Ok(Json(hits))
}

/// `tenant_id` arrives as a raw string on both ban reads (query param on get-by-id, body
/// field on the active lookup). Parse it by hand (rather than a typed `Uuid` field) so a
/// missing/invalid value fails as a 400 in the shared `AppError` envelope, after the token
/// check, not as axum's bare extractor rejection.
fn parse_tenant_id(raw: Option<&str>) -> Result<Uuid, AppError> {
    let raw = raw
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::BadRequest("tenant_id is required".into()))?;
    Uuid::parse_str(raw).map_err(|_| AppError::BadRequest("tenant_id must be a valid uuid".into()))
}

#[derive(Deserialize)]
pub struct BanByIdQuery {
    #[serde(default)]
    tenant_id: Option<String>,
}

/// `GET /internal/bans/{id}?tenant_id=<uuid>`: the tenant service validates + renders a
/// ticket's linked ban (Phase 6 decision C). Lookup is `(id, tenant_id)` on the owner pool,
/// tenant filtered explicitly; a ban belonging to another tenant is a 404, not a leak.
pub async fn get_ban(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Query(q): Query<BanByIdQuery>,
) -> Result<Json<bans::BanSummary>, AppError> {
    check_internal_token(&state, &headers)?;
    let tenant_id = parse_tenant_id(q.tenant_id.as_deref())?;
    bans::get_by_id_for_tenant(&state.owner_pool, tenant_id, id)
        .await?
        .map(Json)
        .ok_or_else(|| AppError::NotFound("ban not found".into()))
}

#[derive(Deserialize)]
pub struct ActiveBansRequest {
    #[serde(default)]
    tenant_id: Option<String>,
    #[serde(default)]
    steam_id: Option<String>,
}

#[derive(Serialize)]
pub struct ActiveBansResponse {
    pub bans: Vec<bans::BanSummary>,
}

/// `POST /internal/bans/active` with body `{"tenant_id": "<uuid>", "steam_id": "<id>"}`:
/// the storefront "appeal this ban" picker (Phase 6 decision C). Hashes `steam_id` with
/// the value pepper and returns only that tenant's currently-active steam bans for it.
/// `steam_id` is PII, so it rides the POST body, never the query string: the router-wide
/// TraceLayer records the URI at INFO (the `/internal/enforce` precedent).
pub async fn active_bans(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ActiveBansRequest>,
) -> Result<Json<ActiveBansResponse>, AppError> {
    check_internal_token(&state, &headers)?;
    let tenant_id = parse_tenant_id(req.tenant_id.as_deref())?;
    let steam_id = req
        .steam_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::BadRequest("steam_id is required".into()))?;
    let bans = bans::active_for_steam(
        &state.owner_pool,
        state.config.value_pepper.as_bytes(),
        tenant_id,
        steam_id,
    )
    .await?;
    Ok(Json(ActiveBansResponse { bans }))
}
