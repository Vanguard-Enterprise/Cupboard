-- Phase 4 PR4: fleet-side support for imported game servers. BattleMetrics (via the
-- import runner, a separate service) discovers servers the tenant doesn't yet have wired
-- into Cupboard; this lets Fleet track where a row came from and re-import idempotently.
--
-- `origin` distinguishes rows created through the tenant-facing API (`cupboard`, the
-- existing default) from rows created by an external import (`bm`). `external_id` is the
-- source system's stable id for the server (BattleMetrics server id); it is NULL for
-- `cupboard`-origin rows, which have no external counterpart.
--
-- Imported servers are upserted by (tenant_id, external_id) so re-running an import is
-- idempotent: the same external server always resolves to the same row instead of piling
-- up duplicates.

ALTER TABLE servers
    ADD COLUMN origin      text NOT NULL DEFAULT 'cupboard',
    ADD COLUMN external_id text;
COMMENT ON COLUMN servers.origin IS 'cupboard | bm';

-- Partial (not plain) so `cupboard`-origin rows, which never have an external_id, don't
-- collide with each other under the uniqueness check.
CREATE UNIQUE INDEX ux_servers_external ON servers (tenant_id, external_id)
    WHERE external_id IS NOT NULL;
