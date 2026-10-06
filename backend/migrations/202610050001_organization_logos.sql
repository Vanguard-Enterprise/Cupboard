ALTER TABLE organizations ADD COLUMN logo_revision bigint NOT NULL DEFAULT 0;
CREATE TABLE organization_logos (
    organization_id text NOT NULL REFERENCES organizations(id),
    id text NOT NULL,
    active boolean NOT NULL DEFAULT false,
    created_at bigint NOT NULL DEFAULT (extract(epoch FROM now())::bigint),
    PRIMARY KEY (organization_id, id)
);
CREATE UNIQUE INDEX organization_logo_active ON organization_logos(organization_id) WHERE active;
CREATE INDEX organization_logo_cleanup ON organization_logos(created_at) WHERE NOT active;
