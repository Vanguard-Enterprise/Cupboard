//! Provider webhook receivers. Live on the tenant service directly (not the gateway):
//! signatures HMAC the raw body byte-for-byte, so a re-serializing proxy would break
//! them; there is no JWT here; and providers need a stable URL. Reached over the public
//! `cupboard-hooks` IngressRoute at `/webhooks/{provider}/{connection_id}` (per-tenant
//! store providers) and `/webhooks/stripe` (single-merchant platform billing, Phase 6
//! decision H: same host, no new ingress).
//!
//! Flow: load the connection + its (envelope-encrypted) signing secret by id, verify the
//! signature, then dedupe + apply the entitlement delta in one transaction. A verified
//! event always returns 2xx (even a duplicate) so the provider stops retrying; only a
//! bad signature or an unconfigured webhook is rejected. Tebex additionally requires the
//! `validation.webhook` handshake to echo the event id back.

use crate::domain::{billing, entitlements, store};
use crate::error::AppError;
use crate::providers::ProviderKind;
use crate::providers::{paynow, tebex};
use crate::state::AppState;
use crate::stripe::{self, StripeClient};
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

// ============================ Stripe (platform billing) ============================

/// What a verified Stripe event asks us to do. Classification happens BEFORE the dedupe
/// transaction and carries ALL outbound work (owner-pool lookups AND the Stripe
/// retrieve): the transaction must never hold a pool connection across a network call,
/// or a webhook burst during Stripe latency starves the owner pool.
enum StripeAction {
    /// `checkout.session.completed` (mode=subscription): the subscription was already
    /// retrieved during classification; applying also clears the org's pending
    /// checkout-session record IF it still names this session (a newer checkout may
    /// already have replaced it).
    UpsertFromCheckout {
        org: Uuid,
        state: billing::SubscriptionState,
        session_id: Option<String>,
    },
    /// `customer.subscription.updated` / `.deleted`: the event carries the subscription.
    Upsert {
        org: Uuid,
        state: billing::SubscriptionState,
    },
    /// `invoice.payment_failed`: flip the org's row to past_due ahead of the matching
    /// subscription.updated (grace resolution decides gating).
    PastDue { org: Uuid },
    /// Everything else (and anything unattributable): dedupe-record + 2xx.
    RecordOnly { org: Option<Uuid> },
}

impl StripeAction {
    fn org(&self) -> Option<Uuid> {
        match self {
            StripeAction::UpsertFromCheckout { org, .. }
            | StripeAction::Upsert { org, .. }
            | StripeAction::PastDue { org } => Some(*org),
            StripeAction::RecordOnly { org } => *org,
        }
    }
}

