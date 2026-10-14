CREATE TABLE pelican_connections (
    organization_id text PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    id text NOT NULL,
    revision bigint NOT NULL DEFAULT 1,
    panel_url text NOT NULL,
    api_key_encrypted bytea NOT NULL,
    checked_at bigint NOT NULL,
    last_success_at bigint,
    error text,
    servers jsonb NOT NULL DEFAULT '[]'::jsonb
);
