CREATE TABLE organization_files (
    organization_id text NOT NULL REFERENCES organizations(id),
    id text NOT NULL,
    name text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 255),
    size bigint NOT NULL CHECK (size BETWEEN 0 AND 10485760),
    created_at bigint NOT NULL DEFAULT (extract(epoch FROM now())::bigint),
    ready boolean NOT NULL DEFAULT false,
    PRIMARY KEY (organization_id, id)
);
CREATE INDEX organization_files_pending ON organization_files(created_at) WHERE NOT ready;