/// POST /webhooks/stripe. Verify the `Stripe-Signature` (HMAC over `"{t}.{raw_body}"`,
/// 5-minute skew), then dedupe on the global `event.id` and apply in ONE owner-pool
/// transaction (the `entitlements::ingest_webhook` flow). A replay rolls back and still
/// answers 2xx; bad signature or stale timestamp is a 400 (Stripe's recommended reject).
/// After a subscription change commits, the resolved plan is mirrored to auth
/// (best-effort; the reconcile re-push heals losses).
pub async fn receive_stripe(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, AppError> {
    let secret = state
        .config
        .stripe_webhook_secret
        .as_deref()
        .ok_or_else(|| AppError::Unavailable("billing webhooks are not configured".into()))?;
    let sig = header(&headers, "stripe-signature")
        .ok_or_else(|| AppError::BadRequest("missing Stripe-Signature header".into()))?;
    stripe::verify_signature(secret, sig, &body, chrono::Utc::now()).map_err(|e| {
        tracing::warn!(error = %e, "rejected stripe webhook");
        AppError::BadRequest("webhook verification failed".into())
    })?;

    let doc: serde_json::Value = serde_json::from_slice(&body)
        .map_err(|_| AppError::BadRequest("malformed webhook body".into()))?;
    let event_id = doc
        .get("id")
        .and_then(|i| i.as_str())
        .ok_or_else(|| AppError::BadRequest("event has no id".into()))?
        .to_string();
    let event_type = doc
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .to_string();
    let object = doc
        .pointer("/data/object")
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    let action = classify_stripe_event(&state, &event_type, &object).await?;
    let org = action.org();

    // Dedupe + apply in the SAME transaction on the owner pool.
    let mut tx = state.owner_pool.begin().await?;
    let new = billing::begin_event_in_tx(&mut tx, &event_id, &event_type, org, &doc).await?;
    if !new {
        tx.rollback().await?;
        tracing::info!(event = %event_id, "replayed stripe event; no-op");
        return Ok(StatusCode::OK.into_response());
    }
    let subscription_touched = apply_stripe_action(&mut tx, action).await?;
    billing::finish_event_in_tx(&mut tx, &event_id).await?;
    tx.commit().await?;
    tracing::info!(event = %event_id, event_type = %event_type, "stripe webhook processed");

    // Mirror push AFTER commit (decision K): best-effort, retry-nothing.
    if subscription_touched {
        if let Some(org) = org {
            stripe::resolve_and_push_mirror(&state.owner_pool, &state.http, &state.config, org)
                .await;
        }
    }
    Ok(StatusCode::OK.into_response())
}

/// Map a verified event to an action (slice 1: subscription lifecycle only).
async fn classify_stripe_event(
    state: &AppState,
    event_type: &str,
    object: &serde_json::Value,
) -> Result<StripeAction, AppError> {
    match event_type {
        "checkout.session.completed" => {
            // Slice-2 seam: mode=payment sessions (one-off services) will land a
            // billing_purchases row here; until then they are dedupe-recorded only.
            if object.get("mode").and_then(|m| m.as_str()) != Some("subscription") {
                return Ok(StripeAction::RecordOnly { org: None });
            }
            let org = object
                .get("client_reference_id")
                .and_then(|c| c.as_str())
                .and_then(|s| s.parse::<Uuid>().ok());
            let subscription_id = object.get("subscription").and_then(stripe_ref_id);
            let (Some(org), Some(subscription_id)) = (org, subscription_id) else {
                tracing::warn!(
                    "checkout.session.completed without client_reference_id/subscription; recording only"
                );
                return Ok(StripeAction::RecordOnly { org });
            };
            // Retrieve the full subscription NOW, before the dedupe transaction opens
            // (never a network call inside an open tx). A replayed event pays this call
            // again and is then dropped by the dedupe: correct, just not free.
            let client = StripeClient::from_config(&state.http, &state.config)
                .ok_or_else(|| AppError::Unavailable("billing is not configured".into()))?;
            let sub = client
                .retrieve_subscription(&subscription_id)
                .await
                // 5xx so Stripe retries; nothing was recorded yet.
                .map_err(|e| AppError::Internal(anyhow::anyhow!("retrieve subscription: {e}")))?;
            let facts = stripe::subscription_facts(&sub).ok_or_else(|| {
                AppError::Internal(anyhow::anyhow!("unparseable subscription from retrieve"))
            })?;
            let mut sub_state = subscription_state(state, &facts, false);
            // The session's customer fills in when the retrieve returned none.
            sub_state.stripe_customer_id = sub_state
                .stripe_customer_id
                .or_else(|| object.get("customer").and_then(stripe_ref_id));
            Ok(StripeAction::UpsertFromCheckout {
                org,
                state: sub_state,
                session_id: object.get("id").and_then(stripe_ref_id),
            })
        }
        "customer.subscription.updated" | "customer.subscription.deleted" => {
            let Some(facts) = stripe::subscription_facts(object) else {
                tracing::warn!(
                    event_type,
                    "unparseable subscription payload; recording only"
                );
                return Ok(StripeAction::RecordOnly { org: None });
            };
            let org = match facts.org_hint {
                Some(org) => Some(org),
                None => billing::find_tenant_by_subscription(&state.owner_pool, &facts.id).await?,
            };
            let Some(org) = org else {
                tracing::warn!(subscription = %facts.id, "stripe subscription for no known org; recording only");
                return Ok(StripeAction::RecordOnly { org: None });
            };
            let deleted = event_type == "customer.subscription.deleted";
            Ok(StripeAction::Upsert {
                org,
                state: subscription_state(state, &facts, deleted),
            })
        }
        "invoice.payment_failed" => {
            // The subscription reference sits at `subscription` (classic) or under
            // `parent.subscription_details.subscription` (2025 API shapes).
            let sub_id = object
                .get("subscription")
                .and_then(stripe_ref_id)
                .or_else(|| {
                    object
                        .pointer("/parent/subscription_details/subscription")
                        .and_then(stripe_ref_id)
                });
            let org = match &sub_id {
                Some(id) => billing::find_tenant_by_subscription(&state.owner_pool, id).await?,
                None => None,
            };
            match org {
                Some(org) => Ok(StripeAction::PastDue { org }),
                None => Ok(StripeAction::RecordOnly { org: None }),
            }
        }
        _ => Ok(StripeAction::RecordOnly { org: None }),
    }
}

/// Apply an action inside the dedupe transaction (pure DB work; every network call
/// already happened during classification). Returns whether an org's subscription state
/// was touched (drives the post-commit mirror push).
async fn apply_stripe_action(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    action: StripeAction,
) -> Result<bool, AppError> {
    match action {
        StripeAction::UpsertFromCheckout {
            org,
            state: sub,
            session_id,
        } => {
            billing::upsert_subscription_in_tx(tx, org, &sub, Some(Uuid::nil()), "webhook").await?;
            // The session this event completes is no longer pending (double-charge
            // guard). Session-id-conditional: completing an OLD session must not wipe
            // the record of a newer pending checkout.
            if let Some(sid) = session_id {
                billing::clear_pending_checkout_in_tx(tx, org, &sid).await?;
            }
            Ok(true)
        }
        StripeAction::Upsert { org, state: sub } => {
            billing::upsert_subscription_in_tx(tx, org, &sub, Some(Uuid::nil()), "webhook").await?;
            Ok(true)
        }
        StripeAction::PastDue { org } => {
            billing::mark_past_due_in_tx(tx, org).await?;
            Ok(true)
        }
        StripeAction::RecordOnly { .. } => Ok(false),
    }
}

/// Build the row state from parsed facts. An unmappable price id passes `plan: None`;
/// the upsert preserves prior plan knowledge for the same subscription (or floors to
/// free when there is none) and does the loud logging.
fn subscription_state(
    state: &AppState,
    facts: &stripe::SubscriptionFacts,
    deleted: bool,
) -> billing::SubscriptionState {
    billing::SubscriptionState {
        stripe_customer_id: facts.customer.clone(),
        stripe_subscription_id: facts.id.clone(),
        plan: facts
            .price_id
            .as_deref()
            .and_then(|p| stripe::plan_for_price(&state.config, p)),
        status: if deleted {
            "canceled"
        } else {
            billing::normalize_status(&facts.status)
        },
        current_period_end: facts.current_period_end,
    }
}

/// An expandable Stripe reference on an event object: bare id string or object with `id`.
fn stripe_ref_id(v: &serde_json::Value) -> Option<String> {
    if let Some(s) = v.as_str() {
        return Some(s.to_string());
    }
    v.get("id").and_then(|i| i.as_str()).map(str::to_string)
}
