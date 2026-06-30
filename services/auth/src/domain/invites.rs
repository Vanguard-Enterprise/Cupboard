//! Staff invitations. Creating an invite is tenant-scoped work (the inviter holds an
//! org token) on the app pool; accepting one happens with no tenant context (a public
//! link), so it runs on the owner pool.
//!
//! Phase 1 stubs email delivery — the accept link is returned to the caller and logged;
//! wiring real SMTP is a later, isolated change.

use crate::domain::{password, users};
use crate::error::AppError;
use chrono::{DateTime, Utc};
use cupboard_domain::TenantId;
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, sqlx::FromRow, serde::Serialize)]
pub struct Invite {
    pub id: Uuid,
    pub email: String,
    pub status: String,
    pub expires_at: DateTime<Utc>,
}

/// A freshly-created invite plus the raw accept token (shown once, embedded in the link).
pub struct NewInvite {
    pub invite: Invite,
    pub token: String,
}

/// Create a pending invite for `email` with the given roles. Validates (under RLS) that
/// the roles belong to this org. App pool, tenant-scoped.
pub async fn create_invite(
    app_pool: &PgPool,
    tenant: TenantId,
    email: &str,
    role_ids: &[Uuid],
    invited_by: Uuid,
    ttl_secs: i64,
    pepper: &[u8],
) -> Result<NewInvite, AppError> {
    let email = email.trim();
    if email.len() < 3 || !email.contains('@') {
        return Err(AppError::BadRequest("a valid email is required".into()));
    }
    let mut unique: Vec<Uuid> = role_ids.to_vec();
    unique.sort();
    unique.dedup();

    let token = cupboard_crypto::random_token();
    let token_hash = cupboard_crypto::hash_token(&token, pepper);
    let expires_at = Utc::now() + chrono::Duration::seconds(ttl_secs);

    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    if !unique.is_empty() {
        let found: i64 = sqlx::query_scalar("SELECT count(*) FROM roles WHERE id = ANY($1)")
            .bind(&unique)
            .fetch_one(&mut *tx)
            .await?;
        if found as usize != unique.len() {
            return Err(AppError::BadRequest(
                "one or more roles do not exist in this organization".into(),
            ));
        }
    }

    let invite = sqlx::query_as::<_, Invite>(
        "INSERT INTO invites (organization_id, email, token_hash, invited_by, expires_at) \
         VALUES ($1, $2, $3, $4, $5) RETURNING id, email, status, expires_at",
    )
    .bind(tenant.0)
    .bind(email)
    .bind(&token_hash)
    .bind(invited_by)
    .bind(expires_at)
    .fetch_one(&mut *tx)
    .await?;

    for role_id in &unique {
        sqlx::query(
            "INSERT INTO invite_roles (organization_id, invite_id, role_id) VALUES ($1, $2, $3)",
        )
        .bind(tenant.0)
        .bind(invite.id)
        .bind(role_id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    Ok(NewInvite { invite, token })
}

/// List pending invites for the org (app pool, tenant-scoped).
pub async fn list_pending(app_pool: &PgPool, tenant: TenantId) -> Result<Vec<Invite>, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let invites = sqlx::query_as::<_, Invite>(
        "SELECT id, email, status, expires_at FROM invites \
         WHERE status = 'pending' ORDER BY created_at DESC",
    )
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(invites)
}

/// The result of accepting an invite: the (possibly newly-created) user and the org they
/// joined, so the caller can mint an org-scoped session.
pub struct Accepted {
    pub user: users::User,
    pub organization_id: Uuid,
}

#[derive(sqlx::FromRow)]
struct InviteRow {
    id: Uuid,
    organization_id: Uuid,
    email: String,
    status: String,
    expires_at: DateTime<Utc>,
}

/// Accept an invite by its raw token. Creates the account (if new — `password` then
/// required) or links the existing account, joins the org, assigns the invited roles, and
/// marks the invite accepted. Runs on the owner pool (no tenant context at accept time).
pub async fn accept_invite(
    owner_pool: &PgPool,
    token: &str,
    pepper: &[u8],
    pw: Option<&str>,
    display_name: Option<&str>,
) -> Result<Accepted, AppError> {
    let token_hash = cupboard_crypto::hash_token(token, pepper);
    let invite = sqlx::query_as::<_, InviteRow>(
        "SELECT id, organization_id, email, status, expires_at FROM invites WHERE token_hash = $1",
    )
    .bind(&token_hash)
    .fetch_optional(owner_pool)
    .await?
    .ok_or_else(|| AppError::NotFound("invite not found".into()))?;

    if invite.status != "pending" {
        return Err(AppError::Conflict(
            "this invite has already been used or revoked".into(),
        ));
    }
    if invite.expires_at < Utc::now() {
        return Err(AppError::Conflict("this invite has expired".into()));
    }

    // Find the existing account for the invited email, or create one.
    let user = match users::find_by_email(owner_pool, &invite.email).await? {
        Some(u) => u,
        None => {
            let pw = pw.ok_or_else(|| {
                AppError::BadRequest("a password is required to create your account".into())
            })?;
            if pw.len() < 8 {
                return Err(AppError::BadRequest(
                    "password must be at least 8 characters".into(),
                ));
            }
            let name = display_name
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| invite.email.split('@').next().unwrap_or("user"));
            let hash = password::hash_password(pw)?;
            let u = users::create_with_password(owner_pool, &invite.email, name, &hash).await?;
            // They demonstrably control the invited address.
            sqlx::query("UPDATE users SET email_verified = true WHERE id = $1")
                .bind(u.id)
                .execute(owner_pool)
                .await?;
            u
        }
    };

    let mut tx = owner_pool.begin().await?;
    let membership_id: Uuid = sqlx::query_scalar(
        "INSERT INTO memberships (organization_id, user_id, status) VALUES ($1, $2, 'active') \
         ON CONFLICT (organization_id, user_id) DO UPDATE SET status = 'active' RETURNING id",
    )
    .bind(invite.organization_id)
    .bind(user.id)
    .fetch_one(&mut *tx)
    .await?;

    let role_ids: Vec<Uuid> =
        sqlx::query_scalar("SELECT role_id FROM invite_roles WHERE invite_id = $1")
            .bind(invite.id)
            .fetch_all(&mut *tx)
            .await?;
    for role_id in &role_ids {
        sqlx::query(
            "INSERT INTO membership_roles (organization_id, membership_id, role_id) \
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        )
        .bind(invite.organization_id)
        .bind(membership_id)
        .bind(role_id)
        .execute(&mut *tx)
        .await?;
    }

    sqlx::query(
        "UPDATE invites SET status = 'accepted', accepted_at = now(), accepted_user_id = $2 \
         WHERE id = $1",
    )
    .bind(invite.id)
    .bind(user.id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(Accepted {
        user,
        organization_id: invite.organization_id,
    })
}
