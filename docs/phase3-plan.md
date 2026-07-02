# Cupboard Phase 3 — Implementation Plan (Rich ingestion: plugin + perf mod + metrics)

> Turns ROADMAP Phase 3 into a sequenced, de-risked build, following the shape that
> worked for Phase 2 (`phase2-plan.md`). Phase 3 raises ingestion from the RCON-poll
> baseline to full fidelity: the gameplay plugin (push, rich tier), the Harmony perf
> mod (push, perf tier), the Phase-2 RCON carry-overs (A2S + console stream), and the
> Metrics service (Mimir + recommendations).
> **Status: in progress — decisions below are working defaults, flagged where the
> user may want to override.**

## Definition of Done (from ROADMAP)

1. A **plugin-enabled server streams rich events** — full identifiers (Steam +
   owner + EAC), chat, F7 reports, playtime — and executes an inbound action
   (ban) without RCON.
2. **Perf telemetry lands in Mimir** and dashboards render; **recommendation tips
   surface** in the dashboard.
3. **Data degrades gracefully without the plugin** — the RCON-only baseline still
   works, and is itself richer than Phase 2 (A2S server info + real-time console
   stream instead of 30s polls only).

The #1 Phase 3 risk (ROADMAP) is **push-ingestion backpressure**, so the push
gateway is built and load-tested (PR3) *before* the plugin exists — a synthetic
pusher stands in for it, exactly like the Phase 2 RCON spike preceded Fleet.

## Working decisions (defaults; recorded 2026-07-01)

| # | Decision |
|---|---|
| A | **One C# plugin codebase targets both Oxide/uMod and Carbon** — written as an Oxide-compatible `RustPlugin` (no Carbon-only APIs), which Carbon loads natively. The `carbon` skill's datasets (hooks/signatures) drive development; the user's test server validates. |
| B | **Push transport = HTTPS batch POST** to `POST /ingest/v1/events` (JSON envelope, optional gzip), routed via the existing public gateway → Collector. Stateless and NAT-friendly; no server-side WS fan-in to manage. The plugin batches locally (flush every ~5s or 100 events). |
| C | **Per-server ingest token**: Fleet issues/rotates an opaque token (`cus_<32 rand bytes b64url>`), shows it once, stores only the SHA-256 hash. The internal config feed to Collector includes `token_hash`; Collector verifies bearer tokens against its cached feed (constant-time compare on the hash). One token per server, shared by plugin + perf mod. |
| D | **Command channel = piggyback on push responses.** Every accepted push returns `{"commands": [...]}` (pending ban/kick/entitlement actions); the plugin ACKs results by pushing `command_result` events. A 30s heartbeat event guarantees a command flush path on idle servers. RCON kick/banid enforcement from Phase 2 stays as the no-plugin fallback. |
| E | **Backpressure**: streams are bounded (`XADD MAXLEN ~`), Collector answers 429 + `Retry-After` when Redis is down or the caller exceeds per-token rate limits; request body capped (1 MiB). The plugin buffers to a bounded queue and sheds lowest-value events first (combat log → chat → stats; identifiers/sessions last). |
| F | **Chat, reports, playtime live in Identity** (tenant-scoped RLS tables `chat_messages`, `player_reports`, plus playtime stats) — they are moderation context and hang off the player graph. Retention/purge tooling stays Phase 7; schema keeps the PII/hash separation discipline. |
| G | **Perf pipeline**: new `services/metrics` consumes `cupboard:perf` → exports OTel metrics with `tenant_id`/`server_id` attributes → `alloy-receiver` → **Mimir** (Decision 5). *Amended at PR7:* the v1 rule engine and dashboard charts read a **process-local sliding window** (2h) inside the metrics service — recommendations compute on read (nothing persisted, nothing stale) and charts serve the recent range without a Mimir round-trip or a PromQL proxy security surface. Mimir remains the long-term TSDB via OTel; PromQL-backed long-range views layer on when needed (Grafana serves operators today). |
| H | **New repos** `Vanguard-Enterprise/cupboard-plugin` (PR4) and `cupboard-perfmod` (PR6), per ARCHITECTURE ("separate game-server-side repos"). Created when their PR starts. |

