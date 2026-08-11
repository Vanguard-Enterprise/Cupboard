# Phase 7 closeout audit: compliance, security, and cutover readiness

Status as of 2026-08-03: **AUDIT COMPLETE; PHASE NOT CLOSED.** Definition of Done
items 1–3 are verified on live `use1` staging. Item 4 (production cutover readiness)
is incomplete, so Phase 7 must remain open until the production decisions, manifests,
PostgreSQL-aware backups, and cutover rehearsal are finished.

This audit reconciles `docs/phase7-plan.md` with the cluster. The plan's PR5–PR7
language is stale: Cilium, enforced CiliumNetworkPolicies, Linkerd injection, and
strict Linkerd authorization are already deployed.

## Result

| DoD | Requirement | Result |
|---|---|---|
| 1 | Export, erasure, and retention across all player stores | **PASS** |
| 2 | Security/cardinality review, alerts, and runbooks | **PASS** |
| 3 | Enforced NetworkPolicy and mTLS on internal services | **PASS** |
| 4 | Production manifests and rehearsed cutover | **FAIL / NOT READY** |

## Live environment

- Kubernetes context: `use1-oidc`; audit date: 2026-08-03.
- ArgoCD reported every Cupboard application `Synced` and `Healthy` at
  v-deployments revision `1f34525dadbcba4ff94872037d7c3135af68cafe`.
- All Cupboard application pods, CNPG, PgBouncer, Redis, Cilium, Hubble, and the
  Linkerd control plane were ready after the audit.
- CNPG `cupboard` reported one of one instances ready and `Cluster in healthy state`.

## DoD 1: privacy and retention — PASS

The audit used a uniquely identified synthetic staging subject in `Test Org`. No
existing player or operator data was erased. The fixture deliberately spanned all
three player-data owners:

- auth: one player account and one Steam identity;
- identity: one player, identifier, name-history row, and active Steam ban;
- tenant: one appeal ticket and one player-authored message.

### Export

A platform-scoped export was queued through the live auth-owned coordinator. It
completed without retry or error, stored a gzip bundle with the seven-day expiry,
and reported the expected rows from auth, identity, and tenant. The result counts
included one account, identity, player, identifier, name-history row, ban, ticket,
and ticket message.

### Dry-run and confirmation

A platform erasure first reached `awaiting_confirm`. Its dry-run counts matched the
fixture, while a direct read proved every raw value and link was unchanged. Only
after confirmation was the job requeued and completed.

After completion:

- the identity player was `erased`;
- raw identifier and ban values were NULL;
- the ban's contextual player link was NULL;
- the account display/avatar and linked identity were removed;
- the ticket subject, message author, and message body were `[erased]`;
- the Discord opener id was NULL;
- auth, identity, and tenant each held a `player.erase` audit row.

### Enforcement survives erasure

Both identifier and ban hashes remained 32 bytes and the ban remained `active`.
An authorized, Linkerd-injected probe using the collector workload identity called
the real `/internal/enforce` endpoint after erasure. It returned the synthetic
Steam ID as banned with the fixture reason. This proves enforcement uses the durable
hash rather than erased PII.

### Retention

The auth, identity, and tenant retention loops all log successful hourly ticks.
Mimir returned fresh `cupboard_retention_last_success_seconds` series for all three
jobs, and auth exposed a fresh `cupboard_privacy_worker_last_success_seconds` series.
The deployed alerts fire when retention is more than two hours stale or privacy is
more than 15 minutes stale.

The targeted auth, identity, and tenant Phase 7 test binaries compile and enumerate
the expected privacy/retention cases. Their DB-backed bodies skip when
`TEST_DATABASE_URL` is absent in the local shell; therefore this audit does not cite
that local invocation as execution evidence. Live coordinator, walker, erasure,
enforcement, log, and metric checks above are the execution evidence. CI remains the
source of truth for exact cutoff-boundary, row-cap, idempotency, and schema-oracle
test execution.

## DoD 2: security and observability — PASS

- The Phase 7 security and Mimir-cardinality changes are on Cupboard `main`.
- The live Grafana `grafana-rules-cupboard` rule set covers down/crash-loop alerts
  for all nine application Deployments, CNPG, Redis, certificates, gateway 5xx,
  limiter fail-open, Stripe webhook failures, and privacy/retention worker stalls.
