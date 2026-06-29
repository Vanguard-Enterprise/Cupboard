# Cupboard — Architecture

> Status: **design** (pre-implementation). This document is the source of truth for
> stack and architecture decisions. The decision log at the bottom records *why*.

## 1. What Cupboard is

Cupboard is the complete **backend + hosted frontend** for a Rust *(the game)*
server network's entire operation. Tenants (server-network owners) connect
everything to us. It spans:

- **Server lifecycle** — provision / start / stop / wipe / update servers and
  nodes via **tenant-configured panel connections (Pelican *and/or* Pterodactyl)
  and/or direct SSH** to the tenant's own installs; plugin management.
- **Metrics & performance** — collect server + plugin performance data, store it,
  and generate **performance recommendation tips**.
- **Player tracking & moderation** — BattleMetrics-style player / IP / alt tracking,
  bans, audit; **import from BattleMetrics with optional continuous sync**.
- **Commerce** — hosted per-tenant stores, payments, entitlement/perk delivery into
  the game servers.
- **Support** — ticketing via the tenant's website *and* via Discord.
- **White-label hosting** — we host each tenant's storefront *and* admin panel,
  customizable themes, paid custom designs, on **custom domains**.

### Surfaces / audiences

| Surface | Audience | Auth |
|---|---|---|
| Admin dashboard | Operators / staff (server owners) | email+password + Discord (own auth) |
| Public storefronts (per tenant, custom domains) | Players / customers | Steam + Discord OAuth (own auth) |
| Discord bot | Operators + players | n/a (bot) |
| Public API | Integrations | API tokens |

There are **three populations**: operators (log into admin), players/customers
(log into tenant storefronts), and tracked players (observed in-game by the
Collector, may never log in). Customer logins link onto tracked identities.

## 2. Scale targets (launch)

- ~500+ Rust game servers
- ~100–300 tenants
- 30–100k tracked players (the identity firehose — the real scale driver)

Cluster capacity will be **added before launch** (see decision log). Design for
headroom; keep services memory-frugal (Rust) since the cluster is memory-bound.

## 3. Stack

| Layer | Choice |
|---|---|
| Backend language | **Rust** (async on **tokio**) |
| Backend web framework | **Axum** + tower middleware |
| DB access | **sqlx** (compile-time-checked SQL, async) |
| Public API | REST + OpenAPI (utoipa); GraphQL deferred |
| Inter-service | REST/JSON via shared client crates initially; gRPC (tonic) only if needed |
| Auth | **Own auth service** — `argon2` passwords, JWT/PASETO sessions, `oauth2`/`openidconnect` (Discord), Steam OpenID (players) |
| Event bus | **Redis Streams** (consumer groups; NATS/Redpanda = upgrade path) |
| Relational DB | **PostgreSQL** via CloudNativePG + PgBouncer |
| Perf time-series | **Mimir** (Prometheus-compatible) via OTLP |
| Cache | **Redis** (redis-operator) |
| Discord bot | **TypeScript** + discord.js |
| Frontend | **Next.js** (App Router, SSR) + Tailwind + shadcn/ui + TanStack Query — SSR is required for per-hostname tenant theming on custom domains |
| Observability | OpenTelemetry (`tracing` + `tracing-opentelemetry` + `opentelemetry-otlp`) → Alloy receiver; Pyroscope for profiling |

## 4. Services (modular code, coarse deploy)

Each is its own crate/binary in a Cargo workspace with clean boundaries, so they
can be split onto dedicated infra later. At launch they **share data stores**
(1–2 CNPG clusters with schema-per-service, one Redis); only the Collector is
deployed as an independently-scalable unit.

| Service | Responsibility | Scaling profile |
|---|---|---|
| **gateway** | Front door: public API, auth validation, tenant routing, fan-out | medium |
| **auth** | Operator + player/customer auth (email, Discord, Steam), RBAC, invites | low (operators) / high (players) |
| **fleet** | Server/node lifecycle via tenant-configured Pelican/Pterodactyl panel connections + SSH (panel-adapter abstraction), plugin management | low-freq control ops |
| **collector** | Connection-heavy ingestion: RCON, metric polling, player/event firehose → publishes to Redis Streams | **horizontally shardable — the one we scale independently** |
| **identity** | Player tracking, IP/alt linking graph, bans, audit, BM import + continuous sync | heavy write path |
| **metrics** | Perf time-series (to Mimir) + recommendation engine | read/compute heavy |
| **tenant** | Commerce (store, payments, entitlements) + Sites (white-label builder, themes, domains) + Support (tickets) — split later | medium |

Non-Rust: **bot** (TS / discord.js), **web** (Next.js).

### Data flow (event firehose)

