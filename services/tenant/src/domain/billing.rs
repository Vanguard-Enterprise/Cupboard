//! Platform billing state (Phase 6 decisions H, I): the `org_subscriptions` mirror of
//! Stripe subscription truth, webhook dedupe, and the plan-resolution semantics every
//! caller (webhook, reconcile, operator read) shares. Stripe is payment truth; the
//! code-defined catalog (`cupboard_domain::Plan`) is gating truth.
//!
//! All writes happen on the owner pool (webhook receiver + reconcile loop); the request
//! path only reads (app pool, RLS + SELECT grant).

use crate::error::AppError;
use chrono::{DateTime, Duration, Utc};
use cupboard_domain::{Plan, TenantId};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

/// How long a `past_due` subscription keeps paid gating (decision I: Stripe's retry
/// schedule runs for roughly a week). Anchored on `past_due_since`, the moment the row
/// ENTERED past_due: Stripe advances `current_period_end` into the NEW period before the
/// renewal invoice fails, so a period-end anchor would gift roughly a month of unpaid
/// paid-gating. `past_due_since` is set once on the transition (COALESCE, so repeated
/// webhooks/reconciles never slide the window) and cleared on return to active/trialing.
/// `current_period_end` remains only a fallback for rows that somehow lack the anchor.
pub const PAST_DUE_GRACE: Duration = Duration::days(7);

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct OrgSubscription {
    pub tenant_id: Uuid,
    pub stripe_customer_id: Option<String>,
    pub stripe_subscription_id: Option<String>,
    pub plan: String,
    pub status: String,
    pub current_period_end: Option<DateTime<Utc>>,
    pub past_due_since: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
}

const SUB_COLS: &str = "tenant_id, stripe_customer_id, stripe_subscription_id, plan, \
     status, current_period_end, past_due_since, updated_at";

/// Normalize a Stripe subscription status to the local vocabulary (decision I). Statuses
/// outside it (`unpaid`, `paused`, `incomplete`, `incomplete_expired`) mean Stripe has
/// given up or never collected; money is involved, so they gate as canceled (free), the
/// safe floor.
pub fn normalize_status(stripe_status: &str) -> &'static str {
    match stripe_status {
        "active" => "active",
        "trialing" => "trialing",
        "past_due" => "past_due",
        "canceled" => "canceled",
        other => {
            tracing::info!(status = other, "unmapped stripe status; gating as canceled");
            "canceled"
        }
    }
}

/// Resolve the effective GATING plan (decision I): `active`/`trialing` gate as the paid
/// plan; `past_due` keeps paid gating within [`PAST_DUE_GRACE`] of the transition into
/// past_due (`past_due_since`; `current_period_end` only as a legacy fallback, and no
/// anchor at all = free, the safe floor); `canceled` or no row is free. An unknown
/// stored plan string parses to free via `Plan::from_claim`.
pub fn effective_plan(row: Option<&OrgSubscription>, now: DateTime<Utc>) -> Plan {
    let Some(row) = row else { return Plan::Free };
    let paid = Plan::from_claim(Some(&row.plan));
    match row.status.as_str() {
        "active" | "trialing" => paid,
        "past_due" => match row.past_due_since.or(row.current_period_end) {
            Some(anchor) if now < anchor + PAST_DUE_GRACE => paid,
            _ => Plan::Free,
        },
        _ => Plan::Free,
    }
}

/// How preferable a (normalized) status is when several Stripe subscriptions map to the
/// same org (cancel-then-resubscribe leaves the old canceled subscription listed
/// forever): live beats past_due beats canceled; the reconcile walk picks ONE winner per
/// org with this and breaks ties by newest `created`.
pub fn status_rank(normalized_status: &str) -> u8 {
    match normalized_status {
        "active" | "trialing" => 2,
        "past_due" => 1,
        _ => 0,
    }
}

/// The status string the plan mirror carries (the cross-service contract adds `"none"`
/// for the no-subscription case).
pub fn mirror_status(row: Option<&OrgSubscription>) -> &str {
    row.map(|r| r.status.as_str()).unwrap_or("none")
}

// ============================ Reads ============================

