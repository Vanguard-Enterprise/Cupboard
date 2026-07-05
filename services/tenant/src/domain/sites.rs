//! Sites: one white-label public site per organization (v1), addressed by a globally
//! unique slug under the platform sites suffix (`{slug}.{SITES_SUFFIX}`) and, later
//! (Phase 5 PR5), by verified custom domains.

use crate::error::AppError;
use chrono::{DateTime, Utc};
use cupboard_domain::TenantId;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

/// Hostname labels that can never be tenant slugs: either they collide with real or
/// plausible platform hosts, or they invite impersonation of platform surfaces.
pub const RESERVED_SLUGS: &[&str] = &[
    "admin",
    "api",
    "app",
    "assets",
    "auth",
    "billing",
    "cdn",
    "cupboard",
    "dashboard",
    "dev",
    "docs",
    "edge",
    "help",
    "hooks",
    "login",
    "mail",
    "ns1",
    "ns2",
    "sites",
    "staging",
    "static",
    "status",
    "store",
    "support",
    "test",
    "www",
];

/// Themes the service accepts. Mirrored by the web theme registry
/// (`apps/web/src/themes/registry.ts`); extend both together.
pub const ALLOWED_THEMES: &[&str] = &["ember"];

/// Site config JSONB size ceiling. The config is operator-supplied free-form JSON
/// (validated structurally by the web editor); the service only bounds it.
const MAX_CONFIG_BYTES: usize = 32 * 1024;

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct Site {
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub slug: String,
    pub theme_id: String,
    pub config: serde_json::Value,
    pub published: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// What the public storefront needs to render a host: the payload of
/// `GET /public/sites/resolve` and the value stored in the Redis cache.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct ResolvedSite {
    pub site_id: Uuid,
    pub tenant_id: Uuid,
    pub slug: String,
    pub theme_id: String,
    pub config: serde_json::Value,
    pub published: bool,
}

pub struct NewSite {
    pub slug: String,
    pub theme_id: String,
    pub config: serde_json::Value,
}

#[derive(Default)]
pub struct SiteUpdate {
    pub slug: Option<String>,
    pub theme_id: Option<String>,
    pub config: Option<serde_json::Value>,
    pub published: Option<bool>,
}

/// Validate a tenant-supplied slug: shape (also enforced by the DB CHECK) plus the
/// reserved list (app-level so it can evolve without a migration).
pub fn validate_slug(slug: &str) -> Result<(), AppError> {
    let ok_shape = slug.len() >= 3
        && slug.len() <= 40
        && slug.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && slug.ends_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !ok_shape {
        return Err(AppError::BadRequest(
            "slug must be 3-40 chars of lowercase letters, digits, and hyphens, starting and \
             ending with a letter or digit"
                .into(),
        ));
    }
    if RESERVED_SLUGS.contains(&slug) {
        return Err(AppError::BadRequest(format!("slug \"{slug}\" is reserved")));
    }
    Ok(())
}

pub fn validate_theme(theme_id: &str) -> Result<(), AppError> {
    if ALLOWED_THEMES.contains(&theme_id) {
        Ok(())
    } else {
        Err(AppError::BadRequest(format!(
            "unknown theme \"{theme_id}\""
        )))
    }
}

pub fn validate_config(config: &serde_json::Value) -> Result<(), AppError> {
    if !config.is_object() {
        return Err(AppError::BadRequest("config must be a JSON object".into()));
    }
    // Cheap length bound on the serialized form; the editor enforces structure.
    let serialized = serde_json::to_string(config)
        .map_err(|e| AppError::BadRequest(format!("config is not serializable: {e}")))?;
    if serialized.len() > MAX_CONFIG_BYTES {
        return Err(AppError::BadRequest(format!(
            "config too large ({} bytes; max {MAX_CONFIG_BYTES})",
            serialized.len()
        )));
    }
    Ok(())
}

/// The default hostname a site serves on.
pub fn default_host(slug: &str, sites_suffix: &str) -> String {
    format!("{slug}.{sites_suffix}")
}