```
                  RCON/A2S (pull) ┐
  tenant servers  plugin   (push) ├─> collector ─Redis Streams─┬─> identity (player/IP/ban events)
                  perf mod (push) ┘                            └─> metrics  (perf events → Mimir)
```

The Collector does no business logic — it ingests and publishes. Identity and
Metrics are independent consumer groups reading at their own pace.

### Data ingestion (Collector)

How Cupboard observes a tenant's Rust servers. **Operators choose, per server,
any combination of three mechanisms** — features degrade gracefully based on what
is enabled:

1. **RCON + A2S — pull, zero-install baseline.** Collector dials *out* to the
   server's RCON (WebSocket) and queries roster (`status`/`playerlist` → Steam ID,
   IP, name, ping, sessions) plus the console stream (chat, connect/disconnect),
   and A2S for server info. Works the moment a connection is added. This is the
   BattleMetrics approach. *Limitation:* console-level only — no plugin perf, no
   deep identifiers.
2. **Cupboard gameplay plugin (Oxide/uMod + Carbon) — push, rich tier.** Installed
   by the operator; pushes rich events to Cupboard's authenticated ingest endpoint
   and executes inbound actions (bans, **store entitlement delivery**). Captures the
   full identity set + chat logs + F7 reports + playtime/stats + (toggleable)
   combat logs.
3. **Cupboard performance mod (Harmony, RustServerMetrics-style) — push, perf
   tier.** A Harmony patch (not an Oxide hook, for low overhead) reporting
   server/plugin performance — frametime/FPS, network, entity counts, GC, per-plugin
   hook timings — to ingest → Metrics → Mimir.

**Direction matters:** RCON is *pull* (Collector → server, persistent outbound WS).
The plugin and mod are *push* (server → Cupboard ingest gateway, per-server token
auth, backpressure into Redis Streams). The Collector unifies both into one event
firehose.

**Identifiers captured** (mechanism permitting): Steam ID, **Steam owner ID**
(family-share — a strong alt signal), **EAC ID**, IP(s), name history, session
start/stop — plus chat logs, F7 reports, playtime stats, and optional combat logs.
These feed the Identity linking graph (see Topic 3 / future section).

**New build deliverables** (separate game-server-side repos, like the AmityRust
plugins — *not* in this backend repo):
- Cupboard **gameplay plugin** (Oxide/uMod + Carbon)
- Cupboard **performance mod** (Harmony)

### Panel connections (Fleet)

Tenants run their **own** game-server panels and add connections to Cupboard
(the in-cluster Pelican is only a dev/test install, not the orchestration layer).
Fleet is a **multi-panel integration layer**:

- A tenant configures one or more **connections**, each typed `pelican` |
  `pterodactyl` | `ssh`, with a base URL + credentials (API key / SSH key).
- Pelican is a Pterodactyl fork with a near-identical Application + Client API, so
  a single **panel-adapter trait** with a per-type implementation covers both;
  RCON and SSH are separate transports underneath.
- Tenant-supplied panel credentials are **encrypted at rest** in Postgres
  (envelope encryption; data key wrapped by a master key from Vault) rather than
  one Vault entry per tenant — there are hundreds of tenants supplying secrets at
  runtime.

## 5. Multi-tenancy, identity & compliance

### Tenant isolation

Shared Postgres; every tenant-scoped table carries **`tenant_id`**, enforced by
**Postgres Row-Level Security (RLS)**. Standard SaaS approach — scales to thousands
of tenants, one schema, simplest ops.

### Two-layer data model: global identity, per-tenant moderation

- **Global identity layer (deduped, canonical).** A real player is represented
  **once, platform-wide**, by an opaque **Cupboard Player ID** (surrogate — *not*
  the Steam ID). It owns many **identifiers** (Steam ID, Steam owner/family-share
  ID, EAC ID, IP, Discord), each with first/last-seen + confidence, plus the
  **links** between identities (alt detection). Global → no per-tenant duplicate
  player rows, better performance, and cross-network alt detection out of the box.
  - **Merge/split**: confirming an alt repoints identifiers onto one Cupboard Player
    ID; a bad match (family share, shared PC) can be un-merged. The surrogate key
    makes this cheap; merges are fully audited.
- **Per-tenant layer (RLS-isolated, private by default).** Each tenant's servers,
  observations, **bans**, notes, flags, store, staff, and site. Moderation data is
  private and shared with other tenants only through **opt-in sharing pools**
  (alliances).

Net: **shared identity/alt graph, private moderation.** Tenants benefit from
platform-wide alt detection but never auto-expose their ban lists.

### Canonical key

**Cupboard Player ID = global opaque surrogate** (ULID/UUID internally; short
public display ID, BM-style). Steam ID is the most important *identifier*, never the
primary key. URLs, API, and audit all reference the Cupboard Player ID.

