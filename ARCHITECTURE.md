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
- **Commerce** — integrate the tenant's **external store provider** (PayNow **and**
  Tebex at launch; others later); ingest purchase/entitlement data only (no payment
  handling — delivery to servers stays with the provider).
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
| **tenant** | Commerce (external store integration: PayNow + Tebex at launch, others later — ingest entitlements, *no* payment handling) + Sites (white-label builder, themes, domains) + Support (tickets) — split later | medium |

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

### Commerce & billing

**Cupboard does not process player payments.** Player→tenant store sales are handled
entirely by the tenant's **external store provider** (PayNow at launch). Cupboard
integrates via a **store-provider adapter** (mirrors the panel adapter — **PayNow +
Tebex** at launch, others later):

- Tenant connects their provider account.
- Cupboard ingests **entitlement/purchase metadata** via the provider's API/webhooks
  — Steam ID + product (kits, subscriptions, ranks), status, timestamps.
- **No financial or payment PII** is ingested — only *who owns what*.
- **Delivery stays with the provider** (PayNow executes grants on servers itself).
- **Also ingests the product catalog** so the storefront can render on the Cupboard
  site (see White-label sites); **checkout is delegated to the provider** (redirect /
  embedded) — Cupboard never touches card data.
- Use in Cupboard: enrich player profiles with customer/VIP status + purchase
  history for moderation context; surface in the dashboard.

**Cupboard→tenant billing (Cupboard's own revenue):** subscription **tiers** +
**one-off services** (custom design, migration), via **Stripe Billing**. Standard
SaaS billing — Cupboard is merchant-of-record for its *own* fees only. **No**
marketplace / Connect / application-fee model; Cupboard takes no cut of store GMV.

### White-label sites (Sites)

Cupboard hosts each tenant's **public website and admin panel** — themeable, on
custom domains. Rendering is **Next.js SSR, tenant-by-hostname** (request → resolve
domain → tenant → load theme + config → render).

- **Customization = curated themes + config** (not a drag-drop builder): the tenant
  picks a theme and customizes logo/colors/content blocks/pages. Bespoke themes are a
  **paid service** ("custom designs"). A builder may come later.
- **On-site store pages (default on, tenant-toggleable).** The store *catalog* renders
  on the Cupboard site, pulling products from the tenant's PayNow/Tebex via the
  store-provider adapter. **Checkout is delegated to the provider** (redirect /
  embedded) — Cupboard never touches card data. A tenant can disable on-site store
  pages and rely on the provider's own pages.
- **Player accounts (full).** Players log into the tenant site via **Steam/Discord**
  to: browse/buy via the on-site store, view their **purchases/entitlements** (from
  the provider), see profile/stats, file **ban appeals**, open **support tickets**,
  and link Discord. The **admin panel stays operators/staff only.**

### Custom-domain TLS (resolved)

Onboarding: the tenant **points a DNS record (A/CNAME) at Cupboard's edge IP**;
Cupboard verifies it resolves to us, then issues the cert. Issuance =
**cert-manager HTTP-01 solved over Traefik**, one `Certificate` + IngressRoute per
verified domain, created by the **Sites** service via the Kubernetes API. HTTP-01
works precisely *because* the domain now points at us; Traefik's built-in ACME is the
fallback. Rate-limit issuance and verify ownership before requesting. See
[`docs/custom-domain-tls.md`](docs/custom-domain-tls.md).

### Support (tickets)

Unified ticketing across **web + Discord** — one ticket store; staff reply from the
admin dashboard **or** Discord with two-way sync.

- **Web**: logged-in players open tickets from the tenant site.
- **Discord**: the bot opens a **private thread/channel per ticket** (classic
  ticket-bot UX); messages sync both ways with the Cupboard ticket. Implemented in
  the TS bot (prior art: the org's `ticket-bot`).
- **Ban appeals = a special ticket type**, pre-linked to the ban + player record, so
  staff see full context and can action the ban from within the ticket.
- Launch scope: categories, assignment, status, internal staff notes, history.

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

### BattleMetrics import & sync

Migration wedge — "bring your whole BM history, lose nothing." Works through BM's
REST API with the tenant's own API token, as a **background job** (queued,
resumable, rate-limit-aware — not synchronous).

**Imported (tenant's own org):** bans + ban lists, players + identifiers (matched
into the global graph by Steam ID), notes + flags, servers + RCON config.

**Sync model: two-way *where BM's API allows*.**
- **Bans** — bidirectional (BM supports ban create/update via API).
- **Notes, flags, players, servers** — one-way BM→Cupboard (BM's API doesn't expose
  these for write).
- Mechanics: each synced record carries `origin` + BM `external_id` + `updated_at` +
  content hash; **echo guard** skips changes we just wrote; **last-write-wins by
  timestamp** with a conflict log.
- ⚠️ "Two-way" is therefore *partial*, bounded by BM's writable surface.

**Import breadth — maximal within the tenant's BM access (default: everything).**
By default, import **everything the tenant's BM API token can reach** — their own org
(bans, players, notes, servers) **plus every shared ban list / resource the tenant
subscribes to**. The tenant may narrow to a subset ("just X") if they prefer. This
maximizes data captured while staying within the tenant's own authorization (the API
can't exceed the token anyway).
- **Partner authorization / opt-in pools** extend sharing forward consensually.
- Access *beyond* the tenant's token (scraping other orgs' private data / BM web
  pages) is not reachable via the API and is not built.

**Strategy:** aggressive, maximal *consensual* ingestion is the growth play —
Cupboard's own global identity graph + pools become the cross-network moat. Privacy
posture is deliberately deferred ("overtake BM, then harden privacy"); the schema
hygiene from Decision 16 keeps that option open without blocking it — see the
controller-risk caveat there.

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

