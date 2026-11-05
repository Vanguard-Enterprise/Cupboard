CREATE TABLE status_pages (
    organization_id text PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    revision bigint NOT NULL DEFAULT 1,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
    published boolean NOT NULL DEFAULT false,
    announcement text NOT NULL DEFAULT '' CHECK (char_length(announcement) <= 500),
    support_url text NOT NULL DEFAULT '' CHECK (char_length(support_url) <= 300),
    created_at bigint NOT NULL
);

-- A component mirrors one saved server or machine. Positions order the public page.
CREATE TABLE status_page_components (
    organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    id text NOT NULL,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    kind text NOT NULL CHECK (kind IN ('server', 'machine')),
    source_id text NOT NULL,
    group_name text NOT NULL DEFAULT '' CHECK (char_length(group_name) <= 80),
    public boolean NOT NULL DEFAULT true,
    position integer NOT NULL,
    PRIMARY KEY (organization_id, id),
    UNIQUE (organization_id, kind, source_id)
);

CREATE TABLE status_page_maintenance (
    organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    id text NOT NULL,
    title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
    message text NOT NULL DEFAULT '' CHECK (char_length(message) <= 2000),
    starts_at bigint NOT NULL,
    ends_at bigint NOT NULL CHECK (ends_at > starts_at),
    completed_at bigint,
    component_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at bigint NOT NULL,
    PRIMARY KEY (organization_id, id)
);
CREATE INDEX status_page_maintenance_window ON status_page_maintenance (organization_id, starts_at DESC);
