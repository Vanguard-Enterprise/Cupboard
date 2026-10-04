ALTER TABLE servers
    ADD COLUMN players bigint CHECK (players >= 0),
    ADD COLUMN players_at bigint,
    ADD COLUMN players_source text CHECK (players_source IN ('rcon', 'a2s'));
CREATE INDEX servers_health_due ON servers (checked_at NULLS FIRST, id);