### Compliance design (schema hygiene now; legal paperwork is a pre-launch checklist)

The full legal apparatus is **not** a launch blocker, but the schema-level hygiene
is built in from day one (cheap now, brutal to retrofit — and it doubles as clean
data architecture):

- **PII vs enforcement-key separation** — bans key off a **salted hash of the Steam
  ID**, stored apart from the linkable profile, so a player's PII can be erased
  while the ban still blocks them.
- **Soft-delete + retention/purge worker** — raw IP/session data has retention
  windows; a scheduled job purges past them.
- **Per-player data export** and an **audit log** of access/changes.
- **Data minimization** — combat logs off by default; collect only what's needed.
- ⚠️ A global identity graph makes Cupboard a **controller** of cross-network PII —
  get a real privacy/DPA review before onboarding EU networks (SCCs for the US
  cluster; an EU region likely later). On the checklist, not a blocker.

### Link detection (global, automatic, advisory)

Link detection is **fully automatic** — no human curates the global graph (one org
must not shape a graph other tenants depend on). Cupboard computes candidate links
from signals, each contributing a weighted **confidence score**:

| Signal | Strength | Notes |
|---|---|---|
| Steam owner / family-share ID | **strong** | The account that owns the game; classic family-share alt. Plugin-captured. |
| EAC / other game IDs | **strong** | Anti-cheat identifier tied to machine/account. Plugin-captured. |
| Shared IP | medium | Down-weighted — CGNAT / shared houses / VPN cause false positives. |
| Name / behavioral | weak | Hint only, never decisive. |

Links are **advisory, not auto-enforcing** — since bans are identifier-level (below),
a false-positive link never auto-bans anyone; it only drives evasion alerts.

### Manual links (per-org, private)

Orgs can assert their **own** links (tenant-scoped, private), typically in the
course of banning/moderation. These do **not** enter the global graph and don't
affect other tenants (they can be shared via opt-in pools, like other moderation).

### Bans & evasion handling

- **Bans target a specific identifier** (Steam ID hash), not the whole player —
  precise, avoids over-banning off a bad link.
