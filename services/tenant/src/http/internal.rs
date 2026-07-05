//! Cross-service internal endpoints (X-Internal-Token guarded, not exposed via the
//! gateway). The auth service calls `resolve_sites` during the Steam login callback to
//! authoritatively map a storefront host to its owning tenant, so a login code can only
//! ever be issued for a real registered storefront (never an attacker-supplied host).

use crate::domain::sites;
use crate::error::AppError;
use crate::http::public::normalize_and_classify;
use crate::state::AppState;
use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::Json;
use cupboard_crypto::constant_time_eq;
use serde::Deserialize;
use serde_json::json;

const INTERNAL_TOKEN_HEADER: &str = "x-internal-token";

/// Fail closed: the endpoint is disabled (503) unless a token is configured, and rejects
/// (401) any request whose token does not match.
fn check_internal_token(state: &AppState, headers: &HeaderMap) -> Result<(), AppError> {
    let expected = state
        .config
        .internal_api_token
        .as_deref()
        .ok_or_else(|| AppError::Unavailable("internal API disabled".into()))?;
    let presented = headers
        .get(INTERNAL_TOKEN_HEADER)
        .and_then(|h| h.to_str().ok())
        .unwrap_or_default();
    if constant_time_eq(presented.as_bytes(), expected.as_bytes()) {
        Ok(())
    } else {
        Err(AppError::Unauthorized("invalid internal token".into()))
    }
}

#[derive(Deserialize)]
pub struct ResolveQuery {
    pub host: String,
}

/// GET /internal/sites/resolve?host=: authoritative host -> tenant mapping. 404 when the
/// host is not a real storefront. No cache, no miss budget (this is a low-volume
/// service-to-service call on the login path, and must not silently 404 under a public
/// flood the way `/public/*` may).
pub async fn resolve_site(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ResolveQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    check_internal_token(&state, &headers)?;

    let resolved = match normalize_and_classify(&query.host, &state.config.sites_suffix) {
        Some(sites::SiteLocator::DefaultSubdomain(slug)) => {
            sites::resolve_by_slug(&state.owner_pool, &slug).await?
        }
        // Custom domains land in PR5.
        Some(sites::SiteLocator::Custom) | None => None,
    };
    match resolved {
        Some(site) => Ok(Json(json!({
            "tenant_id": site.tenant_id,
            "slug": site.slug,
        }))),
        None => Err(AppError::NotFound("no storefront for this host".into())),
    }
}
