-- The announcement's glyph and color on the public page.
ALTER TABLE status_pages
    ADD COLUMN announcement_icon text NOT NULL DEFAULT 'megaphone'
        CHECK (announcement_icon IN ('megaphone', 'info', 'alert', 'wrench', 'calendar', 'sparkles')),
    ADD COLUMN announcement_tone text NOT NULL DEFAULT 'neutral'
        CHECK (announcement_tone IN ('neutral', 'info', 'success', 'warning', 'danger'));