- **Scope options at the network level** — a ban can apply network-wide (all the
  tenant's servers) or per-server; pool-shared bans layer on via opt-in pools.
- **Evasion = alert, not auto-ban.** When a new identifier that is *linked* (global
  auto-graph **or** the org's own manual links) to a currently-banned identifier
  appears on the network, the default is to **alert the operator and/or flag the
  player for manual inspection** — a human decides whether to ban the alt. This
  response is **operator-configurable at the network level** (alert / flag /
  stricter orgs may opt into auto-action).
- **Enforcement** reaches servers via the plugin (sync ban list, block on connect)
  or RCON `banid` fallback, per the operator's enabled ingestion mechanisms.

## 6. Deployment & infra (reuses the `v-deployments` GitOps cluster)

Target: the Talos k8s cluster (`use1`), managed by **ArgoCD app-of-apps + Kustomize**.
Cupboard's k8s manifests live in `v-deployments` (not this repo); this repo holds
source + container builds. Clone the **rustlens** overlay skeleton as the template.

| Concern | Mechanism |
|---|---|
| Images | `ghcr.io/vanguard-enterprise/cupboard-<svc>:main`, digest-pinned by argocd-image-updater |
| Registration | one ArgoCD `Application` per component in `argocd/applications/use1/` |
| Ingress | Traefik `IngressRoute` (not raw Ingress) |
| Postgres | CNPG Cluster + rw/ro PgBouncer poolers + Wasabi S3 backups; connect via `sqlx`, `sslmode=require` |
| Redis | redis-operator `RedisReplication` (also hosts Redis Streams bus) |
| Secrets | Vault + External Secrets; `ClusterSecretStore vault-backend`, keys `cupboard/production/*` |
| Observability | OTLP → `alloy-receiver.alloy-receiver.svc.cluster.local:4317`; Pyroscope `:4040`; metrics land in Mimir |
| Storage | Longhorn (default StorageClass) |
| RBAC | add a RoleBinding per new namespace in `cluster-rbac` |

## 7. Repository layout (this repo)

```
Cupboard/
  Cargo.toml              # workspace
  services/               # one binary crate per service
    gateway/ auth/ fleet/ collector/ identity/ metrics/ tenant/
  crates/                 # shared libs
    domain/               # shared types / service contracts
    telemetry/            # OTel + tracing setup
    db/                   # sqlx pool + migration helpers
  apps/
    web/                  # Next.js (admin + storefronts)
    bot/                  # TypeScript discord.js bot
  docs/
    adr/                  # decision records
    custom-domain-tls.md  # open design problem
  ARCHITECTURE.md
```

## 8. Open design problems

- **TLS for arbitrary tenant custom domains** — the existing cert-manager only does
  DNS-01 wildcards for Cloudflare-owned zones; there is no mechanism for domains we
  don't control. This is a core white-label requirement. See
  [`docs/custom-domain-tls.md`](docs/custom-domain-tls.md).
- **Identity store isolation** — Identity is the heavy write path; it may need its
  own CNPG cluster (split from the shared one) before/at launch depending on volume.
- **Mimir cardinality** — perf metrics are per-tenant/per-server/per-plugin; keep
  label cardinality disciplined (see `v-deployments` `alloy-metrics/CARDINALITY.md`).

## 9. Decision log

| # | Decision | Status | Why |
|---|---|---|---|
| 1 | Backend in **Rust** | accepted | User preference; tokio is excellent for the connection-heavy fleet/firehose; memory-frugal on a memory-bound cluster; one backend language. |
| 2 | **Microservices**, but *modular code / coarse deploy* | accepted | User wants microservices for scale; cluster can't host 7× (Postgres+Redis+replicas). Build real boundaries, co-deploy + share stores at launch, split later. |
| 3 | **Own auth** service (no Zitadel/managed) | accepted | Steam login is OpenID 2.0 (unsupported by most managed IdPs); per-MAU cost at 100k+ users; Steam/Discord identity *is* the core domain. |
| 4 | **Redis Streams** as event bus (not NATS) | accepted | No broker exists; adding NATS = new operator + memory on a memory-bound solo cluster; Redis already first-class. NATS/Redpanda = upgrade path. |
| 5 | **Mimir** for perf metrics (not TimescaleDB) | accepted | Prometheus-compatible TSDB already running + wired to Grafana; CNPG has no Timescale extension anyway. |
| 6 | **Next.js** frontend (not Vite SPA) | accepted | White-label custom domains need SSR + per-hostname tenant theming; Vite SPA is poor at that. |
| 7 | Fleet supports **tenant-configured Pelican *and* Pterodactyl** connections (+ SSH) | accepted | Tenants bring their own panel installs; Cupboard connects out to them (the in-cluster Pelican is only a test install). Pelican is a Pterodactyl fork with a near-identical API → one adapter layer covers both. |
| 8 | Deploy on existing **ArgoCD/Kustomize/Talos** cluster | accepted | Mature GitOps platform already exists (CNPG, Redis, Vault, Traefik, LGTM stack). Reuse, don't reinvent. |
| 9 | **Discord bot in TS** (not Rust) | accepted | Bot is mostly an API client; discord.js is high-velocity and low-risk. |
| 10 | Add **cluster capacity before launch** | accepted | 500 servers / 100k users / white-label hosting needs more than the current memory-bound 3-node cluster. |
| 12 | **Hybrid ingestion**, operator-selectable: RCON/A2S + Oxide-Carbon gameplay plugin + Harmony perf mod | accepted | Operators choose per server; RCON = zero-install baseline, plugin = rich identity/moderation/entitlements, Harmony mod = low-overhead perf (RustServerMetrics-style). Plugin/mod are new game-server-side repos. |
| 13 | **RLS** row-level `tenant_id` isolation in shared Postgres | accepted | Standard SaaS approach; scales to thousands of tenants; fits shared-Postgres/coarse-deploy. |
| 14 | **Global** canonical **Cupboard Player ID** (surrogate, not Steam ID); identifiers as attributes; merge/split | accepted | Dedup + perf + cross-network alt detection; surrogate key enables clean GDPR erasure. Trade-off: makes Cupboard a controller of the identity graph. |
| 15 | **Two-layer model**: global identity/alt graph + per-tenant private moderation (shared via opt-in pools) | accepted | Reconciles the global ID with tenants not auto-exposing their bans. Supersedes the earlier "opt-in pools only" for the identity layer. |
| 16 | **Compliance schema hygiene now**, legal paperwork pre-launch | accepted | PII/enforcement separation, soft-delete, retention, export, audit — cheap now, brutal to retrofit. Global graph raises controller risk → privacy review before EU onboarding. |
| 17 | Link detection **fully automatic** + confidence-scored (owner ID/EAC strong, IP medium, name weak); links **advisory** | accepted | No cross-tenant human curation of the global graph; identifier-level bans mean a false-positive link never auto-bans. |
| 18 | **Per-org manual links** (private, tenant-scoped, ban-context) | accepted | Orgs assert their own associations without polluting the global graph. |
| 19 | **Identifier-level bans** (network/per-server scope); **evasion → alert/flag for manual inspection**, operator-configurable | accepted | Precise bans, no over-banning; catch evaders via linked-alt alerts rather than auto-banning alts. |
| 11 | Tenant custom-domain TLS | **open** | No existing mechanism for non-CF-owned domains. See docs/custom-domain-tls.md. |
