ALTER TABLE servers
    ALTER COLUMN rcon_host DROP NOT NULL,
    ALTER COLUMN rcon_port DROP NOT NULL,
    ALTER COLUMN rcon_password_encrypted DROP NOT NULL,
    ALTER COLUMN a2s_host DROP NOT NULL,
    ALTER COLUMN a2s_port DROP NOT NULL,
    ADD COLUMN panel_connection_id text,
    ADD COLUMN panel_server_uuid text,
    ADD COLUMN panel_server_identifier text;
ALTER TABLE servers ADD CONSTRAINT servers_connection_details CHECK (
    (rcon_host IS NOT NULL AND rcon_port IS NOT NULL AND rcon_password_encrypted IS NOT NULL
     AND a2s_host IS NOT NULL AND a2s_port IS NOT NULL)
    OR (panel_connection_id IS NOT NULL AND panel_server_uuid IS NOT NULL AND panel_server_identifier IS NOT NULL)
);
CREATE UNIQUE INDEX servers_panel_identity ON servers(organization_id,panel_connection_id,panel_server_uuid);
