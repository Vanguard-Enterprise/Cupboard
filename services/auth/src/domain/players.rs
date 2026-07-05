//! Player accounts (storefront customers): resolve-or-create by external identity,
//! tenant-scoped player sessions (keyed-hash refresh tokens), the one-time-code login
//! handoff, and the Steam OpenID nonce replay guard. Global tables (owner pool); a
//! player is one person platform-wide, distinct from operator `users`.

use crate::error::AppError;
use chrono::{Duration, Utc};
use cupboard_domain::OrgId;
use sqlx::PgPool;
use uuid::Uuid;

/// One-time login code TTL: long enough for the browser redirect + BFF exchange, short
/// enough that a leaked redirect URL is near-useless.
const LOGIN_CODE_TTL_SECS: i64 = 60;
/// How long a Steam response nonce is remembered (Steam assertions are short-lived; this
/// only needs to outlast their freshness window).
const NONCE_RETENTION_SECS: i64 = 3600;

#[derive(Debug, Clone)]
pub struct PlayerAccount {
    pub id: Uuid,
}

/// Resolve the player for an external identity: return the linked account (refreshing its
/// display/avatar), else create a new account and link the identity. Steam or Discord.
pub async fn resolve_or_create(
    pool: &PgPool,
    provider: &str,
    subject: &str,
    display_name: Option<&str>,
    avatar_url: Option<&str>,
) -> Result<PlayerAccount, AppError> {
    let mut tx = pool.begin().await?;

    let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT player_account_id FROM player_identities WHERE provider = $1 AND subject = $2",
    )
    .bind(provider)
    .bind(subject)
    .fetch_optional(&mut *tx)
    .await?;

    let account_id = match existing {
        Some(id) => id,
        None => {
            // Race-safe first link: create an account, then claim the identity with an
            // ON CONFLICT guard. `player_identities.UNIQUE(provider, subject)` is the
            // single source of truth: if a concurrent first-login won the race, our
            // insert affects zero rows and we drop the orphan account, then read the
            // winner's id.
            let new_account: Uuid = sqlx::query_scalar(
                "INSERT INTO player_accounts (display_name, avatar_url) VALUES ($1, $2) \
                 RETURNING id",
            )
            .bind(display_name)
            .bind(avatar_url)
            .fetch_one(&mut *tx)
            .await?;
            let claimed = sqlx::query(
                "INSERT INTO player_identities \
                     (player_account_id, provider, subject, display_name, avatar_url) \
                 VALUES ($1, $2, $3, $4, $5) \
                 ON CONFLICT (provider, subject) DO NOTHING",
            )
            .bind(new_account)
            .bind(provider)
            .bind(subject)
            .bind(display_name)
            .bind(avatar_url)
            .execute(&mut *tx)
            .await?
            .rows_affected();
            if claimed == 0 {
                sqlx::query("DELETE FROM player_accounts WHERE id = $1")
                    .bind(new_account)
                    .execute(&mut *tx)
                    .await?;
                sqlx::query_scalar::<_, Uuid>(
                    "SELECT player_account_id FROM player_identities \
                     WHERE provider = $1 AND subject = $2",
                )
                .bind(provider)
                .bind(subject)
                .fetch_one(&mut *tx)
                .await?
            } else {
                new_account
            }
        }
    };

    // Refresh the cached profile + last-login on the resolved account (and its identity).
    sqlx::query(
        "UPDATE player_identities SET display_name = COALESCE($3, display_name), \
             avatar_url = COALESCE($4, avatar_url) \
         WHERE provider = $1 AND subject = $2",
    )
    .bind(provider)
    .bind(subject)
    .bind(display_name)
    .bind(avatar_url)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE player_accounts SET last_login_at = now(), \
             display_name = COALESCE($2, display_name), \
             avatar_url = COALESCE($3, avatar_url) \
         WHERE id = $1",
    )
    .bind(account_id)
    .bind(display_name)
    .bind(avatar_url)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(PlayerAccount { id: account_id })
}

/// Record a Steam OpenID response nonce; returns `false` if it was already seen (replay).
/// Also opportunistically prunes expired nonces.
pub async fn record_nonce(pool: &PgPool, nonce: &str, pepper: &[u8]) -> Result<bool, AppError> {
    let hash = cupboard_crypto::hmac_sha256(nonce.as_bytes(), pepper).to_vec();
    let inserted =
        sqlx::query("INSERT INTO openid_replay (nonce_hash) VALUES ($1) ON CONFLICT DO NOTHING")
            .bind(&hash)
            .execute(pool)
            .await?
            .rows_affected();
    // Best-effort prune (cheap; index on seen_at).
    let _ =
        sqlx::query("DELETE FROM openid_replay WHERE seen_at < now() - make_interval(secs => $1)")
            .bind(NONCE_RETENTION_SECS as f64)
            .execute(pool)
            .await;
    Ok(inserted == 1)
}

