CREATE TABLE organization_file_shares (
    organization_id text NOT NULL,
    file_id text NOT NULL,
    token_hash text NOT NULL UNIQUE,
    expires_at bigint NOT NULL,
    PRIMARY KEY (organization_id, file_id),
    FOREIGN KEY (organization_id, file_id) REFERENCES organization_files(organization_id,id) ON DELETE CASCADE
);