/// The org's subscription row on the request path (app pool, RLS).
pub async fn get_subscription(
    app_pool: &PgPool,
    tenant: TenantId,
) -> Result<Option<OrgSubscription>, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let row = sqlx::query_as::<_, OrgSubscription>(&format!(
        "SELECT {SUB_COLS} FROM org_subscriptions WHERE tenant_id = $1"
    ))
    .bind(tenant.0)
    .fetch_optional(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(row)
}

/// The org's subscription row for webhook/reconcile/mirror work (owner pool).
pub async fn get_subscription_owner(
    owner_pool: &PgPool,
    tenant_id: Uuid,
) -> Result<Option<OrgSubscription>, AppError> {
    Ok(sqlx::query_as::<_, OrgSubscription>(&format!(
        "SELECT {SUB_COLS} FROM org_subscriptions WHERE tenant_id = $1"
    ))
    .bind(tenant_id)
    .fetch_optional(owner_pool)
    .await?)
}

/// Resolve which org a Stripe subscription id belongs to (webhooks that carry no
/// `client_reference_id`, and reconcile rows without an org metadata hint).
pub async fn find_tenant_by_subscription(
    owner_pool: &PgPool,
    stripe_subscription_id: &str,
) -> Result<Option<Uuid>, AppError> {
    Ok(sqlx::query_scalar(
        "SELECT tenant_id FROM org_subscriptions WHERE stripe_subscription_id = $1",
    )
    .bind(stripe_subscription_id)
    .fetch_optional(owner_pool)
    .await?)
}

/// Every org with a subscription row (the reconcile re-push walks all of them,
/// downgrades included).
pub async fn list_all_subscriptions(owner_pool: &PgPool) -> Result<Vec<OrgSubscription>, AppError> {
    Ok(sqlx::query_as::<_, OrgSubscription>(&format!(
        "SELECT {SUB_COLS} FROM org_subscriptions ORDER BY tenant_id"
    ))
    .fetch_all(owner_pool)
    .await?)
}

// ============================ Writes (owner pool) ============================

/// The provider-reported subscription state to store, already normalized. `plan` is
/// `None` when the Stripe price id could not be mapped to the catalog (configmap typo,
/// or a price introduced Stripe-side first): the upsert then preserves the stored plan
/// for the same subscription rather than mass-downgrading paying orgs.
#[derive(Debug)]
pub struct SubscriptionState {
    pub stripe_customer_id: Option<String>,
    pub stripe_subscription_id: String,
    pub plan: Option<Plan>,
    pub status: &'static str,
    pub current_period_end: Option<DateTime<Utc>>,
}

