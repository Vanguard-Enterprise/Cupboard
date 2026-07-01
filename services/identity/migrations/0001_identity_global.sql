-- Phase 2 — Identity & Moderation: the GLOBAL identity layer (Decisions 14–17,
-- docs/identity-schema.md). Lives in the `identity` Postgres schema
-- (search_path=identity,public).
--
-- These tables carry NO tenant_id and have NO RLS: the cross-network identity/alt graph is
-- shared across all tenants ("more data wins"). Only system services write them, on the
-- owner pool; the app (request) role gets SELECT so the dashboard can read profiles.
--
-- PII vs enforcement-key separation from day one: `value` columns are the erasable raw
-- PII; `value_hash` (HMAC-SHA256 under a Vault pepper) is the durable key that survives
-- GDPR erasure and powers dedup + matching. Requires PG18 for uuidv7().

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

-- The canonical, global Cupboard Player ID — a surrogate; NOT a Steam ID. Owns identifiers.
CREATE TABLE players (
    id            uuid PRIMARY KEY DEFAULT uuidv7(),
    display_id    bigint GENERATED ALWAYS AS IDENTITY,   -- short public id (BM-style)
    status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'merged', 'erased')),
    merged_into   uuid REFERENCES players (id),          -- set when merged away
    first_seen_at timestamptz,
    last_seen_at  timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Unique identity keys (Steam / EAC / Discord). The unique index on (type, value_hash) is
-- the dedup that makes the Cupboard Player ID global.
CREATE TABLE player_identifiers (
    id            uuid PRIMARY KEY DEFAULT uuidv7(),
    player_id     uuid NOT NULL REFERENCES players (id),
    type          text NOT NULL CHECK (type IN ('steam', 'eac', 'discord')),
    value         text,                 -- raw value (PII) — NULLed on erasure
    value_hash    bytea NOT NULL,       -- HMAC(value, pepper) — durable
    confidence    real NOT NULL DEFAULT 1.0,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_identifier_value ON player_identifiers (type, value_hash);
CREATE INDEX ix_identifier_player ON player_identifiers (player_id);

-- Shared/linking signals (IP, Steam owner / family-share) — many-to-many, drive link
-- detection (PR6). Kept apart from the unique keys above.
CREATE TABLE identity_signals (
    id             uuid PRIMARY KEY DEFAULT uuidv7(),
    player_id      uuid NOT NULL REFERENCES players (id),
    type           text NOT NULL CHECK (type IN ('ip', 'steam_owner')),
    value          text,                -- raw (PII for ip) — NULLed on erasure
    value_hash     bytea NOT NULL,      -- HMAC(value, pepper)
    sighting_count integer NOT NULL DEFAULT 1,
    first_seen_at  timestamptz NOT NULL DEFAULT now(),
    last_seen_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_signal_player_value ON identity_signals (player_id, type, value_hash);
CREATE INDEX ix_signal_value ON identity_signals (type, value_hash);  -- "who else shares this?"

-- Observed name history per player.
CREATE TABLE name_history (
    id            uuid PRIMARY KEY DEFAULT uuidv7(),
    player_id     uuid NOT NULL REFERENCES players (id),
    name          text,                 -- PII-ish — NULLed/redacted on erasure
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (player_id, name)
);

-- App (request) role reads the global graph for the dashboard; system writes on the owner
-- pool. Guarded so plain local dev without the role still migrates.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cupboard_app') THEN
        GRANT USAGE ON SCHEMA identity, public TO cupboard_app;
        GRANT SELECT ON players, player_identifiers, identity_signals, name_history TO cupboard_app;
    END IF;
END
$$;
