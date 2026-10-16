ALTER TABLE machines ADD COLUMN tags jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE TABLE machine_tag_catalogs (
 organization_id text PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
 tags jsonb NOT NULL DEFAULT '[{"id":"wings","name":"Wings"},{"id":"game-server","name":"Game server"},{"id":"database","name":"Database"},{"id":"backups","name":"Backups"},{"id":"bot-server","name":"Bot server"}]'::jsonb
);