/// Upsert an org's subscription row inside an existing transaction, with an audit row
/// when (and only when) the stored plan/status actually changed. Returns whether it did.
///
/// Two money guards live here so every writer (webhook AND reconcile) shares them:
///
/// * **Stale-terminal guard**: after cancel-then-resubscribe, Stripe still emits/lists
///   the OLD canceled subscription (canceled subs are listed forever), and both carry
///   this org's metadata. A terminal (canceled) incoming state whose subscription id
///   differs from the stored LIVE row's id must never clobber that live row, or a paying
///   org gets pushed to free.
/// * **Unknown-price guard**: an unmappable price id on the subscription we already know
///   keeps the stored paid plan (status still updates); it floors to free only when
///   there is no prior plan knowledge for that subscription.
pub async fn upsert_subscription_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    state: &SubscriptionState,
    actor: Option<Uuid>,
    source: &str,
) -> Result<bool, sqlx::Error> {
    let previous: Option<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT plan, status, stripe_subscription_id FROM org_subscriptions \
         WHERE tenant_id = $1 FOR UPDATE",
    )
    .bind(tenant_id)
    .fetch_optional(&mut **tx)
    .await?;

    // Stale-terminal guard.
    if state.status == "canceled" {
        if let Some((_, prev_status, Some(prev_sub))) = &previous {
            if prev_status != "canceled" && *prev_sub != state.stripe_subscription_id {
                tracing::warn!(
                    tenant = %tenant_id,
                    incoming = %state.stripe_subscription_id,
                    stored = %prev_sub,
                    source,
                    "ignoring terminal state for a superseded subscription; the stored \
                     live subscription wins"
                );
                return Ok(false);
            }
        }
    }

    // Unknown-price guard: resolve the plan string to store.
    let plan = match state.plan {
        Some(p) => p.as_str().to_string(),
        None => {
            let preserved = previous.as_ref().and_then(|(prev_plan, _, prev_sub)| {
                if prev_sub.as_deref() == Some(state.stripe_subscription_id.as_str()) {
                    Plan::from_wire(prev_plan).filter(|p| *p != Plan::Free)
                } else {
                    None
                }
            });
            match preserved {
                Some(p) => {
                    tracing::warn!(
                        tenant = %tenant_id,
                        subscription = %state.stripe_subscription_id,
                        preserved = %p,
                        source,
                        "UNKNOWN STRIPE PRICE ID on a known paid subscription; preserving \
                         the stored plan (check STRIPE_PRICE_* config)"
                    );
                    p.as_str().to_string()
                }
                None => {
                    tracing::warn!(
                        tenant = %tenant_id,
                        subscription = %state.stripe_subscription_id,
                        source,
                        "unknown stripe price id with no prior plan knowledge; gating as free"
                    );
                    "free".to_string()
                }
            }
        }
    };

    // past_due_since: set once on the transition INTO past_due, cleared on recovery,
    // untouched otherwise (see PAST_DUE_GRACE).
    sqlx::query(
        "INSERT INTO org_subscriptions \
             (tenant_id, stripe_customer_id, stripe_subscription_id, plan, status, \
              current_period_end, past_due_since) \
         VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $5 = 'past_due' THEN now() END) \
         ON CONFLICT (tenant_id) DO UPDATE SET \
             stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, \
                                           org_subscriptions.stripe_customer_id), \
             stripe_subscription_id = EXCLUDED.stripe_subscription_id, \
             plan = EXCLUDED.plan, \
             status = EXCLUDED.status, \
             current_period_end = EXCLUDED.current_period_end, \
             past_due_since = CASE \
                 WHEN EXCLUDED.status = 'past_due' \
                     THEN COALESCE(org_subscriptions.past_due_since, now()) \
                 WHEN EXCLUDED.status IN ('active', 'trialing') THEN NULL \
                 ELSE org_subscriptions.past_due_since END, \
             updated_at = now()",
    )
    .bind(tenant_id)
    .bind(&state.stripe_customer_id)
    .bind(&state.stripe_subscription_id)
    .bind(&plan)
    .bind(state.status)
    .bind(state.current_period_end)
    .execute(&mut **tx)
    .await?;

    let changed = previous.as_ref().map(|(p, s, _)| (p.as_str(), s.as_str()))
        != Some((plan.as_str(), state.status));
    if changed {
        crate::domain::audit::record_in_tx(
            tx,
            tenant_id,
            actor,
            "billing.subscription_updated",
            Some("org_subscription"),
            Some(tenant_id),
            Some(serde_json::json!({
                "plan": plan,
                "status": state.status,
                "previous_plan": previous.as_ref().map(|(p, _, _)| p),
                "previous_status": previous.as_ref().map(|(_, s, _)| s),
                "subscription": state.stripe_subscription_id,
                "source": source,
            })),
        )
        .await?;
    }
    Ok(changed)
}

/// Mark an org's subscription `past_due` (an `invoice.payment_failed` ahead of the
/// matching `customer.subscription.updated`). Keeps the stored plan; grace resolution
/// decides gating, anchored on the `past_due_since` this stamps (COALESCE: a repeat
/// failure never slides the window). Audits when the status actually flipped.
pub async fn mark_past_due_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let res = sqlx::query(
        "UPDATE org_subscriptions SET status = 'past_due', \
             past_due_since = COALESCE(past_due_since, now()), updated_at = now() \
         WHERE tenant_id = $1 AND status IN ('active', 'trialing')",
    )
    .bind(tenant_id)
    .execute(&mut **tx)
    .await?;
    let changed = res.rows_affected() == 1;
    if changed {
        crate::domain::audit::record_in_tx(
            tx,
            tenant_id,
            None,
            "billing.subscription_updated",
            Some("org_subscription"),
            Some(tenant_id),
            Some(serde_json::json!({
                "status": "past_due",
                "source": "webhook:invoice.payment_failed",
            })),
        )
        .await?;
    }
    Ok(changed)
}

