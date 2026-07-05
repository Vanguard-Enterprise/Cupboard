//! Steam OpenID 2.0 player login (hand-rolled; the crates.io options are stale
//! micro-crates, checked 2026-07-05). Two hops on the central public callback host:
//!
//!   * `start` (called cluster-internally by the web BFF): builds the Steam redirect,
//!     encoding the tenant + storefront host into the signed `return_to`.
//!   * `callback` (public, on the login host): verifies the assertion via Steam's
//!     `check_authentication`, extracts the steamid64, guards against nonce replay,
//!     resolves-or-creates the player, and hands the browser back to the storefront with
//!     a one-time code.
//!
//! Both 503 when player auth is unconfigured. The tenant + host ride inside
//! `openid.return_to`, which Steam signs; `check_authentication` therefore rejects any
//! tampering, and we additionally re-check `return_to` byte-for-byte.

use crate::config::PlayerAuthConfig;
use crate::domain::{audit, players};
use crate::error::AppError;
use crate::state::AppState;
use axum::extract::{Query, RawQuery, State};
use axum::response::{IntoResponse, Redirect, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use uuid::Uuid;

const STEAM_OPENID_ENDPOINT: &str = "https://steamcommunity.com/openid/login";
const STEAM_NS: &str = "http://specs.openid.net/auth/2.0";
const STEAM_IDENTIFIER_SELECT: &str = "http://specs.openid.net/auth/2.0/identifier_select";

fn player_config(state: &AppState) -> Result<&PlayerAuthConfig, AppError> {
    state
        .config
        .player
        .as_ref()
        .ok_or_else(|| AppError::Unavailable("player login is not configured".into()))
}

/// A tenant storefront host is an internet-tainted value the BFF forwards; accept only
/// plausible DNS names so we never build an odd `return_to` or open redirect.
fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.')
}

fn callback_url(cfg: &PlayerAuthConfig, tenant: Uuid, site_host: &str) -> String {
    // Query params are echoed + signed by Steam inside return_to.
    format!(
        "{}/auth/player/steam/callback?tenant={}&site_host={}",
        cfg.callback_base_url, tenant, site_host
    )
}

#[derive(Deserialize)]
pub struct StartParams {
    /// The tenant (org) id whose site the player is on (from the BFF's resolved site).
    pub tenant: Uuid,
    /// The storefront host (from the BFF's verified `x-cb-site-host`).
    pub site_host: String,
}

/// Build the Steam redirect URL. Called server-side by the web BFF, which then 302s the
/// browser to `url`.
pub async fn start(
    State(state): State<AppState>,
    Query(params): Query<StartParams>,
) -> Result<Json<serde_json::Value>, AppError> {
    let cfg = player_config(&state)?;
    let site_host = params.site_host.trim().to_ascii_lowercase();
    if !valid_host(&site_host) {
        return Err(AppError::BadRequest("invalid site host".into()));
    }
    let return_to = callback_url(cfg, params.tenant, &site_host);
    let url = reqwest::Url::parse_with_params(
        STEAM_OPENID_ENDPOINT,
        &[
            ("openid.ns", STEAM_NS),
            ("openid.mode", "checkid_setup"),
            ("openid.claimed_id", STEAM_IDENTIFIER_SELECT),
            ("openid.identity", STEAM_IDENTIFIER_SELECT),
            ("openid.return_to", return_to.as_str()),
            ("openid.realm", cfg.callback_base_url.as_str()),
        ],
    )
    .map_err(|e| AppError::Internal(e.into()))?;
    Ok(Json(json!({ "url": url.as_str() })))
}

/// Extract steamid64 from a Steam claimed_id URL, validating the canonical shape.
fn steamid_from_claimed_id(claimed_id: &str) -> Option<String> {
    let id = claimed_id
        .strip_prefix("https://steamcommunity.com/openid/id/")
        .or_else(|| claimed_id.strip_prefix("http://steamcommunity.com/openid/id/"))?;
    // steamid64: 17 digits beginning 7656119.
    if id.len() == 17 && id.starts_with("7656119") && id.chars().all(|c| c.is_ascii_digit()) {
        Some(id.to_string())
    } else {
        None
    }
}

