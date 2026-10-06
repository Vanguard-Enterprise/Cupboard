CREATE TABLE machines (
    id text PRIMARY KEY,
    organization_id text NOT NULL REFERENCES organizations(id),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    address text NOT NULL,
    provider text NOT NULL DEFAULT '' CHECK (char_length(provider) <= 80),
    location text NOT NULL DEFAULT '' CHECK (char_length(location) <= 80),
    notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 2000),
    enrollment_hash text UNIQUE,
    enrollment_expires_at bigint,
    agent_hash text UNIQUE,
    enrolled_at bigint,
    last_seen_at bigint,
    health jsonb,
    revision bigint NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, id)
);
CREATE INDEX machines_organization_id ON machines(organization_id);

UPDATE organization_roles
SET permissions = permissions || ARRAY['infrastructure.view', 'infrastructure.manage']
WHERE id IN ('owner', 'administrator') AND system;
