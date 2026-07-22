//! Privacy job routes (Phase 7 PR2, decisions A2/C/D).
//!
//! OPERATOR surface (`/auth/privacy/*`, `players.erase` gated): ALWAYS tenant-scoped
//! (decision A2), and the scope tenant comes from the token claims SERVER-SIDE; the
//! request body has no scope/tenant fields at all (`deny_unknown_fields` rejects any
//! attempt to smuggle them). Cross-org access is a 404, never a 403 (no existence
//! oracle).
//!
//! PLAYER surface (`/auth/player/privacy/*`, PLAYER-keypair JWTs, 503 when player
//! auth is unconfigured): PLATFORM scope, SELF ONLY. The subject is the caller's
//! `player_account_id` from their verified claims; any body is ignored, and the
//! worker resolves the linked identities server-side. Ownership is
//! `job.player_account_id == caller && requested_via == 'player'`, else 404 (an
//! operator-requested job about the same player stays invisible here).
//!
//! Job JSON never carries bundle bytes (the wave-1 data layer excludes them by
//! construction); downloads go through the one-time `take_bundle_once`, 410 Gone
//! once taken or expired. Audit rows for create/confirm/download carry kind/scope
//! metadata only, never raw identifiers (decision G).

use crate::domain::audit;
use crate::domain::privacy::{self, NewPrivacyJob, PrivacyJob};
use crate::error::AppError;
use crate::http::player::verify_player_token;
use crate::http::AuthClaims;
use crate::state::AppState;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use cupboard_domain::Permission;
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

const JOB_LIST_LIMIT: i64 = 50;

// ============================ Operator surface ============================

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateJobRequest {
    pub kind: String,
    #[serde(default)]
    pub steam_id: Option<String>,
    #[serde(default)]
    pub discord_id: Option<String>,
    #[serde(default)]
    pub player_account_id: Option<Uuid>,
}

/// POST /auth/privacy/jobs: create a tenant-scoped job for the claims org.
pub async fn create_operator_job(
    State(state): State<AppState>,
    claims: AuthClaims,
    Json(req): Json<CreateJobRequest>,
) -> Result<(StatusCode, Json<PrivacyJob>), AppError> {
    let org = claims.require(Permission::PlayersErase)?;
    if !matches!(req.kind.as_str(), "export" | "erase") {
        return Err(AppError::BadRequest(
            "kind must be \"export\" or \"erase\"".into(),
        ));
    }
    let steam_id = req
        .steam_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let discord_id = req
        .discord_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if steam_id.is_none() && discord_id.is_none() && req.player_account_id.is_none() {
        return Err(AppError::BadRequest(
            "at least one of steam_id, discord_id, player_account_id is required".into(),
        ));
    }
    // Identifier sanity: a mistyped id would fan out a privacy walk over garbage and
    // truthfully find nothing, so reject the obviously malformed shapes up front.
    if let Some(s) = &steam_id {
        if !all_ascii_digits(s, 17, 17) {
            return Err(AppError::BadRequest(
                "steam_id must be a 17-digit SteamID64".into(),
            ));
        }
    }
    if let Some(d) = &discord_id {
        if !all_ascii_digits(d, 15, 21) {
            return Err(AppError::BadRequest(
                "discord_id must be a Discord user id of 15 to 21 digits".into(),
            ));
        }
    }
    let job = privacy::create_job(
        &state.owner_pool,
        NewPrivacyJob {
            kind: req.kind,
            scope_kind: "tenant".into(),
            tenant_id: Some(org.0),
            steam_id,
            discord_id,
            player_account_id: req.player_account_id,
            requested_by: Some(claims.0.sub.0),
            requested_via: "operator".into(),
        },
    )
    .await?;
    audit::record(
        &state.owner_pool,
        Some(org.0),
        Some(claims.0.sub.0),
        "privacy_job.create",
        Some("privacy_job"),
        Some(job.id),
        Some(json!({ "kind": job.kind, "scope": "tenant" })),
    )
    .await;
    Ok((StatusCode::CREATED, Json(job)))
}

