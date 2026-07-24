# Services runbook

Per-service liveness for the 9 cupboard deployables. Each runs as a Deployment named
`cupboard-<svc>` in namespace `cupboard-<svc>` (bot is `cupboard-bot`, 1 replica, no
Service). Signals are kube-state-metrics, so they work identically for every service.

Degradation matrix: Phase 6 capability behavior is in
`docs/phase6-closeout.md`; the Phase 7 matrix is in `docs/phase7-plan.md`.

## Service map (blast radius)

| Service | Role | If down |
|---|---|---|
| gateway | Public API edge; auth enforcement, rate limiting, proxy to internal services | Total API outage. Storefront + admin + plugin ingest all fail |
| auth | Session/token issuance, org plans, privacy coordinator | Logins fail; privacy jobs stall; downstream authz rejects |
| tenant | Tickets, billing, storefront catalog, Stripe webhooks | Ticketing, checkout, entitlements unavailable |
| identity | Player identity, hashing, bans, reports, chat, name history | Ban checks and identity lookups fail |
| fleet | Server registry, `/internal/servers`, per-server config | Servers cannot resolve config; plugin bootstrap fails |
| collector | Plugin telemetry ingest | Perf/telemetry gap; no user-facing impact |
| metrics | Metrics ingest/query surface | Metrics views degraded; no user-facing impact |
| web | Storefront + admin SSR frontend | Storefront and admin UI down (API still reachable directly) |
| bot | Discord bot: ticket threads, notifications (1 replica) | Discord ticket sync + notifications stop |

## First moves (all)

```
kubectl -n cupboard-<svc> get pods -o wide
kubectl -n cupboard-<svc> describe deploy/cupboard-<svc>
kubectl -n cupboard-<svc> logs deploy/cupboard-<svc> --tail=200
```

Loki: `{namespace="cupboard-<svc>"} | json | level="error"`

---

## CupboardGatewayDown

`kube_deployment_status_replicas_available{namespace="cupboard-gateway"} == 0` for 5m. Critical.

Zero ready gateway replicas. Every external request fails. Check the pod: pull errors
(GHCR pull secret), OOMKill, failing `/readyz` (gateway readiness depends on reaching
Redis and its DB pooler), or a bad rollout. `kubectl -n cupboard-gateway rollout status
deploy/cupboard-gateway`; roll back with `kubectl rollout undo` if a recent deploy is
the cause. If `/readyz` is red, confirm `cupboard-redis` and `cupboard-db` are healthy
(see redis.md, database.md).

## CupboardGatewayCrashLooping

`rate(kube_pod_container_status_restarts_total{namespace="cupboard-gateway"}[15m]) > 0` for 15m. Warning.

Pod is restarting. Usually a panic on startup, a failing liveness probe, or OOM.
`kubectl -n cupboard-gateway logs <pod> --previous` for the crash. Check
`kubectl -n cupboard-gateway describe pod <pod>` for last state / exit code / OOMKilled.

The remaining services share the gateway triage above (Down = zero ready replicas for
5m, critical; CrashLooping = restarts over 15m, warning). Each Down heading notes the
service's blast radius; the matching CrashLooping heading is the same restart triage in
that namespace.

## CupboardAuthDown

Namespace `cupboard-auth`. Auth owns sessions, org plans, and the privacy coordinator.
Down means logins fail and privacy jobs stall (they queue and resume on recovery, per
the Phase 7 matrix, so no data loss). Auth readiness needs its DB pooler; check
`cupboard-db` if `/readyz` is red.

## CupboardAuthCrashLooping

Namespace `cupboard-auth`. Restart triage as for the gateway. Check `--previous` logs
for a startup panic; a red `/readyz` usually points at `cupboard-db`.

## CupboardTenantDown

Namespace `cupboard-tenant`. Tenant owns tickets, billing, storefront catalog, and
Stripe webhook ingestion. Down means checkout and ticketing fail and Stripe webhooks
return 5xx (Stripe retries, so a brief outage self-heals; see billing.md).

## CupboardTenantCrashLooping

Namespace `cupboard-tenant`. Restart triage as for the gateway. If it flaps on
startup, check DB connectivity and the Stripe webhook secret in the external-secret.

## CupboardIdentityDown

Namespace `cupboard-identity`. Owns player identity, ban enforcement, reports, chat.
Down means ban checks fail. Enforcement never depends on erasure state (bans read
`subject_hash`), so a plain identity outage is availability-only.

## CupboardIdentityCrashLooping

Namespace `cupboard-identity`. Restart triage as for the gateway.

## CupboardFleetDown

Namespace `cupboard-fleet`. Owns the server registry and `/internal/servers`. Down
means game servers cannot fetch config and plugin bootstrap fails.

## CupboardFleetCrashLooping

Namespace `cupboard-fleet`. Restart triage as for the gateway.

## CupboardCollectorDown

Namespace `cupboard-collector`. Plugin telemetry ingest. No user-facing impact; a gap
in perf data only. Safe to be patient on recovery.

## CupboardCollectorCrashLooping

Namespace `cupboard-collector`. Restart triage as for the gateway. No user-facing
urgency.

## CupboardMetricsDown

Namespace `cupboard-metrics`. Metrics ingest/query surface. No user-facing impact.

## CupboardMetricsCrashLooping

Namespace `cupboard-metrics`. Restart triage as for the gateway. No user-facing
urgency.

## CupboardWebDown

Namespace `cupboard-web`. SSR storefront + admin. Down means the UI is unreachable
even though the API behind the gateway still serves. Web health probes differ from the
API services (SSR readiness), but the replicas-available signal is identical. Check
that web can reach the gateway URL it renders against.

## CupboardWebCrashLooping

Namespace `cupboard-web`. Restart triage as for the gateway. SSR startup failures
(missing build env, unreachable gateway) are the usual cause.

## CupboardBotDown

Namespace `cupboard-bot`, 1 replica, no Service. Discord bot: ticket-thread sync and
notifications. Down means Discord-side ticketing stops; the web ticket path is
unaffected. The bot consumes the Redis ticket stream, so also check `cupboard-redis`
(redis.md) if the bot is up but not processing. Note: consumer lag / PEL age has no
metric yet (see README gaps).

## CupboardBotCrashLooping

Namespace `cupboard-bot`. Restart triage as for the gateway. A bad Discord token or
gateway/intents error shows in `--previous` logs.
