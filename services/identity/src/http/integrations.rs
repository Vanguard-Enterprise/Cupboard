//! `/integrations/bm/*`: BattleMetrics connection management + import control. Every
//! endpoint requires `integrations.manage`; mutating endpoints 503 when this
//! deployment has no `IDENTITY_MASTER_KEY` (nothing could decrypt what they'd store).

use crate::domain::bm;
use crate::error::AppError;
use crate::http::AuthClaims;
use crate::state::AppState;
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use cupboard_bmapi::{BmClient, BmError};
use cupboard_domain::{Permission, TenantId};
use serde::Deserialize;
use serde_json::json;

fn master_key(state: &AppState) -> Result<[u8; 32], AppError> {
    state.config.identity_master_key.ok_or_else(|| {
        AppError::Unavailable(
            "BattleMetrics integration is not configured on this deployment".into(),
        )
    })
}

/// Connection status + latest job + discovered ban lists + recent sync conflicts
/// (token never included).
pub async fn status(
    State(state): State<AppState>,
    claims: AuthClaims,
) -> Result<Json<serde_json::Value>, AppError> {
    let org = claims.require(Permission::IntegrationsManage)?;
    let tenant = TenantId::from(org);
    let connection = bm::get_view(&state.app_pool, tenant).await?;
    let latest_job = bm::latest_job(&state.app_pool, tenant).await?;
    let ban_lists = bm::list_ban_lists(&state.app_pool, tenant).await?;
    let conflicts = bm::list_conflicts(&state.app_pool, tenant).await?;
    let outbox = bm::outbox_summary(&state.app_pool, tenant).await?;
    Ok(Json(json!({
        "configured": state.config.identity_master_key.is_some(),
        "connection": connection,
        "latest_job": latest_job,
        "ban_lists": ban_lists,
        "conflicts": conflicts,
        "outbox": outbox,
    })))
}

#[derive(Deserialize)]
pub struct SyncSettingsRequest {
    #[serde(default)]
    pub sync_enabled: Option<bool>,
    #[serde(default)]
    pub sync_bans_outbound: Option<bool>,
    #[serde(default)]
    pub target_ban_list: Option<String>,
    /// Opt-in (default off): push existing active Cupboard bans to BM when enabling
    /// outbound sync.
    #[serde(default)]
    pub backfill_existing: bool,
    /// Import subset gates.
    #[serde(default)]
    pub import_servers: Option<bool>,
    #[serde(default)]
    pub import_players: Option<bool>,
    #[serde(default)]
    pub import_notes: Option<bool>,
}

/// Update sync settings (inbound toggle, outbound toggle + target list, opt-in
/// backfill). The runner notices within one tick (claim within ~15s when enabling;
/// loop exit within ~5s when disabling).
pub async fn update_sync(
    State(state): State<AppState>,
    claims: AuthClaims,
    Json(req): Json<SyncSettingsRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let org = claims.require(Permission::IntegrationsManage)?;
    // Sync needs a runner, and runners need the master key.
    master_key(&state)?;
    if let Some(list) = &req.target_ban_list {
        if list.trim().is_empty() || list.len() > 64 {
            return Err(AppError::BadRequest("invalid target ban list id".into()));
        }
    }
    let (view, backfilled) = bm::update_sync_settings(
        &state.app_pool,
        TenantId::from(org),
        claims.0.sub.0,
        bm::SyncChanges {
            sync_enabled: req.sync_enabled,
            sync_bans_outbound: req.sync_bans_outbound,
            target_ban_list: req.target_ban_list,
            backfill_existing: req.backfill_existing,
            import_servers: req.import_servers,
            import_players: req.import_players,
            import_notes: req.import_notes,
        },
    )
    .await?;
    Ok(Json(
        json!({ "connection": view, "backfilled": backfilled }),
    ))
}

#[derive(Deserialize)]
pub struct ConnectRequest {
    pub bm_org_id: String,
    pub token: String,
}

