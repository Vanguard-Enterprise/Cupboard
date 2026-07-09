-- Phase 5 PR5: custom domains for tenant sites, with a state machine driving DNS
-- verification and cert-manager HTTP-01 issuance (ARCHITECTURE decision #11).
--
-- Onboarding: tenant points a DNS record (A/CNAME) at our edge, then adds the domain
-- here. A background loop walks each domain: pending_dns -> (DNS points at us?) dns_ok
-- -> issuing (create Certificate + IngressRoute CRs) -> (cert Ready?) active. Failure
-- states (failed_dns / failed_issuance) back off and retry; disabled tears the CRs down.

CREATE TABLE site_domains (
    id              uuid PRIMARY KEY DEFAULT uuidv7(),
    tenant_id       uuid NOT NULL,
    site_id         uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    -- Lowercased, punycode-normalized hostname. Globally unique: a domain can back at
    -- most one site across the whole platform.
    domain          text NOT NULL,
    status          text NOT NULL DEFAULT 'pending_dns'
                    CHECK (status IN ('pending_dns', 'dns_ok', 'issuing', 'active',
                                      'failed_dns', 'failed_issuance', 'disabled')),
    -- The k8s resource names the loop manages (in the web namespace). Derived from the
    -- domain id so they are stable and collision-free.
    cert_secret_name text,
    ingressroute_name text,
    last_checked_at timestamptz,
    last_error      text,
    attempt_count   integer NOT NULL DEFAULT 0,
    -- The loop claims/leases a row by pushing next_check_at forward, then processes it.
    next_check_at   timestamptz NOT NULL DEFAULT now(),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT site_domains_domain_unique UNIQUE (domain)
);
CREATE INDEX ix_site_domains_tenant ON site_domains (tenant_id);
-- The loop's "which domains need work now?" query: pending/failed/issuing rows that are
-- due. (active + disabled are effectively terminal; active gets an occasional recheck.)
CREATE INDEX ix_site_domains_due ON site_domains (next_check_at)
    WHERE status NOT IN ('disabled');

-- ============================ Row-Level Security ============================
ALTER TABLE site_domains ENABLE ROW LEVEL SECURITY;
CREATE POLICY site_domains_isolation ON site_domains
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- ============================ App-role grants ============================
-- Operators add/list/remove domains on the app pool; the domain loop reads/writes on the
-- owner pool.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cupboard_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON site_domains TO cupboard_app;
    END IF;
END
$$;
