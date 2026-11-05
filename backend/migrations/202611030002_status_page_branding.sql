ALTER TABLE status_pages
    ADD COLUMN theme text NOT NULL DEFAULT 'dark' CHECK (theme IN ('dark', 'light')),
    ADD COLUMN accent_color text NOT NULL DEFAULT '#7cb58d' CHECK (accent_color ~ '^#[0-9a-f]{6}$'),
    ADD COLUMN font text NOT NULL DEFAULT 'geist' CHECK (font IN ('geist', 'inter', 'manrope', 'ibm-plex-sans', 'space-grotesk', 'source-serif', 'jetbrains-mono')),
    ADD COLUMN links jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN footer_text text NOT NULL DEFAULT '' CHECK (char_length(footer_text) <= 200),
    ADD COLUMN powered_by boolean NOT NULL DEFAULT true;

-- Logos are normalized to small PNGs (at most 160 pixels per side), so they
-- live beside the page instead of in object storage.
CREATE TABLE status_page_logos (
    organization_id text PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    version bigint NOT NULL,
    data bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 262144)
);
