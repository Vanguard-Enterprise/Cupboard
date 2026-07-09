-- Phase 5 PR7 (review fix): close the account-linking CSRF in the Discord LINK flow.
--
-- Previously the public OAuth callback linked the Discord identity to the player bound in
-- a server-side state token. That state is readable/relayable by whoever initiated it, so
-- an attacker could have a victim complete the OAuth and bind the victim's Discord to the
-- ATTACKER's account. Fix: the callback no longer links; it mints a ONE-TIME LINK CODE
-- carrying the verified external identity AND the initiating player, and 302s the browser
-- back to the storefront, where the authenticated player COMPLETES the link. The link then
-- only lands if the completing session is the SAME player who initiated it, so a relayed
-- flow cannot bind anyone else's identity to anyone else's account.
--
-- The raw 32-byte code lives only in the redirect URL; we store its SHA-256 keyed hash.
-- Consumed atomically once via DELETE ... RETURNING, TTL ~60s. Global (owner pool).
CREATE TABLE player_link_codes (
    code_hash         bytea PRIMARY KEY,
    player_account_id uuid NOT NULL REFERENCES player_accounts (id) ON DELETE CASCADE,
    provider          text NOT NULL,
    subject           text NOT NULL,
    display_name      text,
    avatar_url        text,
    tenant_id         uuid NOT NULL,
    site_host         text NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    expires_at        timestamptz NOT NULL
);
CREATE INDEX ix_player_link_codes_expiry ON player_link_codes (expires_at);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cupboard_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON player_link_codes TO cupboard_app;
    END IF;
END
$$;
