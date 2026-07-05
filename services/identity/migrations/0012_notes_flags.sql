-- Phase 4 PR4: player notes + flags (docs/identity-schema.md "player_notes" /
-- "player_flags", modernized: uuidv7 ids, updated_at, and an origin column so BM
-- imports coexist with native rows). Tenant-scoped (RLS). BM fidelity that the local
-- row can't hold (shared flag, clearance level, expiry) rides bm_sync_map.meta.

CREATE TABLE player_notes (
    id         uuid PRIMARY KEY DEFAULT uuidv7(),
    tenant_id  uuid NOT NULL,
    player_id  uuid NOT NULL REFERENCES players (id),
    author     uuid,               -- staff user (Auth); NULL for imported notes
    body       text NOT NULL,
    pinned     boolean NOT NULL DEFAULT false,
    origin     text NOT NULL DEFAULT 'cupboard',  -- cupboard | bm
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_player_notes_player ON player_notes (tenant_id, player_id, created_at DESC);
ALTER TABLE player_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY player_notes_isolation ON player_notes
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- NOTE: player_flags has no reader/writer yet. The staff flag CRUD + BM flag import that
-- exercise (and validate) this schema land in PR6; the table ships here so that PR builds
-- on a stable migration rather than adding one late.
CREATE TABLE player_flags (
    id         uuid PRIMARY KEY DEFAULT uuidv7(),
    tenant_id  uuid NOT NULL,
    player_id  uuid NOT NULL REFERENCES players (id),
    label      text NOT NULL,
    color      text,
    created_by uuid,               -- staff user (Auth); NULL for imported flags
    origin     text NOT NULL DEFAULT 'cupboard',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_player_flags_player ON player_flags (tenant_id, player_id);
ALTER TABLE player_flags ENABLE ROW LEVEL SECURITY;
CREATE POLICY player_flags_isolation ON player_flags
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cupboard_app') THEN
        -- Staff CRUD on the request path; the import runner writes on the owner pool.
        GRANT SELECT, INSERT, UPDATE, DELETE ON player_notes TO cupboard_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON player_flags TO cupboard_app;
    END IF;
END
$$;
