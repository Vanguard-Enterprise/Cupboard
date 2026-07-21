//! The Stripe billing reconcile loop (Phase 6 decision H): NO supervisor/runner clone,
//! just one plain 15-minute loop, spawned from `main` when billing is configured (the
//! domains_loop seam). Each tick walks ALL subscriptions (`status=all`, paginated),
//! aggregates them PER ORG and upserts one winner each (Stripe lists canceled
//! subscriptions forever, so after cancel-then-resubscribe an org has several; a naive
//! per-subscription upsert would let the old canceled one clobber the new live one), and
//! ONLY after a COMPLETE walk sweeps local rows whose subscription Stripe no longer
//! reports (a lost `customer.subscription.deleted` must still converge to free). It then
//! re-pushes the plan mirror for EVERY known org, downgrades to free included, healing
//! any lost webhook or mirror write.
//!
//! The same tick also backstops one-off purchases (slice 2, decision H: money must not
//! depend on webhook delivery): it lists Checkout Sessions created in the last 24h,
//! keeps the paid payment-mode ones, and idempotently inserts any `billing_purchases`
//! row a lost webhook missed. Refunds are deliberately webhook-only (decision H).

use crate::config::Config;
use crate::domain::billing;
use crate::stripe::{self, StripeClient, SubscriptionFacts};
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tracing::Instrument as _;
use uuid::Uuid;

/// Reconcile cadence (the store runner precedent; also the mirror-staleness bound of
/// decision K).
const RECONCILE_EVERY: Duration = Duration::from_secs(15 * 60);
/// Bound on the subscription page walk; past this the walk is treated as incomplete and
/// the absent-sweep is skipped (a partial view must not cancel rows it did not see).
const PAGE_CAP: usize = 100;

pub async fn run(owner_pool: PgPool, http: reqwest::Client, config: Arc<Config>) {
    let Some(client) = StripeClient::from_config(&http, &config) else {
        // main gates the spawn on the secret, so this is belt-and-braces.
        tracing::warn!("STRIPE_SECRET_KEY unset; billing reconcile loop not running");
        return;
    };
    tracing::info!("billing reconcile loop started");
    let mut ticker = tokio::time::interval(RECONCILE_EVERY);
    loop {
        ticker.tick().await;
        // Each tick runs in its own task so a panic anywhere inside it is absorbed as a
        // JoinError and the loop keeps ticking; billing reconciliation must never die
        // silently. Errors inside the tick log and return, never propagate.
        let tick = {
            let pool = owner_pool.clone();
            let client = client.clone();
            let http = http.clone();
            let config = config.clone();
            tokio::spawn(async move {
                reconcile_once(&pool, &client, &http, &config)
                    .instrument(tracing::info_span!("billing_reconcile"))
                    .await;
            })
        };
        if let Err(e) = tick.await {
            tracing::error!(error = %e, "billing reconcile tick crashed; the loop continues");
        }
    }
}

