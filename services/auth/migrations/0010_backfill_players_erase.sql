-- Phase 7: backfill `players.erase` into pre-existing orgs' Owner/Admin roles.
-- Role templates only apply at org creation (domain/orgs.rs materializes them into
-- role_permissions), so a permission added to the compile-time templates is invisible
-- to every org created before this deploy without a backfill (the 0007 precedent).
--
-- The catalog row is upserted here too: boot-time seeding (main.rs) runs AFTER
-- migrations, so on a fresh deploy the FK target would not exist yet otherwise. The
-- boot seeder re-upserts the same row harmlessly.

INSERT INTO permission_catalog (permission, area, description)
VALUES (
    'players.erase',
    'players',
    'Export or erase a player''s personal data (GDPR)'
)
ON CONFLICT (permission) DO UPDATE
    SET area = EXCLUDED.area, description = EXCLUDED.description;

-- Owner = the immutable role (template semantics; name-independent). Admin roles are
-- matched by their template name; a renamed Admin keeps its explicit grants and can be
-- granted the new permission through the roles UI.
INSERT INTO role_permissions (organization_id, role_id, permission)
SELECT r.organization_id, r.id, 'players.erase'
FROM roles r
WHERE r.immutable OR r.name = 'Admin'
ON CONFLICT (role_id, permission) DO NOTHING;
