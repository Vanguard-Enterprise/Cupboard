# Redis runbook

opstree `RedisReplication` named `cupboard-redis` in namespace `cupboard-redis`
(`clusterSize: 1`, single master, exposed as `cupboard-redis-master`). It is the
streams bus for ticket events and the backing store for gateway rate limiting. No
`redisExporter` sidecar is configured, so there are no `redis_*` metrics; health rides
kube-state-metrics on the operator's StatefulSet.

Degradation matrix: `docs/phase7-plan.md` ("Redis down" column) and
`docs/phase6-closeout.md`.

## First moves

```
kubectl -n cupboard-redis get redisreplication cupboard-redis
kubectl -n cupboard-redis get statefulset,pods
kubectl -n cupboard-redis logs sts/cupboard-redis --tail=200
kubectl -n cupboard-redis exec -it cupboard-redis-0 -- redis-cli -a "$PW" ping
```

Mimir: `kube_statefulset_status_replicas_ready{namespace="cupboard-redis"}`,
`kube_pod_container_status_restarts_total{namespace="cupboard-redis"}`.

---

## CupboardRedisDown

`kube_statefulset_status_replicas_ready{namespace="cupboard-redis",statefulset="cupboard-redis"} == 0` for 5m. Critical.

The Redis master has zero ready replicas: the streams bus and the rate-limiter backend
are down.

Blast radius:
- **Rate limiting fails open.** The gateway limiter cannot reach Redis and lets
  requests through unlimited (see api-and-limiter.md, `CupboardRateLimiterFailOpen`,
  which should co-fire). Availability is preserved; the limit is not enforced.
- **Ticket stream stalls.** The bot cannot consume ticket events; Discord-side ticket
  sync pauses. Events buffer in the producers and drain on recovery.
- **Retention XTRIM skipped** (Phase 7): stream trims are skipped, PG purge is
  unaffected; next tick catches up.

Diagnose: pod not running (OOM, limit is 256Mi), PVC/Longhorn issue (5Gi longhorn
volume), or the operator failing to reconcile. Check the operator and the pod events.
CNPG-style self-heal does not apply; the opstree operator recreates the pod. If the PVC
is unhealthy, check Longhorn. Data on the streams is not durable-critical (events
replay), so a clean restart is acceptable.

## CupboardRedisCrashLooping

`rate(kube_pod_container_status_restarts_total{namespace="cupboard-redis"}[15m]) > 0` for 15m. Warning.

The Redis pod is restarting. Usually OOM (bump the 256Mi limit if the working set
grew), a corrupt append-only file, or a failing probe. `kubectl -n cupboard-redis logs
cupboard-redis-0 --previous`. If AOF/RDB is corrupt on a throwaway staging store, the
fastest fix is to delete the PVC and let the operator recreate (events replay from
producers; entitlements/tickets are in Postgres, not Redis).
