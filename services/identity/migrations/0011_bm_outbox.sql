-- Phase 4 PR3 (docs/phase4-plan.md decision J): transactional outbox for outbound ban
-- sync. A row is appended in the SAME transaction as bans::create/revoke when the
-- tenant has outbound sync on, so a staff ban never waits on BM and never gets lost:
-- the runner drains rows through the shared rate-limited client.
--
-- Statuses: pending (due when next_attempt_at <= now) -> inflight (being pushed) ->
-- done | failed (retries exhausted) | abandoned (unsupported subject; visible, final).
-- needs_verify marks an ambiguous mutation (timeout after send, no idempotency keys on
-- BM): the drainer existence-checks before re-issuing.

CREATE TABLE bm_outbox (
    id              uuid PRIMARY KEY DEFAULT uuidv7(),
    tenant_id       uuid NOT NULL,
    entity_type     text NOT NULL DEFAULT 'ban' CHECK (entity_type IN ('ban')),
    local_id        uuid NOT NULL,
    op              text NOT NULL CHECK (op IN ('create', 'delete')),
    -- Snapshot at enqueue (subject, reason, expires for create; the map lookup key
    -- travels via local_id). The push uses the snapshot, not the live row, so a
    -- later local edit can't smuggle into an older op.
    payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'inflight', 'needs_verify', 'done', 'failed', 'abandoned')),
    attempts        int NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    last_error      text,
    created_at      timestamptz NOT NULL DEFAULT now()
);
-- Drain order is per-tenant FIFO (create-then-revoke of the same ban must arrive in
-- order); the partial index keeps the due-scan cheap as done rows accumulate.
CREATE INDEX ix_bm_outbox_due ON bm_outbox (tenant_id, created_at)
    WHERE status IN ('pending', 'inflight', 'needs_verify');
ALTER TABLE bm_outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY bm_outbox_isolation ON bm_outbox
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cupboard_app') THEN
        -- The request path (ban create/revoke, backfill opt-in) INSERTs rows inside
        -- its own tx; staff read the queue state on the status page. Drain updates
        -- run on the owner pool.
        GRANT SELECT, INSERT ON bm_outbox TO cupboard_app;
    END IF;
END
$$;
