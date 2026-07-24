# Database runbook

CNPG cluster `cupboard` in namespace `cupboard-db`. Staging is a single instance
(`instances: 1`) on the memory-bound use1 cluster, no S3 backup configured. All
cupboard services connect through the `cupboard-pooled-rw` pooler to the primary.

Degradation matrix: `docs/phase6-closeout.md` (Phase 6 capabilities under "CNPG down")
and `docs/phase7-plan.md` (privacy loops under "CNPG down").

## First moves

```
kubectl -n cupboard-db get cluster cupboard -o wide
kubectl -n cupboard-db get pods
kubectl cnpg status cupboard -n cupboard-db      # if the cnpg plugin is installed
kubectl -n cupboard-db logs cupboard-1 --tail=200
```

Mimir: `cnpg_collector_up{namespace="cupboard-db"}`, `cnpg_backends_total{namespace="cupboard-db"}`,
`cnpg_backends_waiting_total{namespace="cupboard-db"}`.

---

## CupboardDBDown

`cnpg_collector_up{namespace="cupboard-db"} == 0` for 2m. Critical.

The CNPG instance collector is down: the primary is unreachable or the pod is not
running. Because it is a single instance, this is a full database outage. Every
service that needs its pooled connection will fail readiness and start erroring.

Blast radius: gateway, auth, tenant, identity, fleet all depend on Postgres. Privacy
export/erasure jobs stall and resume on recovery (cursor-based, no data loss). Redis
is unaffected, so anything PG-only is down while stream-only paths keep running.

Diagnose: check the pod (`kubectl -n cupboard-db get pods`) for OOMKill (limit is
1Gi), PVC/Longhorn volume issues (`kubectl -n cupboard-db get pvc`), or a stuck
failover. CNPG will self-heal a crashed instance; if the PVC is unhealthy, check
Longhorn. If the primary is up but the collector cannot scrape, restart is usually
enough, but confirm the DB actually serves (`kubectl cnpg status`).

## CupboardDBHighConnections

`sum(cnpg_backends_total{namespace="cupboard-db"}) > 80` for 10m. Warning.

Backend connection count is above 80. Default `max_connections` is 100, so this is
connection pressure that risks "too many clients" errors. Since apps connect through
the rw pooler, a spike usually means a service is leaking connections or the pooler
sizing is off, not raw client fan-out.

Diagnose: identify the noisy client with the per-database/per-application breakdown of
`cnpg_backends_total` (labels), and check `cnpg_backends_waiting_total` for backends
blocked on locks. Look for a service in a restart loop reopening pools, or a slow query
holding connections. Remediation: restart the offending service, or if this is real
sustained growth, raise the pooler `default_pool_size` / cluster `max_connections`.

Gap: there is no `max_connections` metric exported, so the 80 threshold assumes the
CNPG default of 100. Revisit if `max_connections` is tuned.