pub async fn connect(
    State(state): State<AppState>,
    claims: AuthClaims,
    Json(req): Json<ConnectRequest>,
) -> Result<(StatusCode, Json<bm::ConnectionView>), AppError> {
    let org = claims.require(Permission::IntegrationsManage)?;
    let key = master_key(&state)?;

    let bm_org_id = req.bm_org_id.trim().to_string();
    if bm_org_id.is_empty()
        || bm_org_id.len() > 32
        || !bm_org_id.chars().all(|c| c.is_ascii_digit())
    {
        return Err(AppError::BadRequest(
            "bm_org_id must be the numeric BattleMetrics organization id".into(),
        ));
    }
    let token = req.token.trim().to_string();
    if token.is_empty() || token.len() > 2048 || token.chars().any(char::is_whitespace) {
        return Err(AppError::BadRequest(
            "token must be a single BattleMetrics personal access token".into(),
        ));
    }

    // Probe before storing so the wizard fails fast on a bad token. This is the one
    // deliberate BM call on a request path: connection setup, never moderation.
    let client = BmClient::new(&state.config.bm_api_base, &token);
    client.probe().await.map_err(|e| match e {
        BmError::Unauthorized => AppError::BadRequest("BattleMetrics rejected the token".into()),
        BmError::Forbidden(_) => {
            AppError::BadRequest("the token cannot read ban lists; check its scopes".into())
        }
        other => AppError::Unavailable(format!("could not reach BattleMetrics: {other}")),
    })?;

    let sealed = cupboard_crypto::seal(&key, token.as_bytes())
        .map_err(|e| AppError::Internal(anyhow::anyhow!("seal BM token: {e}")))?;
    let view = bm::upsert_connection(
        &state.app_pool,
        TenantId::from(org),
        claims.0.sub.0,
        bm::NewConnection {
            bm_org_id,
            token_enc: sealed.ciphertext,
            token_dek: sealed.wrapped_dek,
        },
    )
    .await?;
    Ok((StatusCode::CREATED, Json(view)))
}

pub async fn start_import(
    State(state): State<AppState>,
    claims: AuthClaims,
) -> Result<(StatusCode, Json<bm::ImportJobView>), AppError> {
    let org = claims.require(Permission::IntegrationsManage)?;
    // Without a master key no supervisor runs; a queued job would strand forever.
    master_key(&state)?;
    let job = bm::enqueue_import(&state.app_pool, TenantId::from(org), claims.0.sub.0).await?;
    Ok((StatusCode::ACCEPTED, Json(job)))
}

#[derive(Deserialize)]
pub struct ResolveConflictRequest {
    pub choice: String,
}

/// Resolve a sync conflict: acknowledge the local outcome or re-apply BM's side.
pub async fn resolve_conflict(
    State(state): State<AppState>,
    claims: AuthClaims,
    axum::extract::Path(id): axum::extract::Path<uuid::Uuid>,
    Json(req): Json<ResolveConflictRequest>,
) -> Result<Json<bm::ConflictView>, AppError> {
    let org = claims.require(Permission::IntegrationsManage)?;
    let conflict = bm::resolve_conflict(
        &state.app_pool,
        TenantId::from(org),
        claims.0.sub.0,
        id,
        &req.choice,
    )
    .await?;
    Ok(Json(conflict))
}

/// Pause (parks at the next slice boundary), resume, or cancel the live import job.
pub async fn control_import(
    State(state): State<AppState>,
    claims: AuthClaims,
    axum::extract::Path(action): axum::extract::Path<String>,
) -> Result<Json<bm::ImportJobView>, AppError> {
    let org = claims.require(Permission::IntegrationsManage)?;
    let job = bm::control_job(
        &state.app_pool,
        TenantId::from(org),
        claims.0.sub.0,
        &action,
    )
    .await?;
    Ok(Json(job))
}
