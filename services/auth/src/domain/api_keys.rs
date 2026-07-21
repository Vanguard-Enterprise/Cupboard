//! Public API keys (Phase 6 decisions L/M): org-scoped machine credentials whose
//! scopes are Permission wire strings capped to the creating operator, and whose
//! lifecycle is tied to that creator's membership at exchange time.
//!
//! Management (create/list/revoke) runs on the RLS-scoped app pool like every other
//! tenant surface. The exchange runs on the OWNER pool: it looks a presented token up
//! by keyed hash across all orgs (cross-org by design; the gateway does not know the
//! org yet) and mints a short-lived operator JWT. The raw token is write-only: it is
//! returned exactly once at creation and never logged or stored.

use crate::domain::{plans, rbac};
use crate::error::AppError;
use chrono::{DateTime, Utc};
use cupboard_auth_core::{Claims, Keys};
use cupboard_domain::{OrgId, Plan, TenantId, UserId};
use sqlx::PgPool;
use uuid::Uuid;

/// The prefix every raw API key token starts with (before the 256-bit base64url body).
const TOKEN_PREFIX: &str = "cb_";
/// Stored/listed identification prefix: the first characters of the raw token.
const DISPLAY_PREFIX_LEN: usize = 8;
/// Exchange-minted JWTs are deliberately short-lived (decision M): revocation and
/// membership-lifecycle latency is bounded by this, NOT the config access-token TTL.
pub const EXCHANGE_TOKEN_TTL_SECS: i64 = 300;

/// An API key row as exposed to the management surface. Never contains the raw token
/// or its hash.
#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct ApiKey {
    pub id: Uuid,
    pub name: String,
    pub token_prefix: String,
    pub scopes: Vec<String>,
    pub created_by: Uuid,
    pub created_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub last_used_at: Option<DateTime<Utc>>,
}

const SELECT_COLS: &str = "id, name, token_prefix, scopes, created_by, created_at, \
     expires_at, revoked_at, last_used_at";

/// A freshly-created key plus the raw token to hand to the client once.
pub struct NewApiKey {
    pub key: ApiKey,
    pub token: String,
}

/// Create a key. `scopes` must already be validated/capped by the caller (the HTTP
/// layer owns the no-escalation check against the creator's resolved permissions).
/// `plan` drives the per-plan live-key cap (decision N / Resolved with Frank #1).
/// RLS-scoped to `tenant`.
#[allow(clippy::too_many_arguments)]
pub async fn create_key(
    app_pool: &PgPool,
    tenant: TenantId,
    name: &str,
    scopes: &[String],
    created_by: Uuid,
    expires_at: Option<DateTime<Utc>>,
    plan: Plan,
    pepper: &[u8],
) -> Result<NewApiKey, AppError> {
    let token = format!("{TOKEN_PREFIX}{}", cupboard_crypto::random_token());
    let hash = cupboard_crypto::hash_token(&token, pepper);
    let token_prefix = &token[..DISPLAY_PREFIX_LEN];
    let id = Uuid::now_v7();

    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    // Serialize concurrent creates for this tenant so the count-then-insert cap cannot
    // be raced (the tenant-service domain cap precedent). Seed 1, not 0: the shared
    // database means seed-0 would share a lock keyspace with that domain cap and
    // needlessly serialize unrelated operations on the same tenant.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 1))")
        .bind(tenant.0)
        .execute(&mut *tx)
        .await?;
    // Live = neither revoked nor expired; revoking a key frees its cap slot. The
    // explicit organization_id predicate is defense in depth (the domain-cap
    // precedent): RLS already scopes this on the app pool, but on an owner-role
    // fallback (unset DATABASE_URL_APP in dev/tests) a bare count would be global.
    let live: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM api_keys \
         WHERE organization_id = $1 \
           AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())",
    )
    .bind(tenant.0)
    .fetch_one(&mut *tx)
    .await?;
    let cap = plan.limits().max_api_keys;
    if live >= i64::from(cap) {
        return Err(AppError::Conflict(format!(
            "the {plan} plan allows {cap} active API key(s); revoke one or upgrade your plan"
        )));
    }
    let sql = format!(
        "INSERT INTO api_keys \
         (id, organization_id, name, token_prefix, key_hash, scopes, created_by, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING {SELECT_COLS}"
    );
    let key = sqlx::query_as::<_, ApiKey>(&sql)
        .bind(id)
        .bind(tenant.0)
        .bind(name)
        .bind(token_prefix)
        .bind(hash)
        .bind(scopes)
        .bind(created_by)
        .bind(expires_at)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(NewApiKey { key, token })
}

