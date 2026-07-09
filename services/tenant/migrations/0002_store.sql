-- Phase 5, tenant service schema part 2: commerce (store-provider connections + the
-- catalog cache). One store connection per organization (v1); the provider column keeps
-- the row shape uniform for Tebex (PR6).
--
-- Credentials are envelope-encrypted at rest exactly like BM tokens and RCON passwords
-- (cupboard-crypto::envelope): `api_key_enc` is the secret under a per-row data key,
-- `api_key_dek` is that data key wrapped by the TENANT_MASTER_KEY from Vault. They are
-- write-only: no API ever returns them. Nullable so a disconnect can shred the secret
-- while keeping the row (catalog + future entitlement history stay intact).

CREATE TABLE store_connections (
    id                   uuid PRIMARY KEY DEFAULT uuidv7(),
    tenant_id            uuid NOT NULL,
    provider             text NOT NULL CHECK (provider IN ('paynow', 'tebex')),
    status               text NOT NULL DEFAULT 'connected'
                         CHECK (status IN ('connected', 'error', 'disconnected')),

    api_key_enc          bytea,
    api_key_dek          bytea,

    -- Provider-side store identity, discovered at probe time. PayNow flake ids are
    -- int64 serialized as strings; stored as text verbatim.
    store_external_id    text NOT NULL,
    store_name           text,
    store_currency       text,
    -- Provider store test/live state (PayNow live_mode; informational).
    store_live           boolean,

    -- Webhook registration lands in PR4 (secret envelope-encrypted like the API key).
    webhook_secret_enc   bytea,
    webhook_secret_dek   bytea,
    webhook_external_id  text,

    settings             jsonb NOT NULL DEFAULT '{}'::jsonb,
    last_error           text,

    -- Catalog sync scheduling: the runner syncs when now() >= next_catalog_sync_at.
    -- "Sync now" sets it to now(); a completed sync sets it +interval.
    next_catalog_sync_at timestamptz NOT NULL DEFAULT now(),
    catalog_synced_at    timestamptz,

    -- Runner lease (BM connection pattern): one runner per connection, stale takeover.
    claimed_by           text,
    heartbeat_at         timestamptz,

    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT store_connections_tenant_unique UNIQUE (tenant_id)
);

-- Cached provider catalog, refreshed by the runner via full-list content-hash diff.
-- The public storefront renders ONLY from these tables; it never calls a provider on a
-- request path. Rows for products that vanish from the provider are soft-deleted
-- (deleted_at) so future entitlement references stay resolvable.
CREATE TABLE store_products (
    id                 uuid PRIMARY KEY DEFAULT uuidv7(),
    tenant_id          uuid NOT NULL,
    connection_id      uuid NOT NULL REFERENCES store_connections (id) ON DELETE CASCADE,
    external_id        text NOT NULL,
    slug               text,
    name               text NOT NULL,
    description        text,
    image_url          text,
    -- Lowest-denomination price (PayNow serves integer minor units) + display price
    -- after provider-side sales/regional pricing.
    price_minor        bigint NOT NULL DEFAULT 0,
    price_final_minor  bigint,
    currency           text NOT NULL,
    kind               text NOT NULL DEFAULT 'single' CHECK (kind IN ('single', 'subscription')),
    interval_value     integer,
    interval_scale     text,
    category_ids       jsonb NOT NULL DEFAULT '[]'::jsonb,
    available          boolean NOT NULL DEFAULT true,
    sort_order         integer NOT NULL DEFAULT 0,
    raw                jsonb,
    content_hash       text NOT NULL,
    first_seen_at      timestamptz NOT NULL DEFAULT now(),
    last_seen_at       timestamptz NOT NULL DEFAULT now(),
    deleted_at         timestamptz,

    CONSTRAINT store_products_conn_ext_unique UNIQUE (connection_id, external_id)
);
CREATE INDEX ix_store_products_tenant ON store_products (tenant_id) WHERE deleted_at IS NULL;

-- Provider categories (PayNow calls them tags): navigation grouping for the storefront.
CREATE TABLE store_categories (
    id            uuid PRIMARY KEY DEFAULT uuidv7(),
    tenant_id     uuid NOT NULL,
    connection_id uuid NOT NULL REFERENCES store_connections (id) ON DELETE CASCADE,
    external_id   text NOT NULL,
    slug          text,
    name          text NOT NULL,
    description   text,
    image_url     text,
    sort_order    integer NOT NULL DEFAULT 0,
    content_hash  text NOT NULL,
    deleted_at    timestamptz,

    CONSTRAINT store_categories_conn_ext_unique UNIQUE (connection_id, external_id)
);
CREATE INDEX ix_store_categories_tenant ON store_categories (tenant_id) WHERE deleted_at IS NULL;

-- ============================ Row-Level Security ============================
ALTER TABLE store_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY store_connections_isolation ON store_connections
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE store_products ENABLE ROW LEVEL SECURITY;
CREATE POLICY store_products_isolation ON store_products
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE store_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY store_categories_isolation ON store_categories
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- ============================ App-role grants ============================
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cupboard_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON store_connections TO cupboard_app;
        -- Catalog rows are runner-owned (owner pool); request paths only read them.
        GRANT SELECT ON store_products TO cupboard_app;
        GRANT SELECT ON store_categories TO cupboard_app;
    END IF;
END
$$;
