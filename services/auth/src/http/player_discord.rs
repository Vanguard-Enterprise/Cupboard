//! Player Discord LINK: attach a Discord identity to a logged-in player. Mirrors the Steam
//! player flow's central-callback shape, but as an authenticated LINK rather than a login:
//!
//!   * `link_start` (player-token authed, called by the web BFF): validates the storefront
//!     host belongs to the player's tenant, mints a single-use link-state binding the
//!     player + host, and returns the Discord authorize URL.
//!   * `callback` (public, on the login host): redeems the state (recovering the player +
//!     host AUTHORITATIVELY, never from a browser value), exchanges the code, links the
//!     Discord identity to that player account, and 302s the browser back to /account.
//!
//! Confidential-client OAuth (client secret), so no PKCE: the single-use server-side state
//! is both the CSRF guard and the player/host binding. Requires BOTH Discord creds and
//! player auth configured (else 503).

use crate::config::PlayerAuthConfig;
use crate::domain::{audit, players};
use crate::error::AppError;
use crate::http::oauth_discord::exchange_code_for_identity;
use crate::http::steam_openid::{resolve_tenant_for_host, valid_host};
use crate::state::AppState;
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap};
use axum::response::{IntoResponse, Redirect, Response};
use axum::Json;
use cupboard_auth_core::PlayerKeys;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

fn player_keys(state: &AppState) -> Result<&Arc<PlayerKeys>, AppError> {
    state
        .player_keys
        .as_ref()
        .ok_or_else(|| AppError::Unavailable("player login is not configured".into()))
}

fn player_cfg(state: &AppState) -> Result<&PlayerAuthConfig, AppError> {
    state
        .config
        .player
        .as_ref()
        .ok_or_else(|| AppError::Unavailable("player login is not configured".into()))
}

fn discord_unconfigured() -> AppError {
    AppError::Unavailable("Discord linking is not configured".into())
}

fn callback_url(cfg: &PlayerAuthConfig) -> String {
    format!("{}/auth/player/discord/callback", cfg.callback_base_url)
}

#[derive(Deserialize)]
pub struct LinkStartRequest {
    /// The storefront host the BFF is serving (its verified `x-cb-site-host`).
    pub site_host: String,
}

/// POST /auth/player/discord/link: begin linking Discord to the authenticated player.
/// Returns the Discord authorize URL for the BFF to 302 the browser to.
pub async fn link_start(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<LinkStartRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let keys = player_keys(&state)?;
    let cfg = player_cfg(&state)?;
    let discord = state
        .config
        .discord
        .as_ref()
        .ok_or_else(discord_unconfigured)?;

    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .ok_or_else(|| AppError::Unauthorized("missing player token".into()))?;
    let claims = keys
        .decode(token)
        .map_err(|_| AppError::Unauthorized("invalid or expired player token".into()))?;

    let site_host = req.site_host.trim().to_ascii_lowercase();
    if !valid_host(&site_host) {
        return Err(AppError::BadRequest("invalid site host".into()));
    }
    // We redirect to https://{site_host}/account after linking, so the host MUST be a
    // storefront owned by THIS player's tenant (authoritative resolve, same posture as the
    // Steam callback); never trust an arbitrary host as a redirect target.
    let host_tenant = resolve_tenant_for_host(&state, cfg, &site_host).await?;
    if host_tenant != claims.tenant.0 {
        return Err(AppError::BadRequest(
            "that storefront is not on your account".into(),
        ));
    }

    let link_state = players::create_link_state(
        &state.owner_pool,
        claims.sub,
        claims.tenant,
        &site_host,
        "discord",
        state.pepper(),
    )
    .await?;

    let redirect_uri = callback_url(cfg);
    let url = reqwest::Url::parse_with_params(
        "https://discord.com/oauth2/authorize",
        &[
            ("response_type", "code"),
            ("client_id", discord.client_id.as_str()),
            ("scope", "identify"),
            ("redirect_uri", redirect_uri.as_str()),
            ("state", link_state.as_str()),
        ],
    )
    .map_err(|e| AppError::Internal(e.into()))?;
    Ok(Json(json!({ "url": url.as_str() })))
}

#[derive(Deserialize)]
pub struct CallbackParams {
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

/// GET /auth/player/discord/callback: complete the link and hand the browser back to the
/// storefront account page.
pub async fn callback(
    State(state): State<AppState>,
    Query(params): Query<CallbackParams>,
) -> Result<Response, AppError> {
    let cfg = player_cfg(&state)?;
    let discord = state
        .config
        .discord
        .as_ref()
        .ok_or_else(discord_unconfigured)?;

    // Redeem the single-use state FIRST: it recovers the player + host authoritatively and
    // is our CSRF guard. A tampered/expired/replayed state has no host to bounce to, so it
    // surfaces as an error rather than a redirect (rare; only a bad state reaches here).
    let state_token = params.state.unwrap_or_default();
    let redeemed =
        players::redeem_link_state(&state.owner_pool, &state_token, "discord", state.pepper())
            .await?;
    let dest = |outcome: &str| format!("https://{}/account?discord={outcome}", redeemed.site_host);

    // Discord bounced back an error (user denied) or omitted the code: send them home.
    let Some(code) = params.code.filter(|_| params.error.is_none()) else {
        return Ok(Redirect::to(&dest("error")).into_response());
    };

    let redirect_uri = callback_url(cfg);
    let identity =
        match exchange_code_for_identity(&state, discord, &code, &redirect_uri, None).await {
            Ok(id) => id,
            Err(e) => {
                tracing::warn!(error = %e, "discord link exchange failed");
                return Ok(Redirect::to(&dest("error")).into_response());
            }
        };

    match players::link_identity(
        &state.owner_pool,
        redeemed.player_account_id,
        "discord",
        &identity.id,
        identity.display_name.as_deref(),
        identity.avatar_url.as_deref(),
    )
    .await
    {
        Ok(()) => {
            audit::record(
                &state.owner_pool,
                None,
                None,
                "player.link.discord",
                Some("player_account"),
                Some(redeemed.player_account_id),
                Some(json!({ "tenant": redeemed.tenant_id })),
            )
            .await;
            Ok(Redirect::to(&dest("linked")).into_response())
        }
        // The Discord account is already linked to a different player.
        Err(AppError::Conflict(_)) => Ok(Redirect::to(&dest("conflict")).into_response()),
        Err(e) => Err(e),
    }
}