/// GET /auth/privacy/jobs: the claims org's jobs, newest first.
pub async fn list_operator_jobs(
    State(state): State<AppState>,
    claims: AuthClaims,
) -> Result<Json<Vec<PrivacyJob>>, AppError> {
    let org = claims.require(Permission::PlayersErase)?;
    Ok(Json(
        privacy::list_jobs_for_tenant(&state.owner_pool, org.0, JOB_LIST_LIMIT).await?,
    ))
}

/// Load a job for the operator surface: 404 unless it is scoped to the claims org.
async fn operator_job(state: &AppState, org: Uuid, id: Uuid) -> Result<PrivacyJob, AppError> {
    privacy::get_job(&state.owner_pool, id)
        .await?
        .filter(|job| job.tenant_id == Some(org))
        .ok_or_else(|| AppError::NotFound("privacy job not found".into()))
}

/// GET /auth/privacy/jobs/{id}.
pub async fn get_operator_job(
    State(state): State<AppState>,
    claims: AuthClaims,
    Path(id): Path<Uuid>,
) -> Result<Json<PrivacyJob>, AppError> {
    let org = claims.require(Permission::PlayersErase)?;
    Ok(Json(operator_job(&state, org.0, id).await?))
}

/// POST /auth/privacy/jobs/{id}/confirm: confirm an awaiting_confirm erasure
/// (decision D rail 1). Wrong-status is the data layer's 409.
pub async fn confirm_operator_job(
    State(state): State<AppState>,
    claims: AuthClaims,
    Path(id): Path<Uuid>,
) -> Result<Json<PrivacyJob>, AppError> {
    let org = claims.require(Permission::PlayersErase)?;
    let job = operator_job(&state, org.0, id).await?;
    privacy::confirm_job(&state.owner_pool, id).await?;
    audit::record(
        &state.owner_pool,
        Some(org.0),
        Some(claims.0.sub.0),
        "privacy_job.confirm",
        Some("privacy_job"),
        Some(id),
        Some(json!({ "kind": job.kind, "scope": "tenant" })),
    )
    .await;
    Ok(Json(operator_job(&state, org.0, id).await?))
}

/// GET /auth/privacy/jobs/{id}/download: the one-time bundle.
pub async fn download_operator_job(
    State(state): State<AppState>,
    claims: AuthClaims,
    Path(id): Path<Uuid>,
) -> Result<Response, AppError> {
    let org = claims.require(Permission::PlayersErase)?;
    let job = operator_job(&state, org.0, id).await?;
    let Some(bytes) = privacy::take_bundle_once(&state.owner_pool, id).await? else {
        return Ok(gone());
    };
    audit::record(
        &state.owner_pool,
        Some(org.0),
        Some(claims.0.sub.0),
        "privacy_job.download",
        Some("privacy_job"),
        Some(id),
        Some(json!({ "kind": job.kind, "scope": "tenant" })),
    )
    .await;
    Ok(bundle_response(id, bytes))
}

// ============================ Player surface ============================

