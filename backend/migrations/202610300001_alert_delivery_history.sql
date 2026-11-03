-- Delivery history outlives the channel it was sent to, so it keeps the name.
ALTER TABLE alert_deliveries ADD COLUMN channel_name text;
UPDATE alert_deliveries d SET channel_name = c.name
    FROM alert_channels c
    WHERE c.organization_id = d.organization_id AND c.id = d.channel_id;
ALTER TABLE alert_deliveries ALTER COLUMN channel_name SET NOT NULL;
ALTER TABLE alert_deliveries DROP CONSTRAINT alert_deliveries_organization_id_channel_id_fkey;