/// Map unique-constraint violations onto operator-actionable conflicts.
fn map_unique_violation(e: sqlx::Error) -> AppError {
    if let sqlx::Error::Database(db) = &e {
        match db.constraint() {
            Some("sites_slug_unique") => {
                return AppError::Conflict("that slug is already taken".into())
            }
            Some("sites_tenant_unique") => {
                return AppError::Conflict(
                    "this organization already has a site; edit it instead".into(),
                )
            }
            _ => {}
        }
    }
    e.into()
}

/// The org's site, if it has one. RLS scopes the app pool already; the explicit filter is
/// defense in depth.
pub async fn get_for_tenant(app_pool: &PgPool, tenant: TenantId) -> Result<Option<Site>, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let site = sqlx::query_as::<_, Site>(
        "SELECT id, tenant_id, slug, theme_id, config, published, created_at, updated_at \
         FROM sites WHERE tenant_id = $1",
    )
    .bind(tenant.0)
    .fetch_optional(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(site)
}

pub async fn create(
    app_pool: &PgPool,
    tenant: TenantId,
    actor: Option<Uuid>,
    new: NewSite,
) -> Result<Site, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let site = sqlx::query_as::<_, Site>(
        "INSERT INTO sites (tenant_id, slug, theme_id, config) \
         VALUES ($1, $2, $3, $4) \
         RETURNING id, tenant_id, slug, theme_id, config, published, created_at, updated_at",
    )
    .bind(tenant.0)
    .bind(&new.slug)
    .bind(&new.theme_id)
    .bind(&new.config)
    .fetch_one(&mut *tx)
    .await
    .map_err(map_unique_violation)?;

    crate::domain::audit::record_in_tx(
        &mut tx,
        tenant.0,
        actor,
        "sites.create",
        Some("site"),
        Some(site.id),
        Some(serde_json::json!({ "slug": site.slug, "theme_id": site.theme_id })),
    )
    .await?;
    tx.commit().await?;
    Ok(site)
}

pub async fn update(
    app_pool: &PgPool,
    tenant: TenantId,
    actor: Option<Uuid>,
    update: SiteUpdate,
) -> Result<Option<Site>, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let site = sqlx::query_as::<_, Site>(
        "UPDATE sites SET \
             slug       = COALESCE($2, slug), \
             theme_id   = COALESCE($3, theme_id), \
             config     = COALESCE($4, config), \
             published  = COALESCE($5, published), \
             updated_at = now() \
         WHERE tenant_id = $1 \
         RETURNING id, tenant_id, slug, theme_id, config, published, created_at, updated_at",
    )
    .bind(tenant.0)
    .bind(update.slug.as_deref())
    .bind(update.theme_id.as_deref())
    .bind(update.config.as_ref())
    .bind(update.published)
    .fetch_optional(&mut *tx)
    .await
    .map_err(map_unique_violation)?;

    let Some(site) = site else {
        tx.rollback().await?;
        return Ok(None);
    };
    crate::domain::audit::record_in_tx(
        &mut tx,
        tenant.0,
        actor,
        "sites.update",
        Some("site"),
        Some(site.id),
        Some(serde_json::json!({
            "slug": site.slug,
            "theme_id": site.theme_id,
            "published": site.published,
        })),
    )
    .await?;
    tx.commit().await?;
    Ok(Some(site))
}

/// Cross-tenant public read for hostname resolution — owner pool by design: there is no
/// tenant context until the host is resolved (this is what *establishes* it). Read-only.
pub async fn resolve_by_slug(
    owner_pool: &PgPool,
    slug: &str,
) -> Result<Option<ResolvedSite>, AppError> {
    Ok(sqlx::query_as::<_, ResolvedSite>(
        "SELECT id AS site_id, tenant_id, slug, theme_id, config, published \
         FROM sites WHERE slug = $1",
    )
    .bind(slug)
    .fetch_optional(owner_pool)
    .await?)
}
