-- Phase 2 — Fleet schema. Lives in the `fleet` Postgres schema (search_path=fleet,public)
-- so its objects and its own `_sqlx_migrations` ledger stay isolated from other services
-- in the shared `cupboard` database.
--
-- One tenant-scoped table so far: `servers` (game-server connections). RLS isolates it by
-- `tenant_id`, enforced on the request path via the non-owner `cupboard_app` role; the
-- owner role bypasses RLS for the cross-tenant internal endpoint the Collector calls.
--
-- Requires PostgreSQL 18 for the built-in `uuidv7()` (time-ordered UUIDs → better index
-- locality on the high-write Phase 2 tables). CI + dev run PG18 to match prod CNPG.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;  -- (defensive; uuidv7 is built-in)

-- A tenant's connection to one game server. RCON credentials are envelope-encrypted at
-- rest: `rcon_password_enc` is the secret under a per-row data key, `rcon_password_dek`
-- is that data key wrapped by the Vault master key (see cupboard-crypto::envelope).
CREATE TABLE servers (
    id                uuid PRIMARY KEY DEFAULT uuidv7(),
    tenant_id         uuid NOT NULL,
    name              text NOT NULL,
    game              text NOT NULL DEFAULT 'rust',

    rcon_host         text NOT NULL,
    rcon_port         integer NOT NULL CHECK (rcon_port BETWEEN 1 AND 65535),
    rcon_password_enc bytea NOT NULL,
    rcon_password_dek bytea NOT NULL,
    query_port        integer CHECK (query_port BETWEEN 1 AND 65535),  -- A2S/UDP; wired later

    enabled           boolean NOT NULL DEFAULT true,

    -- Liveness, written by the Collector (PR3). `unknown` until it first connects.
    connection_status text NOT NULL DEFAULT 'unknown'
                      CHECK (connection_status IN ('unknown', 'connected', 'degraded', 'down')),
    last_seen_at      timestamptz,
    last_error        text,

    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_servers_tenant ON servers (tenant_id);
-- The Collector's cross-tenant "which servers should I dial?" query.
CREATE INDEX ix_servers_enabled ON servers (enabled) WHERE enabled;

-- ============================ Row-Level Security ============================
-- ENABLE (not FORCE) RLS: the non-owner request role is filtered by the policy; the owner
-- role bypasses it for the Collector-facing internal endpoint. No explicit WITH CHECK, so
-- the USING predicate also governs writes — an insert/update row must belong to the bound
-- tenant.
ALTER TABLE servers ENABLE ROW LEVEL SECURITY;
CREATE POLICY servers_isolation ON servers
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- ============================ App-role grants ============================
-- The non-owner request role, created out-of-band (CNPG managed.roles in staging; the
-- test harness locally) BEFORE this migration runs. Guarded so plain local dev without
-- the role still migrates cleanly.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cupboard_app') THEN
        GRANT USAGE ON SCHEMA fleet, public TO cupboard_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON servers TO cupboard_app;
    END IF;
END
$$;
