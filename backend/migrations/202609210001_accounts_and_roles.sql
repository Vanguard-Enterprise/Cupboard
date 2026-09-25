CREATE TABLE accounts (
    id text PRIMARY KEY,
    name text NOT NULL,
    email text NOT NULL UNIQUE CHECK (email = lower(email)),
    password_hash text NOT NULL,
    last_login_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE organizations (
    id text PRIMARY KEY,
    name text NOT NULL,
    revision bigint NOT NULL DEFAULT 0
);
CREATE TABLE organization_roles (
    organization_id text NOT NULL REFERENCES organizations(id),
    id text NOT NULL,
    name text NOT NULL,
    description text NOT NULL,
    permissions text[] NOT NULL,
    system boolean NOT NULL DEFAULT false,
    PRIMARY KEY (organization_id, id)
);
CREATE UNIQUE INDEX organization_role_names ON organization_roles (organization_id, lower(name));
CREATE TABLE organization_members (
    id text PRIMARY KEY,
    organization_id text NOT NULL REFERENCES organizations(id),
    account_id text REFERENCES accounts(id),
    name text NOT NULL,
    email text NOT NULL,
    role_id text NOT NULL,
    status text NOT NULL CHECK (status IN ('active', 'invited', 'suspended')),
    invitation_hash text UNIQUE,
    invitation_expires_at timestamptz,
    FOREIGN KEY (organization_id, role_id) REFERENCES organization_roles(organization_id, id),
    UNIQUE (organization_id, email),
    UNIQUE (organization_id, account_id),
    CHECK ((status = 'invited' AND account_id IS NULL) OR (status <> 'invited' AND account_id IS NOT NULL))
);
CREATE INDEX account_memberships ON organization_members(account_id);
CREATE TABLE auth_attempts (
    bucket text PRIMARY KEY,
    attempts integer NOT NULL,
    expires_at timestamptz NOT NULL
);
-- Schema expected by tower-sessions-sqlx-store 0.15. Migrations stay in our ledger.
CREATE SCHEMA tower_sessions;
CREATE TABLE tower_sessions.session (
    id text PRIMARY KEY,
    data bytea NOT NULL,
    expiry_date timestamptz NOT NULL
);
CREATE INDEX session_expiry ON tower_sessions.session(expiry_date);
