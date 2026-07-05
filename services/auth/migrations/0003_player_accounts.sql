-- Phase 5 PR3 - player accounts. Players (storefront customers) are a distinct
-- population from operators: they never become `users` rows and their tokens are signed
-- with a separate keypair (see cupboard_auth_core::PlayerKeys). These tables are GLOBAL
-- (no RLS), like `users`/`sessions`; a player is one person platform-wide, addressed by
-- their verified Steam/Discord identity. Player *sessions* carry a tenant scope so a
-- login on one tenant site is not valid on another.

-- One row per real player (a global identity, deduped by their external identities).
CREATE TABLE player_accounts (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name  text,
    avatar_url    text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_login_at timestamptz NOT NULL DEFAULT now()
);

-- External login identities linked to a player. Steam is the primary/first identity for
-- Rust stores; Discord is linkable later (PR7). `subject` is the steamid64 or Discord id.
CREATE TABLE player_identities (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    player_account_id uuid NOT NULL REFERENCES player_accounts (id) ON DELETE CASCADE,
    provider          text NOT NULL CHECK (provider IN ('steam', 'discord')),
    subject           text NOT NULL,
    display_name      text,
    avatar_url        text,
    linked_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, subject)
);
CREATE INDEX ix_player_identities_account ON player_identities (player_account_id);

-- Player refresh-token sessions, scoped to the tenant site the player logged in on. Only
-- the keyed hash of the refresh token is stored (the `sessions` pattern); the access
-- token is a stateless player JWT.
CREATE TABLE player_sessions (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    player_account_id  uuid NOT NULL REFERENCES player_accounts (id) ON DELETE CASCADE,
    tenant_id          uuid NOT NULL,
    site_host          text NOT NULL,
    refresh_token_hash bytea NOT NULL UNIQUE,
    user_agent         text,
    ip                 text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    last_used_at       timestamptz NOT NULL DEFAULT now(),
    expires_at         timestamptz NOT NULL,
    revoked_at         timestamptz
);
CREATE INDEX ix_player_sessions_account ON player_sessions (player_account_id);

-- One-time codes for the login handoff from the central auth-callback host to the tenant
-- storefront host (Discord redirect-URI constraint forces a central callback; Steam
-- shares the path). The raw 32-byte code lives only in the redirect URL; we store its
-- SHA-256 hash. Consumed atomically once via DELETE ... RETURNING, TTL ~60s, host-bound.
CREATE TABLE player_login_codes (
    code_hash         bytea PRIMARY KEY,
    player_account_id uuid NOT NULL REFERENCES player_accounts (id) ON DELETE CASCADE,
    tenant_id         uuid NOT NULL,
    site_host         text NOT NULL,
    steam_id          text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    expires_at        timestamptz NOT NULL
);
CREATE INDEX ix_player_login_codes_expiry ON player_login_codes (expires_at);

-- Steam OpenID 2.0 response-nonce replay guard. Steam consumes assertions server-side
-- per spec, but recording the nonce is cheap defense in depth against replay of a
-- captured positive assertion within its freshness window.
CREATE TABLE openid_replay (
    nonce_hash bytea PRIMARY KEY,
    seen_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_openid_replay_seen ON openid_replay (seen_at);

-- ============================ App-role grants ============================
-- These tables are owner-pool only (player auth runs system-side, not tenant-scoped),
-- but grant the app role read/write for symmetry and any future request-path use.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cupboard_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON
            player_accounts, player_identities, player_sessions,
            player_login_codes, openid_replay
            TO cupboard_app;
    END IF;
END
$$;
