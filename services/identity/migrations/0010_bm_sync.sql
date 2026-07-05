-- Phase 4 PR2 (docs/phase4-plan.md decisions H/I): inbound sync bookkeeping.
--
-- BM exposes no last-modified field and no ban webhooks, so inbound sync is a fast
-- tail poll (new bans) plus a periodic full re-scan (edits by content-hash diff,
-- deletes by absence). Conflicts (a BM edit arriving for a locally-revoked ban) are
-- logged here for the review UI; the local action wins (decision I).

CREATE TABLE bm_sync_conflicts (
    id              uuid PRIMARY KEY DEFAULT uuidv7(),
    tenant_id       uuid NOT NULL,
    entity_type     text NOT NULL
                    CHECK (entity_type IN ('ban', 'player', 'note', 'flag', 'ban_list', 'server')),
    external_id     text NOT NULL,
    local_id        uuid,
    direction       text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    local_snapshot  jsonb,
    remote_snapshot jsonb,
    resolution      text NOT NULL DEFAULT 'local_won'
                    CHECK (resolution IN ('local_won', 'remote_won', 'manual_pending', 'manual_resolved')),
    resolved_by     uuid,
    resolved_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_bm_sync_conflicts_tenant ON bm_sync_conflicts (tenant_id, created_at DESC);
ALTER TABLE bm_sync_conflicts ENABLE ROW LEVEL SECURITY;
CREATE POLICY bm_sync_conflicts_isolation ON bm_sync_conflicts
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- Sync loop observability, surfaced on the status page. Written by the runner (owner
-- pool); read tenant-scoped.
ALTER TABLE bm_connections
    ADD COLUMN last_tail_at timestamptz,
    ADD COLUMN last_scan_at timestamptz,
    ADD COLUMN sync_error   text;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cupboard_app') THEN
        -- Staff review conflicts (resolution updates) on the request path.
        GRANT SELECT, UPDATE ON bm_sync_conflicts TO cupboard_app;
    END IF;
END
$$;
