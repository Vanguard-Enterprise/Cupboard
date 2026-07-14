//! Operator custom-domain management (part of the site surface; requires `sites.edit`).
//! The heavy lifting (DNS verification, cert issuance) is done asynchronously by the
//! domain loop; these endpoints just record intent and report status.

use crate::domain::domains;
use crate::error::AppError;
use crate::http::AuthClaims;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use cupboard_domain::{Permission, Plan, TenantId};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

#[derive(Deserialize)]
pub struct AddDomainRequest {
    pub domain: String,
}

/// GET /sites/domains: the tenant's custom domains + the CNAME target to point them at.
pub async fn list(
    State(state): State<AppState>,
    claims: AuthClaims,
) -> Result<Json<serde_json::Value>, AppError> {
    let org = claims.require(Permission::SitesEdit)?;
    let list = domains::list_domains(&state.app_pool, TenantId::from(org)).await?;
    Ok(Json(json!({
        "domains": list,
        // Operators point their DNS (CNAME/A) at this edge target.
        "edge_target": state.config.edge_hostname,
    })))
}

/// POST /sites/domains: connect a custom domain (starts the DNS-verify -> issue flow).
/// The per-tenant cap comes from the caller's plan claim (Phase 6 decision H); an
/// absent/unknown plan gates as free.
pub async fn add(
    State(state): State<AppState>,
    claims: AuthClaims,
    Json(req): Json<AddDomainRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), AppError> {
    let org = claims.require(Permission::SitesEdit)?;
    let domain = domains::validate_domain(&req.domain, &state.config.sites_suffix)?;
    let cap = Plan::from_claim(claims.0.plan.as_deref())
        .limits()
        .max_custom_domains;
    let row = domains::add_domain(&state.app_pool, TenantId::from(org), &domain, cap).await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "domain": domains::DomainView::from(row) })),
    ))
}

/// DELETE /sites/domains/{id}: disconnect a custom domain (the loop tears down its certs).
pub async fn remove(
    State(state): State<AppState>,
    claims: AuthClaims,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, AppError> {
    let org = claims.require(Permission::SitesEdit)?;
    match domains::remove_domain(&state.app_pool, TenantId::from(org), id).await? {
        Some(domain) => {
            // Stop resolving the host at once rather than waiting for the positive cache
            // entry to lapse (the loop also invalidates when it tears down the CRs).
            let _ = state
                .cache
                .invalidate(&[crate::cache::CacheKey::SiteHost(domain)])
                .await;
            Ok(StatusCode::NO_CONTENT)
        }
        None => Err(AppError::NotFound("no such domain".into())),
    }
}

/// POST /sites/domains/{id}/retry: reset a failed domain to retry verification/issuance.
pub async fn retry(
    State(state): State<AppState>,
    claims: AuthClaims,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, AppError> {
    let org = claims.require(Permission::SitesEdit)?;
    if domains::retry_domain(&state.app_pool, TenantId::from(org), id).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::BadRequest(
            "only a failed domain can be retried".into(),
        ))
    }
}
