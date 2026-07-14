-- Phase 6 PR1 - public API keys (decision L). Org-scoped machine credentials: the raw
-- token (`cb_` + 256-bit base64url) is shown once at creation; only its keyed hash
-- (HMAC-SHA256 under TOKEN_PEPPER, the refresh/invite-token precedent) is stored, and
-- the gateway exchanges a presented token for a short-lived operator JWT via
-- /internal/api-keys/exchange (owner-pool hash lookup, cross-org by design). The
-- management surface (list/create/revoke) is tenant-scoped and rides RLS like every
-- other org table.

CREATE TABLE api_keys (
    id              uuid PRIMARY KEY,   -- uuidv7, generated app-side
    organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    name            text NOT NULL,
    token_prefix    text NOT NULL,      -- first 8 chars of the raw token, for the list UI
    key_hash        bytea NOT NULL UNIQUE,
    scopes          text[] NOT NULL,    -- Permission wire strings, capped to the creator's
    -- NOTE: no user hard-delete path exists today, so this CASCADE is inert; a future
    -- GDPR erasure that hard-deletes a users row would silently drop that operator's
    -- keys org-wide. Whoever builds erasure must decide if that is the wanted behavior.
    created_by      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz,
    revoked_at      timestamptz,
    last_used_at    timestamptz
);
CREATE INDEX ix_api_keys_org ON api_keys (organization_id);

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY api_keys_isolation ON api_keys
    USING (organization_id = current_setting('app.current_tenant', true)::uuid);

-- ============================ App-role grants ============================
-- Guarded like every prior migration so plain local dev without the role still
-- migrates cleanly.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cupboard_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON api_keys TO cupboard_app;
    END IF;
END
$$;
