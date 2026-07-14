//! Operator billing surface (Phase 6 decision J): subscription read, Checkout handoff,
//! and Customer Portal handoff. All routes require `billing.manage`; the gateway proxies
//! `/billing/*` with require_auth and this service re-validates. Slice 1 is
//! subscriptions; the one-off services catalog/checkout lands in slice 2.
//!
//! Stripe truth flows back through the webhook + reconcile loop, never through the
//! return page: these handlers only read the local mirror and mint hosted-redirect URLs.

use crate::domain::billing;
use crate::error::AppError;
use crate::http::AuthClaims;
use crate::providers::ProviderError;
use crate::state::AppState;
use crate::stripe::StripeClient;
use axum::extract::State;
use axum::Json;
use cupboard_domain::{Permission, Plan, TenantId};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
pub struct CheckoutRequest {
    pub plan: String,
    pub return_url: String,
}

#[derive(Deserialize)]
pub struct PortalRequest {
    pub return_url: String,
}

/// GET /billing/subscription: the org's stored subscription + the resolved gating plan.
/// No row = the free tier (decision I).
pub async fn get_subscription(
    State(state): State<AppState>,
    claims: AuthClaims,
) -> Result<Json<serde_json::Value>, AppError> {
    let org = claims.require(Permission::BillingManage)?;
    let row = billing::get_subscription(&state.app_pool, TenantId::from(org)).await?;
    let effective = billing::effective_plan(row.as_ref(), chrono::Utc::now());
    Ok(Json(json!({
        "plan": row.as_ref().map(|r| r.plan.as_str()).unwrap_or("free"),
        "status": billing::mirror_status(row.as_ref()),
        "current_period_end": row.as_ref().and_then(|r| r.current_period_end)
            .map(|t| t.to_rfc3339()),
        "effective_plan": effective.as_str(),
    })))
}

/// POST /billing/checkout {plan, return_url} -> {redirect_url}: hand the operator off to
/// Stripe Checkout (subscription mode). Rejected when the org already has a live
/// subscription: plan changes and payment fixes go through the Portal.
///
/// Double-charge guard: Checkout Sessions live 24h, so two tabs (or an abandoned
/// session plus a retry) could otherwise BOTH complete. The whole operation runs on one
/// owner-pool transaction under the per-tenant advisory lock (the domains-cap
/// precedent): re-check the subscription row, expire the org's previous pending session
/// at Stripe, create the new one, record it as pending. Concurrent checkouts for one
/// tenant therefore serialize, and at most one session is live at a time. Checkout is a
/// rare operator action, so holding the tx across the (timeout-bounded) Stripe calls is
/// an accepted cost here, unlike on the webhook path.
pub async fn checkout(
    State(state): State<AppState>,
    claims: AuthClaims,
    Json(req): Json<CheckoutRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let org = claims.require(Permission::BillingManage)?;
    let client = require_stripe(&state)?;

    let plan = Plan::from_wire(&req.plan)
        .filter(|p| *p != Plan::Free)
        .ok_or_else(|| AppError::BadRequest("plan must be \"team\" or \"enterprise\"".into()))?;
    let price_id = match plan {
        Plan::Team => state.config.stripe_price_team.as_deref(),
        Plan::Enterprise => state.config.stripe_price_enterprise.as_deref(),
        Plan::Free => None,
    }
    .ok_or_else(|| AppError::Unavailable("that plan is not purchasable yet".into()))?;
    let return_url = validate_return_url(&req.return_url)?;
    let success_url = with_flag(&return_url, "checkout_success");
    let cancel_url = with_flag(&return_url, "checkout_cancel");

    let mut tx = state.owner_pool.begin().await?;
    // Serialize per tenant. Per-tenant advisory-lock seed registry (hashtextextended's
    // second argument, so unrelated flows never contend): 0 = tenant domains cap
    // (domain/domains.rs), 1 = auth API-key cap (services/auth), 2 = billing checkout
    // (here; held across two timeout-bounded Stripe calls, so it must not share the
    // domains seed).
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 2))")
        .bind(org.0)
        .execute(&mut *tx)
        .await?;
    let row = billing::get_subscription_in_tx(&mut tx, org.0).await?;
    if let Some(r) = &row {
        if r.stripe_subscription_id.is_some() && r.status != "canceled" {
            tx.rollback().await?;
            return Err(AppError::Conflict(
                "this organization already has a subscription; use the billing portal to change it"
                    .into(),
            ));
        }
    }

    // Expire the previous in-flight session. A rejection saying the session is already
    // COMPLETE means the operator's previous checkout just went through (the webhook may
    // simply not have landed yet): abort instead of minting a second subscription. Other
    // failures (already expired, transient) are logged and the new checkout proceeds.
    if let Some(prev) = billing::get_pending_checkout_in_tx(&mut tx, org.0).await? {
        match client.expire_checkout_session(&prev).await {
            Ok(_) => {}
            Err(ProviderError::Rejected(msg)) if msg.to_ascii_lowercase().contains("complete") => {
                tx.rollback().await?;
                return Err(AppError::Conflict(
                    "your previous checkout has just completed; this organization now has \
                     a subscription"
                        .into(),
                ));
            }
            Err(e) => {
                tracing::warn!(org = %org.0, session = %prev, error = %e,
                    "could not expire previous pending checkout session");
            }
        }
    }

    let session = client
        .create_subscription_checkout(
            price_id,
            org.0,
            &success_url,
            &cancel_url,
            row.as_ref().and_then(|r| r.stripe_customer_id.as_deref()),
        )
        .await
        .map_err(|e| AppError::Unavailable(format!("could not start checkout: {e}")))?;
    let redirect_url = session
        .get("url")
        .and_then(|u| u.as_str())
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("checkout session has no url")))?
        .to_string();
    // A session without an id is a broken response: recording an empty pending id would
    // disarm the double-charge guard, so fail hard (the tx rolls back on drop).
    let session_id = session
        .get("id")
        .and_then(|i| i.as_str())
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("checkout session has no id")))?;

    billing::set_pending_checkout_in_tx(&mut tx, org.0, session_id).await?;
    // Audit the handoff in the same transaction (the completion itself is audited by
    // the webhook/reconcile writer).
    crate::domain::audit::record_in_tx(
        &mut tx,
        org.0,
        Some(claims.0.sub.0),
        "billing.checkout_created",
        Some("checkout_session"),
        None,
        Some(json!({ "plan": plan.as_str(), "stripe_checkout_session_id": session_id })),
    )
    .await?;
    tx.commit().await?;

    Ok(Json(json!({ "redirect_url": redirect_url })))
}

