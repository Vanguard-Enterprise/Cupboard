# Cupboard — Build Roadmap

> Turns the architecture (`../ARCHITECTURE.md`) into a sequenced plan. Ordered to
> **de-risk fastest** and prove a **thin vertical slice** of the core product early,
> rather than building services in isolation. Sizes are relative effort (S/M/L/XL),
> not time estimates — Claude is the sole developer.

## Guiding principles

1. **Walking skeleton first.** Get *one* service deployed through the full
   CI→GHCR→ArgoCD→cluster pipeline with DB + observability before building features.
   Proving the pipeline once is worth more than any feature.
2. **Vertical slice early (Phase 2).** The BM-replacement core — connect a real
   server, track players + IPs, issue a ban — is the wedge and the riskiest
   integration. Build it end-to-end *before* breadth.
3. **Cross-cutting from day one, not bolted on.** RLS tenant scoping, OTel,
   audit, and the GDPR-enabling schema hygiene (PII/enforcement-key separation) are
   built into every service as it's created. Only the heavy GDPR *tooling* (export
   UI, erasure/retention workers) is deferred.
4. **Frontend evolves alongside.** The admin dashboard grows phase by phase, not as a
   big-bang at the end.
5. **Game mods can run in parallel.** The Oxide/Carbon plugin and Harmony perf mod
   are separate repos and not on the critical path until Phase 3.

## Repos

- **Cupboard** (this repo) — Rust services workspace + `apps/web` (Next.js) + `apps/bot` (TS).
- **v-deployments** — ArgoCD/Kustomize manifests (one app per component).
- **cupboard-plugin** (new) — Oxide/uMod + Carbon gameplay plugin.
- **cupboard-perfmod** (new) — Harmony performance mod.

---

## Phase 0 — Foundation / walking skeleton  · size **M**

**Goal:** one service live in the cluster, observable, with a database. Pipeline proven.

- Cargo workspace; shared crates: `telemetry` (OTel→Alloy), `db` (sqlx pool, migrations), `domain` (shared types).
- **Gateway** service: health endpoint, OTel wiring, CNPG connection, RLS plumbing, config/secrets via env.
- CI: GitHub Actions (self-hosted runners) → GHCR `:main`.
- v-deployments: Gateway ArgoCD app, CNPG cluster, Redis, ExternalSecret (`cupboard/staging/*`), IngressRoute; **staging namespace**.
- **DoD:** `cupboard-gateway` deployed to staging, `/healthz` green, traces/metrics/logs visible in Grafana, a migration applied.

## Phase 1 — Tenancy & Auth  · size **L**

**Goal:** an operator can sign up, create a tenant org, invite staff, and log into the dashboard. Multi-tenancy proven.

- **Auth** service: operator accounts (email+password `argon2`, Discord OAuth login), sessions/JWT, tenant orgs, **custom RBAC** (permission catalog + tenant-defined roles + default templates), staff invites.
- **Gateway:** auth validation, tenant routing, RLS context propagation.
- **apps/web:** dashboard shell — login, tenant switcher, nav, RBAC-gated routes.
- **DoD:** full signup→org→invite→login flow works; RLS verified (tenant A can't see tenant B); roles enforced.

## Phase 2 — Identity core + first data in  ⭐ **THE VERTICAL SLICE** · size **XL**

**Goal:** connect a real Rust server via RCON, watch players + IPs get tracked, create and enforce a ban. The core product, proven end-to-end.

- **Fleet:** add a connection (start with **RCON/A2S** — zero-install); panel adapters (Pelican/Pterodactyl) can follow.
- **Collector:** RCON ingestion (pull) → Redis Streams; persistent connection management.
- **Identity & Moderation:** global **Cupboard Player ID** + identifiers + sessions; **automatic advisory linking** (IP/owner where RCON exposes it); **identifier-level bans** with network/per-server scope; evasion alerts; audit; **PII vs salted-Steam-hash enforcement-key separation** from the start.
- **apps/web:** live server roster, player list/profiles, ban management, evasion alerts.
- **DoD:** a live server's players appear with IPs; a ban created in Cupboard blocks the player; an alt triggers an evasion alert.

## Phase 3 — Rich ingestion: plugin + perf mod + metrics  · size **XL**

**Goal:** full-fidelity data and performance monitoring with recommendations.

- **cupboard-plugin** (Oxide/Carbon): push rich events (full identifiers incl. owner/EAC, chat, F7 reports, playtime/stats, toggleable combat logs); execute inbound actions (bans, entitlement grants). Per-server token auth.
- **cupboard-perfmod** (Harmony): server/plugin perf telemetry.
- **Collector:** push ingestion gateway (auth, backpressure) alongside RCON pull.
  - *Carried from Phase 2 (RCON-path enrichments deferred to keep the slice thin):*
    **A2S server-info query** (map/hostname/live player count — `query_port` is already
    stored, just unwired) and the **RCON console stream** (real-time chat +
    connect/disconnect events; Phase 2 ingestion is poll-only `playerlist`).
- **Metrics & Analytics:** perf ingestion → **Mimir**; perf dashboards; **recommendation tips** (rule-based to start).
- **apps/web:** perf dashboards, chat logs, richer profiles.
- **DoD:** plugin-enabled server streams rich events + perf; recommendations surface; data degrades gracefully without the plugin.

## Phase 4 — BattleMetrics migration  · size **L**

**Goal:** a tenant migrates from BM losing nothing — the acquisition wedge.

- **BM import** (queued, resumable, rate-limit-aware): bans, players+identifiers, notes, servers — **maximal within the tenant's token access** (default-all, subset-selectable; incl. subscribed shared lists).
- **Two-way sync** where BM allows (bans bidirectional; notes/players/servers one-way) — origin tracking, LWW conflict resolution, conflict log.
- **apps/web:** import wizard, sync status, conflict review.
- **DoD:** import a real BM org; bans/players/notes appear and stay in sync.

## Phase 5 — Commerce + white-label sites  · size **XL**

**Goal:** a tenant has a live public site on their own domain, with a store.

- **Tenant service / Commerce:** store-provider adapter — **PayNow + Tebex**; ingest entitlements + product catalog (no payment data).
- **Sites:** white-label public site, **curated themes + config**, Next.js **SSR tenant-by-hostname**; custom-domain onboarding (point DNS at us) + **cert-manager HTTP-01 over Traefik** per domain.
- **Player accounts** (Steam + Discord) on tenant sites; on-site store pages + **checkout handoff to provider**; entitlement/profile/stats views.
- **DoD:** tenant connects a custom domain (auto-TLS), picks a theme, store renders from PayNow/Tebex, a player logs in via Steam and reaches checkout.
- **Status (2026-07-08):** code-complete on branch `phase5` (8 PRs, each high-effort-reviewed + fixed). Live DoD pending operator prerequisites (router `:80` forward, a test custom domain, PayNow/Tebex test stores, OpenBao secrets). Go-live runbook + verified degradation matrix: `docs/phase5-closeout.md`.

## Phase 6 — Support + billing + public API  · size **L**

**Goal:** monetization, support, and integrations.

- **Support:** unified **web + Discord** tickets (private thread/channel per ticket, two-way sync via the bot); **ban appeals** as a special, ban-linked ticket type.
- **Cupboard billing:** **Stripe Billing** — subscription tiers + one-off services; plan gating + rate-limit tiers.
- **Public API:** per-tenant **scoped keys** + plan-tiered rate limits; OpenAPI (utoipa) via Gateway.
- **DoD:** a player opens a ticket from web + Discord (synced); a tenant subscribes to a paid plan; an API key makes a scoped, rate-limited call.
- **Status (2026-07-21): CLOSED.** Merged via PR #9 (7 logical commits, each adversarially
  reviewed) + v-deployments PR #29; deployed to use1 staging and all three DoD criteria
  verified against the live deployment. Evidence, runbook, degradation matrix, and the
  deferred list: `docs/phase6-closeout.md`.