/// Complete the Steam login. Steam appends its `openid.*` params to our `return_to`, so
/// the whole assertion (plus our `tenant`/`site_host`) arrives in the query string.
pub async fn callback(
    State(state): State<AppState>,
    RawQuery(raw): RawQuery,
) -> Result<Response, AppError> {
    let cfg = player_config(&state)?;
    let raw = raw.unwrap_or_default();
    let params: HashMap<String, String> = reqwest::Url::parse(&format!("http://x/?{raw}"))
        .map_err(|_| AppError::BadRequest("malformed callback query".into()))?
        .query_pairs()
        .into_owned()
        .collect();

    let tenant: Uuid = params
        .get("tenant")
        .and_then(|t| t.parse().ok())
        .ok_or_else(|| AppError::BadRequest("missing tenant".into()))?;
    let site_host = params
        .get("site_host")
        .cloned()
        .filter(|h| valid_host(h))
        .ok_or_else(|| AppError::BadRequest("missing or invalid site host".into()))?;

    // Exact return_to match: it must be the callback URL we minted (defense in depth on
    // top of Steam's signature over return_to).
    let expected_return_to = callback_url(cfg, tenant, &site_host);
    if params.get("openid.return_to").map(String::as_str) != Some(expected_return_to.as_str()) {
        return Err(AppError::BadRequest("return_to mismatch".into()));
    }

    // Verify the assertion with Steam: echo every openid.* field back with
    // mode=check_authentication and require is_valid:true.
    let mut verify: Vec<(String, String)> = params
        .iter()
        .filter(|(k, _)| k.starts_with("openid."))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    // Override mode.
    verify.retain(|(k, _)| k != "openid.mode");
    verify.push(("openid.mode".into(), "check_authentication".into()));

    let body = state
        .http
        .post(STEAM_OPENID_ENDPOINT)
        .form(&verify)
        .send()
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "steam check_authentication failed");
            AppError::Unavailable("Steam is currently unreachable".into())
        })?
        .text()
        .await
        .map_err(|e| AppError::Unavailable(format!("Steam response error: {e}")))?;
    if !body.lines().any(|l| l == "is_valid:true") {
        return Err(AppError::Unauthorized(
            "Steam did not validate this login".into(),
        ));
    }

    // Replay guard on the response nonce.
    if let Some(nonce) = params.get("openid.response_nonce") {
        let fresh = players::record_nonce(&state.owner_pool, nonce, state.pepper()).await?;
        if !fresh {
            return Err(AppError::Unauthorized(
                "this Steam assertion was already used".into(),
            ));
        }
    }

    let claimed_id = params
        .get("openid.claimed_id")
        .ok_or_else(|| AppError::BadRequest("missing claimed_id".into()))?;
    let steam_id = steamid_from_claimed_id(claimed_id)
        .ok_or_else(|| AppError::BadRequest("unrecognized Steam identifier".into()))?;

    // Optional persona/avatar enrichment (login works without it).
    let (display_name, avatar_url) = fetch_steam_profile(&state, &steam_id).await;

    let player = players::resolve_or_create(
        &state.owner_pool,
        "steam",
        &steam_id,
        display_name.as_deref(),
        avatar_url.as_deref(),
    )
    .await?;

    audit::record(
        &state.owner_pool,
        None,
        None,
        "player.login.steam",
        Some("player_account"),
        Some(player.id),
        Some(json!({ "tenant": tenant, "site_host": site_host })),
    )
    .await;

    // Hand back to the storefront with a one-time code.
    let code = players::issue_login_code(
        &state.owner_pool,
        player.id,
        cupboard_domain::OrgId(tenant),
        &site_host,
        Some(&steam_id),
        state.pepper(),
    )
    .await?;

    let dest = format!("https://{site_host}/login/complete?code={code}");
    Ok(Redirect::to(&dest).into_response())
}

/// Best-effort Steam persona name + avatar via GetPlayerSummaries. Returns (name, avatar),
/// both `None` when the key is unset or the call fails (login still succeeds).
async fn fetch_steam_profile(state: &AppState, steam_id: &str) -> (Option<String>, Option<String>) {
    let Some(key) = state.config.steam_web_api_key.as_deref() else {
        return (None, None);
    };
    let url = format!(
        "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key={key}&steamids={steam_id}"
    );
    match state.http.get(&url).send().await {
        Ok(resp) => match resp.json::<serde_json::Value>().await {
            Ok(v) => {
                let p = &v["response"]["players"][0];
                let name = p["personaname"].as_str().map(str::to_string);
                let avatar = p["avatarfull"]
                    .as_str()
                    .or_else(|| p["avatarmedium"].as_str())
                    .map(str::to_string);
                (name, avatar)
            }
            Err(e) => {
                tracing::warn!(error = %e, "steam profile parse failed");
                (None, None)
            }
        },
        Err(e) => {
            tracing::warn!(error = %e, "steam profile fetch failed");
            (None, None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_valid_steamid_only() {
        assert_eq!(
            steamid_from_claimed_id("https://steamcommunity.com/openid/id/76561198000000000")
                .as_deref(),
            Some("76561198000000000")
        );
        // Wrong prefix, wrong length, non-digits, wrong leading digits.
        assert!(steamid_from_claimed_id("https://evil.com/openid/id/76561198000000000").is_none());
        assert!(steamid_from_claimed_id("https://steamcommunity.com/openid/id/123").is_none());
        assert!(
            steamid_from_claimed_id("https://steamcommunity.com/openid/id/7656119800000000x")
                .is_none()
        );
        assert!(
            steamid_from_claimed_id("https://steamcommunity.com/openid/id/12345678901234567")
                .is_none()
        );
    }

    #[test]
    fn host_validation_rejects_junk() {
        assert!(valid_host("acme.sites.vngenterprise.com"));
        assert!(valid_host("store.community.gg"));
        assert!(!valid_host(""));
        assert!(!valid_host("bad_host.com"));
        assert!(!valid_host("has space.com"));
        assert!(!valid_host("javascript:alert"));
    }
}
