//! Unauthenticated storefront reads. `/public/sites/resolve` is the first hop of every
//! public SSR request (host -> site), so it is cache-first and never performs provider
//! or cross-service I/O.

use crate::cache::CacheLookup;
use crate::domain::sites;
use crate::error::AppError;
use crate::state::AppState;
use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;

#[derive(Deserialize)]
pub struct ResolveQuery {
    pub host: String,
}

/// How a request host maps onto the sites model.
enum HostKind {
    /// `{slug}.{SITES_SUFFIX}` — the default hostname every site gets.
    DefaultSubdomain(String),
    /// Anything else — a (future) custom domain. PR5 wires `site_domains` and gives this
    /// variant the domain payload; until then these resolve to nothing.
    Custom,
}

/// Normalize an incoming host: lowercase, strip any port and trailing dot, and reject
/// anything that is not a plausible DNS name (this is an internet-tainted value — the
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

fn classify(host: &str, sites_suffix: &str) -> HostKind {
    match host
        .strip_suffix(sites_suffix)
        .and_then(|p| p.strip_suffix('.'))
    {
        // Exactly one label in front of the suffix — deeper subdomains are not sites.
        Some(label) if !label.is_empty() && !label.contains('.') => {
            HostKind::DefaultSubdomain(label.to_string())
        }
        _ => HostKind::Custom,
    }
}

pub async fn resolve(
    State(state): State<AppState>,
    Query(query): Query<ResolveQuery>,
) -> Result<Json<sites::ResolvedSite>, AppError> {
    let host =
        normalize_host(&query.host).ok_or_else(|| AppError::BadRequest("invalid host".into()))?;

    if let CacheLookup::Hit(cached) = state.cache.get(&host).await {
        return cached
            .map(Json)
            .ok_or_else(|| AppError::NotFound("no site for this host".into()));
    }

    let resolved = match classify(&host, &state.config.sites_suffix) {
        HostKind::DefaultSubdomain(slug) => {
            sites::resolve_by_slug(&state.owner_pool, &slug).await?
        }
        // Custom domains land in PR5 (`site_domains` lookup). Unknown hosts are still
        // negative-cached below so junk traffic cannot become per-request DB load.
        HostKind::Custom => None,
    };

    state.cache.put(&host, &resolved).await;
    resolved
        .map(Json)
        .ok_or_else(|| AppError::NotFound("no site for this host".into()))
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
    fn classify_extracts_single_label_slugs_only() {
        let suffix = "sites.example.com";
        assert!(matches!(
            classify("acme.sites.example.com", suffix),
            HostKind::DefaultSubdomain(s) if s == "acme"
        ));
        // Deeper labels, the bare suffix, and unrelated hosts are all "custom".
        assert!(matches!(
            classify("a.b.sites.example.com", suffix),
            HostKind::Custom
        ));
        assert!(matches!(
            classify("sites.example.com", suffix),
            HostKind::Custom
        ));
        assert!(matches!(
            classify("store.some-community.gg", suffix),
            HostKind::Custom
        ));
        // A host merely *ending* in the suffix string without a dot boundary must not
        // match (e.g. "evilsites.example.com" vs suffix "sites.example.com").
        assert!(matches!(
            classify("evilsites.example.com", suffix),
            HostKind::Custom
        ));
    }
}
