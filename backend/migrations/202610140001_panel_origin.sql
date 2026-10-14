-- Preserve imported identity across reconnects to the same panel origin.
ALTER TABLE servers ADD COLUMN panel_origin text;
UPDATE servers s SET panel_origin=c.panel_url
FROM pelican_connections c
WHERE c.organization_id=s.organization_id AND c.id=s.panel_connection_id;
CREATE UNIQUE INDEX servers_panel_origin_identity
ON servers(organization_id,panel_origin,panel_server_uuid);
