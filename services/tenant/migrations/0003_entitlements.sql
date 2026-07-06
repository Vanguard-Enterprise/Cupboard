-- Phase 5 PR4: checkout sessions + the entitlement ledger + webhook dedupe.
--
-- Cupboard never processes payments: a player is handed off to the provider's hosted
-- checkout, and ownership ("who owns what") flows back in via signed webhooks, with a
-- periodic reconcile poll as the authoritative backstop (webhook delivery is best-effort;
-- both providers' retry schedules are unpublished). The ledger is provider-wins: Cupboard
-- holds no local edits to entitlements, only the provider's reported state.

-- A checkout the player started; mostly a breadcrumb for the return page (PayNow is a
-- single-step redirect, so there is little state to carry).
CREATE TABLE checkout_sessions (
    id                  uuid PRIMARY KEY DEFAULT uuidv7(),
    tenant_id           uuid NOT NULL,
    connection_id       uuid NOT NULL REFERENCES store_connections (id) ON DELETE CASCADE,
    player_account_id   uuid,
    steam_id            text,
    product_external_id text NOT NULL,
    quantity            integer NOT NULL DEFAULT 1 CHECK (quantity >= 1),
    provider_ref        text,                 -- provider-side checkout/session id
    status              text NOT NULL DEFAULT 'created'
                        CHECK (status IN ('created', 'completed', 'abandoned')),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_checkout_sessions_tenant ON checkout_sessions (tenant_id, created_at DESC);

-- The entitlement ledger: one row per provider "delivery item" (a purchased/granted
-- product instance). Keyed by (connection_id, external_ref) so webhook and reconcile
-- updates converge on the same row. steam_id is the enforcement key; player_account_id is
-- filled opportunistically when we can match a logged-in player.
CREATE TABLE entitlements (
    id                  uuid PRIMARY KEY DEFAULT uuidv7(),
    tenant_id           uuid NOT NULL,
    connection_id       uuid NOT NULL REFERENCES store_connections (id) ON DELETE CASCADE,
    provider            text NOT NULL,
    external_ref        text NOT NULL,
    steam_id            text,
    player_account_id   uuid,
    product_external_id text,
    product_name        text,               -- snapshot at grant time
    kind                text NOT NULL DEFAULT 'single'
                        CHECK (kind IN ('single', 'subscription')),
    status              text NOT NULL
                        CHECK (status IN ('active', 'expired', 'revoked', 'refunded', 'chargeback')),
    granted_at          timestamptz,
    expires_at          timestamptz,
    revoked_at          timestamptz,
    source              text NOT NULL CHECK (source IN ('webhook', 'reconcile')),
    content_hash        text NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT entitlements_conn_ref_unique UNIQUE (connection_id, external_ref)
);
CREATE INDEX ix_entitlements_steam ON entitlements (tenant_id, steam_id) WHERE status = 'active';
CREATE INDEX ix_entitlements_player ON entitlements (player_account_id) WHERE player_account_id IS NOT NULL;

-- Webhook idempotency + audit. verify signature -> INSERT ON CONFLICT DO NOTHING -> if
-- newly inserted, apply the entitlement delta in the same tx -> 2xx. A replayed event
-- (same connection_id + event_id) is a no-op.
CREATE TABLE store_webhook_events (
    id            uuid PRIMARY KEY DEFAULT uuidv7(),
    tenant_id     uuid NOT NULL,
    connection_id uuid NOT NULL REFERENCES store_connections (id) ON DELETE CASCADE,
    provider      text NOT NULL,
    event_id      text NOT NULL,
    event_type    text,
    payload       jsonb,
    received_at   timestamptz NOT NULL DEFAULT now(),
    processed_at  timestamptz,
    error         text,

    CONSTRAINT store_webhook_events_conn_event_unique UNIQUE (connection_id, event_id)
);
CREATE INDEX ix_store_webhook_events_tenant ON store_webhook_events (tenant_id, received_at DESC);

-- ============================ Row-Level Security ============================
ALTER TABLE checkout_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY checkout_sessions_isolation ON checkout_sessions
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE entitlements ENABLE ROW LEVEL SECURITY;
CREATE POLICY entitlements_isolation ON entitlements
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE store_webhook_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY store_webhook_events_isolation ON store_webhook_events
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- ============================ App-role grants ============================
-- Entitlements + webhook events are runner/receiver-owned (owner pool). The app role
-- reads entitlements (admin list, player-facing reads go via the owner pool on the public
-- path); checkout_sessions are written on the player request path (app pool).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cupboard_app') THEN
        GRANT SELECT, INSERT, UPDATE ON checkout_sessions TO cupboard_app;
        GRANT SELECT ON entitlements TO cupboard_app;
        GRANT SELECT ON store_webhook_events TO cupboard_app;
    END IF;
END
$$;
