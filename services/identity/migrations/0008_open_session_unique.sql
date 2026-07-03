-- Phase 3 hardening — make "at most one open session per (tenant, server, player)"
-- an enforced invariant. The session upsert was a non-atomic SELECT-then-INSERT, and
-- Phase 3 added a second concurrent writer (the real-time session-edge consumer racing
-- the roster consumer), so a connect observed by both could open two sessions for the
-- same player. Ingestion now uses INSERT ... ON CONFLICT against this partial unique
-- index, which also makes the invariant impossible to violate going forward.

-- Close any pre-existing duplicate open sessions before the unique index can be built:
-- keep the earliest-connected open row per (tenant, server, player), close the rest at
-- their last_seen_at (best available end time).
UPDATE player_sessions ps SET disconnected_at = ps.last_seen_at
WHERE ps.disconnected_at IS NULL
  AND EXISTS (
      SELECT 1 FROM player_sessions keep
      WHERE keep.tenant_id = ps.tenant_id
        AND keep.server_id = ps.server_id
        AND keep.player_id = ps.player_id
        AND keep.disconnected_at IS NULL
        AND (keep.connected_at, keep.id) < (ps.connected_at, ps.id)
  );

-- Replace the non-unique open-session index with a unique partial index (same predicate
-- and columns, so it still serves the ingestion open-session lookup).
DROP INDEX IF EXISTS ix_session_open;
CREATE UNIQUE INDEX ix_session_open
    ON player_sessions (tenant_id, server_id, player_id)
    WHERE disconnected_at IS NULL;
