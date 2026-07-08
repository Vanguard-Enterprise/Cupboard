//! Operator store management. All routes require `store.manage`. The API key is
//! write-only: accepted here, sealed under TENANT_MASTER_KEY, never returned by any
//! endpoint. The connect probe is the single place a provider is called on a request
//! path (one attempt, short timeout).

use crate::domain::store;
use crate::error::AppError;
use crate::http::AuthClaims;
use crate::providers::paynow::PayNowClient;
use crate::providers::tebex::TebexClient;
use crate::providers::{ProviderError, ProviderKind, StoreInfo, StoreProvider};
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
    /// The secret credential: PayNow API key, or the Tebex Game Server secret key.
    pub api_key: String,
    /// PayNow: optional, required only when the key reaches more than one store. Tebex:
    /// REQUIRED, the public/project token that identifies the store in Headless URLs.
    #[serde(default)]
    pub store_id: Option<String>,
}

#[derive(Deserialize)]
pub struct WebhookSecretRequest {
    pub secret: String,
}

/// GET /store: the connection view (never the key) or `{"connection": null}`. For Tebex,
/// fills the manual-registration `webhook_url` from `PUBLIC_WEBHOOK_BASE`.
pub async fn get_store(
    State(state): State<AppState>,
    claims: AuthClaims,
) -> Result<Json<serde_json::Value>, AppError> {
    let org = claims.require(Permission::StoreManage)?;
    let view = view_with_webhook(&state, TenantId::from(org)).await?;
    Ok(Json(json!({ "connection": view })))
}

/// Fetch the connection view and, for Tebex, fill the manual-registration `webhook_url`
/// from `PUBLIC_WEBHOOK_BASE`.
async fn view_with_webhook(
    state: &AppState,
    tenant: TenantId,
) -> Result<Option<store::ConnectionView>, AppError> {
    let mut view = store::connection_view(&state.app_pool, tenant).await?;
    if let Some(v) = view.as_mut() {
        if v.provider == ProviderKind::Tebex.as_str() {
            if let Some(base) = &state.config.public_webhook_base {
                v.webhook_url = Some(format!(
                    "{}/webhooks/{}/{}",
                    base.trim_end_matches('/'),
                    ProviderKind::Tebex.as_str(),
                    v.connection_id
                ));
            }
        }
    }
    Ok(view)
}

/// Map a connect-time probe failure to a caller-facing error (BM connect discipline: the
/// operator sees whether it was a bad key, a rejection, or an unreachable provider).
fn connect_probe_error(e: ProviderError) -> AppError {
    match e {
        ProviderError::Auth(e) => {
            AppError::BadRequest(format!("the provider rejected these credentials: {e}"))
        }
        ProviderError::Rejected(e) => AppError::BadRequest(e),
        ProviderError::Transient(e) => {
            AppError::Unavailable(format!("could not reach the provider: {e}"))
        }
    }
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
    let api_key = req.api_key.trim().to_string();
    if api_key.is_empty() {
        return Err(AppError::BadRequest("api_key is required".into()));
    }
    let store_id = req
        .store_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    // Probe the credential before persisting anything (BM connect discipline). Each
    // provider validates its own way; the sealed secret is always `api_key`.
    let info = match provider {
        ProviderKind::PayNow => {
            let mut client =
                PayNowClient::new(state.config.paynow_api_base.clone(), &api_key, store_id);
            client.probe().await.map_err(connect_probe_error)?
        }
        ProviderKind::Tebex => {
            let public_token = store_id.ok_or_else(|| {
                AppError::BadRequest("Tebex needs your store's public token".into())
            })?;
            let mut client = TebexClient::new(
                state.config.tebex_headless_base.clone(),
                state.config.tebex_plugin_base.clone(),
                &api_key,
                &public_token,
            );
            client.probe().await.map_err(connect_probe_error)?
        }
    };
    let info: StoreInfo = info;

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

    let view = view_with_webhook(&state, TenantId::from(org)).await?;
    Ok((StatusCode::CREATED, Json(json!({ "connection": view }))))
}

/// POST /store/webhook-secret: save the operator-provided webhook signing secret. Tebex
/// webhooks are registered manually in the creator panel (no API), so the operator pastes
/// the secret Tebex shows them; it is sealed like the API key and never returned.
pub async fn set_webhook_secret(
    State(state): State<AppState>,
    claims: AuthClaims,
    Json(req): Json<WebhookSecretRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let org = claims.require(Permission::StoreManage)?;
    let Some(master_key) = state.config.tenant_master_key else {
        return Err(AppError::Unavailable(
            "store integration is not configured on this deployment".into(),
        ));
    };
    let secret = req.secret.trim();
    if secret.is_empty() {
        return Err(AppError::BadRequest(
            "the webhook secret is required".into(),
        ));
    }
    let sealed = cupboard_crypto::seal(&master_key, secret.as_bytes())
        .map_err(|e| AppError::Internal(anyhow::Error::new(e)))?;
    if store::set_webhook_secret(
        &state.app_pool,
        TenantId::from(org),
        &sealed.ciphertext,
        &sealed.wrapped_dek,
    )
    .await?
    {
        Ok(Json(json!({ "ok": true })))
    } else {
        Err(AppError::BadRequest(
            "connect a store before configuring its webhook".into(),
        ))
    }
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
