-- Phase 5 PR7: player Discord LINK state. A logged-in player initiates a Discord OAuth
-- link; the callback (on the central login host, a different origin than the storefront)
-- must recover WHICH player + storefront the link is for WITHOUT trusting any
-- browser-supplied value. We store a single-use, TTL-bound state token (SHA-256 keyed
-- hash) binding the player account + tenant + site host, redeemed atomically by the
-- callback (DELETE ... RETURNING). Mirrors player_login_codes. Global (owner pool).
CREATE TABLE player_link_states (
    state_hash        bytea PRIMARY KEY,
    player_account_id uuid NOT NULL REFERENCES player_accounts (id) ON DELETE CASCADE,
    tenant_id         uuid NOT NULL,
    site_host         text NOT NULL,
    provider          text NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    expires_at        timestamptz NOT NULL
);
CREATE INDEX ix_player_link_states_expiry ON player_link_states (expires_at);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cupboard_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON player_link_states TO cupboard_app;
    END IF;
END
$$;
