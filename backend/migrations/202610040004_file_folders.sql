ALTER TABLE organization_files
    ADD COLUMN parent_id text,
    ADD COLUMN is_folder boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT organization_files_parent FOREIGN KEY (organization_id, parent_id)
        REFERENCES organization_files(organization_id, id) ON DELETE SET NULL (parent_id),
    ADD CONSTRAINT organization_files_not_own_parent CHECK (parent_id IS DISTINCT FROM id),
    ADD CONSTRAINT organization_files_folder_size CHECK (NOT is_folder OR size = 0);
CREATE INDEX organization_files_parent ON organization_files(organization_id, parent_id);
