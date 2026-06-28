# Cupboard — Architecture

> Status: **design** (pre-implementation). This document is the source of truth for
> stack and architecture decisions. The decision log at the bottom records *why*.

## 1. What Cupboard is

Cupboard is the complete **backend + hosted frontend** for a Rust *(the game)*
server network's entire operation. Tenants (server-network owners) connect
everything to us. It spans:

- **Server lifecycle** — provision / start / stop / wipe / update servers and
  nodes via **Pelican** (panel) + Wings on the game hosts + SSH; plugin management.
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
| **fleet** | Server/node lifecycle via Pelican + SSH, plugin management | low-freq control ops |
| **collector** | Connection-heavy ingestion: RCON, metric polling, player/event firehose → publishes to Redis Streams | **horizontally shardable — the one we scale independently** |
| **identity** | Player tracking, IP/alt linking graph, bans, audit, BM import + continuous sync | heavy write path |
| **metrics** | Perf time-series (to Mimir) + recommendation engine | read/compute heavy |
| **tenant** | Commerce (store, payments, entitlements) + Sites (white-label builder, themes, domains) + Support (tickets) — split later | medium |

Non-Rust: **bot** (TS / discord.js), **web** (Next.js).

### Data flow (event firehose)

```
500 servers ──RCON/poll──> collector ──Redis Streams──┬──> identity (player/IP/ban events)
                                                       └──> metrics  (perf/plugin events → Mimir)
```

The Collector does no business logic — it ingests and publishes. Identity and
Metrics are independent consumer groups reading at their own pace.

## 5. Deployment & infra (reuses the `v-deployments` GitOps cluster)

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

## 6. Repository layout (this repo)

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

## 7. Open design problems

- **TLS for arbitrary tenant custom domains** — the existing cert-manager only does
  DNS-01 wildcards for Cloudflare-owned zones; there is no mechanism for domains we
  don't control. This is a core white-label requirement. See
  [`docs/custom-domain-tls.md`](docs/custom-domain-tls.md).
- **Identity store isolation** — Identity is the heavy write path; it may need its
  own CNPG cluster (split from the shared one) before/at launch depending on volume.
- **Mimir cardinality** — perf metrics are per-tenant/per-server/per-plugin; keep
  label cardinality disciplined (see `v-deployments` `alloy-metrics/CARDINALITY.md`).

## 8. Decision log

| # | Decision | Status | Why |
|---|---|---|---|
| 1 | Backend in **Rust** | accepted | User preference; tokio is excellent for the connection-heavy fleet/firehose; memory-frugal on a memory-bound cluster; one backend language. |
| 2 | **Microservices**, but *modular code / coarse deploy* | accepted | User wants microservices for scale; cluster can't host 7× (Postgres+Redis+replicas). Build real boundaries, co-deploy + share stores at launch, split later. |
| 3 | **Own auth** service (no Zitadel/managed) | accepted | Steam login is OpenID 2.0 (unsupported by most managed IdPs); per-MAU cost at 100k+ users; Steam/Discord identity *is* the core domain. |
| 4 | **Redis Streams** as event bus (not NATS) | accepted | No broker exists; adding NATS = new operator + memory on a memory-bound solo cluster; Redis already first-class. NATS/Redpanda = upgrade path. |
| 5 | **Mimir** for perf metrics (not TimescaleDB) | accepted | Prometheus-compatible TSDB already running + wired to Grafana; CNPG has no Timescale extension anyway. |
| 6 | **Next.js** frontend (not Vite SPA) | accepted | White-label custom domains need SSR + per-hostname tenant theming; Vite SPA is poor at that. |
| 7 | **Fleet integrates with Pelican** (not Pterodactyl) | accepted | Pelican panel is already deployed in the cluster. |
| 8 | Deploy on existing **ArgoCD/Kustomize/Talos** cluster | accepted | Mature GitOps platform already exists (CNPG, Redis, Vault, Traefik, LGTM stack). Reuse, don't reinvent. |
| 9 | **Discord bot in TS** (not Rust) | accepted | Bot is mostly an API client; discord.js is high-velocity and low-risk. |
| 10 | Add **cluster capacity before launch** | accepted | 500 servers / 100k users / white-label hosting needs more than the current memory-bound 3-node cluster. |
| 11 | Tenant custom-domain TLS | **open** | No existing mechanism for non-CF-owned domains. See docs/custom-domain-tls.md. |