## Thinnest end-to-end slice ("first rich data in")

```
Fleet: issue ingest token → plugin (or synthetic pusher): batch POST /ingest/v1/events
   → Collector: token auth + validate + XADD (chat/sessions/reports/perf streams)
   → Identity: consume rich events (EAC/owner identifiers, chat, reports)
   → Metrics: consume perf → OTel → Mimir
   → web: chat logs, richer profiles, perf charts + tips
```

PR1/PR2 first close the Phase 2 carry-overs so the *baseline* (no plugin) tier is
complete before the push tier stacks on top — that's what makes "degrades
gracefully" checkable at the end.

## Service boundaries (delta from Phase 2)

| Service | Phase 3 delta |
|---|---|
| **fleet** | Ingest-token issue/rotate/revoke (hash at rest); server-info columns (A2S hostname/map/players); token_hash + query_port in the internal feed. |
| **collector** | A2S poll (best-effort, same per-server task); RCON console tail → chat/session streams; **push ingest endpoint** (auth, limits, backpressure); command queue delivery via push responses. Still zero business logic. |
| **identity** | New consumers: sessions (real-time edges), chat, reports, rich identifiers (EAC/owner as first-class identifier types — schema already supports), playtime; source tagging (`rcon` vs `plugin`) + dedupe when both feed the same server. |
| **metrics** (new) | `cupboard:perf` consumer → OTel/Mimir; rule-based recommendation engine (PromQL); tips storage (RLS) + query API; PromQL proxy for web charts. |
| **gateway** | Route `/ingest/*` → collector (public, token-authed by collector, no JWT); `/perf/*` → metrics (JWT + RLS context as usual). |
| **apps/web** | Servers page: live A2S info. New: chat logs. Profiles: reports/playtime/identifier sources. New: perf dashboard + recommendations. |
| **cupboard-plugin** (new repo) | Rich events out, commands in. |
| **cupboard-perfmod** (new repo) | Harmony-only perf telemetry out. |

## Event contract (crates/domain)

New versioned push envelope + typed events shared by Collector (producer) and
Identity/Metrics (consumers). Streams:

- `cupboard:roster` — existing (RCON poll snapshots).
- `cupboard:sessions` — connect/disconnect edges (console stream **and** plugin).
- `cupboard:chat` — chat messages (console stream **and** plugin; team chat plugin-only).
- `cupboard:reports` — F7 reports (plugin-only).
- `cupboard:perf` — perf samples (perf mod only).

Push envelope: `{schema: 1, events: [{type, at, ...}]}`; unknown event types are
accepted-and-dropped (forward compat) with a counter metric.

## PR sequence (each shippable to staging)

| PR | Title | Proves |
|---|---|---|
| **PR1** | **A2S server info** — `gameconn::a2s` (UDP, challenge flow) + Collector best-effort poll + fleet info columns/endpoint + web server cards | Phase 2 carry-over closed; map/hostname/player-count live without RCON. |
| **PR2** | **RCON console stream** — gameconn subscription split (unsolicited frames) + chat/join/leave parsing; Collector tail → `cupboard:chat`/`cupboard:sessions`; Identity `chat_messages` + real-time session edges; web chat logs | Real-time baseline without the plugin — the degradation floor. |
| **PR3** | **Push ingest gateway** — fleet ingest tokens; Collector `POST /ingest/v1/events` (auth, caps, 429 backpressure, MAXLEN); command-queue schema + piggyback delivery; gateway `/ingest/*`; synthetic-pusher load test | ⭐ The Phase 3 risk, de-risked before the plugin exists. |
| **PR4** | **cupboard-plugin MVP** (new repo) — identifiers/chat/reports/heartbeat out; bounded buffer + retry; executes ban/kick commands | A real server streams rich events; a ban enforces without RCON. |
| **PR5** | **Rich ingestion** — Identity consumes plugin events (EAC/owner identifiers, reports, playtime, source tagging + dedupe); web richer profiles | DoD #1 visible end-to-end. |
| **PR6** | **Perf tier** — cupboard-perfmod (new repo, Harmony) + `services/metrics` consumer → OTel → Mimir | DoD #2 first half: perf lands in Mimir. |
| **PR7** | **Recommendations + dashboards** — rule engine (PromQL) + tips API/UI + web perf charts; degradation-matrix verification (RCON-only / +plugin / +perfmod) | DoD #2 second half + DoD #3 closeout. |

