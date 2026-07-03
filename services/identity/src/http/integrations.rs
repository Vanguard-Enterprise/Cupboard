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

/// Connection status + latest job + discovered ban lists (token never included).
pub async fn status(
    State(state): State<AppState>,
    claims: AuthClaims,
) -> Result<Json<serde_json::Value>, AppError> {
    let org = claims.require(Permission::IntegrationsManage)?;
    let tenant = TenantId::from(org);
    let connection = bm::get_view(&state.app_pool, tenant).await?;
    let latest_job = bm::latest_job(&state.app_pool, tenant).await?;
    let ban_lists = bm::list_ban_lists(&state.app_pool, tenant).await?;
    Ok(Json(json!({
        "configured": state.config.identity_master_key.is_some(),
        "connection": connection,
        "latest_job": latest_job,
        "ban_lists": ban_lists,
    })))
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
