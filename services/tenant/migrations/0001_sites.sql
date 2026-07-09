-- Phase 5, tenant service schema part 1: white-label sites. Lives in the `tenant`
-- Postgres schema (search_path=tenant,public) so its objects and its own
-- `_sqlx_migrations` ledger stay isolated from other services in the shared database.
--
-- One site per organization (v1): `tenant_id` is UNIQUE. The slug is globally unique;
-- it is the leftmost DNS label of the site's default hostname `{slug}.{SITES_SUFFIX}`.
-- Custom domains arrive in a later migration (`site_domains`).
--
-- Requires PostgreSQL 18 for the built-in `uuidv7()` (matches the other services).

CREATE TABLE sites (
    id         uuid PRIMARY KEY DEFAULT uuidv7(),
    tenant_id  uuid NOT NULL,
    -- DNS-label shape (3-40 chars, lowercase alnum + inner hyphens). The reserved-name
    -- list lives in application code so it can evolve without a migration.
    slug       text NOT NULL
               CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])$'),
    -- Validated against the web theme registry in application code (no DB enum: themes
    -- ship without migrations).
    theme_id   text NOT NULL DEFAULT 'ember',
    -- Operator-supplied theme configuration (logo, colors, hero, content blocks). Free
    -- JSON, structurally validated by the site editor; size-bounded by the service.
    config     jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- v1: informational (the default subdomain always serves, so operators can preview).
    -- Custom-domain serving (PR5) requires published=true.
    published  boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT sites_tenant_unique UNIQUE (tenant_id),
    CONSTRAINT sites_slug_unique UNIQUE (slug)
);

-- Per-tenant audit log for site/store administration (identity's audit_log pattern;
-- every service owns its own schema-local audit table).
CREATE TABLE audit_log (
    id          uuid PRIMARY KEY DEFAULT uuidv7(),
    tenant_id   uuid,
    actor_id    uuid,
    action      text NOT NULL,
    target_type text,
    target_id   uuid,
    metadata    jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_tenant_audit_tenant_time ON audit_log (tenant_id, created_at DESC);

-- ============================ Row-Level Security ============================
-- ENABLE (not FORCE) RLS: the non-owner request role is filtered by the policy; the
-- owner role bypasses it for cross-tenant public site resolution. No explicit WITH
-- CHECK, so the USING predicate also governs writes.
ALTER TABLE sites ENABLE ROW LEVEL SECURITY;
CREATE POLICY sites_isolation ON sites
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_audit_isolation ON audit_log
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- ============================ App-role grants ============================
-- The non-owner request role, created out-of-band (CNPG managed.roles in staging; the
-- test harness locally) BEFORE this migration runs. Guarded so plain local dev without
-- the role still migrates cleanly.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cupboard_app') THEN
        GRANT USAGE ON SCHEMA tenant, public TO cupboard_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON sites TO cupboard_app;
        GRANT SELECT, INSERT ON audit_log TO cupboard_app;
    END IF;
END
$$;