/// POST /auth/player/privacy/export: self-serve export (decision A2 platform scope).
pub async fn create_player_export(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<(StatusCode, Json<PrivacyJob>), AppError> {
    create_player_job(&state, &headers, "export").await
}

/// POST /auth/player/privacy/erase: self-serve erasure (dry-run first, decision D).
pub async fn create_player_erase(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<(StatusCode, Json<PrivacyJob>), AppError> {
    create_player_job(&state, &headers, "erase").await
}

/// The shared self-serve create: subject = the verified claims sub, nothing from the
/// request body (which is ignored entirely).
async fn create_player_job(
    state: &AppState,
    headers: &HeaderMap,
    kind: &str,
) -> Result<(StatusCode, Json<PrivacyJob>), AppError> {
    let claims = verify_player_token(state, headers)?;
    let job = privacy::create_job(
        &state.owner_pool,
        NewPrivacyJob {
            kind: kind.into(),
            scope_kind: "platform".into(),
            tenant_id: None,
            steam_id: None,
            discord_id: None,
            player_account_id: Some(claims.sub),
            requested_by: None,
            requested_via: "player".into(),
        },
    )
    .await?;
    audit::record(
        &state.owner_pool,
        None,
        None,
        "privacy_job.create",
        Some("privacy_job"),
        Some(job.id),
        Some(json!({ "kind": kind, "scope": "platform", "via": "player" })),
    )
    .await;
    Ok((StatusCode::CREATED, Json(job)))
}

/// GET /auth/player/privacy/jobs: the caller's own self-serve jobs.
pub async fn list_player_jobs(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<PrivacyJob>>, AppError> {
    let claims = verify_player_token(&state, &headers)?;
    Ok(Json(
        privacy::list_jobs_for_player(&state.owner_pool, claims.sub, JOB_LIST_LIMIT).await?,
    ))
}

/// Load a job for the player surface: 404 unless the caller owns it AND it was
/// self-serve requested.
async fn player_job(state: &AppState, player: Uuid, id: Uuid) -> Result<PrivacyJob, AppError> {
    privacy::get_job(&state.owner_pool, id)
        .await?
        .filter(|job| job.player_account_id == Some(player) && job.requested_via == "player")
        .ok_or_else(|| AppError::NotFound("privacy job not found".into()))
}

/// GET /auth/player/privacy/jobs/{id}.
pub async fn get_player_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<PrivacyJob>, AppError> {
    let claims = verify_player_token(&state, &headers)?;
    Ok(Json(player_job(&state, claims.sub, id).await?))
}

/// POST /auth/player/privacy/jobs/{id}/confirm.
pub async fn confirm_player_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<PrivacyJob>, AppError> {
    let claims = verify_player_token(&state, &headers)?;
    let job = player_job(&state, claims.sub, id).await?;
    privacy::confirm_job(&state.owner_pool, id).await?;
    audit::record(
        &state.owner_pool,
        None,
        None,
        "privacy_job.confirm",
        Some("privacy_job"),
        Some(id),
        Some(json!({ "kind": job.kind, "scope": "platform", "via": "player" })),
    )
    .await;
    Ok(Json(player_job(&state, claims.sub, id).await?))
}

/// GET /auth/player/privacy/jobs/{id}/download.
pub async fn download_player_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response, AppError> {
    let claims = verify_player_token(&state, &headers)?;
    let job = player_job(&state, claims.sub, id).await?;
    let Some(bytes) = privacy::take_bundle_once(&state.owner_pool, id).await? else {
        return Ok(gone());
    };
    audit::record(
        &state.owner_pool,
        None,
        None,
        "privacy_job.download",
        Some("privacy_job"),
        Some(id),
        Some(json!({ "kind": job.kind, "scope": "platform", "via": "player" })),
    )
    .await;
    Ok(bundle_response(id, bytes))
}

// ============================ Shared ============================

/// True when `s` is `min..=max` characters, all ASCII digits.
fn all_ascii_digits(s: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
}

/// 410 Gone: the bundle was already taken, expired, or never existed on this job.
fn gone() -> Response {
    (
        StatusCode::GONE,
        Json(json!({
            "error": "gone",
            "message": "export bundle already downloaded, expired, or not available",
        })),
    )
        .into_response()
}

/// The one-time bundle download response (decision C).
fn bundle_response(id: Uuid, bytes: Vec<u8>) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/gzip")
        .header(
            header::CONTENT_DISPOSITION,
            format!(
                "attachment; filename=\"{}\"",
                crate::privacy_worker::bundle_filename(id)
            ),
        )
        .body(Body::from(bytes))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}