CI: PR6 adds `cupboard-metrics` to the build matrix (generic `BIN`-arg Dockerfile
unchanged). Plugin/perfmod repos get their own minimal CI (C# compile against
Oxide/Carbon reference assemblies).

## Deploy / OpenBao additions (v-deployments, mirroring Phase 2)

- **PR3:** gateway route env for `/ingest/*` → collector ClusterIP (collector gains
  a real Service port beyond health); rate-limit envs.
- **PR6:** new ArgoCD app `cupboard-metrics` (overlay cloned from identity; direct
  `cupboard-rw` if it uses `search_path`); Mimir write path is just OTLP →
  `alloy-receiver` (already reachable); watch **Mimir cardinality** (per-tenant ×
  per-server × per-plugin labels — keep hook timings top-N, not unbounded).
- No new OpenBao keys expected: collector/identity/metrics reuse
  `internal→api_token`, `redis→password`; ingest tokens are data (hashed in PG),
  not deploy secrets. (`cupboard/staging/metrics` only if a Mimir tenant header or
  basic-auth turns out to be needed.)
- `use1` app-of-apps is `syncPolicy: None` — `kubectl apply` new Application CRs.

## Degradation matrix (DoD #3 closeout — verified 2026-07-02)

Operators enable mechanisms per server; every column degrades to the one left of it.
Verified live on the test server (RCON+A2S+plugin) and synthetically for the rest.

| Capability | RCON only | + A2S | + plugin (CupboardLink) | + perf mod |
|---|---|---|---|---|
| Roster / sessions / IPs | ✅ 30s polls | ✅ | ✅ + exact edges, works with RCON down | ✅ |
| Server metadata (map/pop) | — | ✅ | ✅ | ✅ |
| Chat | ✅ console stream | ✅ | ✅ (+team chat); cross-source deduped | ✅ |
| Ban enforcement | ✅ kick ≤30s + instant on join | ✅ | ✅ + command channel (kick/ban/unban), works with RCON down | ✅ |
| Identifiers | steam + owner (roster) | ✅ | ✅ + EAC id | ✅ |
| F7 reports | — | — | ✅ | ✅ |
| Playtime | ✅ (session-derived) | ✅ | ✅ | ✅ |
| Perf samples + recommendations | — | — | ✅ 30s sampler (no frame dist.) | ✅ + frame-time avg/max |

Loss behaviors: plugin unreachable → bounded buffer + backoff (oldest shed);
Redis down → 503 backpressure, plugin re-sends; identity down → enforcement
skipped that batch, healed at next poll/roster; perf reporting stops → the
`stale-reporting` recommendation says so.

## Open questions (non-blocking; decide as we reach them)

- **Combat logs** — toggleable in plugin config; default off (volume + privacy).
  Where they land (identity vs object storage) decided when someone asks for them.
- **Playtime granularity** — start with per-server lifetime seconds + last-30d
  rollup; refine against dashboard needs.
- **Mimir tenancy** — single Mimir org with `tenant_id` label at launch scale
  (500 servers); revisit per-tenant orgs only if isolation demands it.
- **Recommendation rules v1** — start set: sustained FPS < target, frametime
  spikes, entity count vs map size, GC pause frequency, top plugin hook time,
  mem growth. Tune once real perf data flows (PR7).
- **Plugin update channel** — manual download at first; auto-update prompt via
  command channel is a later phase.
