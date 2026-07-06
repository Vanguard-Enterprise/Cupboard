//! Custom-domain records + the state-machine DB layer the domain loop drives. Operator
//! CRUD runs on the app pool (RLS); the loop claims and transitions rows on the owner
//! pool. Resolution (host -> site) is a cross-tenant owner-pool read.

use crate::error::AppError;
use chrono::{DateTime, Duration, Utc};
use cupboard_domain::TenantId;
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

/// Max custom domains per tenant (LE issuance is rate-limited; keep the surface small).
pub const MAX_DOMAINS_PER_TENANT: i64 = 5;

const DOMAIN_COLS: &str = "id, tenant_id, site_id, domain, status, cert_secret_name, \
     ingressroute_name, last_checked_at, last_error, attempt_count, next_check_at, \
     created_at, updated_at";

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SiteDomain {
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub site_id: Uuid,
    pub domain: String,
    pub status: String,
    pub cert_secret_name: Option<String>,
    pub ingressroute_name: Option<String>,
    pub last_checked_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub attempt_count: i32,
    pub next_check_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Operator-facing view (drops the k8s resource names + lease internals).
#[derive(Debug, Serialize)]
pub struct DomainView {
    pub id: Uuid,
    pub domain: String,
    pub status: String,
    pub last_error: Option<String>,
    pub last_checked_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

impl From<SiteDomain> for DomainView {
    fn from(d: SiteDomain) -> Self {
        DomainView {
            id: d.id,
            domain: d.domain,
            status: d.status,
            last_error: d.last_error,
            last_checked_at: d.last_checked_at,
            created_at: d.created_at,
        }
    }
}

/// Backoff for the retry states. Escalates, then caps (manual retry resets attempts).
pub fn backoff(attempt: i32) -> Duration {
    match attempt {
        0 | 1 => Duration::minutes(1),
        2 => Duration::minutes(5),
        3 => Duration::minutes(30),
        4 => Duration::hours(2),
        _ => Duration::hours(12),
    }
}

/// Validate a tenant-supplied custom domain: hostname shape, length, and that it is not
/// under our own platform sites suffix (which is served by the wildcard, not per-domain).
pub fn validate_domain(domain: &str, sites_suffix: &str) -> Result<String, AppError> {
    let d = domain.trim().trim_end_matches('.').to_ascii_lowercase();
    if d.is_empty() || d.len() > 253 {
        return Err(AppError::BadRequest("invalid domain".into()));
    }
    // Must be a plausible multi-label DNS name (at least one dot), ASCII/punycode only.
    let labels: Vec<&str> = d.split('.').collect();
    if labels.len() < 2 || labels.iter().any(|l| l.is_empty() || l.len() > 63) {
        return Err(AppError::BadRequest(
            "enter a full domain, e.g. store.yourcommunity.gg".into(),
        ));
    }
    let ok_chars = d
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.');
    if !ok_chars {
        return Err(AppError::BadRequest(
            "domain may contain only letters, digits, hyphens, and dots (punycode for IDNs)".into(),
        ));
    }
    if d == sites_suffix || d.ends_with(&format!(".{sites_suffix}")) {
        return Err(AppError::BadRequest(
            "that is a Cupboard-managed hostname; add your own external domain instead".into(),
        ));
    }
    Ok(d)
}

fn map_unique(e: sqlx::Error) -> AppError {
    if let sqlx::Error::Database(db) = &e {
        if db.constraint() == Some("site_domains_domain_unique") {
            return AppError::Conflict("that domain is already connected".into());
        }
    }
    e.into()
}

// ============================ Operator CRUD (app pool) ============================

/// Add a custom domain to the tenant's site. Enforces the per-tenant cap and requires a
/// site to exist.
pub async fn add_domain(
    app_pool: &PgPool,
    tenant: TenantId,
    domain: &str,
) -> Result<SiteDomain, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let site_id: Option<Uuid> = sqlx::query_scalar("SELECT id FROM sites WHERE tenant_id = $1")
        .bind(tenant.0)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(site_id) = site_id else {
        tx.rollback().await?;
        return Err(AppError::BadRequest(
            "create your site before adding a custom domain".into(),
        ));
    };
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM site_domains WHERE tenant_id = $1 AND status <> 'disabled'",
    )
    .bind(tenant.0)
    .fetch_one(&mut *tx)
    .await?;
    if count >= MAX_DOMAINS_PER_TENANT {
        tx.rollback().await?;
        return Err(AppError::BadRequest(format!(
            "you can connect at most {MAX_DOMAINS_PER_TENANT} custom domains"
        )));
    }
    let row = sqlx::query_as::<_, SiteDomain>(&format!(
        "INSERT INTO site_domains (tenant_id, site_id, domain) VALUES ($1, $2, $3) \
         RETURNING {DOMAIN_COLS}"
    ))
    .bind(tenant.0)
    .bind(site_id)
    .bind(domain)
    .fetch_one(&mut *tx)
    .await
    .map_err(map_unique)?;
    tx.commit().await?;
    Ok(row)
}

