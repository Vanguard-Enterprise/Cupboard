-- Keep soft-removed memberships available for reinvites without retaining their roles.
ALTER TABLE memberships DROP CONSTRAINT memberships_status_check;
ALTER TABLE memberships
    ADD CONSTRAINT memberships_status_check
    CHECK (status IN ('active', 'invited', 'suspended', 'removed'));
