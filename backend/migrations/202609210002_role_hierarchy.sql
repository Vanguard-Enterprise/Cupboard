ALTER TABLE organizations ADD COLUMN owner_account_id text REFERENCES accounts(id);
UPDATE organizations o SET owner_account_id = (
    SELECT account_id FROM organization_members m
    WHERE m.organization_id=o.id AND m.role_id='owner' AND m.status='active'
    ORDER BY m.id LIMIT 1
);
ALTER TABLE organizations ALTER COLUMN owner_account_id SET NOT NULL;
ALTER TABLE organization_roles ADD COLUMN position integer NOT NULL DEFAULT 0 CHECK (position >= 0);
WITH ranked AS (
    SELECT organization_id,id,row_number() OVER (PARTITION BY organization_id ORDER BY
        CASE id WHEN 'owner' THEN 0 WHEN 'administrator' THEN 1 ELSE 2 END,name,id)-1 AS position
    FROM organization_roles
) UPDATE organization_roles r SET position=ranked.position FROM ranked
WHERE r.organization_id=ranked.organization_id AND r.id=ranked.id;
ALTER TABLE organization_roles ADD CONSTRAINT role_positions UNIQUE(organization_id,position) DEFERRABLE INITIALLY DEFERRED;
UPDATE organization_roles SET permissions=ARRAY['servers.view','servers.manage','players.moderate','integrations.manage','billing.manage','organization.manage']
WHERE id IN ('owner','administrator');
-- Preserve existing assignments; legacy defaults become ordinary custom roles.
UPDATE organization_roles SET system=false WHERE id NOT IN ('owner','administrator');
ALTER TABLE organization_members ADD CONSTRAINT member_tenant_id UNIQUE(organization_id,id);
CREATE TABLE organization_member_roles (
    organization_id text NOT NULL,
    member_id text NOT NULL,
    role_id text NOT NULL,
    PRIMARY KEY (organization_id,member_id,role_id),
    FOREIGN KEY (organization_id,member_id) REFERENCES organization_members(organization_id,id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id,role_id) REFERENCES organization_roles(organization_id,id)
);
INSERT INTO organization_member_roles SELECT organization_id,id,role_id FROM organization_members;
-- Older versions allowed multiple owners. Keep the recorded owner exclusive.
UPDATE organization_member_roles mr SET role_id='administrator'
FROM organization_members m JOIN organizations o ON o.id=m.organization_id
WHERE mr.organization_id=m.organization_id AND mr.member_id=m.id AND mr.role_id='owner'
AND m.account_id IS DISTINCT FROM o.owner_account_id;
ALTER TABLE organization_members DROP COLUMN role_id;
