//! Player session endpoints: exchange a one-time login code for a session, re-mint a
//! player access token from a refresh token, return the current player, and log out.
//! These ride the gateway's unauthenticated `/auth/*` passthrough; the player access
//! token is verified here with the PLAYER keypair (disjoint from operator tokens).
//!
//! All 503 when player auth is unconfigured.

use crate::domain::players;
use crate::error::AppError;
use crate::http::client_info;
use crate::state::AppState;
use axum::extract::State;
use axum::http::{header, HeaderMap};
use axum::Json;
use cupboard_auth_core::{PlayerClaims, PlayerKeys};
use cupboard_domain::OrgId;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use uuid::Uuid;

/// Player access-token TTL (short; the refresh token backs longer sessions).
const PLAYER_ACCESS_TTL_SECS: i64 = 900;
/// Player refresh/session TTL.
const PLAYER_SESSION_TTL_SECS: i64 = 60 * 60 * 24 * 30;

fn player_keys(state: &AppState) -> Result<&Arc<PlayerKeys>, AppError> {
    state
        .player_keys
        .as_ref()
        .ok_or_else(|| AppError::Unavailable("player login is not configured".into()))
}

/// Verify the `Authorization: Bearer <player-jwt>` with the PLAYER keypair and return its
/// claims. Shared by every player endpoint that authenticates a token, so token validation
/// lives in one place (503 when player auth is unconfigured, 401 on a missing/invalid one).
pub(crate) fn verify_player_token(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<PlayerClaims, AppError> {
    let keys = player_keys(state)?;
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .ok_or_else(|| AppError::Unauthorized("missing player token".into()))?;
    keys.decode(token)
        .map_err(|_| AppError::Unauthorized("invalid or expired player token".into()))
}

fn mint_access(
    keys: &PlayerKeys,
    player_id: Uuid,
    tenant: Uuid,
    steam_id: Option<String>,
    session_id: Uuid,
) -> Result<String, AppError> {
    let claims = PlayerClaims::new(
        player_id,
        OrgId(tenant),
        steam_id,
        session_id,
        PLAYER_ACCESS_TTL_SECS,
    );
    keys.encode(&claims)
        .map_err(|e| AppError::Internal(anyhow::Error::new(e)))
}

#[derive(Deserialize)]
pub struct ExchangeRequest {
    pub code: String,
    /// The storefront host the BFF is serving (its verified `x-cb-site-host`); must match
    /// the host the code was issued for.
    pub site_host: String,
}

/// POST /auth/player/exchange: consume a one-time code (single-use, host-bound) and mint
/// a player session. Returns the access + refresh tokens for the BFF to set as cookies.
pub async fn exchange(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ExchangeRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let keys = player_keys(&state)?;
    let site_host = req.site_host.trim().to_ascii_lowercase();

    let redeemed = players::redeem_login_code(
        &state.owner_pool,
        req.code.trim(),
        &site_host,
        state.pepper(),
    )
    .await?;

    let (user_agent, ip) = client_info(&headers);
    let (session_id, refresh_token) = players::create_session(
        &state.owner_pool,
        redeemed.player_account_id,
        redeemed.tenant_id,
        &redeemed.site_host,
        user_agent.as_deref(),
        ip.as_deref(),
        PLAYER_SESSION_TTL_SECS,
        state.pepper(),
    )
    .await?;

    let access = mint_access(
        keys,
        redeemed.player_account_id,
        redeemed.tenant_id,
        redeemed.steam_id.clone(),
        session_id,
    )?;

    Ok(Json(json!({
        "access_token": access,
        "refresh_token": refresh_token,
        "player": { "id": redeemed.player_account_id, "steam_id": redeemed.steam_id },
    })))
}

#[derive(Deserialize)]
pub struct RefreshRequest {
    pub refresh_token: String,
}

/// POST /auth/player/refresh: re-mint a player access token from a live session.
pub async fn refresh(
    State(state): State<AppState>,
    Json(req): Json<RefreshRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let keys = player_keys(&state)?;
    let session =
        players::find_session_by_token(&state.owner_pool, req.refresh_token.trim(), state.pepper())
            .await?
            .ok_or_else(|| AppError::Unauthorized("session is invalid or expired".into()))?;
    let access = mint_access(
        keys,
        session.player_account_id,
        session.tenant_id,
        session.steam_id,
        session.id,
    )?;
    Ok(Json(json!({ "access_token": access })))
}

#[derive(Deserialize)]
pub struct LogoutRequest {
    pub refresh_token: String,
}

/// POST /auth/player/logout: revoke a player session. Idempotent.
pub async fn logout(
    State(state): State<AppState>,
    Json(req): Json<LogoutRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    player_keys(&state)?; // 503 when unconfigured, for consistency
    players::revoke_session(&state.owner_pool, req.refresh_token.trim(), state.pepper()).await?;
    Ok(Json(json!({ "ok": true })))
}

/// GET /auth/player/me: verify the player access token and return the player profile.
/// The token is validated with the PLAYER keypair, so an operator token is rejected here.
pub async fn me(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let claims = verify_player_token(&state, &headers)?;

    // Load the fresh profile + linked identities for display.
    let profile = sqlx::query_as::<_, (Option<String>, Option<String>)>(
        "SELECT display_name, avatar_url FROM player_accounts WHERE id = $1",
    )
    .bind(claims.sub)
    .fetch_optional(&state.owner_pool)
    .await?;
    let (display_name, avatar_url) = profile.unwrap_or((None, None));

    let identities = players::list_identities(&state.owner_pool, claims.sub).await?;
    let identities: Vec<serde_json::Value> = identities
        .into_iter()
        .map(|(provider, subject, name)| {
            json!({ "provider": provider, "subject": subject, "display_name": name })
        })
        .collect();

    Ok(Json(json!({
        "player": {
            "id": claims.sub,
            "tenant": claims.tenant,
            "steam_id": claims.steam_id,
            "display_name": display_name,
            "avatar_url": avatar_url,
            "identities": identities,
        }
    })))
}