/// After a COMPLETE reconcile walk only: cancel every local row whose subscription id
/// Stripe did not report (a lost `customer.subscription.deleted`, decision H). A partial
/// walk must NOT call this. Audits each downgrade; returns the downgraded org ids so the
/// caller re-pushes their mirrors.
pub async fn sweep_absent_subscriptions(
    owner_pool: &PgPool,
    seen_subscription_ids: &[String],
) -> Result<Vec<Uuid>, AppError> {
    let mut tx = owner_pool.begin().await?;
    let swept: Vec<Uuid> = sqlx::query_scalar(
        "UPDATE org_subscriptions \
         SET status = 'canceled', plan = 'free', updated_at = now() \
         WHERE stripe_subscription_id IS NOT NULL \
           AND stripe_subscription_id <> ALL($1) \
           AND status <> 'canceled' \
         RETURNING tenant_id",
    )
    .bind(seen_subscription_ids)
    .fetch_all(&mut *tx)
    .await?;
    for tenant_id in &swept {
        crate::domain::audit::record_in_tx(
            &mut tx,
            *tenant_id,
            None,
            "billing.subscription_updated",
            Some("org_subscription"),
            Some(*tenant_id),
            Some(serde_json::json!({
                "plan": "free",
                "status": "canceled",
                "source": "reconcile:absent_sweep",
            })),
        )
        .await?;
    }
    tx.commit().await?;
    Ok(swept)
}

/// How many local rows still claim a live (non-canceled) subscription. The reconcile
/// loop's empty-walk guard: a completed walk that saw ZERO subscriptions while live rows
/// exist means the credentials look at the wrong Stripe account/mode, not that every
/// customer canceled at once; sweeping then would free every paying org in one tick.
pub async fn count_live_subscriptions(owner_pool: &PgPool) -> Result<i64, AppError> {
    Ok(sqlx::query_scalar(
        "SELECT count(*) FROM org_subscriptions \
         WHERE stripe_subscription_id IS NOT NULL AND status <> 'canceled'",
    )
    .fetch_one(owner_pool)
    .await?)
}

/// How many live rows [`sweep_absent_subscriptions`] WOULD cancel for this seen-set
/// (same predicate, no write). The reconcile loop's fraction guard: a completed walk
/// whose sweep would cancel more than half of the live rows points at a wrong Stripe
/// account that happens to contain foreign subscriptions, not at mass cancellation.
pub async fn count_sweep_candidates(
    owner_pool: &PgPool,
    seen_subscription_ids: &[String],
) -> Result<i64, AppError> {
    Ok(sqlx::query_scalar(
        "SELECT count(*) FROM org_subscriptions \
         WHERE stripe_subscription_id IS NOT NULL \
           AND stripe_subscription_id <> ALL($1) \
           AND status <> 'canceled'",
    )
    .bind(seen_subscription_ids)
    .fetch_one(owner_pool)
    .await?)
}

// ============================ Pending checkout sessions ============================

/// The org's subscription row inside an existing (owner) transaction; the checkout
/// handler re-checks it under the per-tenant advisory lock.
pub async fn get_subscription_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
) -> Result<Option<OrgSubscription>, sqlx::Error> {
    sqlx::query_as::<_, OrgSubscription>(&format!(
        "SELECT {SUB_COLS} FROM org_subscriptions WHERE tenant_id = $1"
    ))
    .bind(tenant_id)
    .fetch_optional(&mut **tx)
    .await
}

/// The org's in-flight Checkout Session id, if any (to be expired before a new one).
pub async fn get_pending_checkout_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT stripe_checkout_session_id FROM billing_pending_checkouts WHERE tenant_id = $1",
    )
    .bind(tenant_id)
    .fetch_optional(&mut **tx)
    .await
}

