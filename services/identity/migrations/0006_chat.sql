-- Phase 3 PR2 — chat messages (per-tenant, RLS). Populated by the ingestion consumer
-- from the RCON console stream now, and by plugin push events later; used as moderation
-- context (chat logs page, player profiles).
--
-- PII discipline: `name` and `message` are erasable player content; `player_id` points
-- at the durable surrogate. Server/system messages carry player_id NULL. Retention/purge
-- tooling is Phase 7 (same as sessions/signals).

CREATE TABLE chat_messages (
    id          uuid PRIMARY KEY DEFAULT uuidv7(),
    tenant_id   uuid NOT NULL,
    server_id   uuid NOT NULL,
    player_id   uuid REFERENCES players (id),   -- NULL = server/system message
    channel     integer NOT NULL DEFAULT 0,     -- game channel (Rust: 0 global, 1 team, …)
    name        text,                           -- display name at send time (PII)
    message     text NOT NULL,                  -- PII
    sent_at     timestamptz NOT NULL
);
-- The chat-log page: newest messages for one server (or the whole tenant).
CREATE INDEX ix_chat_tenant_server_time ON chat_messages (tenant_id, server_id, sent_at DESC);
CREATE INDEX ix_chat_tenant_time ON chat_messages (tenant_id, sent_at DESC);
-- Profile view: one player's recent chat.
CREATE INDEX ix_chat_player ON chat_messages (player_id) WHERE player_id IS NOT NULL;

ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY chat_messages_isolation ON chat_messages
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cupboard_app') THEN
        -- Reads for the dashboard; ingestion writes on the owner pool.
        GRANT SELECT ON chat_messages TO cupboard_app;
    END IF;
END
$$;
