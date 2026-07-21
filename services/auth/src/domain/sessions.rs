//! Refresh-token sessions and access-token minting.
//!
//! A **session** is a long-lived refresh token (opaque random secret) stored only as a
//! keyed hash. Exchanging it mints a short-lived **access token** (EdDSA JWT) that the
//! gateway validates statelessly. Phase 1 does not rotate the refresh token on use —
//! it stays valid until logout or expiry.

use crate::error::AppError;
use chrono::Utc;
use cupboard_auth_core::{Claims, Keys};
use cupboard_domain::{OrgId, UserId};
use sqlx::PgPool;
use uuid::Uuid;

/// A session row, limited to the columns the service reads (validity is enforced in the
/// lookup query, not in Rust).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Session {
    pub id: Uuid,
    pub user_id: Uuid,
}

const SELECT_COLS: &str = "id, user_id";

/// A freshly-created session plus the raw refresh token to hand to the client once.
pub struct NewSession {
    pub session: Session,
    pub refresh_token: String,
}

/// Create a session and return the raw refresh token (shown to the client a single
/// time; only its keyed hash is persisted).
pub async fn create_session(
    pool: &PgPool,
    user_id: Uuid,
    user_agent: Option<&str>,
    ip: Option<&str>,
    ttl_secs: i64,
    pepper: &[u8],
) -> Result<NewSession, AppError> {
    let refresh_token = cupboard_crypto::random_token();
    let hash = cupboard_crypto::hash_token(&refresh_token, pepper);
    let expires_at = Utc::now() + chrono::Duration::seconds(ttl_secs);

    let sql = format!(
        "INSERT INTO sessions (user_id, refresh_token_hash, user_agent, ip, expires_at) \
         VALUES ($1, $2, $3, $4, $5) RETURNING {SELECT_COLS}"
    );
    let session = sqlx::query_as::<_, Session>(&sql)
        .bind(user_id)
        .bind(hash)
        .bind(user_agent)
        .bind(ip)
        .bind(expires_at)
        .fetch_one(pool)
        .await?;
    Ok(NewSession {
        session,
        refresh_token,
    })
}

/// Resolve a non-revoked, unexpired session from a raw refresh token, or `None`.
pub async fn find_valid_by_token(
    pool: &PgPool,
    refresh_token: &str,
    pepper: &[u8],
) -> Result<Option<Session>, AppError> {
    let hash = cupboard_crypto::hash_token(refresh_token, pepper);
    let sql = format!(
        "SELECT {SELECT_COLS} FROM sessions \
         WHERE refresh_token_hash = $1 AND revoked_at IS NULL AND expires_at > now()"
    );
    Ok(sqlx::query_as::<_, Session>(&sql)
        .bind(hash)
        .fetch_optional(pool)
        .await?)
}

/// Mark the most-recent-use time on a session.
pub async fn touch(pool: &PgPool, id: Uuid) -> Result<(), AppError> {
    sqlx::query("UPDATE sessions SET last_used_at = now() WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Revoke the session identified by a raw refresh token (logout). Idempotent.
pub async fn revoke_by_token(
    pool: &PgPool,
    refresh_token: &str,
    pepper: &[u8],
) -> Result<(), AppError> {
    let hash = cupboard_crypto::hash_token(refresh_token, pepper);
    sqlx::query(
        "UPDATE sessions SET revoked_at = now() \
         WHERE refresh_token_hash = $1 AND revoked_at IS NULL",
    )
    .bind(hash)
    .execute(pool)
    .await?;
    Ok(())
}

/// Sign an access token for this session, scoped to `org` with the resolved `perms`
/// (both empty/`None` for a just-logged-in token before an org is selected). `plan`
/// is the org's mirrored plan claim from [`crate::domain::plans::plan_claim`]
/// (`None` = free tier, and always `None` for org-less tokens).
pub fn mint_access_token(
    keys: &Keys,
    user_id: Uuid,
    session_id: Uuid,
    org: Option<OrgId>,
    perms: Vec<String>,
    plan: Option<String>,
    ttl_secs: i64,
) -> Result<String, AppError> {
    let mut claims = Claims::new(UserId(user_id), session_id, org, perms, ttl_secs);
    claims.plan = plan;
    Ok(keys.encode(&claims)?)
}