/// Record the org's (single) in-flight Checkout Session.
pub async fn set_pending_checkout_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    session_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO billing_pending_checkouts (tenant_id, stripe_checkout_session_id) \
         VALUES ($1, $2) \
         ON CONFLICT (tenant_id) DO UPDATE SET \
             stripe_checkout_session_id = EXCLUDED.stripe_checkout_session_id, \
             created_at = now()",
    )
    .bind(tenant_id)
    .bind(session_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Clear the pending session a completion webhook consumed, but ONLY when it is the one
/// on record: paying session A seconds before starting checkout B must not wipe B's
/// pending record (B is the session the expire-before-create guard has to know about).
pub async fn clear_pending_checkout_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    completed_session_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "DELETE FROM billing_pending_checkouts \
         WHERE tenant_id = $1 AND stripe_checkout_session_id = $2",
    )
    .bind(tenant_id)
    .bind(completed_session_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

// ============================ One-off service purchases ============================

/// A paid one-off purchase to record (Resolved with Frank #2). Webhook and the 24h
/// reconcile backstop both build this from the same Checkout Session facts.
#[derive(Debug)]
pub struct NewPurchase {
    pub service_key: String,
    pub stripe_checkout_session_id: String,
    pub stripe_payment_intent_id: Option<String>,
    pub amount: Option<i64>,
    pub currency: Option<String>,
}

/// Insert a purchase row idempotently (the UNIQUE `stripe_checkout_session_id`), with
/// an audit row when (and only when) it is new. Returns whether it was inserted.
///
/// Refund-race guard: a `charge.refunded` can beat the purchase row into existence
/// (receiver down during a deploy, staff refund fast, backstop inserting later).
/// `charge.refunded` events are dedupe-recorded even when unmatched, so this checks the
/// event journal for an already-recorded FULL refund of this session's payment intent
/// and lands the row as `refunded` when found; a permanently `paid` row would drive
/// manual fulfillment of refunded money. Partial refunds (`refunded != true`) do NOT
/// count: the customer mostly paid, fulfillment proceeds.
pub async fn insert_purchase_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    purchase: &NewPurchase,
    source: &str,
) -> Result<bool, sqlx::Error> {
    let refund_pre_recorded = match &purchase.stripe_payment_intent_id {
        Some(pi) => {
            sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS (\
                 SELECT 1 FROM billing_webhook_events \
                 WHERE event_type = 'charge.refunded' \
                   AND payload->'data'->'object'->>'payment_intent' = $1 \
                   AND payload->'data'->'object'->>'refunded' = 'true')",
            )
            .bind(pi)
            .fetch_one(&mut **tx)
            .await?
        }
        None => false,
    };
    let status = if refund_pre_recorded {
        tracing::warn!(
            tenant = %tenant_id,
            session = %purchase.stripe_checkout_session_id,
            "a full refund was recorded before the purchase row landed; inserting as refunded"
        );
        "refunded"
    } else {
        "paid"
    };
    let inserted: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO billing_purchases \
             (tenant_id, service_key, stripe_checkout_session_id, \
              stripe_payment_intent_id, amount, currency, status) \
         VALUES ($1, $2, $3, $4, $5, $6, $7) \
         ON CONFLICT (stripe_checkout_session_id) DO NOTHING \
         RETURNING id",
    )
    .bind(tenant_id)
    .bind(&purchase.service_key)
    .bind(&purchase.stripe_checkout_session_id)
    .bind(&purchase.stripe_payment_intent_id)
    .bind(purchase.amount)
    .bind(&purchase.currency)
    .bind(status)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(id) = inserted else {
        return Ok(false);
    };
    crate::domain::audit::record_in_tx(
        tx,
        tenant_id,
        None,
        "billing.service_purchased",
        Some("billing_purchase"),
        Some(id),
        Some(serde_json::json!({
            "service_key": purchase.service_key,
            "stripe_checkout_session_id": purchase.stripe_checkout_session_id,
            "amount": purchase.amount,
            "currency": purchase.currency,
            "status": status,
            "refund_pre_recorded": refund_pre_recorded,
            "source": source,
        })),
    )
    .await?;
    Ok(true)
}

