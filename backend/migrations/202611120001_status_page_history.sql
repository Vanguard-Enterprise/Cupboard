-- The page name can step aside so the logo is the page's title.
ALTER TABLE status_pages
    ADD COLUMN show_name boolean NOT NULL DEFAULT true,
    -- When the history sampler last recorded this page's targets.
    ADD COLUMN sampled_at bigint NOT NULL DEFAULT 0;

-- One row per target per UTC hour: how many minute samples saw each state,
-- and the URL response times measured in that hour. Rows follow a target's
-- id, so they are removed when the target is removed or points elsewhere.
CREATE TABLE status_page_health_hours (
    organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    component_id text NOT NULL,
    hour bigint NOT NULL,
    operational integer NOT NULL DEFAULT 0,
    degraded integer NOT NULL DEFAULT 0,
    down integer NOT NULL DEFAULT 0,
    maintenance integer NOT NULL DEFAULT 0,
    unknown integer NOT NULL DEFAULT 0,
    latency_total bigint NOT NULL DEFAULT 0,
    latency_count integer NOT NULL DEFAULT 0,
    PRIMARY KEY (organization_id, component_id, hour)
);
CREATE INDEX status_page_health_hours_age ON status_page_health_hours (hour);

-- Stretches where a target was degraded or down outside maintenance. An open
-- incident has no end yet; each target has at most one.
CREATE TABLE status_page_incidents (
    organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    component_id text NOT NULL,
    started_at bigint NOT NULL,
    ended_at bigint,
    worst text NOT NULL CHECK (worst IN ('degraded', 'down')),
    PRIMARY KEY (organization_id, component_id, started_at)
);
CREATE UNIQUE INDEX status_page_incidents_open
    ON status_page_incidents (organization_id, component_id) WHERE ended_at IS NULL;
