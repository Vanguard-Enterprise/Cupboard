# Cupboard runbooks

One page per alert group in `applications/grafana/overlays/use1/vanguard/alerts/rules-cupboard.configmap.yaml`
(v-deployments). Every alert's `runbook_url` annotation deep-links to the matching
heading here. Alerts carry `team: cupboard`; routing today falls through to the
platform Slack channels (`#alerts-platform-critical` / `#alerts-platform-warning`)
because there is no cupboard-specific notification policy yet.

## Pages

| Page | Covers |
|---|---|
| [services.md](services.md) | Per-service Down / CrashLooping for all 9 deployables (auth, gateway, tenant, identity, fleet, collector, metrics, web, bot) |
| [database.md](database.md) | CNPG cluster `cupboard` in `cupboard-db` |
| [redis.md](redis.md) | opstree `cupboard-redis` streams bus |
| [certificates.md](certificates.md) | Custom-domain TLS certs in `cupboard-web` |
| [api-and-limiter.md](api-and-limiter.md) | Gateway 5xx rate, rate-limiter fail-open |
| [billing.md](billing.md) | Stripe webhook ingestion on tenant |

## Conventions

- **severity**: `critical` = user-facing outage or data-at-risk, pages the critical
  channel; `warning` = degraded or trending-bad, needs attention this shift.
- **Signals**: kube-state-metrics (`kube_deployment_*`, `kube_pod_*`,
  `kube_statefulset_*`) work for every namespace and back the liveness alerts. App
  metrics arrive over OTLP into Mimir tenant `metrics`; metric-name suffixes are OFF
  on this Mimir, so OTLP counters keep their emitted names (for example
  `http_server_request_count`, not `..._total`).
- **Degradation matrices**: Phase 6 capability behavior lives in
  `docs/phase6-closeout.md` ("Degradation matrix (verified)"); the Phase 7
  privacy/mesh matrix lives in `docs/phase7-plan.md` ("Degradation matrix"). Each
  page points at the relevant one.

## First moves (any alert)

```
kubectl -n <namespace> get pods
kubectl -n <namespace> describe deploy/<name>
kubectl -n <namespace> logs deploy/<name> --tail=200
```

Loki in Grafana Explore, scoped to the namespace:

```
{namespace="cupboard-<svc>"} | json | level="error"
```

Grafana dashboards: the Cupboard overview + per-service panels under the `platform`
folder. Mimir Explore for the PromQL in each alert's `expr`.

## Documented metric gaps (decision L, no metric yet)

These decision-L items have no live metric, so no rule is wired. They are a small
app-code follow-up, out of PR4 scope. Add the metric, then add the rule.

| Item | Where | Metric to add |
|---|---|---|
| Ticket-stream consumer lag / PEL age | bot | Redis-stream consumer-group lag gauge, for example `cupboard_ticket_stream_pending{group,stream}` and `cupboard_ticket_stream_pel_age_seconds` emitted by the bot consumer loop |
| Privacy / retention worker stall | auth (coordinator + retention loops), identity, tenant | last-successful-tick gauge, for example `cupboard_privacy_worker_last_success_timestamp_seconds` and per-table purge counters `cupboard_retention_purged_rows_total{schema,table}`; alert on `time() - last_success > 2 * interval` |
| Stripe reconcile stall | tenant | reconcile-loop last-success gauge, for example `cupboard_billing_reconcile_last_success_timestamp_seconds` (distinct from the live webhook-5xx signal, which is wired) |
| CNPG backup failed | cupboard-db | needs `barmanObjectStore` + `ScheduledBackup` on the cluster (not configured in staging); then mirror `CNPGBackupFailed` from rules-cnpg |
| Rustlike perf gauges (`cupboard_server_*`) | collector/metrics ingest | present in code but absent from Mimir until a plugin reports; not an alerting target, informational only |

Note on `CupboardRateLimiterFailOpen`: the counter `gateway_ratelimit_fail_open`
exists in gateway code but is absent from Mimir until the limiter first fails open
(Redis unreachable). The rule is wired and stays silent (noData -> OK) until the
series appears, which is exactly when it should fire.
