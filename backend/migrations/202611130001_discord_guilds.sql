-- Discord guilds an organization owns or manages. A guild ID is a Discord
-- snowflake; image hashes build Discord CDN URLs in the browser.
CREATE TABLE discord_guilds (
    organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    guild_id text NOT NULL CHECK (guild_id ~ '^[0-9]{17,20}$'),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
    icon_hash text CHECK (icon_hash ~ '^(a_)?[0-9a-f]{32}$'),
    -- Tile background: the guild banner, else its Server Guide header.
    banner_hash text CHECK (banner_hash ~ '^(a_)?[0-9a-f]{32}$'),
    home_header_hash text CHECK (home_header_hash ~ '^(a_)?[0-9a-f]{32}$'),
    access text NOT NULL CHECK (access IN ('owner', 'manager')),
    member_count integer CHECK (member_count >= 0),
    connected_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, guild_id)
);

UPDATE organization_roles
SET permissions = permissions || ARRAY['community.view']
WHERE id IN ('owner', 'administrator') AND system
    AND NOT ('community.view' = ANY(permissions));
