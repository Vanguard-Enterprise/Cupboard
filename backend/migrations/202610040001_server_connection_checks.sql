ALTER TABLE servers
    ADD COLUMN checked_at bigint,
    ADD COLUMN rcon_status text CHECK (rcon_status IN ('connected', 'authentication_failed', 'unreachable', 'timeout', 'invalid_configuration', 'protocol_error')),
    ADD COLUMN a2s_status text CHECK (a2s_status IN ('connected', 'unreachable', 'timeout', 'invalid_configuration', 'protocol_error')),
    ADD CONSTRAINT server_check_complete CHECK (
        (checked_at IS NULL AND rcon_status IS NULL AND a2s_status IS NULL) OR
        (checked_at IS NOT NULL AND rcon_status IS NOT NULL AND a2s_status IS NOT NULL)
    );
