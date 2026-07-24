# Billing runbook

Stripe webhook ingestion runs on the tenant service. The webhook route is exact:
`/webhooks/stripe` on `job="cupboard-tenant"`. Signal is the same OTLP
`http_server_request_count` counter used in api-and-limiter.md.

Degradation matrix: billing is a Phase 6 surface; behavior under Redis/CNPG down is in
`docs/phase6-closeout.md`.

## First moves

```
kubectl -n cupboard-tenant logs deploy/cupboard-tenant --tail=200 | grep -i webhook
```

Loki:
`{namespace="cupboard-tenant"} | json | http_route="/webhooks/stripe" | http_response_status_code=~"5.."`

Stripe Dashboard -> Developers -> Webhooks: check the endpoint's recent delivery
attempts and response codes. Stripe retries failed deliveries with backoff, so a short
outage self-heals once the endpoint recovers.

---

## CupboardStripeWebhook5xx

`sum(increase(http_server_request_count{job="cupboard-tenant",http_route="/webhooks/stripe",http_response_status_code=~"5.."}[15m])) > 3` for 5m. Warning.

Meaning: the tenant service returned more than 3 server errors on the Stripe webhook
endpoint in 15 minutes. Stripe retries, so a handful is tolerable, but a sustained
burst means checkout events (subscriptions, entitlement grants) are not being applied.

Blast radius: paying customers may not receive entitlements until the webhook succeeds
(or is retried successfully). No data is lost as long as Stripe keeps retrying and the
endpoint recovers within Stripe's retry window; past that window, events must be
replayed from the Stripe Dashboard.

Diagnose: the failure is almost always downstream of the HTTP layer:
- Signature verification misconfig (webhook secret rotated in Stripe but not in Vault /
  the tenant external-secret).
- The handler cannot write to Postgres (`cupboard-db` down or slow; see database.md).
- A panic in a specific event handler: the log line names the event type.

Remediation: fix the underlying cause, then in the Stripe Dashboard resend the failed
events (or let Stripe's automatic retries redeliver). Verify entitlements landed for
affected orgs.

Gap: the billing **reconcile stall** signal that decision L names is not wired (no
metric). This alert catches the live webhook path; a background reconcile that silently
stops would not fire here. Add `cupboard_billing_reconcile_last_success_timestamp_seconds`
on the tenant reconcile loop and alert on staleness (see README gaps).
