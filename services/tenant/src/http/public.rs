//! Unauthenticated storefront reads. `/public/sites/resolve` is the first hop of every
//! public SSR request (host -> site), so it is cache-first and never performs provider
//! or cross-service I/O.
//!
//! Flood posture: per-host negative caching is useless against a *distinct-host* flood
//! (each junk host is a fresh miss), so the cache-miss database path sits behind a
//! per-pod token bucket. Under a flood, cache hits keep serving normally and excess
//! misses become 404s instead of Postgres load.

use crate::cache::{CacheKey, CacheLookup};
use crate::domain::{sites, store};
use crate::error::AppError;
use crate::state::AppState;
use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use std::sync::Mutex;
use std::time::Instant;

/// Token bucket over the miss->database path. Sized well above legitimate traffic:
/// steady-state misses are new/expired hosts only (hits are served from Redis), so
/// tens per second sustained is already anomalous.
const MISS_BUCKET_CAPACITY: f64 = 50.0;
const MISS_REFILL_PER_SEC: f64 = 20.0;

pub struct MissBudget {
    state: Mutex<(f64, Instant)>,
}

impl Default for MissBudget {
    fn default() -> Self {
        Self {
            state: Mutex::new((MISS_BUCKET_CAPACITY, Instant::now())),
        }
    }
}