/// Which org (and purchase row) a Stripe payment intent belongs to (the
/// `charge.refunded` webhook carries only the charge/payment-intent, not our ids).
pub async fn find_purchase_by_payment_intent(
    owner_pool: &PgPool,
    payment_intent_id: &str,
) -> Result<Option<(Uuid, Uuid)>, AppError> {
    Ok(sqlx::query_as(
        "SELECT tenant_id, id FROM billing_purchases WHERE stripe_payment_intent_id = $1",
    )
    .bind(payment_intent_id)
    .fetch_optional(owner_pool)
    .await?)
}

/// Flip a purchase to refunded (webhook-only per decision H: refunds are initiated by
/// Cupboard staff in the Stripe dashboard, so the event always fires where we see it;
/// no reconcile sweep). Audits when the status actually flipped.
pub async fn refund_purchase_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    payment_intent_id: &str,
) -> Result<bool, sqlx::Error> {
    let refunded: Option<Uuid> = sqlx::query_scalar(
        "UPDATE billing_purchases SET status = 'refunded' \
         WHERE tenant_id = $1 AND stripe_payment_intent_id = $2 AND status = 'paid' \
         RETURNING id",
    )
    .bind(tenant_id)
    .bind(payment_intent_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(id) = refunded else {
        return Ok(false);
    };
    crate::domain::audit::record_in_tx(
        tx,
        tenant_id,
        None,
        "billing.purchase_refunded",
        Some("billing_purchase"),
        Some(id),
        Some(serde_json::json!({
            "stripe_payment_intent_id": payment_intent_id,
            "source": "webhook:charge.refunded",
        })),
    )
    .await?;
    Ok(true)
}

/// Record a PARTIAL refund against a purchase: the row STAYS paid (the customer mostly
/// paid; fulfillment proceeds), the refunded amount lands in the audit trail.
pub async fn record_partial_refund_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    payment_intent_id: &str,
    amount_refunded: Option<i64>,
) -> Result<(), sqlx::Error> {
    let purchase_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM billing_purchases \
         WHERE tenant_id = $1 AND stripe_payment_intent_id = $2",
    )
    .bind(tenant_id)
    .bind(payment_intent_id)
    .fetch_optional(&mut **tx)
    .await?;
    crate::domain::audit::record_in_tx(
        tx,
        tenant_id,
        None,
        "billing.purchase_refund_partial",
        Some("billing_purchase"),
        purchase_id,
        Some(serde_json::json!({
            "stripe_payment_intent_id": payment_intent_id,
            "amount_refunded": amount_refunded,
            "status_kept": "paid",
            "source": "webhook:charge.refunded",
        })),
    )
    .await?;
    Ok(())
}

/// One row of the org's purchase history (the operator services page).
#[derive(Debug, serde::Serialize, sqlx::FromRow)]
pub struct PurchaseView {
    pub id: Uuid,
    pub service_key: String,
    pub status: String,
    pub amount: Option<i64>,
    pub currency: Option<String>,
    pub purchased_at: DateTime<Utc>,
}

/// The org's purchase history, newest first (app pool, RLS).
pub async fn list_purchases(
    app_pool: &PgPool,
    tenant: TenantId,
) -> Result<Vec<PurchaseView>, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let rows = sqlx::query_as::<_, PurchaseView>(
        "SELECT id, service_key, status, amount, currency, purchased_at \
         FROM billing_purchases WHERE tenant_id = $1 \
         ORDER BY purchased_at DESC, id DESC",
    )
    .bind(tenant.0)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(rows)
}

// ============================ Webhook dedupe ============================

/// Record a Stripe event inside the ingest transaction. Returns `true` when the event is
/// new; `false` means a replay (the caller rolls back and answers 2xx, the
/// `entitlements::ingest_webhook` flow). Global unique `event_id`: single merchant.
pub async fn begin_event_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    event_id: &str,
    event_type: &str,
    tenant_id: Option<Uuid>,
    payload: &serde_json::Value,
) -> Result<bool, sqlx::Error> {
    let inserted = sqlx::query(
        "INSERT INTO billing_webhook_events (tenant_id, event_id, event_type, payload) \
         VALUES ($1, $2, $3, $4) \
         ON CONFLICT (event_id) DO NOTHING",
    )
    .bind(tenant_id)
    .bind(event_id)
    .bind(event_type)
    .bind(payload)
    .execute(&mut **tx)
    .await?
    .rows_affected();
    Ok(inserted == 1)
}

