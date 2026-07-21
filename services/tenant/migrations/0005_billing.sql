-- Phase 6 PR2: Stripe platform billing (decisions H, I). Subscriptions land in slice 1;
-- billing_purchases ships now so the schema is complete, its write path lands in slice 2.
--
-- Stripe is single-merchant platform billing (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET
-- are platform secrets, not tenant-supplied creds), so unlike the store tables there is
-- no connection row to hang state off: org_subscriptions is keyed directly by the org id.

-- One row per org with a Stripe subscription (free tier = absence of a row). Stripe is
-- payment truth; the code-defined plan catalog (crates/domain/src/plan.rs) is gating
-- truth. Written from the webhook receiver and the reconcile loop on the owner pool;
-- the request path (GET /billing/subscription) only reads it.
CREATE TABLE org_subscriptions (
    tenant_id              uuid PRIMARY KEY,      -- = org id
    stripe_customer_id     text,
    stripe_subscription_id text,
    plan                   text NOT NULL DEFAULT 'free',
    status                 text NOT NULL
                           CHECK (status IN ('active', 'trialing', 'past_due', 'canceled')),
    current_period_end     timestamptz,
    -- When the row ENTERED past_due (set on the transition, cleared on return to
    -- active/trialing). The 7-day grace window anchors here: Stripe advances
    -- current_period_end into the NEW period before the renewal invoice fails, so
    -- anchoring grace on the period end would gift about a month of unpaid paid-gating.
    past_due_since         timestamptz,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);
-- Webhooks (customer.subscription.*) and the reconcile walk resolve the org by the
-- Stripe subscription id.
CREATE INDEX ix_org_subscriptions_sub ON org_subscriptions (stripe_subscription_id)
    WHERE stripe_subscription_id IS NOT NULL;

-- The org's one in-flight Checkout Session (subscription mode). Sessions live for 24h,
-- so without this an operator could open two tabs (or abandon one and retry) and
-- complete BOTH, double-charging the org: /billing/checkout expires the previous
-- pending session at Stripe before minting a new one (serialized per tenant on the
-- advisory lock), and the completion webhook clears the row. Owner-written only; no
-- app-role grant.
CREATE TABLE billing_pending_checkouts (
    tenant_id                  uuid PRIMARY KEY,
    stripe_checkout_session_id text NOT NULL,
    created_at                 timestamptz NOT NULL DEFAULT now()
);

-- Stripe webhook idempotency + audit (the store_webhook_events shape, decision H).
-- Single merchant: event_id is GLOBALLY unique (no connection_id in the key). tenant_id
-- is nullable because some verified events cannot be attributed to an org (unknown
-- subscription, unhandled types); they are still recorded for dedupe.
CREATE TABLE billing_webhook_events (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    tenant_id    uuid,
    event_id     text NOT NULL,
    event_type   text,
    payload      jsonb,
    received_at  timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz,
    error        text,

    CONSTRAINT billing_webhook_events_event_unique UNIQUE (event_id)
);
CREATE INDEX ix_billing_webhook_events_tenant
    ON billing_webhook_events (tenant_id, received_at DESC) WHERE tenant_id IS NOT NULL;

-- One-off service purchases ledger (decision I; Resolved with Frank #2). Purchase is
-- self-serve, fulfillment is manual/human. Written by webhook + reconcile backstop in
-- slice 2; the operator catalog/history surface reads it.
CREATE TABLE billing_purchases (
    id                         uuid PRIMARY KEY DEFAULT uuidv7(),
    tenant_id                  uuid NOT NULL,
    service_key                text NOT NULL,
    stripe_checkout_session_id text,
    stripe_payment_intent_id   text,
    amount                     bigint,
    currency                   text,
    status                     text NOT NULL DEFAULT 'paid'
                               CHECK (status IN ('paid', 'refunded')),
    purchased_at               timestamptz NOT NULL DEFAULT now(),

    -- Natural idempotency key: webhook and the 24h reconcile backstop converge on the
    -- same row per Checkout Session (slice 2).
    CONSTRAINT billing_purchases_session_unique UNIQUE (stripe_checkout_session_id)
);
CREATE INDEX ix_billing_purchases_tenant ON billing_purchases (tenant_id, purchased_at DESC);

-- ============================ Row-Level Security ============================
ALTER TABLE org_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_subscriptions_isolation ON org_subscriptions
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE billing_pending_checkouts ENABLE ROW LEVEL SECURITY;
CREATE POLICY billing_pending_checkouts_isolation ON billing_pending_checkouts
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE billing_webhook_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY billing_webhook_events_isolation ON billing_webhook_events
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE billing_purchases ENABLE ROW LEVEL SECURITY;
CREATE POLICY billing_purchases_isolation ON billing_purchases
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- ============================ App-role grants ============================
-- org_subscriptions / billing_purchases: read-only on the request path; all writes come
-- from the webhook receiver and reconcile loop on the owner pool. billing_webhook_events
-- is entirely owner-side (no app grant).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cupboard_app') THEN
        GRANT SELECT ON org_subscriptions TO cupboard_app;
        GRANT SELECT ON billing_purchases TO cupboard_app;
    END IF;
END
$$;
