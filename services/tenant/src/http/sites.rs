//! Operator site management. All routes require `sites.edit` (the site is a single
//! operator-managed surface; there is no separate read-only site permission).

use crate::domain::sites;
use crate::error::AppError;
use crate::http::AuthClaims;
use crate::state::AppState;
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use cupboard_domain::{Permission, TenantId};
use serde::Deserialize;
use serde_json::json;

fn default_theme() -> String {
    "ember".to_string()
}

#[derive(Deserialize)]
pub struct CreateSiteRequest {
    pub slug: String,
    #[serde(default = "default_theme")]
    pub theme_id: String,
    #[serde(default)]
    pub config: Option<serde_json::Value>,
}

#[derive(Deserialize, Default)]
pub struct UpdateSiteRequest {
    #[serde(default)]
    pub slug: Option<String>,
    #[serde(default)]
    pub theme_id: Option<String>,
    #[serde(default)]
    pub config: Option<serde_json::Value>,
    #[serde(default)]
    pub published: Option<bool>,
}

/// The org's site (or `{"site": null}` before one is created), plus the default host the
/// admin UI links to.
pub async fn get_site(
    State(state): State<AppState>,
    claims: AuthClaims,
) -> Result<Json<serde_json::Value>, AppError> {
    let org = claims.require(Permission::SitesEdit)?;
    let site = sites::get_for_tenant(&state.app_pool, TenantId::from(org)).await?;
    Ok(Json(site_payload(&state, site)))
}

pub async fn create(
    State(state): State<AppState>,
    claims: AuthClaims,
    Json(req): Json<CreateSiteRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), AppError> {
    let org = claims.require(Permission::SitesEdit)?;

    let slug = req.slug.trim().to_ascii_lowercase();
    sites::validate_slug(&slug)?;
    sites::validate_theme(&req.theme_id)?;
    let config = req.config.unwrap_or_else(|| json!({}));
    sites::validate_config(&config)?;

    let site = sites::create(
        &state.app_pool,
        TenantId::from(org),
        Some(claims.0.sub.0),
        sites::NewSite {
            slug,
            theme_id: req.theme_id,
            config,
        },
    )
    .await?;

    state
        .cache
        .invalidate(&[crate::cache::CacheKey::SiteHost(sites::default_host(
            &site.slug,
            &state.config.sites_suffix,
        ))])
        .await;
    Ok((StatusCode::CREATED, Json(site_payload(&state, Some(site)))))
}

pub async fn update(
    State(state): State<AppState>,
    claims: AuthClaims,
    Json(req): Json<UpdateSiteRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let org = claims.require(Permission::SitesEdit)?;

    let slug = match req.slug {
        Some(raw) => {
            let slug = raw.trim().to_ascii_lowercase();
            sites::validate_slug(&slug)?;
            Some(slug)
        }
        None => None,
    };
    if let Some(theme_id) = &req.theme_id {
        sites::validate_theme(theme_id)?;
    }
    if let Some(config) = &req.config {
        sites::validate_config(config)?;
    }

    // Capture the pre-update slug so a rename invalidates the old host too.
    let previous = sites::get_for_tenant(&state.app_pool, TenantId::from(org)).await?;

    let site = sites::update(
        &state.app_pool,
        TenantId::from(org),
        Some(claims.0.sub.0),
        sites::SiteUpdate {
            slug,
            theme_id: req.theme_id,
            config: req.config,
            published: req.published,
        },
    )
    .await?
    .ok_or_else(|| AppError::NotFound("this organization has no site yet".into()))?;

    let mut keys = vec![crate::cache::CacheKey::SiteHost(sites::default_host(
        &site.slug,
        &state.config.sites_suffix,
    ))];
    if let Some(prev) = previous {
        if prev.slug != site.slug {
            keys.push(crate::cache::CacheKey::SiteHost(sites::default_host(
                &prev.slug,
                &state.config.sites_suffix,
            )));
        }
    }
    state.cache.invalidate(&keys).await;
    Ok(Json(site_payload(&state, Some(site))))
}

fn site_payload(state: &AppState, site: Option<sites::Site>) -> serde_json::Value {
    match site {
        Some(site) => {
            let host = sites::default_host(&site.slug, &state.config.sites_suffix);
            json!({ "site": site, "default_host": host })
        }
        None => json!({ "site": null, "default_host": null }),
    }
}
