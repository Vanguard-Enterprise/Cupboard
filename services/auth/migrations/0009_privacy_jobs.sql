-- Phase 7 PR2 - privacy export/erasure jobs (decisions A/A2/C/D). One row per
-- coordinator job: auth fans the subject identifiers out to identity/tenant walkers
-- and records progress, dry-run counts, and (for exports) the gzip bundle here.
--
-- GLOBAL table, no RLS (a person spans tenants by design); owner-pool writes only,
-- like org_plans (0008): no request path reads it through the app pool, so no
-- cupboard_app grant. `tenant_id` is the SCOPE of a tenant-scoped job (decision A2),
-- not an RLS key. The bundle is stored inline (bytea, bounded sizes; decision C)
-- with a TTL and a one-time download, and the subject identifiers stay raw here:
-- auth is the store that legitimately holds provider+subject, and identity hashes
-- them internally on receipt (decision A).

CREATE TABLE privacy_jobs (
    id                uuid PRIMARY KEY DEFAULT uuidv7(),
    kind              text NOT NULL CHECK (kind IN ('export', 'erase')),
    scope_kind        text NOT NULL CHECK (scope_kind IN ('platform', 'tenant')),
    tenant_id         uuid,
    steam_id          text,
    discord_id        text,
    player_account_id uuid,
    status            text NOT NULL DEFAULT 'queued' CHECK
        (status IN ('queued', 'running', 'awaiting_confirm', 'completed', 'failed')),
    dry_run_counts    jsonb,
    result_counts     jsonb,
    error             text,
    -- The requesting operator's user id; NULL for player self-serve and runbook jobs.
    requested_by      uuid,
    requested_via     text NOT NULL CHECK (requested_via IN ('operator', 'player', 'runbook')),
    bundle            bytea,
    bundle_expires_at timestamptz,
    downloaded_at     timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    -- Tenant scope requires a tenant id; platform scope forbids one (decision A2).
    CONSTRAINT privacy_jobs_tenant_scope CHECK ((scope_kind = 'tenant') = (tenant_id IS NOT NULL)),
    -- A job must name its subject by at least one identifier.
    CONSTRAINT privacy_jobs_subject CHECK (
        steam_id IS NOT NULL OR discord_id IS NOT NULL OR player_account_id IS NOT NULL
    )
);

-- The worker's claim scan only ever looks at queued rows.
CREATE INDEX ix_privacy_jobs_queued ON privacy_jobs (created_at) WHERE status = 'queued';
-- Operator job listings, newest first.
CREATE INDEX ix_privacy_jobs_requester ON privacy_jobs (requested_by, created_at DESC);
