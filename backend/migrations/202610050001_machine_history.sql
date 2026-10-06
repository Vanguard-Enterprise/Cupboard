ALTER TABLE machines ADD COLUMN metric_history jsonb NOT NULL DEFAULT '[]'::jsonb;
