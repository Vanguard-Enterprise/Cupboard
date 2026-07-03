-- Phase 3 PR5 — rich ingestion: F7 player reports + chat source tagging.

-- F7 reports (plugin push only; RCON can't see them). Tenant-scoped moderation context:
-- repeated reports against one player are a strong review signal.
--
-- PII discipline: names/subject/message are erasable player content; *_player_id point
-- at durable surrogates (nullable — a report can name a player the graph hasn't resolved).
CREATE TABLE player_reports (
    id                 uuid PRIMARY KEY DEFAULT uuidv7(),
    tenant_id          uuid NOT NULL,
    server_id          uuid NOT NULL,
    reporter_player_id uuid REFERENCES players (id),
    target_player_id   uuid REFERENCES players (id),
    reporter_name      text,
    target_name        text,
    subject            text,
    message            text,
    report_type        text,                -- F7 category, raw (cheat, abusive, …)
    reported_at        timestamptz NOT NULL
);
CREATE INDEX ix_reports_tenant_time ON player_reports (tenant_id, reported_at DESC);
-- Profile view + "most-reported" aggregation.
CREATE INDEX ix_reports_target ON player_reports (target_player_id)
    WHERE target_player_id IS NOT NULL;

ALTER TABLE player_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY player_reports_isolation ON player_reports
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cupboard_app') THEN
        -- Reads for the dashboard; ingestion writes on the owner pool.
        GRANT SELECT ON player_reports TO cupboard_app;
    END IF;
END
$$;

-- Chat source tagging: a server running RCON *and* the plugin reports every message
-- twice; ingest dedupes across sources (same player+message, different source, ±15s).
-- Pre-existing rows stay NULL (unknown source) and never suppress an insert.
ALTER TABLE chat_messages ADD COLUMN source text
    CHECK (source IN ('rcon', 'plugin'));