/// POST /billing/portal {return_url} -> {redirect_url}: hand the operator off to the
/// Stripe Customer Portal (manage/cancel/payment method). Requires an existing customer.
pub async fn portal(
    State(state): State<AppState>,
    claims: AuthClaims,
    Json(req): Json<PortalRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let org = claims.require(Permission::BillingManage)?;
    let client = require_stripe(&state)?;

    let row = billing::get_subscription(&state.app_pool, TenantId::from(org)).await?;
    let customer = row
        .as_ref()
        .and_then(|r| r.stripe_customer_id.as_deref())
        .ok_or_else(|| {
            AppError::Conflict(
                "no billing account exists for this organization yet; subscribe first".into(),
            )
        })?;

    let return_url = validate_return_url(&req.return_url)?;
    let session = client
        .create_portal_session(customer, &return_url)
        .await
        .map_err(|e| AppError::Unavailable(format!("could not open the billing portal: {e}")))?;
    let redirect_url = session
        .get("url")
        .and_then(|u| u.as_str())
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("portal session has no url")))?;
    Ok(Json(json!({ "redirect_url": redirect_url })))
}

fn require_stripe(state: &AppState) -> Result<StripeClient, AppError> {
    StripeClient::from_config(&state.http, &state.config)
        .ok_or_else(|| AppError::Unavailable("billing is not configured".into()))
}

/// The return URL comes from our own web app, but validate shape anyway: https (Stripe
/// requires it outside dev), no fragment (Stripe rejects fragments in redirect URLs).
fn validate_return_url(url: &str) -> Result<String, AppError> {
    let u = url.trim();
    if !u.starts_with("https://") || u.contains('#') || u.contains(char::is_whitespace) {
        return Err(AppError::BadRequest(
            "return_url must be an https URL without a fragment".into(),
        ));
    }
    Ok(u.to_string())
}

/// Append the `(app)/billing?flag=...` breadcrumb (decision J) to a return URL that may
/// already carry a query string.
fn with_flag(return_url: &str, flag: &str) -> String {
    let sep = if return_url.contains('?') { '&' } else { '?' };
    format!("{return_url}{sep}flag={flag}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn return_url_flagging_handles_existing_query() {
        assert_eq!(
            with_flag("https://app.test/billing", "checkout_success"),
            "https://app.test/billing?flag=checkout_success"
        );
        assert_eq!(
            with_flag("https://app.test/billing?tab=plan", "checkout_cancel"),
            "https://app.test/billing?tab=plan&flag=checkout_cancel"
        );
    }

    #[test]
    fn return_url_validation() {
        assert!(validate_return_url("https://app.test/billing").is_ok());
        assert!(validate_return_url("http://app.test/billing").is_err());
        assert!(validate_return_url("https://app.test/billing#frag").is_err());
        assert!(validate_return_url("javascript:alert(1)").is_err());
    }
}
