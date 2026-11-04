-- "system" follows each visitor's light or dark preference; "dark" and
-- "light" lock the page to the organization's choice.
ALTER TABLE status_pages
    DROP CONSTRAINT status_pages_theme_check,
    ADD CONSTRAINT status_pages_theme_check CHECK (theme IN ('dark', 'light', 'system'));
