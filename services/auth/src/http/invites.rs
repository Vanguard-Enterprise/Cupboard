//! Staff-invite endpoints: create/list (require `staff.manage`) and a public accept
//! endpoint that creates-or-links the account, joins the org, and auto-logs the user in.

use crate::domain::{audit, invites};
use crate::error::AppError;
use crate::http::auth::{issue_session_for_org, TokenResponse};
use crate::http::AuthClaims;
use crate::state::AppState;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use cupboard_domain::Permission;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Invites are valid for 7 days.
const INVITE_TTL_SECS: i64 = 60 * 60 * 24 * 7;

#[derive(Deserialize)]
pub struct CreateInviteRequest {
    pub email: String,
    #[serde(default)]
    pub role_ids: Vec<Uuid>,
}

#[derive(Serialize)]
pub struct CreateInviteResponse {
    pub invite: invites::Invite,
    /// The link to send the invitee. Phase 1: email delivery is stubbed, so this is
    /// returned (and logged) for the inviter to share manually.
    pub accept_url: String,
}

pub async fn create(
    State(state): State<AppState>,
    claims: AuthClaims,
    Json(req): Json<CreateInviteRequest>,
) -> Result<(StatusCode, Json<CreateInviteResponse>), AppError> {
    let org = claims.require(Permission::StaffManage)?;
    let new = invites::create_invite(
        &state.app_pool,
        org.into(),
        &req.email,
        &req.role_ids,
        claims.0.sub.0,
        INVITE_TTL_SECS,
        state.pepper(),
    )
    .await?;

    let accept_url = format!(
        "{}/invite/accept?token={}",
        state.config.public_base_url.trim_end_matches('/'),
        new.token
    );
    // Email delivery is stubbed in Phase 1 — surface the link so it can be shared.
    tracing::info!(invite_id = %new.invite.id, email = %new.invite.email, %accept_url, "staff invite created (email delivery stubbed)");

    audit::record(
        &state.owner_pool,
        Some(org.0),
        Some(claims.0.sub.0),
        "invite.create",
        Some("invite"),
        Some(new.invite.id),
        None,
    )
    .await;

    Ok((
        StatusCode::CREATED,
        Json(CreateInviteResponse {
            invite: new.invite,
            accept_url,
        }),
    ))
}

pub async fn list(
    State(state): State<AppState>,
    claims: AuthClaims,
) -> Result<Json<Vec<invites::Invite>>, AppError> {
    let org = claims.require(Permission::StaffManage)?;
    Ok(Json(
        invites::list_pending(&state.app_pool, org.into()).await?,
    ))
}

#[derive(Deserialize)]
pub struct AcceptInviteRequest {
    pub token: String,
    /// Required only when the invited email has no account yet.
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
}

/// Public (unauthenticated) — accept an invite and receive an org-scoped session.
pub async fn accept(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<AcceptInviteRequest>,
) -> Result<Json<TokenResponse>, AppError> {
    let accepted = invites::accept_invite(
        &state.owner_pool,
        &req.token,
        state.pepper(),
        req.password.as_deref(),
        req.display_name.as_deref(),
    )
    .await?;

    audit::record(
        &state.owner_pool,
        Some(accepted.organization_id),
        Some(accepted.user.id),
        "invite.accept",
        Some("user"),
        Some(accepted.user.id),
        None,
    )
    .await;

    // Auto-login scoped to the org they just joined.
    let tokens = issue_session_for_org(
        &state,
        &accepted.user,
        Some(accepted.organization_id),
        &headers,
    )
    .await?;
    Ok(Json(tokens))
}
