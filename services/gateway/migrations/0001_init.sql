-- Phase 0 baseline migration: proves the migration pipeline end-to-end.
-- Real schema (identity, tenancy, etc.) arrives in later phases per docs/.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- A trivial marker table so a fresh DB has something the gateway can verify.
CREATE TABLE IF NOT EXISTS _cupboard_meta (
    key        text PRIMARY KEY,
    value      text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO _cupboard_meta (key, value)
VALUES ('schema_baseline', '0001')
ON CONFLICT (key) DO NOTHING;
