-- Phase 4 (docs/phase4-plan.md decisions C/D/E/F/N): BattleMetrics connection, import
-- jobs, external-ID sync mapping, and the ban-list registry. All four tables are
-- tenant-scoped (RLS). Runner claim/heartbeat columns are written on the owner pool by
-- the supervisor; request-path reads/writes go through the app pool.

CREATE TABLE bm_connections (
    id                  uuid PRIMARY KEY DEFAULT uuidv7(),
    tenant_id           uuid NOT NULL UNIQUE,   -- one BM connection per tenant
    bm_org_id           text NOT NULL,
    -- Tenant's BM personal access token, envelope-encrypted (crates/crypto): the token
    -- sealed under a fresh DEK, the DEK wrapped under IDENTITY_MASTER_KEY. Write-only:
    -- no API response ever includes it.
    token_enc           bytea NOT NULL,
    token_dek           bytea NOT NULL,
    -- Import subset + sync cadence settings (wizard-managed; defaults in code).
    settings            jsonb NOT NULL DEFAULT '{}'::jsonb,
    sync_enabled        boolean NOT NULL DEFAULT false,
    sync_bans_outbound  boolean NOT NULL DEFAULT false,
    status              text NOT NULL DEFAULT 'connected'
                        CHECK (status IN ('connected', 'error', 'disabled')),
    last_error          text,
    -- Runner lease: exactly one runner task owns a connection (its process-local rate
    -- limiter is then globally correct per token). Stale heartbeat (> 2 min) = takeover.
    claimed_by          text,
    heartbeat_at        timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE bm_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY bm_connections_isolation ON bm_connections
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE TABLE bm_import_jobs (
    id            uuid PRIMARY KEY DEFAULT uuidv7(),
    tenant_id     uuid NOT NULL,
    connection_id uuid NOT NULL REFERENCES bm_connections (id) ON DELETE CASCADE,
    status        text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
    phase         text NOT NULL DEFAULT 'ban_lists'
                  CHECK (phase IN ('servers', 'ban_lists', 'bans', 'players', 'notes', 'done')),
    -- Resumable position: {"phase": ..., "sub_id": <ban list id>, "next_url": <BM
    -- links.next verbatim>, "pending": [...]}. Written once per imported page, in the
    -- same tx as that page's rows, so a crash loses at most one page.
    cursor        jsonb NOT NULL DEFAULT '{}'::jsonb,
    phase_counts  jsonb NOT NULL DEFAULT '{}'::jsonb,
    error         text,
    requested_by  uuid,
    started_at    timestamptz,
    finished_at   timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_bm_import_jobs_conn ON bm_import_jobs (connection_id, created_at DESC);
-- At most one live job per connection.
CREATE UNIQUE INDEX ux_bm_import_jobs_live ON bm_import_jobs (connection_id)
    WHERE status IN ('queued', 'running', 'paused');
ALTER TABLE bm_import_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY bm_import_jobs_isolation ON bm_import_jobs
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- Generic external-ID sidecar (decision D): one shape for every synced entity type,
-- including fleet-owned servers (local_id then references a row in fleet's DB). The
-- content hash is the echo guard / no-op skip / edit detector; meta preserves BM
-- fidelity the local row can't hold (full identifier array, banList, orgWide, note).
CREATE TABLE bm_sync_map (
    id              uuid PRIMARY KEY DEFAULT uuidv7(),
    tenant_id       uuid NOT NULL,
    entity_type     text NOT NULL
                    CHECK (entity_type IN ('ban', 'player', 'note', 'flag', 'ban_list', 'server')),
    external_id     text NOT NULL,
    local_id        uuid NOT NULL,
    content_hash    bytea,
    meta            jsonb NOT NULL DEFAULT '{}'::jsonb,
    bm_seen_at      timestamptz,
    local_synced_at timestamptz,
    last_direction  text CHECK (last_direction IN ('inbound', 'outbound')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, entity_type, external_id),
    UNIQUE (tenant_id, entity_type, local_id)
);
ALTER TABLE bm_sync_map ENABLE ROW LEVEL SECURITY;
CREATE POLICY bm_sync_map_isolation ON bm_sync_map
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- Owned + subscribed BM ban lists (decision N): the import iterates bans per list, and
-- perm_* records what the list owner granted us (gates outbound push targets in PR3).
CREATE TABLE bm_ban_lists (
    id             uuid PRIMARY KEY DEFAULT uuidv7(),
    tenant_id      uuid NOT NULL,
    external_id    text NOT NULL,
    name           text,
    action         text,
    owner_bm_org   text,
    subscribed     boolean NOT NULL DEFAULT false,
    perm_create    boolean NOT NULL DEFAULT false,
    perm_update    boolean NOT NULL DEFAULT false,
    perm_delete    boolean NOT NULL DEFAULT false,
    import_enabled boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, external_id)
);
ALTER TABLE bm_ban_lists ENABLE ROW LEVEL SECURITY;
CREATE POLICY bm_ban_lists_isolation ON bm_ban_lists
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- Widen ban subjects for imported identifier kinds (decision F). Enforcement matches
-- by hash on observed types (steam today), so the extra types are inert until the
-- matching side learns them.
ALTER TABLE bans DROP CONSTRAINT IF EXISTS bans_subject_type_check;
ALTER TABLE bans ADD CONSTRAINT bans_subject_type_check
    CHECK (subject_type IN ('steam', 'eac', 'eos', 'beguid', 'ip', 'name'));

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cupboard_app') THEN
        -- Tenant staff manage their connection + jobs on the request path (RLS-scoped);
        -- the runner writes rows on the owner pool. Map rows are read-only for staff.
        GRANT SELECT, INSERT, UPDATE, DELETE ON bm_connections TO cupboard_app;
        GRANT SELECT, INSERT, UPDATE ON bm_import_jobs TO cupboard_app;
        GRANT SELECT ON bm_sync_map TO cupboard_app;
        GRANT SELECT, UPDATE ON bm_ban_lists TO cupboard_app;
    END IF;
END
$$;