/// One reconcile tick. Public so tests drive it directly against the stub.
pub async fn reconcile_once(
    owner_pool: &PgPool,
    client: &StripeClient,
    http: &reqwest::Client,
    config: &Config,
) {
    // Phase 1: walk every page, remembering every subscription id seen (the sweep set)
    // and every parseable subscription (grouped per org later). Nothing is written until
    // the walk stops, so ordering inside Stripe's listing cannot bias the winner.
    let mut cursor: Option<String> = None;
    let mut complete = false;
    let mut seen_ids: Vec<String> = Vec::new();
    let mut all_facts: Vec<SubscriptionFacts> = Vec::new();

    for _ in 0..PAGE_CAP {
        let page = match client.list_subscriptions(cursor.as_deref()).await {
            Ok(page) => page,
            Err(e) => {
                tracing::warn!(error = %e, "subscription list failed; walk incomplete");
                break;
            }
        };
        let last_id = page
            .data
            .last()
            .and_then(|s| s.get("id"))
            .and_then(|i| i.as_str())
            .map(str::to_string);
        for sub in &page.data {
            match stripe::subscription_facts(sub) {
                Some(facts) => {
                    seen_ids.push(facts.id.clone());
                    all_facts.push(facts);
                }
                None => {
                    tracing::warn!("unparseable subscription in reconcile page; skipping");
                    // Still SEEN when it has an id: the sweep must not act on it.
                    if let Some(id) = sub.get("id").and_then(|i| i.as_str()) {
                        seen_ids.push(id.to_string());
                    }
                }
            }
        }
        if page.has_more {
            match last_id {
                Some(id) => cursor = Some(id),
                None => {
                    tracing::warn!("stripe page has_more but no cursor; walk incomplete");
                    break;
                }
            }
        } else {
            complete = true;
            break;
        }
    }

    // Phase 2: group per org and upsert ONE winner each: best status rank
    // (live > past_due > canceled), newest `created` breaking ties. The upsert's own
    // stale-terminal guard is a second line of defense for partial walks that only saw
    // an org's old canceled subscription.
    let mut by_org: HashMap<Uuid, Vec<SubscriptionFacts>> = HashMap::new();
    for facts in all_facts {
        let org = match facts.org_hint {
            Some(org) => Some(org),
            None => match billing::find_tenant_by_subscription(owner_pool, &facts.id).await {
                Ok(org) => org,
                Err(e) => {
                    tracing::warn!(subscription = %facts.id, error = ?e, "org lookup failed");
                    None
                }
            },
        };
        match org {
            Some(org) => by_org.entry(org).or_default().push(facts),
            None => {
                tracing::warn!(subscription = %facts.id, "subscription attributable to no org; skipping");
            }
        }
    }
    let mut upserts = 0u64;
    for (org, mut candidates) in by_org {
        // Winner order: status rank first (live > past_due > canceled), then the
        // candidate matching the STORED subscription id, then newest `created`. The
        // stored-id preference matters when every candidate is terminal: with a lost
        // deleted-webhook the local row still holds sub_B live while Stripe lists
        // sub_B canceled plus a newer canceled sub_C; a created-only tie-break would
        // pick sub_C, the stale-terminal guard would refuse it every tick, and the org
        // would keep paid gating forever. Preferring sub_B lets the same-id
        // cancellation write and converge the org to free.
        let stored_sub = match billing::get_subscription_owner(owner_pool, org).await {
            Ok(row) => row.and_then(|r| r.stripe_subscription_id),
            Err(e) => {
                tracing::warn!(org = %org, error = ?e, "stored-subscription lookup failed");
                None
            }
        };
        candidates.sort_by_key(|f| {
            (
                billing::status_rank(billing::normalize_status(&f.status)),
                stored_sub.as_deref() == Some(f.id.as_str()),
                f.created.unwrap_or(0),
            )
        });
        let Some(best) = candidates.pop() else {
            continue;
        };
        match upsert_reconciled(owner_pool, config, org, &best).await {
            Ok(()) => upserts += 1,
            Err(e) => tracing::warn!(org = %org, error = ?e, "reconcile upsert failed"),
        }
    }

    // Sweep ONLY after a completed walk (the sweep_absent_actives discipline), and only
    // when the completed walk looks sane: an EMPTY listing while live local rows exist,
    // or a sweep that would cancel MORE THAN HALF of the live rows, means the key looks
    // at the wrong Stripe account or mode (possibly one with foreign subscriptions),
    // not that most customers canceled at once; sweeping then would mass-downgrade
    // paying orgs in one tick.
    if complete {
        let counts = match (
            billing::count_live_subscriptions(owner_pool).await,
            billing::count_sweep_candidates(owner_pool, &seen_ids).await,
        ) {
            (Ok(live), Ok(would_sweep)) => Some((live, would_sweep)),
            (live, would_sweep) => {
                tracing::warn!(
                    live = ?live.err(),
                    would_sweep = ?would_sweep.err(),
                    "sweep sanity counts failed; refusing the absent-sweep"
                );
                None
            }
        };
        if let Some((live, would_sweep)) = counts {
            if seen_ids.is_empty() && live > 0 {
                tracing::error!(
                    live_rows = live,
                    "completed subscription walk saw ZERO subscriptions while live local \
                     rows exist; REFUSING the absent-sweep (is STRIPE_SECRET_KEY pointing \
                     at the right account/mode?)"
                );
            } else if would_sweep > 0 && would_sweep * 2 > live {
                tracing::error!(
                    live_rows = live,
                    would_sweep,
                    "absent-sweep would cancel more than half of the live rows; REFUSING \
                     it (is STRIPE_SECRET_KEY pointing at the right account/mode?)"
                );
            } else {
                match billing::sweep_absent_subscriptions(owner_pool, &seen_ids).await {
                    Ok(swept) if !swept.is_empty() => {
                        tracing::info!(
                            orgs = swept.len(),
                            "swept subscriptions absent from stripe"
                        );
                    }
                    Ok(_) => {}
                    Err(e) => tracing::warn!(error = ?e, "absent-subscription sweep failed"),
                }
            }
        }
    } else {
        tracing::warn!("subscription walk incomplete; skipping absent-sweep");
    }

    // Re-push the mirror for EVERY known org, downgrades included (decision K's healer).
    match billing::list_all_subscriptions(owner_pool).await {
        Ok(rows) => {
            for row in rows {
                stripe::resolve_and_push_mirror(owner_pool, http, config, row.tenant_id).await;
            }
        }
        Err(e) => tracing::warn!(error = ?e, "could not list subscriptions for mirror re-push"),
    }

    // Purchases backstop (decision H): failures here log and never affect the
    // subscriptions phase above, which has already run to completion.
    reconcile_purchases(owner_pool, client).await;

    tracing::info!(
        upserts,
        complete,
        seen = seen_ids.len(),
        "billing reconcile tick done"
    );
}

