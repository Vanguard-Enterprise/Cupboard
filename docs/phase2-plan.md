# Cupboard Phase 2 — Implementation Plan (⭐ The Vertical Slice)

> Turns ROADMAP Phase 2 + `identity-schema.md` into a sequenced, de-risked build.
> Phase 2 is the make-or-break integration: connect a real Rust server via RCON,
> track players + IPs, create and enforce a ban — proven end-to-end.
> **Status: approved decisions recorded; awaiting go-ahead to start PR1.**

## Definition of Done (three escalating proofs)

1. A live server's players appear in Cupboard **with their IPs**. ← the wedge
2. A ban created in Cupboard **blocks the player**.
3. An alt **triggers an evasion alert**.

The #1 risk (ROADMAP) is **RCON connection management at scale**, so PR1 is a
spike that proves the RCON protocol before any service scaffolding exists.

## Resolved decisions (2026-06-30/07-01)

| # | Decision |
|---|---|
| A | **Test server:** user has an existing Rust server with RCON — will supply host/port/password for staging validation (needed by PR1/PR3). |
| B | **PKs = uuidv7** (`uuidv7()`), since prod/staging CNPG is PG18. **Prereq:** bump CI test container + local dev Postgres 16→18 (native `uuidv7()`), or migrations fail in CI. Folded into PR1. |
| C | **Ban enforcement = RCON-only in Phase 2**: Collector matches connects against active bans → RCON kick / `banid` across the tenant's servers. Rich plugin enforcement is Phase 3. |
| D | **Creds boundary:** Fleet alone holds the envelope master key and exposes a cluster-internal endpoint serving decrypted connection configs for enabled servers; Collector pulls from it (does not read Fleet's tables or hold the key). |

## Thinnest end-to-end slice ("first data in")

```
Fleet: add server (RCON host/port/pw)  →  Collector: dial RCON, poll `status`
   →  publish RosterEvent to Redis Stream  →  Identity: consume + upsert
   player + steam identifier + ip signal + session  →  web: roster + players w/ IPs
```

No bans, link graph, A2S, console parsing, or panel adapters in slice #1 — just
roster pull → normalized event → identity upsert → visible with IP. That one thread
exercises all three new services + the Redis bus.

## Service boundaries

| Service | Owns (schema) | Phase 2 responsibility |
|---|---|---|
| **fleet** | `fleet`: `servers` (+ envelope-encrypted RCON creds), `server_status` | Server-connection CRUD (RLS, per-tenant); encrypts creds at rest; **internal endpoint** serving decrypted configs to Collector. Panel adapters deferred. |
| **collector** | *none* (stateless funnel) | Persistent outbound RCON WS per enabled server; `status` poll + console tail; normalize → Redis Streams. Later: RCON enforcement actions. The one horizontally-shardable unit. |
| **identity** | `identity`: global (`players`, `player_identifiers`, `identity_signals`, `name_history`, `player_links`, `merge_log`) + per-tenant RLS (`player_sessions`, `bans`, `ban_evasion_alerts`, `player_notes`, `player_flags`, `manual_links`, `audit_log`, pools) | Redis consumer → ingestion upsert; link-detection worker; bans CRUD + connect-time lookup; evasion detection; audit. Heavy write path. |
| **gateway** (existing) | — | Route `/fleet/*`, `/players/*`, `/bans/*` to new ClusterIP services; JWT + RLS context (built). |
| **apps/web** | — | Server roster, player list/profiles (IPs), ban management, evasion alerts. |

## New / extended crates

| Crate | Why |
|---|---|
| `crates/gameconn` (new) | RCON (WebSocket, Rust protocol) + A2S (UDP). Deps: `tokio-tungstenite`, `futures-util`. Reconnect/backoff; `status`/`playerlist` parsing. |
| `crates/bus` (new) | Redis Streams helpers (`XADD`/consumer-group/`XREADGROUP`/`XACK`/claim). Dep: `redis` async. First Redis usage in repo. |
| `crates/crypto` (extend) | Has `hmac_sha256(value, pepper)` (= `subject_hash`/`value_hash`). **Add** AES-256-GCM envelope encryption (DEK wrapped by master key) for Fleet creds. |
| `crates/domain` (extend) | New IDs via `uuid_newtype!` (`ServerId`, `BanId`, `SessionId`, `IdentifierId`…) + the inter-service **event contract** (`RosterEvent`, `SessionEvent`, Redis envelope). |

`crates/db` + `crates/telemetry` unchanged — `connect_scoped`, `begin_tenant_tx`,
`set_tenant`, `telemetry::init` + `http::track` already cover the need.

## Schema / migration order

Each service embeds `migrations/000N_*.sql` (sqlx `migrate!`), schema-scoped, with
RLS policies + guarded `cupboard_app` grants (mirror `auth/0001_auth_schema.sql`).

- `fleet/0001_fleet_schema.sql` — `servers` (encrypted creds), `server_status`; RLS.
- `identity/0001_identity_global.sql` — `players`, `player_identifiers`
  (unique `(type, value_hash)`), `identity_signals`, `name_history`. No tenant_id,
  no RLS, `cupboard_app` SELECT-only.
- `identity/0002_identity_tenant.sql` — `player_sessions` (RLS). *(completes slice #1)*
- `identity/0003_bans.sql` — `bans` + `subject_hash` enforcement index. *(slice #2)*
- `identity/0004_links_evasion.sql` — `player_links`, `manual_links`,
  `ban_evasion_alerts`, `merge_log`. *(slice #3)*
- `identity/0005_pools_audit.sql` — `sharing_pools`, `pool_members`,
  `ban_pool_shares`, `audit_log`.

**Two pools in Identity** (like auth): owner pool (RLS-bypass) for firehose writes to
global tables + explicit-`tenant_id` writes from Redis events; app pool +
`begin_tenant_tx` for the JWT-scoped read path. Fleet: app pool for CRUD, owner pool
for migrations + the internal config endpoint.

## RCON ingestion & connection management (risky core)

- **Transport:** Rust RCON = WebSocket JSON frames (not Source TCP). `status` → roster
  (SteamID64, IP, name, ping, connected time); console stream → connect/disconnect.
  A2S/UDP for server metadata (follow-up within Fleet PR).
- **Connection manager (Collector):** one supervised tokio task per enabled server;
  persistent WS + exp-backoff reconnect + circuit breaker; `status` poll ~30s
  (configurable) + continuous console tail. Connection state → OTel gauges +
  `fleet.server_status` for UI liveness.
- **Normalize → bus:** roster rows / console edges → `domain` events, `XADD` to
  `cupboard:roster` / `cupboard:sessions`. Collector holds zero business logic.
- **Sharding (forward-design, NOT built in P2):** single replica now; server→worker
  assignment behind an `enabled`/claim flag so a claim-lease / consistent-hash layer
  drops in at Phase 3/7 without reshaping code. Seam noted, not implemented.
- **Ingestion upsert (Identity):** resolve player by `(steam, value_hash)` (miss →
  create), upsert IP into `identity_signals`, upsert `name_history`, write
  `player_sessions`, refresh `players.last_seen_at`, enqueue link re-eval.
  `value_hash`/`subject_hash` via `crypto::hmac_sha256` + the global pepper.

## Cross-cutting (built in from day one — non-negotiable)

- **RLS** on every per-tenant table from migration #1; per-service `tests/rls.rs`
  (CI runs against the non-owner role, as in Phase 1).
- **OTel** via `telemetry::init` + `http::track` route-layer in all services;
  Collector also exports connection-health metrics.
- **Audit** on every ban create/revoke, server add/remove, merge, and PII view.
- **PII vs enforcement-key separation:** `value`/`ip`/`name`/`subject_value` are
  erasable PII; `*_hash` are durable keys. **Single global pepper** (same across
  tenants so global dedup + cross-network matching works) from Vault.
- **Phase-1 watch-items:** Identity & Fleet use `search_path` → connect to the
  **direct `cupboard-rw` service, not the pooler** (PgBouncer drops libpq `options`);
  any new CNPG managed-role password must equal its Vault/OpenBao secret.

## PR sequence (each shippable to staging)

| PR | Title | Proves |
|---|---|---|
| **PR1** | `crates/gameconn` + RCON spike + **CI/dev Postgres→18** | RCON protocol + `status` parsing vs a real server. De-risks #1. |
| **PR2** | Fleet + `servers` schema + crypto envelope encryption + gateway route + web add-server/roster | Operator adds a connection; creds encrypted at rest; on staging. |
| **PR3** | `crates/bus` + Collector + connection manager → publishes roster events | Live roster on the bus; connection health in Grafana. |
| **PR4** | Identity + global schema + `player_sessions` + Redis consumer + ingestion + web players | **⭐ DoD #1: players appear with IPs.** |
| **PR5** | `bans` schema + CRUD + connect-time lookup + Collector kick/banid + web bans | **DoD #2: a ban blocks the player.** |
| **PR6** | Link-detection worker + links + `ban_evasion_alerts` + evasion-on-connect + web alerts | **DoD #3: an alt triggers an evasion alert.** |
| **PR7** | Audit sweep + pools stub + merge endpoint + hardening | Cross-cutting closeout (retention/erasure *tooling* → Phase 7). |

Each PR adds its binary to the CI build matrix
(`+cupboard-fleet, cupboard-collector, cupboard-identity`); generic `Dockerfile`
(`BIN` arg) needs no change.

## Deploy / Vault additions (in `v-deployments`, mirroring Phase 1)

- New ArgoCD apps + overlays: `cupboard-fleet`, `cupboard-collector`,
  `cupboard-identity` (ClusterIP, behind gateway, no public ingress). `use1` root is
  `syncPolicy:None` → apply the new Application CRs manually.
- **Redis** redis-operator `RedisReplication` — first Redis dependency (Phase 0
  deferred it; now required).
- New Vault/OpenBao keys (KV v2):
  - `cupboard/staging/identity` → `value_pepper` (global HMAC pepper, `value_hash` +
    `subject_hash`).
  - `cupboard/staging/fleet` → `master_key` (envelope master key for RCON creds).
  - `cupboard/staging/redis` → connection URL/password.
- System writers (Identity/Collector) reuse the existing **`cupboard` owner role**
  (RLS-bypass for global writes); read/CRUD path keeps `cupboard_app`. No new DB role
  → avoids the Phase-1 managed-role/grant gotcha.

## Remaining open questions (non-blocking; decide as we reach them)

- **Signal retention vs enforcement** — how long to keep IP hashes purely for linking
  (schema supports it; worker is Phase 7).
- **Pool ban precedence** — if a pool ban and a local revoke disagree, which wins?
  (Only matters once pools are enforced; schema is present in PR7.)
- **Un-merge fidelity** — is the `merge_log` snapshot enough, or full reversibility?
- **Link-confidence weights + surfacing threshold** — start with the doc's example
  weights (`steam_owner 0.6, eac 0.7, shared_ip 0.3 time-decayed, name 0.1`); tune
  against real data at PR6.