## 7. Cross-cutting concerns

### Environments

**Staging + production.** Staging runs as separate namespaces + its own CNPG/Redis on
the cluster (`*-staging` namespaces, Vault path `cupboard/staging/*`), promoted to
prod through the same ArgoCD/image-updater flow. Test tenant onboarding, billing, and
server connections before they touch prod.

### CI/CD

GitHub Actions (self-hosted runners) build each service/app container → GHCR
`ghcr.io/vanguard-enterprise/cupboard-<svc>:main`; argocd-image-updater digest-pins
and ArgoCD syncs. sqlx migrations run as a pre-deploy job per service.

### RBAC (tenant staff)

**Fully custom roles + permissions.** A granular **permission catalog** (per-area
actions — e.g. `bans.create`, `players.view_pii`, `servers.restart`, `store.manage`,
`support.respond`, `sites.edit`, `billing.manage`). Tenants define **custom roles** =
permission sets, with optional **resource scoping** (limit a role/member to specific
servers). Ship **default role templates** (Owner [full, immutable], Admin, Moderator,
Support) that tenants can clone/edit. Cupboard-staff superadmin sits above tenants.

### Public API

**Per-tenant scoped API keys** (read/write scopes per area), **rate limits tied to
subscription tier**, usage metering. REST + OpenAPI (utoipa) via the Gateway; keys
validated at the Gateway.

### Secrets & encryption

Vault + ESO (`vault-backend`, keys `cupboard/{production,staging}/*`). Tenant-supplied
panel/store credentials envelope-encrypted at rest (Vault-wrapped data key). TLS
everywhere; Postgres `sslmode=require`.

### Audit

Central audit log of staff/admin actions and player-data access (Identity owns
player-data audit). Feeds the GDPR export/erasure tooling (Decision 16).

## 8. Repository layout (this repo)

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

## 9. Open design problems

- ~~TLS for arbitrary tenant custom domains~~ — **resolved**: cert-manager HTTP-01
  over Traefik, per-domain, tenant points DNS at our edge (see §6 Custom-domain TLS /
  `docs/custom-domain-tls.md`).
- **Identity store isolation** — Identity is the heavy write path; it may need its
  own CNPG cluster (split from the shared one) before/at launch depending on volume.
- **Mimir cardinality** — perf metrics are per-tenant/per-server/per-plugin; keep
  label cardinality disciplined (see `v-deployments` `alloy-metrics/CARDINALITY.md`).

## 10. Decision log

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
| 20 | BM import scope: bans, players+identifiers, notes+flags, servers+RCON (own org, tenant token; queued/resumable) | accepted | Full migration; lose nothing. |
| 21 | BM sync **two-way where BM's API allows** (bans bidirectional; notes/flags/players/servers one-way BM→Cupboard); origin tracking + LWW conflict resolution | accepted | User chose two-way; necessarily partial, bounded by BM's writable surface. |
| 22 | BM import is **maximal within the tenant's own access** (default-all: own org + subscribed shared lists; subset-selectable). No access beyond the token (no scraping). | accepted | "More data wins" growth strategy, kept legitimate by bounding to the tenant's authorization. Privacy deferred by choice (see #16 caveat). |
| 23 | **No Cupboard-built commerce/payments** — player payments via external store providers (**PayNow + Tebex** at launch; adapter for others later); Cupboard ingests entitlement metadata only (Steam ID + product), no payment PII; delivery stays with provider | accepted | Sidesteps merchant-of-record / money-transmitter burden; PayNow/Tebex already solve game-store monetization. |
| 24 | **Cupboard revenue = subscription tiers + one-off services** via Stripe Billing (own fees only, no GMV cut) | accepted | Simple SaaS billing; no marketplace compliance. |
| 25 | White-label sites = **curated themes + config** (not a builder); Next.js SSR tenant-by-hostname; bespoke themes = paid service | accepted | Far less to build than a builder; fits the "custom designs" revenue line. |
| 26 | **Full player accounts** on tenant sites (Steam/Discord): store browse/buy, view entitlements, profile/stats, appeals, support, link Discord. Admin panel stays operator-only. | accepted | Players need login for appeals/support/entitlements; checkout still provider-side. |
| 27 | **On-site store pages** (default on, tenant-toggleable): catalog rendered on the Cupboard site from PayNow/Tebex; **checkout delegated to provider** | accepted | Keeps storefront UX on-platform while payments stay with the provider (no MoR). |
| 28 | **Unified support**: web + Discord, one ticket store, two-way synced; staff work from dashboard or Discord | accepted | Full vision; reuses the bot. |
| 29 | Discord tickets = **private thread/channel per ticket**, synced (in the TS bot) | accepted | Familiar ticket-bot UX; prior art in the org. |
| 30 | **Ban appeals = special ticket type** pre-linked to the ban/player record | accepted | Reuses the ticket system; gives staff context. |
| 31 | **Staging + production** environments (separate namespaces/DB/Vault path on the cluster) | accepted | Safe pre-prod testing for a tenant-critical system. |
| 32 | **Fully custom RBAC** — granular permission catalog + tenant-defined roles + per-server resource scoping; default role templates | accepted | Tenant choice; big networks need granular control. More to build (catalog + UI). |
| 33 | **Public API** = per-tenant scoped keys + plan-tiered rate limits, REST/OpenAPI via Gateway | accepted | Proper integration foundation; ties limits to billing. |
| 11 | Tenant custom-domain TLS → **cert-manager HTTP-01 over Traefik**, per-domain via the Sites service; tenant points DNS (A/CNAME) at our edge | accepted | DNS-points-at-us enables HTTP-01; reuses the existing cert-manager/Traefik toolchain. |
