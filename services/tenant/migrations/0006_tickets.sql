-- Phase 6 PR3: support tickets, web-only (decisions A, B). One ticket store, two tables
-- (tickets + ticket_messages) in the tenant schema, standard RLS recipe. The Discord
-- config/bind tables ship now so the schema is complete; their routes land in PR4/PR5.
--
-- Requires PostgreSQL 18 for the built-in `uuidv7()` (matches the other services).

-- One support ticket per row. `type` and `status` are CHECK-constrained text (no DB
-- enums: vocabulary evolves in code). A ticket is opened by a player (web,
-- player_account_id) or - from PR5 - by a Discord user (opener_discord_user_id); both
-- nullable, at least one set in practice (not constrained: `system`-opened tickets stay
-- possible).
CREATE TABLE tickets (
    id                     uuid PRIMARY KEY DEFAULT uuidv7(),
    tenant_id              uuid NOT NULL,
    type                   text NOT NULL CHECK (type IN ('general', 'ban_appeal')),
    status                 text NOT NULL DEFAULT 'open'
                           CHECK (status IN ('open', 'pending', 'resolved', 'closed')),
    category               text,
    subject                text NOT NULL,
    player_account_id      uuid,
    opener_discord_user_id text,
    -- identity's `bans.id`. NO cross-schema FK (decision B): the link crosses services
    -- over internal HTTP (decision C), never at the schema level.
    ban_id                 uuid,
    -- Denormalized ban summary (subject, reason, status) captured from identity's
    -- internal endpoint at open (decision C), so the ticket renders even if the ban
    -- later changes or identity is down.
    ban_snapshot           jsonb,
    assignee_user_id       uuid,
    -- Discord sync state, written by the bot's internal routes (PR5).
    discord_channel_id     text,
    discord_thread_id      text,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);
-- Operator list (newest first) and player "my tickets" lookups.
CREATE INDEX ix_tickets_tenant_created ON tickets (tenant_id, created_at DESC);
CREATE INDEX ix_tickets_tenant_player ON tickets (tenant_id, player_account_id)
    WHERE player_account_id IS NOT NULL;
-- One open appeal per ban (decision B): a second appeal for the same ban while one is
-- still open/pending violates this partial unique index; the service maps the
-- violation to a friendly 409.
CREATE UNIQUE INDEX ux_tickets_one_open_appeal ON tickets (tenant_id, ban_id)
    WHERE type = 'ban_appeal' AND status IN ('open', 'pending');

-- One message per row. `id` is uuidv7 and doubles as the ordering key (decision B).
-- `internal` = staff-only note: web-only, NEVER published to the stream and NEVER
-- returned on the player surface. `origin` drives echo-guarding (decision F): the
-- service never publishes origin='discord' messages back to the stream.
CREATE TABLE ticket_messages (
    id                 uuid PRIMARY KEY DEFAULT uuidv7(),
    ticket_id          uuid NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
    tenant_id          uuid NOT NULL,
    author_kind        text NOT NULL CHECK (author_kind IN ('player', 'staff', 'system')),
    author_id          uuid,
    author_display     text NOT NULL,
    body               text NOT NULL,
    internal           boolean NOT NULL DEFAULT false,
    origin             text NOT NULL CHECK (origin IN ('web', 'discord', 'system')),
    discord_message_id text,
    created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_ticket_messages_ticket ON ticket_messages (ticket_id, id);
-- Discord -> web dedupe (decision F): the bot POSTs with `discord_message_id`; inserts
-- are ON CONFLICT DO NOTHING against this index (PR5).
CREATE UNIQUE INDEX ux_ticket_messages_discord ON ticket_messages (tenant_id, discord_message_id)
    WHERE discord_message_id IS NOT NULL;

-- Per-tenant Discord binding (decision D). guild_id is GLOBALLY unique: one guild binds
-- one tenant, resolved server-side, never trusted from a bot payload. Tables only in
-- PR3; the bind/config routes are PR4/PR5.
CREATE TABLE ticket_discord_configs (
    tenant_id          uuid PRIMARY KEY,
    guild_id           text NOT NULL,
    tickets_channel_id text,
    staff_role_id      text,
    status             text NOT NULL DEFAULT 'linked',
    linked_by          uuid,
    linked_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT ticket_discord_configs_guild_unique UNIQUE (guild_id)
);

-- One-time guild-bind codes (decision D; the Phase 5 one-time-code precedent:
-- single-use consume via DELETE .. RETURNING).
--
-- Hashing contract for PR4: `code_hash` is the UNKEYED cupboard_crypto::sha256 of the
-- plaintext code. The codes are 256-bit `cupboard_crypto::random_token()` values, so
-- the hash is preimage-safe without a pepper (the ingest-token precedent, NOT the
-- keyed hash_token used for API keys). PR4's mint and bind paths must both implement
-- exactly this.
CREATE TABLE ticket_bind_codes (
    code_hash  bytea PRIMARY KEY,
    tenant_id  uuid NOT NULL,
    created_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);
-- Expiry sweeps.
CREATE INDEX ix_ticket_bind_codes_expiry ON ticket_bind_codes (expires_at);

-- ============================ Row-Level Security ============================
-- ENABLE (not FORCE): the non-owner request role is filtered; the owner role bypasses
-- for the bot's internal routes (PR5) and cross-tenant work. No explicit WITH CHECK,
-- so the USING predicate also governs writes.
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
CREATE POLICY tickets_isolation ON tickets
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE ticket_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY ticket_messages_isolation ON ticket_messages
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE ticket_discord_configs ENABLE ROW LEVEL SECURITY;
CREATE POLICY ticket_discord_configs_isolation ON ticket_discord_configs
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE ticket_bind_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY ticket_bind_codes_isolation ON ticket_bind_codes
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- ============================ App-role grants ============================
-- Ticket tables are request-writable (operator + player surfaces run on the app pool
-- inside begin_tenant_tx): no DELETE anywhere (tickets are never deleted from the
-- request path), and messages are IMMUTABLE once written (no UPDATE grant; only
-- tickets takes status/assignee/updated_at writes). The Discord config table is
-- read-only on the request path in PR3 (the operator UI will read binding status);
-- its writes and the bind-code lifecycle arrive with PR4/PR5 (owner pool, or a later
-- grant migration if they move to the request path).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cupboard_app') THEN
        GRANT SELECT, INSERT, UPDATE ON tickets TO cupboard_app;
        GRANT SELECT, INSERT ON ticket_messages TO cupboard_app;
        GRANT SELECT ON ticket_discord_configs TO cupboard_app;
    END IF;
END
$$;
