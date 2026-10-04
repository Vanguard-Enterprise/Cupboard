CREATE TABLE servers (
    id text PRIMARY KEY,
    organization_id text NOT NULL REFERENCES organizations(id),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    rcon_host text NOT NULL,
    rcon_port integer NOT NULL CHECK (rcon_port BETWEEN 1 AND 65535),
    rcon_password_encrypted bytea NOT NULL CHECK (octet_length(rcon_password_encrypted) >= 29),
    a2s_host text NOT NULL,
    a2s_port integer NOT NULL CHECK (a2s_port BETWEEN 1 AND 65535),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX servers_organization_id ON servers(organization_id);
