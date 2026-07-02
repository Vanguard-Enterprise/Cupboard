-- Phase 3 PR1 — A2S server info. The Collector queries each server's A2S_INFO (UDP,
-- `query_port`) and heartbeats the result here, giving operators live metadata (listing
-- hostname, map, player counts) that keeps working even when RCON is down or mis-crededed.
--
-- Columns, not a table: this is a same-cardinality, last-write-wins snapshot per server,
-- exactly like the existing connection_status/last_seen_at liveness fields. History (perf
-- time-series) is Phase 3 PR6's Mimir pipeline, not Postgres.
--
-- No new grants needed: cupboard_app's existing table-level SELECT/UPDATE on `servers`
-- covers new columns.

ALTER TABLE servers
    ADD COLUMN info_hostname    text,
    ADD COLUMN info_map         text,
    ADD COLUMN info_players     integer CHECK (info_players >= 0),
    ADD COLUMN info_max_players integer CHECK (info_max_players >= 0),
    ADD COLUMN info_queued      integer CHECK (info_queued >= 0),
    ADD COLUMN info_updated_at  timestamptz;