/// How far back the purchases backstop looks. Sessions live at most 24h, so a session
/// created earlier than this cannot still complete; each is re-seen by several ticks.
const PURCHASES_LOOKBACK: chrono::Duration = chrono::Duration::hours(24);

/// Walk Checkout Sessions created in the lookback window and idempotently insert any
/// paid payment-mode purchase the webhook missed (the UNIQUE session id converges both
/// writers on one row). Completeness does not matter here the way it does for the
/// subscription sweep: this only ADDS missed rows, so a partial walk is just a smaller
/// backstop this tick.
async fn reconcile_purchases(owner_pool: &PgPool, client: &StripeClient) {
    let created_gte = (chrono::Utc::now() - PURCHASES_LOOKBACK).timestamp();
    let mut cursor: Option<String> = None;
    let mut inserted = 0u64;
    for _ in 0..PAGE_CAP {
        let page = match client
            .list_checkout_sessions(created_gte, cursor.as_deref())
            .await
        {
            Ok(page) => page,
            Err(e) => {
                tracing::warn!(error = %e, "checkout-session list failed; purchases backstop cut short");
                return;
            }
        };
        let last_id = page
            .data
            .last()
            .and_then(|s| s.get("id"))
            .and_then(|i| i.as_str())
            .map(str::to_string);
        for session in &page.data {
            // Not payment mode, not paid, or unattributable: not backstop material.
            let Some(facts) = stripe::payment_session_facts(session) else {
                continue;
            };
            let purchase = billing::NewPurchase {
                service_key: facts.service_key,
                stripe_checkout_session_id: facts.session_id,
                stripe_payment_intent_id: facts.payment_intent,
                amount: facts.amount_total,
                currency: facts.currency,
            };
            let landed: Result<bool, crate::error::AppError> = async {
                let mut tx = owner_pool.begin().await?;
                let new =
                    billing::insert_purchase_in_tx(&mut tx, facts.org, &purchase, "reconcile")
                        .await?;
                tx.commit().await?;
                Ok(new)
            }
            .await;
            match landed {
                Ok(true) => {
                    inserted += 1;
                    tracing::warn!(
                        org = %facts.org,
                        session = %purchase.stripe_checkout_session_id,
                        "purchases backstop landed a paid session the webhook missed"
                    );
                }
                Ok(false) => {}
                Err(e) => tracing::warn!(error = ?e, "purchase backstop insert failed"),
            }
        }
        if page.has_more {
            match last_id {
                Some(id) => cursor = Some(id),
                None => {
                    tracing::warn!("checkout-session page has_more but no cursor; stopping");
                    break;
                }
            }
        } else {
            break;
        }
    }
    if inserted > 0 {
        tracing::info!(inserted, "purchases backstop inserted missed rows");
    }
}

/// Upsert one org's winning subscription into the local mirror. An unmappable price id
/// passes `plan: None`; the upsert preserves prior plan knowledge (or floors to free).
async fn upsert_reconciled(
    owner_pool: &PgPool,
    config: &Config,
    org: Uuid,
    facts: &SubscriptionFacts,
) -> Result<(), crate::error::AppError> {
    let state = billing::SubscriptionState {
        stripe_customer_id: facts.customer.clone(),
        stripe_subscription_id: facts.id.clone(),
        plan: facts
            .price_id
            .as_deref()
            .and_then(|p| stripe::plan_for_price(config, p)),
        status: billing::normalize_status(&facts.status),
        current_period_end: facts.current_period_end,
    };
    let mut tx = owner_pool.begin().await?;
    billing::upsert_subscription_in_tx(&mut tx, org, &state, Some(Uuid::nil()), "reconcile")
        .await?;
    tx.commit().await?;
    Ok(())
}
