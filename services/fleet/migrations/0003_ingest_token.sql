-- Phase 3 PR3 — per-server ingest tokens. The gameplay plugin / perf mod authenticate
-- pushes to the Collector's /ingest endpoint with an opaque bearer token issued here.
--
-- Only the SHA-256 of the token is stored (the plaintext is shown once at issue time).
-- Unkeyed SHA-256 is sufficient: tokens carry 256 bits of entropy, so a DB leak cannot
-- be brute-forced (same reasoning as the PKCE S256 challenge). One active token per
-- server; issuing again rotates (old token stops working on the Collector's next config
-- refresh).

ALTER TABLE servers
    ADD COLUMN ingest_token_hash       bytea,
    ADD COLUMN ingest_token_created_at timestamptz;