- Every inspected Cupboard alert has a repository runbook URL.
- Linkerd has certificate-expiry and identity-control-plane alerts with its rotation
  runbook.
- No Cupboard workload was unhealthy at audit completion. Unrelated failed historical
  `cloudflare-ddns` Job pods were observed and are outside Cupboard's Phase 7 scope.

## DoD 3: Cilium and Linkerd — PASS

### Cilium

- Cilium `v1.19.6` and Cilium Envoy were ready on all six nodes.
- Hubble Relay was ready.
- Valid `CiliumNetworkPolicy` resources exist for all eleven Cupboard namespaces,
  including `cupboard-db` and `cupboard-redis`, with default-deny enabled.
- A Linkerd-injected pod in `cupboard-web` attempted a flow to identity that web is
  not allowed to make. Cilium denied the upstream connection; the local Linkerd proxy
  surfaced the denial as HTTP 504. The probe asserted that result and completed.

### Linkerd

- The Linkerd destination, identity, and injector Deployments were ready.
- Cupboard application pods contain the Linkerd proxy as a Kubernetes native sidecar
  init container and carry workload-identity metadata.
- Every HTTP service has a `Server` with deny access policy, paired
  `AuthorizationPolicy`, and `MeshTLSAuthentication` identity allow-list.
- An authorized collector identity reached identity and completed a real enforcement
  call.
- A pod in the same Cilium-allowed collector namespace but using an unlisted service
  account received HTTP 403 on `/internal/enforce`. This isolates the Linkerd identity
  decision from the network-policy decision and proves plaintext/permissive bypass is
  not accepted for the protected route.
- `/healthz` remained reachable to the denied identity, as expected from Linkerd's
  generated kubelet-probe authorization; application routes remained protected.

## Recovery audit

The newest completed Longhorn S3 backup for the Cupboard PostgreSQL PVC (snapshot
time 2026-08-03 14:00 UTC) was restored into an isolated PVC and booted with the same
PostgreSQL 18 image. PostgreSQL completed crash recovery, checksums were on, all 70
application tables across five schemas were readable, and a full logical dump scan
succeeded. The temporary restore resources were removed and the live cluster stayed
healthy.

This proves the Longhorn volume backup is recoverable. It does **not** provide the
production backup posture required by decision M: there are no CNPG `Backup` or
`ScheduledBackup` objects and no tested point-in-time recovery. Repository text that
says staging has no backups is stale, but its warning that CNPG-native PITR is absent
is still correct.

## DoD 4: cutover readiness — FAIL / blocking work

Operator decision recorded 2026-08-03: production will run on `use1`, but all
production-environment work and cutover rehearsal are intentionally deferred until
Cupboard has its EIN, production domain, and live Stripe setup. Product testing and
development continue against staging in the meantime.

The following required artifacts or decisions are absent:

1. acquire the production domain;
2. production placement: **resolved — `use1`**;
3. production manifest tree and unapplied ArgoCD Application resources;
4. `cupboard/production/*` OpenBao paths and population checklist;
5. Stripe live-mode products/prices, webhook, and Stripe Tax decision;
6. production CNPG object-store backups, `ScheduledBackup`, WAL archiving, and a
   successful point-in-time restore drill;
7. ordered cutover/rollback rehearsal and Phase 5 production certificate/browser
   click-through.

Production must not be applied until these gates pass. Longhorn backups are a useful
second layer, not a substitute for database-aware backups and PITR.

## Temporary resources and retained evidence

All temporary network probe pods and their temporary service account were deleted.
The synthetic subject is intentionally left only in its post-erasure state: identity
tombstone, redacted ticket/message, durable active ban hash, privacy job metadata,
and audit rows. Those rows contain no live person's data and preserve the audit proof.
No secret value was printed or stored in the repository.

## Closure gate

Phase 7 can be marked **CLOSED** only after DoD 4 is implemented and rehearsed. PR8
is intentionally on hold pending the EIN, production domain, and live Stripe setup.
The one approved infrastructure task before then is CNPG-native backup/PITR validation
on staging; production erasure must remain disabled until the same protection exists
and passes its own restore drill.
