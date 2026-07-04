-- Phase 4 PR4 outbox hygiene. The status-page poll (outbox_summary: tenant_id AND
-- status <> 'done') and the request-path retry/re-point writes could not use the partial
-- due-index (which excludes done/failed/abandoned), forcing seq scans as settled rows
-- accumulate. This composite index covers both; the drain also opportunistically prunes
-- old done rows.
CREATE INDEX ix_bm_outbox_tenant_status ON bm_outbox (tenant_id, status, created_at);

-- The retry endpoint (failed -> pending) and the org re-point cleanup (abandon in-flight
-- ops) UPDATE the outbox on the request path (RLS-scoped app pool); the drain already
-- runs on the owner pool. The isolation policy already scopes visibility.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cupboard_app') THEN
        GRANT UPDATE ON bm_outbox TO cupboard_app;
    END IF;
END
$$;
