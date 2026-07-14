-- Phase 6 PR2 - org plan mirror (decision K). Written ONLY by the tenant service via
-- PUT /internal/orgs/{id}/plan (guarded by the distinct PLAN_WRITE_TOKEN, never the
-- shared INTERNAL_API_TOKEN: a plan write is a privilege-escalation primitive), read
-- at every operator token mint. The pushed plan is already RESOLVED for gating (the
-- tenant service applies past_due grace etc. before pushing); auth stores and mints
-- it verbatim, with no interpretation. A missing row = the free tier.
--
-- System/global table like users/sessions (0001 conventions): owner-pool only, no
-- RLS, and no cupboard_app grant since no tenant-scoped request path reads it.

CREATE TABLE org_plans (
    organization_id uuid PRIMARY KEY,
    plan            text NOT NULL,
    status          text NOT NULL,
    updated_at      timestamptz NOT NULL DEFAULT now()
);
