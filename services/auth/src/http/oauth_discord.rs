//! Discord OAuth2 login (authorization-code + PKCE).
//!
//! `start` redirects the browser to Discord, stashing the PKCE verifier and a CSRF state
//! token in short-lived **signed** cookies. `callback` verifies the state, exchanges the
//! code, fetches the Discord profile, resolves the Cupboard account (link existing email,
//! else create), mints a session, and redirects to the dashboard with the session as
//! httpOnly cookies.
//!
//! Both routes return 503 when Discord is unconfigured (no client creds / cookie key).
//! End-to-end exercise requires a registered Discord application.

use crate::domain::{audit, users};
use crate::error::AppError;
use crate::http::auth::issue_session_for_org;
use crate::state::AppState;
use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Redirect, Response};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite, SignedCookieJar};
use base64::Engine as _;
use serde::Deserialize;

fn unconfigured() -> AppError {
    AppError::Unavailable("Discord login is not configured".into())
}

fn upstream<E: std::fmt::Display>(e: E) -> AppError {
    tracing::error!(error = %e, "discord oauth upstream error");
    AppError::Unavailable("Discord is currently unreachable".into())
}

/// A short-lived, httpOnly, signed cookie holding OAuth dance state.
fn temp_cookie(name: &'static str, value: String) -> Cookie<'static> {
    Cookie::build((name, value))
        .http_only(true)
        .same_site(SameSite::Lax)
        .path("/")
        .secure(true)
        .build()
}

/// A session cookie (the token itself), httpOnly so JS can't read it. Unsigned — the web
/// BFF reads the raw value to forward as the bearer / refresh.
fn session_cookie(name: &'static str, value: String) -> Cookie<'static> {
    Cookie::build((name, value))
        .http_only(true)
        .same_site(SameSite::Lax)
        .path("/")
        .secure(true)
        .build()
}

/// Begin the Discord login: redirect to Discord with PKCE + CSRF state in signed cookies.
pub async fn start(State(state): State<AppState>) -> Result<Response, AppError> {
    let discord = state.config.discord.as_ref().ok_or_else(unconfigured)?;
    let key = state.cookie_key.as_ref().ok_or_else(unconfigured)?;

    let verifier = cupboard_crypto::random_token();
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(cupboard_crypto::sha256(verifier.as_bytes()));
    let csrf = cupboard_crypto::random_token();

    let url = reqwest::Url::parse_with_params(
        "https://discord.com/oauth2/authorize",
        &[
            ("response_type", "code"),
            ("client_id", discord.client_id.as_str()),
            ("scope", "identify email"),
            ("redirect_uri", discord.redirect_uri.as_str()),
            ("state", csrf.as_str()),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
        ],
    )
    .map_err(|e| AppError::Internal(e.into()))?;

    let jar = SignedCookieJar::from_headers(&HeaderMap::new(), key.clone())
        .add(temp_cookie("cb_pkce", verifier))
        .add(temp_cookie("cb_csrf", csrf));

    Ok((jar, Redirect::to(url.as_str())).into_response())
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

/// Complete the Discord login.
pub async fn callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<CallbackParams>,
) -> Result<Response, AppError> {
    let discord = state.config.discord.as_ref().ok_or_else(unconfigured)?;
    let key = state.cookie_key.as_ref().ok_or_else(unconfigured)?;

    if let Some(err) = params.error {
        return Err(AppError::BadRequest(format!(
            "Discord authorization was denied: {err}"
        )));
    }
    let code = params
        .code
        .ok_or_else(|| AppError::BadRequest("missing authorization code".into()))?;
    let returned_state = params.state.unwrap_or_default();

    // Recover + verify the PKCE verifier and CSRF state from the signed cookies.
    let jar = SignedCookieJar::from_headers(&headers, key.clone());
    let verifier = jar
        .get("cb_pkce")
        .map(|c| c.value().to_string())
        .ok_or_else(|| AppError::BadRequest("missing or tampered PKCE cookie".into()))?;
    let csrf = jar
        .get("cb_csrf")
        .map(|c| c.value().to_string())
        .ok_or_else(|| AppError::BadRequest("missing or tampered state cookie".into()))?;
    if csrf != returned_state {
        return Err(AppError::BadRequest("OAuth state mismatch".into()));
    }

    // Exchange the code for an access token.
    let token: serde_json::Value = state
        .http
        .post("https://discord.com/api/oauth2/token")
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", discord.redirect_uri.as_str()),
            ("client_id", discord.client_id.as_str()),
            ("client_secret", discord.client_secret.as_str()),
            ("code_verifier", verifier.as_str()),
        ])
        .send()
        .await
        .map_err(upstream)?
        .error_for_status()
        .map_err(|_| AppError::Unauthorized("Discord token exchange failed".into()))?
        .json()
        .await
        .map_err(upstream)?;
    let access = token["access_token"]
        .as_str()
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("Discord returned no access_token")))?;

    // Fetch the Discord profile.
    let profile: serde_json::Value = state
        .http
        .get("https://discord.com/api/users/@me")
        .bearer_auth(access)
        .send()
        .await
        .map_err(upstream)?
        .error_for_status()
        .map_err(upstream)?
        .json()
        .await
        .map_err(upstream)?;
    let discord_id = profile["id"]
        .as_str()
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("Discord returned no user id")))?;
    let email = profile["email"].as_str().filter(|e| !e.is_empty());
    let display = profile["global_name"]
        .as_str()
        .or_else(|| profile["username"].as_str())
        .unwrap_or("Discord User");

    let user =
        users::find_or_create_by_discord(&state.owner_pool, discord_id, email, display).await?;
    audit::record(
        &state.owner_pool,
        None,
        Some(user.id),
        "user.login.discord",
        Some("user"),
        Some(user.id),
        None,
    )
    .await;

    let tokens = issue_session_for_org(&state, &user, None, &headers).await?;

    // Clear the dance cookies; set the session as httpOnly cookies; land on the dashboard.
    let signed = jar
        .remove(Cookie::build("cb_pkce").path("/").build())
        .remove(Cookie::build("cb_csrf").path("/").build());
    let session = CookieJar::new()
        .add(session_cookie("cb_access", tokens.access_token))
        .add(session_cookie("cb_refresh", tokens.refresh_token));

    Ok((signed, session, Redirect::to(&state.config.public_base_url)).into_response())
}
