-- The title in the public page's top bar. Empty shows the page name.
ALTER TABLE status_pages
    ADD COLUMN header_title text NOT NULL DEFAULT '' CHECK (char_length(header_title) <= 80);
