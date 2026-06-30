//! Operator/user accounts. Global rows (no tenant), so all access is on the owner pool.

use crate::error::AppError;
use sqlx::PgPool;
use uuid::Uuid;

/// A user row, limited to the columns the service reads. (`email_verified`/timestamps
/// exist in the table but aren't needed in code yet.)
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct User {
    pub id: Uuid,
    pub email: Option<String>,
    pub password_hash: Option<String>,
    pub display_name: String,
    pub status: String,
}

const SELECT_COLS: &str = "id, email, password_hash, display_name, status";

/// Look up a user by email (case-insensitive via the `citext` column).
pub async fn find_by_email(pool: &PgPool, email: &str) -> Result<Option<User>, AppError> {
    let sql = format!("SELECT {SELECT_COLS} FROM users WHERE email = $1");
    Ok(sqlx::query_as::<_, User>(&sql)
        .bind(email.trim())
        .fetch_optional(pool)
        .await?)
}

/// Look up a user by id.
pub async fn find_by_id(pool: &PgPool, id: Uuid) -> Result<Option<User>, AppError> {
    let sql = format!("SELECT {SELECT_COLS} FROM users WHERE id = $1");
    Ok(sqlx::query_as::<_, User>(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await?)
}

/// Create an email+password user. Returns [`AppError::Conflict`] if the email is taken.
pub async fn create_with_password(
    pool: &PgPool,
    email: &str,
    display_name: &str,
    password_hash: &str,
) -> Result<User, AppError> {
    let sql = format!(
        "INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, $3) \
         RETURNING {SELECT_COLS}"
    );
    sqlx::query_as::<_, User>(&sql)
        .bind(email.trim())
        .bind(display_name.trim())
        .bind(password_hash)
        .fetch_one(pool)
        .await
        .map_err(|e| match e {
            sqlx::Error::Database(db) if db.is_unique_violation() => {
                AppError::Conflict("an account with that email already exists".into())
            }
            other => other.into(),
        })
}

/// Create a user from an external (Discord) identity — no password. `email` may be
/// `None`.
pub async fn create_from_external(
    pool: &PgPool,
    email: Option<&str>,
    display_name: &str,
) -> Result<User, AppError> {
    let sql =
        format!("INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING {SELECT_COLS}");
    sqlx::query_as::<_, User>(&sql)
        .bind(email.map(str::trim))
        .bind(display_name.trim())
        .fetch_one(pool)
        .await
        .map_err(|e| match e {
            sqlx::Error::Database(db) if db.is_unique_violation() => {
                AppError::Conflict("an account with that email already exists".into())
            }
            other => other.into(),
        })
}

/// Resolve the Cupboard user for a Discord login: return the already-linked account;
/// else, if the Discord email matches an existing account, link Discord to it; else
/// create a fresh account and link it. Owner pool (global tables).
pub async fn find_or_create_by_discord(
    pool: &PgPool,
    discord_id: &str,
    email: Option<&str>,
    display_name: &str,
) -> Result<User, AppError> {
    // 1. Already linked?
    let linked: Option<Uuid> = sqlx::query_scalar(
        "SELECT user_id FROM user_identities WHERE provider = 'discord' AND provider_user_id = $1",
    )
    .bind(discord_id)
    .fetch_optional(pool)
    .await?;
    if let Some(user_id) = linked {
        if let Some(user) = find_by_id(pool, user_id).await? {
            return Ok(user);
        }
    }

    // 2. Link to an existing account with the same email.
    if let Some(email) = email {
        if let Some(user) = find_by_email(pool, email).await? {
            link_discord(pool, user.id, discord_id).await?;
            return Ok(user);
        }
    }

    // 3. Brand-new account.
    let user = create_from_external(pool, email, display_name).await?;
    link_discord(pool, user.id, discord_id).await?;
    Ok(user)
}

async fn link_discord(pool: &PgPool, user_id: Uuid, discord_id: &str) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO user_identities (user_id, provider, provider_user_id) \
         VALUES ($1, 'discord', $2) ON CONFLICT (provider, provider_user_id) DO NOTHING",
    )
    .bind(user_id)
    .bind(discord_id)
    .execute(pool)
    .await?;
    Ok(())
}