/// Stamp the event processed inside the same transaction, just before commit.
pub async fn finish_event_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    event_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE billing_webhook_events SET processed_at = now() WHERE event_id = $1")
        .bind(event_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(plan: &str, status: &str, period_end: Option<DateTime<Utc>>) -> OrgSubscription {
        OrgSubscription {
            tenant_id: Uuid::nil(),
            stripe_customer_id: Some("cus_1".into()),
            stripe_subscription_id: Some("sub_1".into()),
            plan: plan.into(),
            status: status.into(),
            current_period_end: period_end,
            past_due_since: None,
            updated_at: Utc::now(),
        }
    }

    #[test]
    fn effective_plan_resolution_matrix() {
        let now = Utc::now();
        assert_eq!(effective_plan(None, now), Plan::Free);
        assert_eq!(
            effective_plan(Some(&row("team", "active", None)), now),
            Plan::Team
        );
        assert_eq!(
            effective_plan(Some(&row("enterprise", "trialing", None)), now),
            Plan::Enterprise
        );
        assert_eq!(
            effective_plan(Some(&row("team", "canceled", None)), now),
            Plan::Free
        );
        // Unknown stored plan gates as free even when active.
        assert_eq!(
            effective_plan(Some(&row("platinum", "active", None)), now),
            Plan::Free
        );
    }

    #[test]
    fn past_due_grace_anchors_on_the_transition_not_the_period_end() {
        let now = Utc::now();
        // The realistic renewal-failure shape: Stripe already advanced the period end a
        // month into the future BEFORE the invoice failed. Grace must run from the
        // transition into past_due, so 8 days after it the org gates free even though
        // current_period_end + 7d is still far away.
        let mut r = row("team", "past_due", Some(now + Duration::days(27)));
        r.past_due_since = Some(now - Duration::days(8));
        assert_eq!(
            effective_plan(Some(&r), now),
            Plan::Free,
            "grace expired 7 days after entering past_due, period end is irrelevant"
        );
        // Within the window: entered past_due 6 days ago.
        r.past_due_since = Some(now - Duration::days(6));
        assert_eq!(effective_plan(Some(&r), now), Plan::Team);

        // Legacy fallback: no past_due_since recorded, anchor on period end.
        let within = row("team", "past_due", Some(now - Duration::days(6)));
        assert_eq!(effective_plan(Some(&within), now), Plan::Team);
        let past = row("team", "past_due", Some(now - Duration::days(8)));
        assert_eq!(effective_plan(Some(&past), now), Plan::Free);
        // No anchor at all: no grace (safe floor).
        let anchorless = row("team", "past_due", None);
        assert_eq!(effective_plan(Some(&anchorless), now), Plan::Free);
    }

    #[test]
    fn status_rank_prefers_live_over_past_due_over_terminal() {
        assert!(status_rank("active") > status_rank("past_due"));
        assert_eq!(status_rank("active"), status_rank("trialing"));
        assert!(status_rank("past_due") > status_rank("canceled"));
        assert_eq!(status_rank("canceled"), 0);
    }

    #[test]
    fn status_normalization_floors_unknowns() {
        assert_eq!(normalize_status("active"), "active");
        assert_eq!(normalize_status("trialing"), "trialing");
        assert_eq!(normalize_status("past_due"), "past_due");
        assert_eq!(normalize_status("canceled"), "canceled");
        for odd in ["unpaid", "paused", "incomplete", "incomplete_expired", "??"] {
            assert_eq!(normalize_status(odd), "canceled");
        }
    }

    #[test]
    fn mirror_status_reports_none_without_a_row() {
        assert_eq!(mirror_status(None), "none");
        assert_eq!(mirror_status(Some(&row("team", "active", None))), "active");
    }
}