pub async fn list_domains(
    app_pool: &PgPool,
    tenant: TenantId,
) -> Result<Vec<DomainView>, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let rows = sqlx::query_as::<_, SiteDomain>(&format!(
        "SELECT {DOMAIN_COLS} FROM site_domains \
         WHERE tenant_id = $1 AND status <> 'disabled' ORDER BY created_at"
    ))
    .bind(tenant.0)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(rows.into_iter().map(DomainView::from).collect())
}

/// Mark a domain disabled and due immediately; the loop tears down its CRs and deletes
/// the row.
pub async fn remove_domain(
    app_pool: &PgPool,
    tenant: TenantId,
    id: Uuid,
) -> Result<bool, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let res = sqlx::query(
        "UPDATE site_domains SET status = 'disabled', next_check_at = now(), updated_at = now() \
         WHERE tenant_id = $1 AND id = $2 AND status <> 'disabled'",
    )
    .bind(tenant.0)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(res.rows_affected() == 1)
}

/// Reset a failed domain for a manual retry (attempts back to 0, due now).
pub async fn retry_domain(app_pool: &PgPool, tenant: TenantId, id: Uuid) -> Result<bool, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let res = sqlx::query(
        "UPDATE site_domains SET status = 'pending_dns', attempt_count = 0, \
             last_error = NULL, next_check_at = now(), updated_at = now() \
         WHERE tenant_id = $1 AND id = $2 \
           AND status IN ('failed_dns', 'failed_issuance')",
    )
    .bind(tenant.0)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(res.rows_affected() == 1)
}

// ============================ Loop (owner pool) ============================

/// Claim due domains by leasing them (push next_check_at forward) so a slow DNS/kube
/// step does not hold a row lock, and concurrent replicas do not double-process.
pub async fn claim_due(
    owner_pool: &PgPool,
    limit: i64,
    lease_secs: i64,
) -> Result<Vec<SiteDomain>, AppError> {
    let rows = sqlx::query_as::<_, SiteDomain>(&format!(
        "UPDATE site_domains SET next_check_at = now() + make_interval(secs => $2) \
         WHERE id IN ( \
             SELECT id FROM site_domains WHERE next_check_at <= now() \
             ORDER BY next_check_at LIMIT $1 FOR UPDATE SKIP LOCKED \
         ) RETURNING {DOMAIN_COLS}"
    ))
    .bind(limit)
    .bind(lease_secs as f64)
    .fetch_all(owner_pool)
    .await?;
    Ok(rows)
}

/// Record a state transition: status + optional error + attempt count + when to look
/// again. `last_checked_at` is stamped now.
pub async fn transition(
    owner_pool: &PgPool,
    id: Uuid,
    status: &str,
    last_error: Option<&str>,
    attempt_count: i32,
    next_check_in: Duration,
) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE site_domains SET status = $2, last_error = $3, attempt_count = $4, \
             last_checked_at = now(), next_check_at = now() + $5, updated_at = now() \
         WHERE id = $1",
    )
    .bind(id)
    .bind(status)
    .bind(last_error)
    .bind(attempt_count)
    .bind(next_check_in)
    .execute(owner_pool)
    .await?;
    Ok(())
}

/// Persist the k8s resource names once the loop derives them.
pub async fn set_resource_names(
    owner_pool: &PgPool,
    id: Uuid,
    cert_secret_name: &str,
    ingressroute_name: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE site_domains SET cert_secret_name = $2, ingressroute_name = $3, \
             updated_at = now() WHERE id = $1",
    )
    .bind(id)
    .bind(cert_secret_name)
    .bind(ingressroute_name)
    .execute(owner_pool)
    .await?;
    Ok(())
}

/// Delete a domain row (after its CRs are torn down).
pub async fn delete_row(owner_pool: &PgPool, id: Uuid) -> Result<(), AppError> {
    sqlx::query("DELETE FROM site_domains WHERE id = $1")
        .bind(id)
        .execute(owner_pool)
        .await?;
    Ok(())
}

/// Resolve an active custom domain to its owning site (cross-tenant owner-pool read).
pub async fn resolve_by_domain(
    owner_pool: &PgPool,
    domain: &str,
) -> Result<Option<crate::domain::sites::ResolvedSite>, AppError> {
    Ok(sqlx::query_as::<_, crate::domain::sites::ResolvedSite>(
        "SELECT s.id AS site_id, s.tenant_id, s.slug, s.theme_id, s.config, s.published \
         FROM site_domains d JOIN sites s ON s.id = d.site_id \
         WHERE d.domain = $1 AND d.status = 'active'",
    )
    .bind(domain)
    .fetch_optional(owner_pool)
    .await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_domain_rules() {
        assert_eq!(
            validate_domain("Store.Community.GG", "sites.vngenterprise.com").unwrap(),
            "store.community.gg"
        );
        assert!(validate_domain("nodot", "sites.test").is_err());
        assert!(validate_domain("bad_underscore.com", "sites.test").is_err());
        assert!(validate_domain("", "sites.test").is_err());
        // Our own suffix is rejected (served by the wildcard).
        assert!(validate_domain("acme.sites.test", "sites.test").is_err());
        assert!(validate_domain("sites.test", "sites.test").is_err());
    }

    #[test]
    fn backoff_escalates_and_caps() {
        assert_eq!(backoff(1), Duration::minutes(1));
        assert_eq!(backoff(3), Duration::minutes(30));
        assert_eq!(backoff(99), Duration::hours(12));
    }
}