/// List the org's keys, newest first (uuidv7 ids order by creation time).
pub async fn list_keys(app_pool: &PgPool, tenant: TenantId) -> Result<Vec<ApiKey>, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let sql = format!("SELECT {SELECT_COLS} FROM api_keys ORDER BY id DESC");
    let keys = sqlx::query_as::<_, ApiKey>(&sql)
        .fetch_all(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(keys)
}

/// Revoke a key. Idempotent (re-revoking is a no-op success); `NotFound` when the key
/// is not visible to `tenant` (RLS hides other orgs' keys).
pub async fn revoke_key(app_pool: &PgPool, tenant: TenantId, id: Uuid) -> Result<(), AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let found: Option<Uuid> = sqlx::query_scalar(
        "UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now()) \
         WHERE id = $1 RETURNING id",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    tx.commit().await?;
    match found {
        Some(_) => Ok(()),
        None => Err(AppError::NotFound("API key not found".into())),
    }
}

/// The columns the exchange verification path needs (owner pool, cross-org).
#[derive(Debug, sqlx::FromRow)]
struct ExchangeRow {
    id: Uuid,
    organization_id: Uuid,
    scopes: Vec<String>,
    created_by: Uuid,
    expires_at: Option<DateTime<Utc>>,
    revoked_at: Option<DateTime<Utc>>,
}

/// Exchange a presented raw token for a short-lived operator JWT (decision M).
///
/// Every refusal ("no such key", "revoked"/"expired", "creator removed") returns the
/// same generic 401 body. Response latency is NOT uniform: the creator-membership
/// branch runs extra queries after the cheap early-outs (which garbage floods never
/// get past), an accepted low-value side channel since distinguishing the reasons
/// requires already holding the specific token. The minted claims carry the key id as
/// both `sub` and `sid`, and `perms` is the intersection of the key's scopes with the
/// creator's CURRENT resolved permissions: a demoted creator means a shrunk key, a
/// removed creator means a dead key. An empty intersection still mints (a zero-perm
/// principal is valid; every permission gate downstream will refuse it anyway).
pub async fn exchange(
    owner_pool: &PgPool,
    keys: &Keys,
    pepper: &[u8],
    presented: &str,
) -> Result<String, AppError> {
    let invalid = || AppError::Unauthorized("invalid API key".into());

    let hash = cupboard_crypto::hash_token(presented, pepper);
    let row = sqlx::query_as::<_, ExchangeRow>(
        "SELECT id, organization_id, scopes, created_by, expires_at, revoked_at \
         FROM api_keys WHERE key_hash = $1",
    )
    .bind(hash)
    .fetch_optional(owner_pool)
    .await?
    .ok_or_else(invalid)?;

    if row.revoked_at.is_some() || row.expires_at.is_some_and(|t| t <= Utc::now()) {
        return Err(invalid());
    }

    // Membership-lifecycle check: no active membership for the creator means the key
    // dies with them, no matter what the stored scopes say.
    let current = rbac::resolve_permissions(owner_pool, row.created_by, row.organization_id)
        .await?
        .ok_or_else(invalid)?;
    let effective: Vec<String> = row
        .scopes
        .into_iter()
        .filter(|s| current.contains(s))
        .collect();

    // Best-effort usage stamp; a failure must not block the exchange.
    if let Err(e) = sqlx::query("UPDATE api_keys SET last_used_at = now() WHERE id = $1")
        .bind(row.id)
        .execute(owner_pool)
        .await
    {
        tracing::warn!(error = %e, api_key_id = %row.id, "failed to stamp api key last_used_at");
    }

    // Built directly rather than via sessions::mint_access_token: `sub` is the key id,
    // not a user id, and `sid` correlates back to the key. `plan` comes from the
    // org_plans mirror (None = free, same rule as every operator mint).
    let plan = plans::plan_claim(owner_pool, row.organization_id).await?;
    let mut claims = Claims::new(
        UserId(row.id),
        row.id,
        Some(OrgId(row.organization_id)),
        effective,
        EXCHANGE_TOKEN_TTL_SECS,
    );
    claims.plan = plan;
    claims.kind = Some("api_key".into());
    Ok(keys.encode(&claims)?)
}
