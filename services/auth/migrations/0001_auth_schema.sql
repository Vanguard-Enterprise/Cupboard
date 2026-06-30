-- Phase 1 — Tenancy & Auth schema. Lives in the `auth` Postgres schema (the service
-- connects with search_path=auth,public), so its objects and its own `_sqlx_migrations`
-- ledger are isolated from the gateway's in the shared `cupboard` database.
--
-- Two layers of isolation:
--   * Global tables (users, user_identities, sessions) carry no tenant and have no RLS.
--   * Tenant-scoped tables carry `organization_id` (the org IS the tenant) and enforce
--     Row-Level Security. Isolation hinges on connecting the request path as the
--     NON-OWNER `cupboard_app` role, which IS subject to the policies. The owner role
--     bypasses RLS by virtue of owning the tables — which is exactly what the few
--     cross-tenant/system operations (signup, create-org, list-my-orgs) need, so they
--     run on the owner pool. (We deliberately do NOT `FORCE` RLS: forcing it would
--     subject the owner/system path to the policies too and break unscoped inserts like
--     creating a brand-new org before any tenant context exists.)

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;  -- gen_random_uuid
CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;    -- case-insensitive email

-- ============================ Global identity (no RLS) ============================

-- An operator/staff account. Global — one user may belong to several organizations.
CREATE TABLE users (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email          citext UNIQUE,                 -- NULL allowed for Discord-only accounts
    email_verified boolean NOT NULL DEFAULT false,
    password_hash  text,                          -- NULL = no password (Discord-only / invite pending)
    display_name   text NOT NULL,
    status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- External login identities linked to a user (Discord today; Steam is for player
-- accounts in a later phase, not operators).
CREATE TABLE user_identities (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider         text NOT NULL CHECK (provider IN ('discord')),
    provider_user_id text NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_user_id)
);
CREATE INDEX ix_user_identities_user ON user_identities (user_id);

-- Refresh-token sessions. Only the keyed hash of the token is stored; the raw token is
-- shown to the client once. Access (JWT) tokens are stateless and not stored.
CREATE TABLE sessions (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    refresh_token_hash bytea NOT NULL UNIQUE,
    user_agent         text,
    ip                 text,                       -- PII; retention worker in a later phase
    created_at         timestamptz NOT NULL DEFAULT now(),
    last_used_at       timestamptz NOT NULL DEFAULT now(),
    expires_at         timestamptz NOT NULL,
    revoked_at         timestamptz
);
CREATE INDEX ix_sessions_user ON sessions (user_id);

-- ============================ Tenant-scoped (RLS) ============================

-- An organization is a tenant. Its `id` is the value bound to `app.current_tenant`.
CREATE TABLE organizations (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug       text NOT NULL UNIQUE,
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'invited', 'suspended')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, user_id)
);
CREATE INDEX ix_memberships_user ON memberships (user_id);
CREATE INDEX ix_memberships_org ON memberships (organization_id);

CREATE TABLE roles (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    name            text NOT NULL,
    immutable       boolean NOT NULL DEFAULT false,  -- the Owner role; cannot be edited/deleted
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, name)
);
CREATE INDEX ix_roles_org ON roles (organization_id);

-- The permission catalog is global reference data, seeded from code at boot.
CREATE TABLE permission_catalog (
    permission  text PRIMARY KEY,
    area        text NOT NULL,
    description text NOT NULL
);

-- Join tables carry `organization_id` too so RLS isolates them directly (the org graph
-- is never readable across tenants, even via a join-table leak).
CREATE TABLE role_permissions (
    organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    role_id         uuid NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
    permission      text NOT NULL REFERENCES permission_catalog (permission),
    PRIMARY KEY (role_id, permission)
);

CREATE TABLE membership_roles (
    organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    membership_id   uuid NOT NULL REFERENCES memberships (id) ON DELETE CASCADE,
    role_id         uuid NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
    PRIMARY KEY (membership_id, role_id)
);

CREATE TABLE invites (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    email            citext NOT NULL,
    token_hash       bytea NOT NULL UNIQUE,        -- keyed hash; raw token in the emailed link only
    invited_by       uuid REFERENCES users (id),
    status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
    created_at       timestamptz NOT NULL DEFAULT now(),
    expires_at       timestamptz NOT NULL,
    accepted_at      timestamptz,
    accepted_user_id uuid REFERENCES users (id)
);
CREATE INDEX ix_invites_org ON invites (organization_id);

CREATE TABLE invite_roles (
    organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    invite_id       uuid NOT NULL REFERENCES invites (id) ON DELETE CASCADE,
    role_id         uuid NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
    PRIMARY KEY (invite_id, role_id)
);

-- Central audit log of staff/admin actions. `organization_id` NULL = system/global.
CREATE TABLE audit_log (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid,
    actor_id        uuid,
    action          text NOT NULL,
    target_type     text,
    target_id       uuid,
    metadata        jsonb,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_org_time ON audit_log (organization_id, created_at DESC);

-- ============================ Row-Level Security ============================
-- Every tenant table: ENABLE RLS + a FOR ALL policy whose predicate is the bound
-- tenant. With no explicit WITH CHECK, Postgres reuses the USING predicate for writes,
-- so INSERT/UPDATE rows must also belong to the current tenant. The `cupboard_app`
-- (non-owner) role is subject to these; the owner role bypasses them.

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY organizations_isolation ON organizations
    USING (id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY memberships_isolation ON memberships
    USING (organization_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY roles_isolation ON roles
    USING (organization_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY role_permissions_isolation ON role_permissions
    USING (organization_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE membership_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY membership_roles_isolation ON membership_roles
    USING (organization_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
CREATE POLICY invites_isolation ON invites
    USING (organization_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE invite_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY invite_roles_isolation ON invite_roles
    USING (organization_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
-- Audit rows may be system-global (NULL org); those are invisible to tenant-scoped
-- reads, which is intended — only the owner role reads global audit.
CREATE POLICY audit_log_isolation ON audit_log
    USING (organization_id = current_setting('app.current_tenant', true)::uuid);

-- ============================ App-role grants ============================
-- The non-owner request role. Created out-of-band (CNPG managed.roles in staging; the
-- integration-test harness locally) BEFORE this migration runs, so the grants apply.
-- Guarded so plain local dev without the role still migrates cleanly.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cupboard_app') THEN
        GRANT USAGE ON SCHEMA auth, public TO cupboard_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON
            organizations, memberships, roles, role_permissions,
            membership_roles, invites, invite_roles, audit_log
            TO cupboard_app;
        GRANT SELECT ON users, permission_catalog TO cupboard_app;
    END IF;
END
$$;
