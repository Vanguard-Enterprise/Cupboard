CREATE TABLE alert_settings (
    organization_id text PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    revision bigint NOT NULL DEFAULT 1,
    routes jsonb NOT NULL DEFAULT '{}'::jsonb,
    retention_days integer NOT NULL DEFAULT 30 CHECK (retention_days IN (7, 30, 90))
);

CREATE TABLE alert_channels (
    organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('discord', 'webhook')),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    destination text NOT NULL CHECK (char_length(destination) <= 300),
    url_encrypted bytea NOT NULL CHECK (octet_length(url_encrypted) >= 29),
    signing_secret_encrypted bytea,
    created_at bigint NOT NULL,
    last_delivery_at bigint,
    last_delivery_ok boolean,
    last_error text,
    PRIMARY KEY (organization_id, id),
    CHECK ((kind = 'webhook') = (signing_secret_encrypted IS NOT NULL))
);

CREATE TABLE alert_events (
    organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    id text NOT NULL,
    event text NOT NULL,
    severity text NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
    title text NOT NULL,
    detail text NOT NULL,
    created_at bigint NOT NULL,
    PRIMARY KEY (organization_id, id)
);
CREATE INDEX alert_events_recent ON alert_events (organization_id, created_at DESC);
CREATE INDEX alert_events_age ON alert_events (created_at);

CREATE TABLE alert_deliveries (
    organization_id text NOT NULL,
    event_id text NOT NULL,
    channel_id text NOT NULL,
    status text NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at bigint NOT NULL,
    completed_at bigint,
    error text,
    PRIMARY KEY (organization_id, event_id, channel_id),
    FOREIGN KEY (organization_id, event_id) REFERENCES alert_events (organization_id, id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id, channel_id) REFERENCES alert_channels (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX alert_deliveries_due ON alert_deliveries (next_attempt_at) WHERE status = 'pending';

-- Machine staleness is derived at read time; alerts need the last announced state.
ALTER TABLE machines ADD COLUMN alert_offline boolean NOT NULL DEFAULT false;
