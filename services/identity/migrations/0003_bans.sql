-- Phase 2 — Identity & Moderation: identifier-level bans (Decision 19,
-- docs/identity-schema.md "bans"). Per-tenant (RLS). A ban targets a specific identifier
-- (Steam/EAC), not the whole player, via a durable enforcement key:
-- `subject_hash = HMAC(subject_value, pepper)` — the same key survives PII erasure and
-- powers the connect-time lookup.

CREATE TABLE bans (
    id            uuid PRIMARY KEY DEFAULT uuidv7(),
    tenant_id     uuid NOT NULL,
    subject_type  text NOT NULL CHECK (subject_type IN ('steam', 'eac')),
    subject_value text,                 -- PII — NULLed on erasure
    subject_hash  bytea NOT NULL,       -- HMAC(value, pepper) — THE enforcement key
    player_id     uuid REFERENCES players (id),  -- context only; NULLed on erasure
    scope         text NOT NULL DEFAULT 'network' CHECK (scope IN ('network', 'server')),
    server_id     uuid,                 -- required when scope = 'server'
    reason        text,
    evidence      jsonb,
    issued_by     uuid,                 -- staff user (Auth)
    issued_at     timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz,          -- NULL = permanent
    status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked')),
    revoked_by    uuid,
    revoked_at    timestamptz,
    revoke_reason text,
    origin        text NOT NULL DEFAULT 'cupboard',  -- cupboard | bm | pool
    -- A server-scoped ban must name its server.
    CONSTRAINT ban_server_scope_needs_server
        CHECK (scope <> 'server' OR server_id IS NOT NULL)
);
-- Hot path: connect-time enforcement lookup.
CREATE INDEX ix_ban_enforcement ON bans (tenant_id, subject_hash) WHERE status = 'active';
CREATE INDEX ix_ban_player ON bans (tenant_id, player_id);

ALTER TABLE bans ENABLE ROW LEVEL SECURITY;
CREATE POLICY bans_isolation ON bans
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cupboard_app') THEN
        -- Staff create/list/revoke on the request path; the Collector enforcement lookup
        -- runs on the owner pool.
        GRANT SELECT, INSERT, UPDATE ON bans TO cupboard_app;
    END IF;
END
$$;
