//! Provider webhook receiver. Lives on the tenant service directly (not the gateway):
//! signatures HMAC the raw body byte-for-byte, so a re-serializing proxy would break
//! them; there is no JWT here; and providers need a stable URL. Reached over the public
//! `cupboard-hooks` IngressRoute at `/webhooks/{provider}/{connection_id}`.
//!
//! Flow: load the connection + its (envelope-encrypted) signing secret by id, verify the
//! signature, then dedupe + apply the entitlement delta in one transaction. A verified
//! event always returns 2xx (even a duplicate) so the provider stops retrying; only a
//! bad signature or an unconfigured webhook is rejected.

use crate::domain::{entitlements, store};
use crate::error::AppError;
use crate::providers::paynow;
use crate::providers::ProviderKind;
use crate::state::AppState;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use uuid::Uuid;

/// POST /webhooks/{provider}/{connection_id}
pub async fn receive(
    State(state): State<AppState>,
    Path((provider, connection_id)): Path<(String, Uuid)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, AppError> {
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

    // The webhook signing secret must have been registered (runner step); without it we
    // cannot authenticate the event, so reject rather than trust it.
    let (Some(enc), Some(dek)) = (
        conn.webhook_secret_enc.clone(),
        conn.webhook_secret_dek.clone(),
    ) else {
        return Err(AppError::Unavailable(
            "webhook not yet registered for this connection".into(),
        ));
    };
    let secret = String::from_utf8(
        cupboard_crypto::open(
            &master_key,
            &cupboard_crypto::Envelope {
                wrapped_dek: dek,
                ciphertext: enc,
            },
        )
        .map_err(|e| AppError::Internal(anyhow::Error::new(e)))?,
    )
    .map_err(|_| AppError::Internal(anyhow::anyhow!("webhook secret is not UTF-8")))?;

    match kind {
        ProviderKind::PayNow => receive_paynow(&state, &conn, &secret, &headers, &body).await,
        ProviderKind::Tebex => Err(AppError::NotFound("tebex webhooks land in PR6".into())),
    }
}

async fn receive_paynow(
    state: &AppState,
    conn: &store::StoreConnection,
    secret: &str,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<StatusCode, AppError> {
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
    // 2xx whether newly processed or a dedup'd replay, so the provider stops retrying.
    Ok(StatusCode::OK)
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|h| h.to_str().ok())
}
