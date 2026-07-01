-- Phase 2 — Identity & Moderation: automatic advisory alt-links + ban-evasion alerts
-- (Decisions 17-19, docs/identity-schema.md). Links are advisory only (bans are
-- identifier-level, so a false-positive link never auto-bans); they drive evasion alerts.

-- Global, automatic links between two players, scored from shared signals. System-only.
CREATE TABLE player_links (
    id                uuid PRIMARY KEY DEFAULT uuidv7(),
    player_a          uuid NOT NULL REFERENCES players (id),  -- stored with player_a < player_b
    player_b          uuid NOT NULL REFERENCES players (id),
    confidence        real NOT NULL,                          -- 0..1
    signals           jsonb NOT NULL,                         -- {"shared":["ip","steam_owner"]}
    first_detected_at timestamptz NOT NULL DEFAULT now(),
    last_evaluated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (player_a < player_b)
);
CREATE UNIQUE INDEX ux_link_pair ON player_links (player_a, player_b);
CREATE INDEX ix_link_a ON player_links (player_a);
CREATE INDEX ix_link_b ON player_links (player_b);

-- Per-org PRIVATE links (do NOT enter the global graph). RLS.
CREATE TABLE manual_links (
    id         uuid PRIMARY KEY DEFAULT uuidv7(),
    tenant_id  uuid NOT NULL,
    player_a   uuid NOT NULL REFERENCES players (id),
    player_b   uuid NOT NULL REFERENCES players (id),
    reason     text,
    created_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (player_a < player_b)
);
CREATE INDEX ix_manual_link_tenant ON manual_links (tenant_id);
ALTER TABLE manual_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY manual_links_isolation ON manual_links
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- Per-tenant ban-evasion alerts (RLS). Raised when a connecting player is *linked* to a
-- player with an active ban on this tenant. Default response = alert, not auto-ban.
CREATE TABLE ban_evasion_alerts (
    id             uuid PRIMARY KEY DEFAULT uuidv7(),
    tenant_id      uuid NOT NULL,
    ban_id         uuid NOT NULL REFERENCES bans (id),
    suspect_player uuid NOT NULL REFERENCES players (id),
    via_link       uuid,        -- player_links.id or manual_links.id that triggered it
    via_kind       text CHECK (via_kind IN ('auto', 'manual')),
    detected_at    timestamptz NOT NULL DEFAULT now(),
    status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'actioned'))
);
-- One open alert per (tenant, ban, suspect); re-detection is idempotent.
CREATE UNIQUE INDEX ux_evasion_unique ON ban_evasion_alerts (tenant_id, ban_id, suspect_player);
CREATE INDEX ix_evasion_tenant ON ban_evasion_alerts (tenant_id, status, detected_at DESC);
ALTER TABLE ban_evasion_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY ban_evasion_alerts_isolation ON ban_evasion_alerts
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cupboard_app') THEN
        GRANT SELECT ON player_links TO cupboard_app;                    -- global, read-only
        GRANT SELECT, INSERT, DELETE ON manual_links TO cupboard_app;    -- tenant-managed
        GRANT SELECT, UPDATE ON ban_evasion_alerts TO cupboard_app;      -- view + dismiss/action
    END IF;
END
$$;