## Phase 7 — Launch hardening  · size **L**

**Goal:** production-ready at launch scale (500 servers / 100–300 tenants / 30–100k players).

- **Cluster capacity scale-up** (the pre-launch capacity add); load test the firehose.
- **Identity store isolation** — split Identity onto its own CNPG cluster if write volume needs it.
- **GDPR tooling** — per-player export, erasure + retention/purge worker (schema hygiene already in place).
- **Security review** (`/security-review`), Mimir cardinality pass, runbooks/alerts, prod cutover.
- **Network segmentation backlog** (deferred from Phase 2 — the workload layer is already
  hardened: restricted PodSecurity enforced on all cupboard namespaces, ClusterIP-only
  backends, envelope-encrypted creds, internal-token auth on `/internal/*`):
  - **Adopt a policy-capable CNI first.** The cluster runs **flannel**, which does *not*
    enforce `NetworkPolicy` (objects apply but are silent no-ops) — introduce Calico
    (Canal: flannel + Calico policy) or Cilium before any of the below can take effect.
  - **NetworkPolicies:** default-deny ingress/egress per cupboard namespace, then explicit
    allows — gateway→{auth,fleet,identity}, collector→{fleet,identity,redis} + broad
    egress for outbound RCON, {fleet,identity,auth}→CNPG `cupboard-db`,
    identity/collector→`cupboard-redis`, all→kube-dns + `alloy-receiver` (OTLP). Mind
    kubelet health-probe traffic when writing default-deny ingress.
  - **mTLS between services** — replace the shared `INTERNAL_API_TOKEN` on the cross-service
    `/internal/*` endpoints with mutual TLS (SPIFFE/cert-manager or a mesh).
- **DoD:** load test passes at target scale; security review clean; network policies enforced
  (on a policy-capable CNI); prod environment live.

---

## Critical path & parallelism

```
Phase 0 ─> 1 ─> 2 ⭐ ─> 3 ─> 4 ─┐
                     └─> 5 ─> 6 ─> 7
        (game mods: cupboard-plugin / cupboard-perfmod can start during Phase 2,
         land in Phase 3)
```

- **Critical path:** 0 → 1 → 2 → 3. Everything depends on tenancy (1) and the
  identity core (2). Phase 2 is the make-or-break integration — treat it as the
  milestone everything else is judged against.
- **Can parallelize:** the **game mods** (Phase 3 deliverables) can be prototyped
  during Phase 2 against a test server; **Sites/Commerce** (5) only depends on Auth
  (1) + Tenant service, not on Identity, so it can overlap with Phase 4.
- **Biggest risks (front-loaded on purpose):** RCON connection management at scale
  (Phase 2), push-ingestion backpressure (Phase 3), and per-domain TLS automation
  (Phase 5). None are deferred to the end.

## What "launch" needs at minimum

Phases 0–2 are the **demoable core**. A credible **paid launch** needs through Phase
6 (migration, sites/commerce, billing, support). Phase 7 makes it safe at scale.
