# API and rate-limiter runbook

App-level HTTP signals for the gateway edge. Source metric is the OTLP-derived
`http_server_request_count` in Mimir tenant `metrics`, with labels `job=cupboard-<svc>`,
`http_route`, `http_response_status_code`, `http_request_method`. OTLP metric-name
suffixes are OFF on this Mimir, so the counter keeps its emitted name (no `_total`).

Degradation matrix: `docs/phase6-closeout.md` (API surface) and `docs/phase7-plan.md`
(rate-limiter fail-open under "Redis down").

## First moves

```
kubectl -n cupboard-gateway logs deploy/cupboard-gateway --tail=200 | grep -E '5[0-9]{2}'
```

Loki: `{namespace="cupboard-gateway"} | json | http_response_status_code=~"5.."`

Mimir, top offending routes:

```
topk(10, sum by (http_route, http_response_status_code) (
  rate(http_server_request_count{job="cupboard-gateway",http_response_status_code=~"5.."}[5m])))
```

---

## CupboardGateway5xxRate

```
sum(rate(http_server_request_count{job="cupboard-gateway",http_response_status_code=~"5..",http_route!~"/healthz|/readyz"}[5m]))
  / clamp_min(sum(rate(http_server_request_count{job="cupboard-gateway",http_route!~"/healthz|/readyz"}[5m])), 1) > 0.05
```

For 5m. Warning. Health probes are excluded; `clamp_min(...,1)` guards against
divide-by-zero at low traffic so a single stray 5xx cannot false-fire.

Meaning: more than 5% of gateway API responses are 5xx over 5m. This covers the whole
gateway API surface (`/api/v1/*`, `/auth/*`, `/billing/*`, `/store/*`, etc.), which is
the intended "5xx on the public API" signal.

Blast radius: users are seeing errors on real API calls. Isolate whether it is one
route or broad: run the topk query above. A single route points at one downstream
(gateway proxies to auth/tenant/identity/fleet), so check that service's runbook in
services.md and its logs. Broad 5xx across routes points at the gateway itself
(pool exhaustion, a bad deploy, Redis/DB dependency) or a shared downstream.

Remediation: if it maps to a downstream service, treat that service's Down/CrashLoop.
If it is the gateway, check a recent rollout (`kubectl rollout undo` if so), and confirm
`cupboard-redis` and `cupboard-db` health.

## CupboardRateLimiterFailOpen

`sum(increase(gateway_ratelimit_fail_open{job="cupboard-gateway"}[10m])) > 0` for 5m. Warning.

Meaning: the gateway rate limiter could not reach Redis and is failing open, letting
requests through without enforcing per-org limits. This is deliberate fail-open
behavior (availability over enforcement), but it means the platform is unprotected
against abuse or runaway clients while it persists.

Almost always co-fires with `CupboardRedisDown` (redis.md): fix Redis and the limiter
resumes enforcing automatically. If Redis is healthy but this fires, the gateway cannot
reach it (network policy, wrong endpoint/secret, auth failure): check gateway logs for
the Redis connection error and the `cupboard-redis-master` Service/endpoints.

Note: the counter `gateway.ratelimit.fail_open` (Mimir name
`gateway_ratelimit_fail_open`) does not exist in Mimir until the limiter fails open for
the first time, so the rule stays silent (noData -> OK) until then, which is correct.