/// Mint a one-time login code for the handoff to a tenant site. Returns the raw code
/// (goes only in the redirect URL); only its SHA-256 keyed hash is stored.
pub async fn issue_login_code(
    pool: &PgPool,
    player_id: Uuid,
    tenant: OrgId,
    site_host: &str,
    steam_id: Option<&str>,
    pepper: &[u8],
) -> Result<String, AppError> {
    let code = cupboard_crypto::random_token();
    let hash = cupboard_crypto::hash_token(&code, pepper);
    let expires_at = Utc::now() + Duration::seconds(LOGIN_CODE_TTL_SECS);
    sqlx::query(
        "INSERT INTO player_login_codes \
             (code_hash, player_account_id, tenant_id, site_host, steam_id, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(hash)
    .bind(player_id)
    .bind(tenant.0)
    .bind(site_host)
    .bind(steam_id)
    .bind(expires_at)
    .execute(pool)
    .await?;
    Ok(code)
}

/// The claims a redeemed login code carries into the minted session.
pub struct RedeemedCode {
    pub player_account_id: Uuid,
    pub tenant_id: Uuid,
    pub site_host: String,
    pub steam_id: Option<String>,
}

/// Atomically consume a login code, verifying the site host it was issued for. Single-use
/// (DELETE ... RETURNING) and TTL-bounded; also prunes expired codes.
pub async fn redeem_login_code(
    pool: &PgPool,
    code: &str,
    site_host: &str,
    pepper: &[u8],
) -> Result<RedeemedCode, AppError> {
    let hash = cupboard_crypto::hash_token(code, pepper);
    let row = sqlx::query_as::<_, (Uuid, Uuid, String, Option<String>)>(
        "DELETE FROM player_login_codes \
         WHERE code_hash = $1 AND site_host = $2 AND expires_at > now() \
         RETURNING player_account_id, tenant_id, site_host, steam_id",
    )
    .bind(&hash)
    .bind(site_host)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| {
        AppError::Unauthorized("login code is invalid, expired, or already used".into())
    })?;

    let _ = sqlx::query("DELETE FROM player_login_codes WHERE expires_at < now()")
        .execute(pool)
        .await;

    Ok(RedeemedCode {
        player_account_id: row.0,
        tenant_id: row.1,
        site_host: row.2,
        steam_id: row.3,
    })
}

/// Create a tenant-scoped player session; returns the raw refresh token (shown once).
#[allow(clippy::too_many_arguments)]
pub async fn create_session(
    pool: &PgPool,
    player_id: Uuid,
    tenant_id: Uuid,
    site_host: &str,
    user_agent: Option<&str>,
    ip: Option<&str>,
    ttl_secs: i64,
    pepper: &[u8],
) -> Result<(Uuid, String), AppError> {
    let refresh_token = cupboard_crypto::random_token();
    let hash = cupboard_crypto::hash_token(&refresh_token, pepper);
    let expires_at = Utc::now() + Duration::seconds(ttl_secs);
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO player_sessions \
             (player_account_id, tenant_id, site_host, refresh_token_hash, user_agent, ip, \
              expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
    )
    .bind(player_id)
    .bind(tenant_id)
    .bind(site_host)
    .bind(hash)
    .bind(user_agent)
    .bind(ip)
    .bind(expires_at)
    .fetch_one(pool)
    .await?;
    Ok((id, refresh_token))
}

/// A valid player session resolved from a refresh token.
pub struct PlayerSession {
    pub id: Uuid,
    pub player_account_id: Uuid,
    pub tenant_id: Uuid,
    pub steam_id: Option<String>,
}

/// Look up a live (unexpired, unrevoked) player session by refresh token, joined to the
/// account and its Steam identity (for re-minting an access token).
pub async fn find_session_by_token(
    pool: &PgPool,
    refresh_token: &str,
    pepper: &[u8],
) -> Result<Option<PlayerSession>, AppError> {
    let hash = cupboard_crypto::hash_token(refresh_token, pepper);
    // Touch last_used_at and return the live session joined to its (earliest-linked)
    // Steam identity. Deterministic ORDER BY so a multi-identity account is stable.
    let row = sqlx::query_as::<_, (Uuid, Uuid, Uuid, Option<String>)>(
        "UPDATE player_sessions s SET last_used_at = now() \
         WHERE s.refresh_token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() \
         RETURNING s.id, s.player_account_id, s.tenant_id, \
                (SELECT subject FROM player_identities \
                   WHERE player_account_id = s.player_account_id AND provider = 'steam' \
                   ORDER BY linked_at ASC LIMIT 1)",
    )
    .bind(&hash)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| PlayerSession {
        id: r.0,
        player_account_id: r.1,
        tenant_id: r.2,
        steam_id: r.3,
    }))
}

/// Revoke a player session by its refresh token (logout). Idempotent.
pub async fn revoke_session(
    pool: &PgPool,
    refresh_token: &str,
    pepper: &[u8],
) -> Result<(), AppError> {
    let hash = cupboard_crypto::hash_token(refresh_token, pepper);
    sqlx::query(
        "UPDATE player_sessions SET revoked_at = now() \
         WHERE refresh_token_hash = $1 AND revoked_at IS NULL",
    )
    .bind(&hash)
    .execute(pool)
    .await?;
    Ok(())
}
