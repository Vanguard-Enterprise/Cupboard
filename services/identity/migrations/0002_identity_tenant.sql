-- Phase 2 — Identity & Moderation: the PER-TENANT layer (RLS). Each tenant's private
-- observation of players on their servers. Isolated by `tenant_id` via Row-Level Security,
-- enforced on the request path through the non-owner `cupboard_app` role; the owner role
-- (used by the ingestion consumer) bypasses RLS and sets tenant_id explicitly.

-- A tenant's observation of a player on one of its servers. Each roster poll upserts the
-- open session and closes sessions for players no longer present.
CREATE TABLE player_sessions (
    id              uuid PRIMARY KEY DEFAULT uuidv7(),
    tenant_id       uuid NOT NULL,
    server_id       uuid NOT NULL,
    player_id       uuid NOT NULL REFERENCES players (id),
    connected_at    timestamptz NOT NULL,
    disconnected_at timestamptz,               -- NULL = currently online (by last poll)
    last_seen_at    timestamptz NOT NULL DEFAULT now(),
    ip              text,                       -- PII — NULLed on erasure/retention
    ip_hash         bytea,
    name            text,
    playtime_secs   integer
);
CREATE INDEX ix_session_tenant_server_time
    ON player_sessions (tenant_id, server_id, connected_at DESC);
CREATE INDEX ix_session_player ON player_sessions (player_id);
-- Fast "the open session for this player on this server" lookup during ingestion.
CREATE INDEX ix_session_open
    ON player_sessions (tenant_id, server_id, player_id)
    WHERE disconnected_at IS NULL;

ALTER TABLE player_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY player_sessions_isolation ON player_sessions
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cupboard_app') THEN
        -- Reads for the dashboard; ingestion writes on the owner pool.
        GRANT SELECT ON player_sessions TO cupboard_app;
    END IF;
END
$$;
