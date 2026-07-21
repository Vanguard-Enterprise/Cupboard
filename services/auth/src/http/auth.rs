//! Email/password auth endpoints: signup, login, token refresh, logout, and `me`.
//! Org-scoping of the token (and Discord login) layer onto `token`/this module in later
//! steps.

use crate::domain::{audit, password, plans, rbac, sessions, users};
use crate::error::AppError;
use crate::http::{client_info, AuthClaims};
use crate::state::AppState;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use cupboard_domain::OrgId;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Serialize)]
pub struct UserDto {
    pub id: Uuid,
    pub email: Option<String>,
    pub display_name: String,
}

impl From<users::User> for UserDto {
    fn from(u: users::User) -> Self {
        UserDto {
            id: u.id,
            email: u.email,
            display_name: u.display_name,
        }
    }
}

/// The token bundle returned by signup/login/refresh. The web BFF stores both tokens as
/// httpOnly cookies; other clients use the body directly.
#[derive(Serialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub token_type: &'static str,
    /// Access-token lifetime in seconds.
    pub expires_in: i64,
    pub user: UserDto,
}

#[derive(Deserialize)]
pub struct SignupRequest {
    pub email: String,
    pub password: String,
    pub display_name: String,
}

pub async fn signup(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<SignupRequest>,
) -> Result<(StatusCode, Json<TokenResponse>), AppError> {
    validate_email(&req.email)?;
    validate_password(&req.password)?;
    let display_name = req.display_name.trim();
    if display_name.is_empty() {
        return Err(AppError::BadRequest("display_name is required".into()));
    }

    let hash = password::hash_password(&req.password)?;
    let user =
        users::create_with_password(&state.owner_pool, &req.email, display_name, &hash).await?;
    let response = issue_tokens(&state, &user, &headers).await?;
    audit::record(
        &state.owner_pool,
        None,
        Some(user.id),
        "user.signup",
        Some("user"),
        Some(user.id),
        None,
    )
    .await;
    Ok((StatusCode::CREATED, Json(response)))
}

#[derive(Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

pub async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<LoginRequest>,
) -> Result<Json<TokenResponse>, AppError> {
    // Uniform "invalid email or password" so callers can't probe which accounts exist.
    let invalid = || AppError::Unauthorized("invalid email or password".into());
    let user = users::find_by_email(&state.owner_pool, &req.email)
        .await?
        .ok_or_else(invalid)?;
    if user.status != "active" {
        return Err(AppError::Forbidden("account is suspended".into()));
    }
    let hash = user.password_hash.as_deref().ok_or_else(invalid)?;
    if !password::verify_password(&req.password, hash) {
        return Err(invalid());
    }

    let response = issue_tokens(&state, &user, &headers).await?;
    audit::record(
        &state.owner_pool,
        None,
        Some(user.id),
        "user.login",
        Some("user"),
        Some(user.id),
        None,
    )
    .await;
    Ok(Json(response))
}

#[derive(Deserialize)]
pub struct TokenRequest {
    pub refresh_token: String,
    /// The organization to scope the new access token to. Resolved (membership check +
    /// permission expansion) in step 3; ignored until then.
    #[serde(default)]
    pub org_id: Option<Uuid>,
}

/// Exchange a refresh token for a fresh access token (and, from step 3, re-scope it to a
/// chosen org). The refresh token itself is not rotated in Phase 1.
pub async fn token(
    State(state): State<AppState>,
    Json(req): Json<TokenRequest>,
) -> Result<Json<TokenResponse>, AppError> {
    let session =
        sessions::find_valid_by_token(&state.owner_pool, &req.refresh_token, state.pepper())
            .await?
            .ok_or_else(|| AppError::Unauthorized("invalid or expired refresh token".into()))?;
    let user = users::find_by_id(&state.owner_pool, session.user_id)
        .await?
        .ok_or_else(|| AppError::Unauthorized("account no longer exists".into()))?;

    // Scope the new access token to the requested org (verifying membership and
    // expanding its permissions), or leave it org-less.
    let (org, perms) = match req.org_id {
        Some(org_id) => {
            match rbac::resolve_permissions(&state.owner_pool, user.id, org_id).await? {
                Some(perms) => (Some(OrgId(org_id)), perms),
                None => {
                    return Err(AppError::Forbidden(
                        "you are not a member of that organization".into(),
                    ))
                }
            }
        }
        None => (None, Vec::new()),
    };

    // Org-scoped tokens carry the mirrored plan claim (None = free, decision K).
    let plan = match org {
        Some(o) => plans::plan_claim(&state.owner_pool, o.0).await?,
        None => None,
    };

    sessions::touch(&state.owner_pool, session.id).await?;
    let access_token = sessions::mint_access_token(
        &state.keys,
        user.id,
        session.id,
        org,
        perms,
        plan,
        state.config.access_token_ttl_secs,
    )?;
    Ok(Json(TokenResponse {
        access_token,
        refresh_token: req.refresh_token,
        token_type: "Bearer",
        expires_in: state.config.access_token_ttl_secs,
        user: user.into(),
    }))
}

