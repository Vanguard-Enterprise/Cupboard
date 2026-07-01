-- Phase 2 — Identity & Moderation cross-cutting closeout:
--   * audit_log      — moderation/player-data audit (Identity owns this; Decision 16)
--   * merge_log      — best-effort reversibility record for player merges
--   * sharing pools  — schema stub for opt-in cross-tenant ban sharing (Decision 15);
--                      enforcement/UI deferred to a later phase.

-- Per-tenant audit log (RLS). `tenant_id` NULL = a system/global action (e.g. a merge).
CREATE TABLE audit_log (
    id          uuid PRIMARY KEY DEFAULT uuidv7(),
    tenant_id   uuid,
    actor_id    uuid,
    action      text NOT NULL,
    target_type text,
    target_id   uuid,
    metadata    jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_tenant_time ON audit_log (tenant_id, created_at DESC);
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
-- Tenant-scoped rows are visible/insertable by the tenant; system-global (NULL) rows are
-- written on the owner pool and invisible to tenant reads (intended).
CREATE POLICY audit_log_isolation ON audit_log
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- Merge audit + snapshot (global). System-only.
CREATE TABLE merge_log (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    from_player  uuid NOT NULL,
    into_player  uuid NOT NULL,
    performed_by uuid,               -- staff user, or NULL = system
    reason       text,
    snapshot     jsonb,              -- repointed-row counts, to support un-merge
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- ============================ Sharing pools (stub) ============================
CREATE TABLE sharing_pools (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    name         text NOT NULL,
    owner_tenant uuid NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pool_members (
    pool_id   uuid NOT NULL REFERENCES sharing_pools (id),
    tenant_id uuid NOT NULL,
    role      text NOT NULL DEFAULT 'member',
    status    text NOT NULL DEFAULT 'active',
    joined_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (pool_id, tenant_id)
);
CREATE TABLE ban_pool_shares (
    ban_id  uuid NOT NULL REFERENCES bans (id),
    pool_id uuid NOT NULL REFERENCES sharing_pools (id),
    PRIMARY KEY (ban_id, pool_id)
);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cupboard_app') THEN
        GRANT SELECT, INSERT ON audit_log TO cupboard_app;
        GRANT SELECT ON merge_log TO cupboard_app;
        -- Pools: forward grants for the future sharing API.
        GRANT SELECT, INSERT, UPDATE, DELETE ON sharing_pools, pool_members, ban_pool_shares
            TO cupboard_app;
    END IF;
END
$$;
