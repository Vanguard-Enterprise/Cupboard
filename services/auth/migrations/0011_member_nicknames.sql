ALTER TABLE memberships ADD COLUMN nickname text;

ALTER TABLE memberships
  ADD CONSTRAINT memberships_nickname_length CHECK (nickname IS NULL OR char_length(nickname) <= 80);
