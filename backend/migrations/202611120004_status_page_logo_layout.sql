-- Where the logo and title sit in the public page's top bar, and how large
-- the logo is when it stands in for the title.
ALTER TABLE status_pages
    ADD COLUMN logo_align text NOT NULL DEFAULT 'left' CHECK (logo_align IN ('left', 'center', 'right')),
    ADD COLUMN logo_size text NOT NULL DEFAULT 'medium' CHECK (logo_size IN ('small', 'medium', 'large'));
