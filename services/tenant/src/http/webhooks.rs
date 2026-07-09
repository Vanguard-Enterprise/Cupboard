//! Provider webhook receiver. Lives on the tenant service directly (not the gateway):
//! signatures HMAC the raw body byte-for-byte, so a re-serializing proxy would break
//! them; there is no JWT here; and providers need a stable URL. Reached over the public
//! `cupboard-hooks` IngressRoute at `/webhooks/{provider}/{connection_id}`.
//!
//! Flow: load the connection + its (envelope-encrypted) signing secret by id, verify the
//! signature, then dedupe + apply the entitlement delta in one transaction. A verified
//! event always returns 2xx (even a duplicate) so the provider stops retrying; only a
//! bad signature or an unconfigured webhook is rejected. Tebex additionally requires the
//! `validation.webhook` handshake to echo the event id back.

use crate::domain::{entitlements, store};
use crate::error::AppError;
use crate::providers::ProviderKind;
use crate::providers::{paynow, tebex};
use crate::state::AppState;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;
use uuid::Uuid;

/// POST /webhooks/{provider}/{connection_id}
pub async fn receive(
    State(state): State<AppState>,
    Path((provider, connection_id)): Path<(String, Uuid)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, AppError> {
    let kind = provider
        .parse::<ProviderKind>()
        .map_err(|_| AppError::NotFound("unknown provider".into()))?;

    let master_key = state
        .config
        .tenant_master_key
        .ok_or_else(|| AppError::Unavailable("store integration is not configured".into()))?;

    let conn = store::load_fresh(&state.owner_pool, connection_id)
        .await?
        .ok_or_else(|| AppError::NotFound("unknown connection".into()))?;
    if conn.provider != kind.as_str() {
        return Err(AppError::NotFound("provider mismatch".into()));
    }
    // A disconnected store must stop affecting the ledger even if the provider still has
    // the webhook registered (disconnect also shreds the secret, so this is belt-and-
    // braces). Return 404 rather than 200 so the operator's intent is honored.
    if conn.status != "connected" {
        return Err(AppError::NotFound("store is not connected".into()));
    }

    // The webhook signing secret must be present (PayNow: registered by the runner; Tebex:
    // pasted by the operator). Without it we cannot authenticate the event, so reject.
    let (Some(enc), Some(dek)) = (
        conn.webhook_secret_enc.clone(),
        conn.webhook_secret_dek.clone(),
    ) else {
        return Err(AppError::Unavailable(
            "webhook not yet configured for this connection".into(),
        ));
    };
    let secret = store::unseal_utf8(&master_key, &enc, &dek)?;

    match kind {
        ProviderKind::PayNow => receive_paynow(&state, &conn, &secret, &headers, &body).await,
        ProviderKind::Tebex => receive_tebex(&state, &conn, &secret, &headers, &body).await,
    }
}

async fn receive_paynow(
    state: &AppState,
    conn: &store::StoreConnection,
    secret: &str,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<Response, AppError> {
    let sig = header(headers, "paynow-signature");
    let ts = header(headers, "paynow-timestamp");
    let (Some(sig), Some(ts)) = (sig, ts) else {
        return Err(AppError::BadRequest("missing signature headers".into()));
    };

    let parsed = paynow::verify_and_parse_webhook(secret, sig, ts, body, chrono::Utc::now())
        .map_err(|e| match e {
            paynow::WebhookError::BadSignature | paynow::WebhookError::StaleTimestamp => {
                tracing::warn!(connection = %conn.id, error = %e, "rejected webhook");
                AppError::Unauthorized("webhook verification failed".into())
            }
            paynow::WebhookError::Malformed(m) => AppError::BadRequest(m.into()),
        })?;

    ingest(state, conn, &parsed, body).await?;
    // 2xx whether newly processed or a dedup'd replay, so the provider stops retrying.
    Ok(StatusCode::OK.into_response())
}

async fn receive_tebex(
    state: &AppState,
    conn: &store::StoreConnection,
    secret: &str,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<Response, AppError> {
    let sig = header(headers, "x-signature")
        .ok_or_else(|| AppError::BadRequest("missing signature header".into()))?;

    let parsed = tebex::verify_and_parse_webhook(secret, sig, body).map_err(|e| match e {
        tebex::WebhookError::BadSignature => {
            tracing::warn!(connection = %conn.id, "rejected tebex webhook: bad signature");
            AppError::Unauthorized("webhook verification failed".into())
        }
        tebex::WebhookError::Malformed(m) => AppError::BadRequest(m.into()),
    })?;

    // The endpoint-validation handshake carries no entitlement; Tebex activates the
    // endpoint only when we echo the id back. Verified above, so answer it.
    if tebex::is_validation(&parsed.event_type) {
        tracing::info!(connection = %conn.id, "tebex webhook validated");
        return Ok(Json(json!({ "id": parsed.event_id })).into_response());
    }

    ingest(state, conn, &parsed, body).await?;
    Ok(StatusCode::OK.into_response())
}

/// Dedupe + apply the entitlement delta for a verified event (shared by both providers).
async fn ingest(
    state: &AppState,
    conn: &store::StoreConnection,
    parsed: &crate::providers::NormalizedWebhook,
    body: &Bytes,
) -> Result<(), AppError> {
    let payload: serde_json::Value =
        serde_json::from_slice(body).unwrap_or(serde_json::Value::Null);
    let newly = entitlements::ingest_webhook(
        &state.owner_pool,
        conn.tenant_id,
        conn.id,
        conn.provider.as_str(),
        &parsed.event_id,
        &parsed.event_type,
        &payload,
        &parsed.entitlements,
    )
    .await?;
    tracing::info!(
        connection = %conn.id,
        event = %parsed.event_id,
        event_type = %parsed.event_type,
        newly,
        entitlements = parsed.entitlements.len(),
        "webhook processed"
    );
    Ok(())
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|h| h.to_str().ok())
}