impl MissBudget {
    /// Take one token if available. Never blocks.
    pub fn try_take(&self) -> bool {
        let mut guard = self.state.lock().expect("miss-budget lock poisoned");
        let (ref mut tokens, ref mut last) = *guard;
        let now = Instant::now();
        *tokens = (*tokens + now.duration_since(*last).as_secs_f64() * MISS_REFILL_PER_SEC)
            .min(MISS_BUCKET_CAPACITY);
        *last = now;
        if *tokens >= 1.0 {
            *tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

#[derive(Deserialize)]
pub struct ResolveQuery {
    pub host: String,
}

use crate::domain::sites::SiteLocator;

/// Normalize an incoming host: lowercase, strip any port and trailing dot, and reject
/// anything that is not a plausible DNS name (this is an internet-tainted value; the
/// web middleware forwards whatever `Host` header the client sent).
fn normalize_host(raw: &str) -> Option<String> {
    let raw = raw.trim().to_ascii_lowercase();
    let host = raw.split(':').next()?.trim_end_matches('.');
    if host.is_empty() || host.len() > 253 {
        return None;
    }
    let plausible = host
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.');
    if !plausible {
        return None;
    }
    Some(host.to_string())
}

fn classify(host: &str, sites_suffix: &str) -> SiteLocator {
    match host
        .strip_suffix(sites_suffix)
        .and_then(|p| p.strip_suffix('.'))
    {
        // Exactly one label in front of the suffix; deeper subdomains are not sites.
        Some(label) if !label.is_empty() && !label.contains('.') => {
            SiteLocator::DefaultSubdomain(label.to_string())
        }
        _ => SiteLocator::Custom,
    }
}

/// Normalize + classify in one step, returning `None` for hosts that fail normalization.
/// Shared with the internal resolve endpoint.
pub fn normalize_and_classify(raw_host: &str, sites_suffix: &str) -> Option<SiteLocator> {
    normalize_host(raw_host).map(|h| classify(&h, sites_suffix))
}

/// Cache-first host resolution shared by the resolve and catalog endpoints.
async fn resolve_host(
    state: &AppState,
    raw_host: &str,
) -> Result<Option<sites::ResolvedSite>, AppError> {
    let host =
        normalize_host(raw_host).ok_or_else(|| AppError::BadRequest("invalid host".into()))?;
    let key = CacheKey::SiteHost(host.clone());

    if let CacheLookup::Hit(cached) = state.cache.get::<sites::ResolvedSite>(&key).await {
        return Ok(cached);
    }

    // Cache miss: the only path that can reach Postgres. Under a distinct-host flood
    // the bucket empties and excess misses 404 without touching the database.
    if !state.site_miss_budget.try_take() {
        tracing::warn!(
            host,
            "resolve miss budget exhausted; serving 404 without lookup"
        );
        return Ok(None);
    }

    let resolved = match classify(&host, &state.config.sites_suffix) {
        SiteLocator::DefaultSubdomain(slug) => {
            sites::resolve_by_slug(&state.owner_pool, &slug).await?
        }
        // A verified custom domain (active in `site_domains`) resolves to its site;
        // unknown hosts are negative-cached below so junk traffic is absorbed by Redis.
        SiteLocator::Custom => {
            crate::domain::domains::resolve_by_domain(&state.owner_pool, &host).await?
        }
    };

    state.cache.put(&key, &resolved).await;
    Ok(resolved)
}

pub async fn resolve(
    State(state): State<AppState>,
    Query(query): Query<ResolveQuery>,
) -> Result<Json<sites::ResolvedSite>, AppError> {
    resolve_host(&state, &query.host)
        .await?
        .map(Json)
        .ok_or_else(|| AppError::NotFound("no site for this host".into()))
}

/// GET /public/store/catalog?host=: the storefront's store pages. 404 when the host has
/// no site, the site disabled its store pages, or the tenant has no connected store.
pub async fn catalog(
    State(state): State<AppState>,
    Query(query): Query<ResolveQuery>,
) -> Result<Json<store::PublicCatalog>, AppError> {
    let not_found = || AppError::NotFound("no store for this host".into());
    let site = resolve_host(&state, &query.host)
        .await?
        .ok_or_else(not_found)?;
    if site.config.get("store_enabled").and_then(|v| v.as_bool()) == Some(false) {
        return Err(not_found());
    }

    let key = CacheKey::Catalog(site.tenant_id);
    if let CacheLookup::Hit(cached) = state.cache.get::<store::PublicCatalog>(&key).await {
        return cached.map(Json).ok_or_else(not_found);
    }
    if !state.catalog_miss_budget.try_take() {
        tracing::warn!(tenant = %site.tenant_id, "catalog miss budget exhausted; serving 404");
        return Err(not_found());
    }

    let catalog = store::public_catalog(&state.owner_pool, site.tenant_id).await?;
    state.cache.put(&key, &catalog).await;
    catalog.map(Json).ok_or_else(not_found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_strips_port_case_and_trailing_dot() {
        assert_eq!(
            normalize_host("My-Site.Sites.Example.COM:3000").as_deref(),
            Some("my-site.sites.example.com")
        );
        assert_eq!(
            normalize_host("host.example.com.").as_deref(),
            Some("host.example.com")
        );
    }

    #[test]
    fn normalize_rejects_junk() {
        assert!(normalize_host("").is_none());
        assert!(normalize_host(":3000").is_none());
        assert!(normalize_host("bad_host!.com").is_none());
        assert!(normalize_host(&"a".repeat(260)).is_none());
    }

    #[test]
    fn miss_budget_exhausts_at_capacity() {
        let budget = MissBudget::default();
        for _ in 0..50 {
            assert!(budget.try_take(), "bucket should hold its full capacity");
        }
        assert!(!budget.try_take(), "51st immediate take must be refused");
    }

    #[test]
    fn classify_extracts_single_label_slugs_only() {
        let suffix = "sites.example.com";
        assert!(matches!(
            classify("acme.sites.example.com", suffix),
            SiteLocator::DefaultSubdomain(s) if s == "acme"
        ));
        // Deeper labels, the bare suffix, and unrelated hosts are all "custom".
        assert!(matches!(
            classify("a.b.sites.example.com", suffix),
            SiteLocator::Custom
        ));
        assert!(matches!(
            classify("sites.example.com", suffix),
            SiteLocator::Custom
        ));
        assert!(matches!(
            classify("store.some-community.gg", suffix),
            SiteLocator::Custom
        ));
        // A host merely *ending* in the suffix string without a dot boundary must not
        // match (e.g. "evilsites.example.com" vs suffix "sites.example.com").
        assert!(matches!(
            classify("evilsites.example.com", suffix),
            SiteLocator::Custom
        ));
    }
}