#[derive(Deserialize)]
pub struct LogoutRequest {
    pub refresh_token: String,
}

pub async fn logout(
    State(state): State<AppState>,
    Json(req): Json<LogoutRequest>,
) -> Result<StatusCode, AppError> {
    sessions::revoke_by_token(&state.owner_pool, &req.refresh_token, state.pepper()).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
pub struct MeResponse {
    pub user: UserDto,
    /// The org the current access token is scoped to (if any).
    pub org: Option<Uuid>,
    /// Permissions granted in that org.
    pub permissions: Vec<String>,
}

pub async fn me(
    State(state): State<AppState>,
    AuthClaims(claims): AuthClaims,
) -> Result<Json<MeResponse>, AppError> {
    let user = users::find_by_id(&state.owner_pool, claims.sub.0)
        .await?
        .ok_or_else(|| AppError::Unauthorized("account no longer exists".into()))?;
    Ok(Json(MeResponse {
        user: user.into(),
        org: claims.org.map(|o| o.0),
        permissions: claims.perms,
    }))
}

/// Create a session and mint an org-less access token for `user` (signup/login).
async fn issue_tokens(
    state: &AppState,
    user: &users::User,
    headers: &HeaderMap,
) -> Result<TokenResponse, AppError> {
    issue_session_for_org(state, user, None, headers).await
}

/// Create a session and mint an access token, optionally scoped to `org_id` with that
/// org's resolved permissions. Shared by login/signup (org-less) and invite-accept
/// (auto-login into the joined org). If membership can't be resolved, falls back to an
/// org-less token rather than failing the session creation.
pub(crate) async fn issue_session_for_org(
    state: &AppState,
    user: &users::User,
    org_id: Option<Uuid>,
    headers: &HeaderMap,
) -> Result<TokenResponse, AppError> {
    let (user_agent, ip) = client_info(headers);
    let new_session = sessions::create_session(
        &state.owner_pool,
        user.id,
        user_agent.as_deref(),
        ip.as_deref(),
        state.config.refresh_token_ttl_secs,
        state.pepper(),
    )
    .await?;

    let (org, perms) = match org_id {
        Some(id) => match rbac::resolve_permissions(&state.owner_pool, user.id, id).await? {
            Some(perms) => (Some(OrgId(id)), perms),
            None => (None, Vec::new()),
        },
        None => (None, Vec::new()),
    };
    // Org-scoped tokens carry the mirrored plan claim (None = free, decision K).
    let plan = match org {
        Some(o) => plans::plan_claim(&state.owner_pool, o.0).await?,
        None => None,
    };

    let access_token = sessions::mint_access_token(
        &state.keys,
        user.id,
        new_session.session.id,
        org,
        perms,
        plan,
        state.config.access_token_ttl_secs,
    )?;
    Ok(TokenResponse {
        access_token,
        refresh_token: new_session.refresh_token,
        token_type: "Bearer",
        expires_in: state.config.access_token_ttl_secs,
        user: user.clone().into(),
    })
}

fn validate_email(email: &str) -> Result<(), AppError> {
    let e = email.trim();
    if e.len() < 3 || !e.contains('@') {
        return Err(AppError::BadRequest("a valid email is required".into()));
    }
    Ok(())
}

fn validate_password(password: &str) -> Result<(), AppError> {
    if password.len() < 8 {
        return Err(AppError::BadRequest(
            "password must be at least 8 characters".into(),
        ));
    }
    Ok(())
}
