//! Operator store management. All routes require `store.manage`. The API key is
//! write-only: accepted here, sealed under TENANT_MASTER_KEY, never returned by any
//! endpoint. The connect probe is the single place a provider is called on a request
//! path (one attempt, short timeout).

use crate::domain::store;
use crate::error::AppError;
use crate::http::AuthClaims;
use crate::providers::paynow::PayNowClient;
use crate::providers::{ProviderError, ProviderKind, StoreProvider};
use crate::state::AppState;
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use cupboard_domain::{Permission, TenantId};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
pub struct ConnectRequest {
    pub provider: String,
    pub api_key: String,
    /// Required when the key can reach more than one store.
    #[serde(default)]
    pub store_id: Option<String>,
}

/// GET /store: the connection view (never the key) or `{"connection": null}`.
pub async fn get_store(
    State(state): State<AppState>,
    claims: AuthClaims,
) -> Result<Json<serde_json::Value>, AppError> {
    let org = claims.require(Permission::StoreManage)?;
    let view = store::connection_view(&state.app_pool, TenantId::from(org)).await?;
    Ok(Json(json!({ "connection": view })))
}

/// POST /store/connection: probe-before-store (BM connect discipline). Only a
/// successful probe persists anything.
pub async fn connect(
    State(state): State<AppState>,
    claims: AuthClaims,
    Json(req): Json<ConnectRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), AppError> {
    let org = claims.require(Permission::StoreManage)?;
    let Some(master_key) = state.config.tenant_master_key else {
        return Err(AppError::Unavailable(
            "store integration is not configured on this deployment".into(),
        ));
    };

    let provider = req
        .provider
        .trim()
        .parse::<ProviderKind>()
        .map_err(|_| AppError::BadRequest(format!("unknown provider \"{}\"", req.provider)))?;
    if provider == ProviderKind::Tebex {
        return Err(AppError::BadRequest(
            "Tebex support is coming later in Phase 5; connect a PayNow store for now".into(),
        ));
    }
    let api_key = req.api_key.trim().to_string();
    if api_key.is_empty() {
        return Err(AppError::BadRequest("api_key is required".into()));
    }
    let store_id = req
        .store_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let mut client = PayNowClient::new(state.config.paynow_api_base.clone(), &api_key, store_id);
    let info = match client.probe().await {
        Ok(info) => info,
        Err(ProviderError::Auth(e)) => {
            return Err(AppError::BadRequest(format!(
                "the provider rejected this API key: {e}"
            )))
        }
        Err(ProviderError::Rejected(e)) => return Err(AppError::BadRequest(e)),
        Err(ProviderError::Transient(e)) => {
            return Err(AppError::Unavailable(format!(
                "could not reach the provider: {e}"
            )))
        }
    };

    let sealed = cupboard_crypto::seal(&master_key, api_key.as_bytes())
        .map_err(|e| AppError::Internal(anyhow::Error::new(e)))?;
    store::upsert_connection(
        &state.app_pool,
        TenantId::from(org),
        Some(claims.0.sub.0),
        store::NewConnection {
            provider: provider.as_str().to_string(),
            api_key_enc: sealed.ciphertext,
            api_key_dek: sealed.wrapped_dek,
            info,
        },
    )
    .await?;

    // A reconnect can change the store identity (or revive an errored connection
    // whose catalog was cache-hidden); drop the cached catalog eagerly.
    state
        .cache
        .invalidate(&[crate::cache::CacheKey::Catalog(org.0)])
        .await;

    let view = store::connection_view(&state.app_pool, TenantId::from(org)).await?;
    Ok((StatusCode::CREATED, Json(json!({ "connection": view }))))
}

/// DELETE /store/connection: shred the credential, keep history; the storefront's
/// store pages hide immediately (public reads require status='connected').
pub async fn disconnect(
    State(state): State<AppState>,
    claims: AuthClaims,
) -> Result<StatusCode, AppError> {
    let org = claims.require(Permission::StoreManage)?;
    if store::disconnect(&state.app_pool, TenantId::from(org), Some(claims.0.sub.0)).await? {
        // The catalog stops serving with the status change, not a row sweep.
        state
            .cache
            .invalidate(&[crate::cache::CacheKey::Catalog(org.0)])
            .await;
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::NotFound("no store connection".into()))
    }
}

/// POST /store/sync: pull the next catalog sync forward to now.
pub async fn sync_now(
    State(state): State<AppState>,
    claims: AuthClaims,
) -> Result<Json<serde_json::Value>, AppError> {
    let org = claims.require(Permission::StoreManage)?;
    if store::request_sync(&state.app_pool, TenantId::from(org)).await? {
        Ok(Json(json!({ "ok": true })))
    } else {
        Err(AppError::BadRequest(
            "no connected store to sync (connect one, or fix its error first)".into(),
        ))
    }
}

/// GET /store/products: the admin catalog table.
pub async fn list_products(
    State(state): State<AppState>,
    claims: AuthClaims,
) -> Result<Json<serde_json::Value>, AppError> {
    let org = claims.require(Permission::StoreManage)?;
    let products = store::list_products_admin(&state.app_pool, TenantId::from(org)).await?;
    Ok(Json(json!({ "products": products })))
}

/// GET /store/entitlements: recent entitlements for the admin dashboard.
pub async fn list_entitlements(
    State(state): State<AppState>,
    claims: AuthClaims,
) -> Result<Json<serde_json::Value>, AppError> {
    let org = claims.require(Permission::StoreManage)?;
    let list =
        crate::domain::entitlements::list_admin(&state.app_pool, TenantId::from(org), 200).await?;
    Ok(Json(json!({ "entitlements": list })))
}
