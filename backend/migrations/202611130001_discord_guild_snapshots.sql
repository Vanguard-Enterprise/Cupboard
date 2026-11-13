-- What Cupboard last read from Discord about a linked guild. Discord rate
-- limits bot reads, and every environment shares one application, so guild
-- pages serve this snapshot and call Discord only when it has gone stale.
-- One row per guild: every organization that linked the guild sees the same
-- Discord data, and removing the guild deletes it.
CREATE TABLE discord_guild_snapshots (
    guild_id text PRIMARY KEY CHECK (guild_id ~ '^[0-9]{17,20}$'),
    data jsonb NOT NULL,
    fetched_at timestamptz NOT NULL DEFAULT now()
);
