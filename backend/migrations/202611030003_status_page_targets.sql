-- Targets can also watch a public URL, and group under the organization's
-- machine tags instead of free-text group names.
ALTER TABLE status_page_components DROP CONSTRAINT status_page_components_kind_check;
ALTER TABLE status_page_components
    ADD CONSTRAINT status_page_components_kind_check CHECK (kind IN ('server', 'machine', 'url'));
ALTER TABLE status_page_components
    ADD COLUMN tag_id text NOT NULL DEFAULT '' CHECK (char_length(tag_id) <= 80);
ALTER TABLE status_page_components DROP COLUMN group_name;

-- The latest probe of each URL target. The URL is repeated so a result for an
-- address that has since been edited is never shown for the new one.
CREATE TABLE status_page_url_checks (
    organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    component_id text NOT NULL,
    url text NOT NULL,
    next_check_at bigint NOT NULL DEFAULT 0,
    checked_at bigint,
    result text CHECK (result IN ('up', 'slow', 'down')),
    status_code integer,
    latency_ms integer,
    error text,
    PRIMARY KEY (organization_id, component_id)
);
CREATE INDEX status_page_url_checks_due ON status_page_url_checks (next_check_at);
