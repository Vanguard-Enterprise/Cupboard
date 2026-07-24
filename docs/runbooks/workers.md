# Workers runbook

Background loops that run inside the service pods (not their own deployments): the
retention/purge loops on auth, identity, and tenant, and the privacy coordinator on
auth. Each stamps an OTLP observable gauge with the unix seconds of its last
successful tick, so a stalled or dead loop is detectable even while the pod itself is
healthy (the liveness alerts in services.md would not catch a wedged loop in a running
pod). Zero extra labels on the gauges (decision L cardinality budget): the OTLP
`service.name` becomes the Mimir `job` label, which is what distinguishes
auth/identity/tenant, exactly as `gateway_ratelimit_fail_open` is per-service.

Both metrics are absent until the first successful tick after a deploy, so the rules
sit in noData -> OK until the series appears. That is expected: the alert only fires
once a worker has run at least once and then fallen behind.

Degradation matrix: the Phase 7 privacy/retention behavior is in
`docs/phase7-plan.md` ("Degradation matrix"); the worker designs are in
`services/{auth,identity,tenant}/src/retention_loop.rs` and
`services/auth/src/privacy_worker.rs`.

## CupboardRetentionWorkerStalled

`time() - max by (job) (cupboard_retention_last_success_seconds{job=~"cupboard-(auth|identity|tenant)"}) > 7200` for 10m. Warning.

**Meaning.** One of the retention purge loops (auth, identity, or tenant, per
`{{ $labels.job }}`) has not completed a tick in over two hours. The loop ticks
hourly, so the 7200s threshold is 2x the interval: a single missed tick is tolerated,
two consecutive misses fire. The gauge is stamped at the end of every tick that
returns without panicking, so a stall means the loop is wedged, panicking every tick,
or the pod is not running the loop at all. Data past its retention window is not being
purged while this is firing (a compliance/PII-retention concern, not a user-facing
outage).

**First moves.** Identify the service from `{{ $labels.job }}` (e.g. `cupboard-auth`),
then:

```
kubectl -n <namespace> logs deploy/<name> --tail=200 | grep -i "retention"
```

You expect a `retention purge tick done` info line each hour. Its absence, or a
recurring `retention ... tick crashed; the loop continues` error, localizes the fault.

**Remediation.**
- If the pod is crash-looping or was recently restarted, the loop restarts with the
  pod; confirm the deployment is healthy (services.md) and the gauge recovers on the
  next tick.
- A repeated tick crash points at the database: the purges run on the owner pool.
  Check `cupboard-db` (database.md); a purge that errors per-table only logs and
  continues, so a full-tick crash is unusual and worth capturing with
  `--previous` logs.
- The purges are bounded (per-table row cap, cutoffs are absolute), so there is
  nothing to unstick manually: once the loop ticks again it catches up across
  subsequent ticks. Rolling-restart the deployment if the loop is wedged but the pod
  otherwise looks healthy.

## CupboardPrivacyWorkerStalled

`time() - cupboard_privacy_worker_last_success_seconds{job="cupboard-auth"} > 900` for 5m. Warning.

**Meaning.** The privacy coordinator on auth has not completed a drain pass in over 15
minutes. The worker ticks every 15s, so 900s is roughly 60 missed ticks. The gauge is
stamped at the end of every tick that returns without panicking; a stall means
export/erase (DSAR) jobs are queuing without being processed. The metric only exists
when the worker runs (`PRIVACY_TOKEN` set), so if it is absent entirely the worker is
simply not enabled, which is not this alert.

**First moves.**

```
kubectl -n cupboard-auth logs deploy/cupboard-auth --tail=200 | grep -i "privacy"
```

You expect frequent `privacy worker` activity; look for a recurring
`privacy worker tick crashed; the loop continues` error, or silence.

**Remediation.**
- The coordinator fans out to the identity and tenant walkers over HTTP. If those
  services are down or unreachable, jobs fail/requeue but the tick itself still
  completes, so a true stall (no completed tick) points at the worker loop or auth's
  own database, not the walkers. Confirm `cupboard-db` (database.md).
- Jobs are idempotent and resume on recovery (Phase 7 matrix), so no data is lost
  while this fires; the queue drains once the loop ticks again.
- Rolling-restart `cupboard-auth` if the loop is wedged. Re-check the gauge after the
  next tick (within ~15s of a healthy pod).
