# Cupboard Phase 7 - Implementation Plan (Compliance, security hardening & cutover readiness)

> Turns ROADMAP Phase 7 (rescoped 2026-07-21: capacity scale-up, load test, and
> demand-gated items moved to Phase 8) into a sequenced, de-risked build. Follows the
> shape that worked for Phases 2-6. Inputs: the 2026-07-21 scouting briefs (player-PII
> inventory, internal-surface matrix, v-deployments infra state), `docs/phase6-closeout.md`,
> ARCHITECTURE decisions #14/#16 (surrogate player id, compliance schema hygiene).
> **Status (2026-07-22): FINAL.** Adversarially reviewed (17 findings folded in);
> Frank's resolutions recorded 2026-07-22: **Cilium** (#1), **Linkerd** (#2),
> Stripe live-mode objects are Frank's task at cutover-prep time (#6). Retention
> defaults (#3) and the DSAR surface recommendation (#4) proceed as proposed
> (adjustable without blocking). The ONE still-open item is #5 (production base
> domain + placement), not needed before PR8. Implementation started 2026-07-22
> (PR1 slice 1: the recon bug fixes).

## Definition of Done (from ROADMAP)

1. **Privacy**: per-player data export, erasure, and retention/purge proven on a real
   player across ALL stores (identity, auth, tenant schemas; Redis streams documented
   as transient), satisfying GDPR (access/erasure/retention) and CCPA/CPRA (know,
   delete, disclosure honesty; the no-sale opt-out is a documented no-op).
2. **Security**: full `/security-review` pass clean (findings fixed), Mimir
   cardinality pass, runbooks + alerts for every cupboard service.
3. **Network**: NetworkPolicies enforced on a policy-capable CNI; mTLS on
   `/internal/*`.
4. **Cutover readiness**: a documented, rehearsed cutover runbook with production
   manifests ready to apply on operator signal (prod Stripe objects + Tax posture,
   prod environment + base domain, the two Phase 5 leftovers).

## Corrections to the roadmap text (from recon)

- The ROADMAP never names the cluster distro: **it is Talos Linux**
  (`v-deployments/cluster/talos/use1/README.md`; three control planes, VIP
  `10.1.50.30`), which changes how the CNI swap is applied. Flannel is Talos's
  default CNI, so the roadmap's premise holds, but the swap is a **Talos
  machine-config operation applied out-of-band with `talosctl`**, not a GitOps
  change, documented in `cluster/talos/use1/` like the existing OIDC patch. Only
  the NetworkPolicy objects themselves are GitOps-managed. Note the rollout shape
  is NOT the OIDC node-at-a-time canary: a datapath swap has a mixed-CNI window in
  which cross-node pod traffic is broken, so PR5 follows Cilium's documented
  live-migration procedure (or an accepted big-bang window), decision J.
- Telemetry PII exposure is already time-bounded: Loki retention 7d, Mimir blocks 14d,
  Tempo 72h (`applications/{loki,mimir,tempo}/overlays/use1/configmap.yaml`). The
  privacy story can treat logs/traces as transient stores and focus on Postgres.

## Risk framing

The #1 risk is the **live-cluster CNI swap**: use1 is a shared, memory-bound cluster
running every Vanguard workload (rustlens x5 namespaces, the whole Grafana stack,
zitadel, openbao, netbird, mancini-beer, longhorn, metallb, cert-manager, plus
cupboard's 11 namespaces including `cupboard-db` and `cupboard-redis`). A datapath
change touches all of it at once, out-of-band from ArgoCD, with Longhorn (iSCSI
volumes) and MetalLB (L2 announcements) the most likely casualties of a botched
migration, and a mixed-CNI window in which cross-node pod traffic is down (decision
J). This is the only genuinely dangerous work in the phase and it is gated on a
Frank-approved maintenance window.

The #2 risk is **mTLS vs kubelet probes**: every service serves `/healthz`/`/readyz`
on the SAME `:8080` listener as `/internal/*`, and kubelet probes are plain HTTP from
the node. A naive client-cert requirement on the listener breaks every liveness probe
in the fleet. The mechanism decision (Frank #2) is framed around this constraint.

The #3 risk is that **erasure is the platform's first deliberately destructive
primitive**, and the staging CNPG cluster has NO backups today (single instance,
no barman object store, per `cloudnative-postgres/overlays/cupboard/cluster.yaml`:
"the baseline DB is throwaway"). There is no PITR to fall back on, so the safety
rails in decision D (dry-run, idempotency, audit, scope model) are the ONLY rails
on staging, and production backups are a hard gate before any prod erasure
(decision M).

Structurally the phase is two nearly-independent tracks - an in-product track
(privacy tooling, security fixes, alerts) and an infra track (CNI, NetworkPolicies,
mTLS, prod manifests). PR order interleaves them so the privacy track, which has zero
Frank prerequisites, is never blocked behind infra decisions.

## Decisions needed from Frank

> Resolutions (2026-07-22): #1 **Cilium, APPROVED**. #2 **Linkerd, APPROVED**
> ("works for me"), with the Server/AuthorizationPolicy default-deny deliverable
> and the token planes retained as second factor, as recommended. #6 **Frank will
> create the live-mode Stripe objects when it is time** (cutover prep, PR8); the
> Tax recommendation stands for that moment. #3/#4 proceed on the proposed
> defaults. #5 (prod base domain + placement) REMAINS OPEN; blocking only for PR8.

1. **CNI choice: recommend Cilium.** Talos + Cilium is the well-documented pairing;
   Cilium brings policy **audit mode** (log-only verdicts, the safe way to stage
   default-deny on a live cluster), Hubble flow observability (which makes authoring
   the allow-list empirical instead of speculative), and FQDN-based egress rules
   (clean allow-lists for `api.stripe.com`, `discord.com`, Steam, BattleMetrics,
   and the collector's arbitrary-IP carve-out). The alternative, Canal (flannel
   datapath + Calico policy), is a smaller datapath change but an unusual pairing on
   Talos, with no audit mode and no FQDN egress. Needs from Frank: the choice, a
   maintenance window, and `talosctl` access for the canary rollout.
2. **mTLS mechanism for `/internal/*`: recommend Linkerd.** Options considered:
   (a) **Linkerd** sidecar mesh, injected only into the cupboard namespaces: true
   mutual TLS with workload identity, transparent to the 6 plain reqwest clients and
   the bot's `fetch`, and probe-aware (Linkerd 2.12+ generates default probe-route
   authorizations). Honesty about what "enforced" costs: Linkerd's default is
   PERMISSIVE (meshed-to-meshed gets mTLS, but a plaintext in-cluster client is not
   rejected), so PR7 must also ship the per-workload `Server` +
   `AuthorizationPolicy`/`MeshTLSAuthentication` default-deny objects - those are a
   named deliverable, not an afterthought. Cost: a sidecar per pod on a memory-bound
   cluster (~20-30Mi each, ~12 pods) PLUS the control plane (a few hundred Mi) plus
   one more moving part.
   (b) **Cilium mutual authentication + WireGuard encryption** (if Cilium wins #1):
   no sidecars, but the mutual-auth feature is younger and it authenticates at the
   network identity layer, not per-request TLS; strictly speaking it is not "mTLS on
   /internal/*". (c) **Hand-rolled**: cert-manager internal CA, client certs in every
   reqwest client + the bot, rustls listeners on a second port to keep probes on
   plaintext `:8080`. Most code, most drift risk, no new infra. Recommendation: (a),
   with the three existing token planes retained as an application-layer second
   factor (they also keep working during any mesh outage/bypass).
3. **Retention windows** (defaults proposed; all configurable per-table cutoffs):
   identity `player_sessions` raw `ip` AND per-session `name` + `identity_signals`
   raw values **90d** (hashes and rows retained; the 2y `name_history` remains the
   name record past that), `chat_messages` **180d**, `player_reports` **1y**,
   `name_history` **2y**;
   auth `player_sessions` + operator `sessions` rows **90d past expiry/revocation**,
   expired `player_login_codes`/`player_link_codes`/`openid_replay` swept continuously;
   tenant `store_webhook_events.payload` + `billing_webhook_events` payloads **90d**
   (row kept for dedupe, payload NULLed); expired/revoked `invites` rows purged
   **30d** after terminal status (they hold third-party emails of people who may
   never have accepted); all three schema-local `audit_log` tables (auth, identity,
   tenant) **2y** (retention basis: legal obligation + legitimate interest, stated
   on the disclosure page); Redis streams
   time-trimmed to **14d** via `XTRIM MINID` in the same loops (decision E; `MAXLEN`
   alone bounds length, not time, and a quiet stream could otherwise hold an erased
   player's IP/chat for months); completed `bm_import_jobs` cursor/phase_counts
   cleared after **30d**; resolved/closed tickets retained indefinitely (support
   history) unless Frank wants a window.
4. **DSAR surface for v1: recommend both self-serve and operator-triggered, with
   the two-scope model from decision A2.** Player-facing (PLATFORM-GLOBAL scope):
   "Download my data" + "Delete my account" on the storefront `account/` page - the
   data subject themselves, authenticated via their Steam/Discord login (which IS
   the requester verification both regimes require). Operator-facing
   (TENANT-SCOPED only): an erasure/export action on the admin player profile page
   gated by a new `players.erase` permission, covering ONLY that org's rows - an
   org operator must never be able to destroy the shared global graph or other
   tenants' moderation context (decision A2). Platform-level: a documented runbook
   for out-of-band DSAR requests, which MUST verify the requester controls the
   Steam/Discord account (a sign-in challenge) before any export or erasure - an
   unverified DSAR is the classic attack vector for exfiltrating someone else's
   chat/IP history. Rectification (GDPR Art. 16 / CPRA right-to-correct) is served
   by the existing edit surfaces (account profile, operator player editing) plus
   the runbook; no new machinery. Alternative (smaller): platform/operator-only v1,
   no player self-serve. The recommendation matches the "self-serve in product"
   precedent from Phase 6 billing.
5. **Production base domain + prod placement.** `vng.bet` appears nowhere in the
   manifests; every host is `*.vngenterprise.com` and there is no environment axis at
   all (everything is `cupboard/staging/*` + `ENVIRONMENT=staging`). Decision M
   proposes prod as parallel namespaces on use1 with its own CNPG cluster, Redis, and
   OpenBao path prefix; Frank picks the actual product domain (this is a
   brand/business call, e.g. a dedicated cupboard domain vs a vng.bet subdomain) and
   whether prod shares use1 or waits for separate hardware (Phase 8 scale-up interacts
   with this).
6. **Stripe production + Tax posture.** Creating the live-mode products/prices is a
   Frank dashboard task at cutover-prep time (test-mode IDs: Team
   `price_1TsoVRQ8u2sG5NBcfNULAcK0`, Enterprise `price_1TsoVbQ8u2sG5NBctEl6IPhi`,
   Custom Design `price_1TsoXCQ8u2sG5NBcn8SGPh6i`). Tax: recommend enabling **Stripe
   Tax** on the live account from day one (automatic calculation; registrations added
   as thresholds approach) over manual tax handling; where Cupboard must register
   first is a legal/accounting question outside the codebase.

## Resolved decisions

| # | Decision |
|---|----------|
| A | **Privacy architecture: service-local walkers + an auth-owned coordinator.** Each data-owning service implements its own privacy surface over its own schema: `POST /internal/privacy/export` and `POST /internal/privacy/erase` on identity, auth (self), and tenant (fleet, gateway, collector, metrics hold no player PII - confirmed by recon). The coordinator lives in **auth** because auth already owns the person concept that bridges stores: it mints the `player_account_id` tenant uses and holds the raw `provider+subject` (steam/discord) that identity hashes. Fan-out payload is **`{steam_id, discord_id, player_account_id}`** (there is no cross-service person id; identity joins on hashed steam/discord, but tenant rows join on `player_account_id` - `tickets.player_account_id`, `entitlements.player_account_id` - and a web-opened ticket from a Steam-only player has NO steam column, so identifiers alone would strand it; auth mints the account id and therefore always has it). The coordinator never holds identity's `VALUE_PEPPER`: it passes raw identifiers and identity hashes them internally (existing precedent: `POST /internal/bans/active` already does exactly this hash-inside-identity dance). Jobs live in a new auth-schema `privacy_jobs` table modeled on `bm_import_jobs` (status/phase/cursor, resumable), driven by a plain interval worker in the `billing_loop.rs` shape (each tick in its own `tokio::spawn`, owner pool, log-and-continue). No new deployable, no new service. |
| A2 | **Two erasure/export scopes; blast radius follows the requester.** The identity graph is deliberately GLOBAL and shared across tenants (ARCHITECTURE #14: Cupboard is the controller of the cross-network graph), so who asks determines what may be touched. **Platform-global scope** (full walk incl. global rows: `player_identifiers.value`, `identity_signals.value`, `name_history`, every tenant's sessions/chat/reports rows for the player, plus auth + tenant stores): reserved for the DATA SUBJECT's authenticated self-serve flow and the platform DSAR runbook. **Tenant scope** (that org's rows only: its sessions/chat/reports/notes/flags/bans context, its tickets, its entitlements linkage; global rows and other tenants' rows untouched): what the operator `players.erase` surface gets - one org must never destroy the shared alt-graph or another tenant's moderation history, and an operator-triggered export must never hand org A another org's data. Controller-vs-processor per store is stated on the disclosure page (Cupboard = controller of the global graph; per-tenant stores = processed for the org). Every walker takes an explicit `scope` parameter; the completeness tests run per scope. |
| B | **Erasure semantics: NULL the raw, keep the hash, tombstone the player.** The Phase 2 hygiene (every durable identifier paired with a `*_hash`) is real, but the walk is derived from a full schema inventory, NOT from `merge.rs` (see B2). Identity side: NULL `player_identifiers.value`, `identity_signals.value`, `player_sessions.ip` **and `.name`**, delete `name_history` rows, NULL `bans.subject_value` + `bans.player_id` (context only; **`subject_hash` is retained so the ban still enforces** - the legitimate-interest basis, the whole point of the Phase 2 separation), marker `chat_messages.name/message`, `player_reports.*_name/subject/message`, and **`player_notes.body`** (staff/BM-imported free text about the player), delete **`player_flags`** rows, set `players.status='erased'`. Explicit retention-basis columns (kept, stated on the disclosure page): `bans.reason` + `bans.evidence` (moderation record, legitimate interest; the log-PII review rule G keeps fresh identifier values out of them going forward). BM jsonb: `bm_sync_map` rows are addressable precisely by `local_id` (unique per entity), so rows resolving to the erased player's entities get `meta` scrubbed WHOLESALE (value-matching would miss BM identifier types Cupboard never saw: ip/eos/beguid, names inside note text); value-matching is only the supplementary sweep for `bm_outbox.payload` + `bm_sync_conflicts.*_snapshot`. Auth side: `player_accounts` display/avatar NULLed, `player_identities` rows deleted, sessions revoked+scrubbed. Tenant side: ticket messages authored by the player get body/author_display markered, **`tickets.subject` markered too** (player-authored, NOT NULL), `tickets.opener_discord_user_id` NULLed, `tickets.ban_snapshot` scrubbed, `checkout_sessions` scrubbed; **`entitlements.steam_id` is RETAINED** (proof-of-purchase + grant enforcement; contract/legitimate-interest basis, stated in the disclosure page). **Re-collection after erasure is fresh collection**: if an erased player rejoins a tracked server, the ingest hash-match revives the same player row (status back to `active`, values repopulate going forward); history stays gone. Documented, standard GDPR posture (erasure applies to held data, not future lawful collection). |
| B2 | **Walker completeness is proven against the schema, not a code list.** `merge.rs` was the candidate oracle but is itself INCOMPLETE (it predates migration 0012 and the BM tables: merging a player today orphans `player_notes`/`player_flags` on the merged-away row and leaves `bm_sync_map`/`bm_outbox`/`bm_sync_conflicts` pointing at the dead player id - a live bug, fixed in PR1). The real oracle: a test that enumerates `information_schema.tables` per schema and FAILS on any table not explicitly classified as walked / no-player-data / retained-with-basis, so every future migration must take a privacy stance to pass CI. The same classification list drives export, so export and erasure cannot drift apart. |
| C | **Export bundle: one gzip JSON per request, assembled by the coordinator, stored inline.** Each service's export endpoint returns its stores' rows for the person as JSON; auth concatenates into `{identity:{...}, auth:{...}, tenant:{...}}`, gzips, and stores it on the `privacy_jobs` row (bytea) with a **7-day TTL and one-time download** (the one-time-code precedent). Sizes are bounded (the fattest store is chat history for one player). No object store needed - consistent with the Phase 5/6 "no uploads infra" deferral. Third-party redaction posture (adversarial-review resolution, 2026-07-22): the bundle carries only the subject's own content, meaning ticket messages are limited to the subject's own authorship plus NULL-author rows in the subject's own tickets, BM sync internals (`bm_outbox.payload`, `bm_sync_conflicts` snapshots) ship as a redaction marker, and the opposing party's name on `player_reports` is masked as "[third party]". The erase-side broad scrub is retained deliberately: over-erasing third-party mentions harms no one's rights, while over-exporting them would hand the subject other people's data. |
| D | **Erasure safety rails.** (1) Every erasure runs **dry-run first**: the same walk in count-only mode, results stored on the job row and shown before confirm (self-serve player deletions show a plain-language summary instead). (2) Erasure endpoints are **idempotent**: re-running on an erased player is a no-op, so a mid-flight crash is retried safely by the worker. (3) Every job writes **audit rows** (who requested, subject identifiers hashed, per-service row counts, timestamps) - audit of erasure is itself a GDPR obligation. (4) Stated honestly: there is NO database backup/PITR on staging today (`cnpg-cupboard` is single-instance with no barman object store, by design: "the baseline DB is throwaway"), so rails 1-3 plus the A2 scope model are the only protection on staging; the PRODUCTION cluster in decision M ships `barmanObjectStore` + `ScheduledBackup` as a hard gate before any prod erasure runs, and the runbook's recovery procedure applies there. (5) The identity walk runs in one owner-pool transaction per service (the `merge_players()` precedent), so partial erasure within a service is impossible; cross-service partial completion is visible per-phase on the job row and resumable. |
| E | **Retention/purge = service-local interval loops, no coordinator.** Each of identity/auth/tenant gets a `retention_loop.rs` in the `billing_loop.rs`/`domains_loop.rs` shape: hourly tick, per-table cutoffs from config (decision #3 windows), owner pool, paginated deletes/NULLing with a per-tick row cap (bounded work, no vacuum storms), a counter metric per table, and "only delete rows the cutoff clearly covers" (timestamp IS NOT NULL guards). The auth loop also purges terminal `invites` rows (30d) and expired login/link codes; both `audit_log`s get their 2y window here. Redis streams DO need the loops' help: `XADD MAXLEN ~` bounds length, not time (a quiet stream could hold an erased player's IP/chat for months), so each loop `XTRIM MINID` its streams to the 14d horizon; the disclosure page then states a proven bounded window instead of hand-waving "transient". Loki/Mimir/Tempo already enforce 7d/14d/72h. |
| F | **Privacy internal endpoints ride a new scoped `PRIVACY_TOKEN`** held only by auth (coordinator client) and verified by identity/tenant (auth self-calls in-process). Precedent: decisions E/K from Phase 6 - a destructive, cross-tenant primitive must not ride the widely-shared `INTERNAL_API_TOKEN` (which the bot-adjacent tenant service and five other services already hold). Same `x-internal-token` header + `constant_time_eq` mechanics, fail-closed. |
| G | **Log/trace PII fixes.** Two confirmed leaks are fixed in PR1: `services/collector/src/rcon_task.rs:245` logs raw `steam_id` at INFO ("kicked banned player" - switch to player_id/hash prefix), and `services/auth/src/http/invites.rs:57` logs invitee `email` AND `accept_url` - which embeds the raw invite TOKEN, i.e. a live org-access credential sitting in Loki for its 7-day retention, worse than PII. The fix drops both fields, and any currently-pending invites are revoked (their tokens transited logs), batched with the PR3 rotation checklist. The Phase 6 rule (no PII in URIs because TraceLayer records them) is generalized to "no raw identifiers/emails/IPs/tokens as log fields" and added to the review checklist in CLAUDE.md. |
| H | **Operators are never hard-DELETEd.** `auth.api_keys.created_by REFERENCES users ON DELETE CASCADE` (flagged in the 0006 migration comment) means a user-row delete silently drops org API keys. Resolution: operator erasure (a GDPR subject too) is **soft-anonymization** - email/display_name/password_hash NULLed or tombstoned, identities deleted, sessions revoked - so the CASCADE never fires and org-owned keys stay governed by the existing membership-lifecycle check (dead anyway once membership is gone, per Phase 6 decision M). The CASCADE is left in place but documented as intentionally unreachable. |
| I | **NetworkPolicy design: default-deny both directions across all ELEVEN cupboard namespaces (`cupboard-db` and `cupboard-redis` are IN scope), allows generated SYMMETRICALLY from a single directional-pair matrix.** The matrix is a list of `client-ns -> server-ns:port` pairs; the generator emits BOTH the egress allow on the client and the ingress allow on the server (writing only one side under default-deny-both is the classic way to break everything; the pairs below are the single source of truth). App pairs: gateway->{auth,fleet,identity,collector,metrics,tenant}:8080 (the proxy fan-out), web->gateway:8080 (SSR BFF), bot->tenant:8080 ONLY (mirroring the BOT_API_TOKEN blast radius at the network layer), auth->tenant:8080, tenant->{auth,identity}:8080, collector->{fleet,identity}:8080, identity->fleet:8080, traefik->{gateway,web,auth,tenant} (the four ingressed services). Data pairs: {gateway,auth,fleet,identity,tenant}->cupboard-db:5432 (collector and metrics have NO Postgres access - denied), {gateway,collector,identity,metrics,tenant,bot}->cupboard-redis:6379. Infra flows the recon says defaults would otherwise kill: cnpg-operator->cupboard-db (instance management), cupboard-db->kube-apiserver (CNPG instance manager), cupboard-db intra-namespace (pooler->primary, future replicas), redis-operator->cupboard-redis, alloy-metrics->cupboard-db (the CNPG PodMonitor scrape), all->kube-dns:53, all->alloy-receiver:4317 (+bot->:4040 Pyroscope), tenant->kube-apiserver (certmgr writes Certificates/IngressRoutes). Internet egress per service: auth->Discord/Steam, identity->BattleMetrics, tenant->Stripe/PayNow/Tebex, bot->Discord, and the **collector's arbitrary-IP carve-out** (RCON `ws://` any-port + A2S UDP to tenant-supplied addresses; egress-to-anywhere-except-cluster-CIDRs, the one deliberately broad rule, FQDN-unconstrainable by nature). Conditional block: if decision #2a (Linkerd) wins, every injected namespace additionally needs egress to the linkerd control plane (destination/identity/policy) - PR6's matrix carries this block behind the #2 decision so PR7 does not retro-break it. Kubelet probes: host-to-pod traffic is permitted by default in Cilium (fromEntities host) - verified during the audit-mode phase, before enforcement. Rollout: **audit mode first, enforce cupboard namespaces one at a time**, non-cupboard namespaces stay unpoliced this phase (their lockdown is not a Phase 7 deliverable; the CNI makes it possible later). |
| J | **CNI rollout runbook lives in `cluster/talos/use1/`** (documentation home per the OIDC-patch precedent - but NOT its node-at-a-time canary shape: that was an apiserver flag where nothing spans nodes, whereas a datapath swap has a mixed-CNI window in which flannel-node pods and Cilium-node pods cannot reach each other, a partial outage on a 3-node converged cluster). PR5's runbook is instead built on **Cilium's documented live-migration procedure** (dual-overlay, per-node drain with a distinct pod CIDR) OR an explicitly-accepted big-bang inside the maintenance window (full workload restart, shorter total exposure) - the runbook states which and why. Content: pre-flight health snapshot (every namespace's pods, Longhorn volume attach/detach, MetalLB L2 announcement, CNPG primary, NetBird connectivity, DNS), the `talosctl` machine-config steps, per-node validation, and the rollback (revert machine config, reverse the migration). Executed only inside Frank's maintenance window. Post-swap soak before any NetworkPolicy enforcement. |
| K | **Security review = its own PR, run against the whole workspace** (`/security-review` breadth: authn/authz surfaces, the four credential planes, webhook receivers, SSRF-adjacent code (BM import, RCON dialer, storefront resolve), RLS coverage, secrets handling, the bot's untrusted-Discord-content parsing). Findings fixed in the same PR with named regression tests; anything structural graduates to its own line item. The Phase 6 chat-transited API key and Discord bot token rotations are folded into this PR's checklist if not already done. |
| L | **Observability hardening.** Mimir cardinality pass: inventory per-metric series counts (the memory-bound cluster is the motivation), cap label sets (no per-player/per-key labels anywhere; verify the rate-limiter and ingest counters), document budgets. Alert expansion in `applications/grafana/overlays/use1/vanguard/alerts/rules-cupboard.configmap.yaml` (today: 2 gateway rules only) to per-service down/crashloop (all 9 deployables), CNPG cupboard health, cupboard-redis health, cert-issuance failures (custom domains), Stripe webhook failure rate + reconcile-stall, ticket-stream consumer lag/PEL age (the bot), rate-limiter fail-open counter, and the new privacy/retention worker stall metrics. Every alert annotation links a runbook in `docs/runbooks/*.md` (new; one page per alert group: meaning, blast radius, first moves, degradation-matrix pointer). |
| M | **Prod environment = parallel manifest tree, prepared but not applied.** A `applications/cupboard/overlays-prod/` tree (or env-parameterized components; final shape decided in PR8 against real Kustomize ergonomics) with separate namespaces (`cupboard-prod-*`), its own CNPG cluster + Redis, OpenBao paths `cupboard/production/*`, prod base domain from Frank #5, `CERT_ISSUER=letsencrypt-http01`, **`barmanObjectStore` + `ScheduledBackup` on the prod CNPG cluster from day one** (S3-compatible target chosen at PR8; a hard gate before any prod erasure per decision D), and **manual image promotion**: argocd-image-updater keeps writing staging digests only; promoting to prod is a deliberate git commit pinning a staging-proven digest (no auto-flow from `:main` to prod). Application CRs staged under `argocd/applications/use1/` but NOT applied until Frank's signal (the manual-first-apply precedent from Phases 5/6 is now load-bearing policy). The cutover runbook covers: OpenBao secret population, DNS, Stripe live keys + webhook endpoint, the ordered apply, DoD-style smoke checks, and rollback (delete Application CRs; staging untouched). |
| N | **The two Phase 5 leftovers land inside this phase's runbooks.** The `CERT_ISSUER` staging->prod flip for custom domains is executed on staging THIS phase (it is safe now: staging issuance has been clean since 2026-07-12, and prod LE limits are respected) - it stops being a leftover. Phase 5 DoD #4 (live Steam login + test purchase -> entitlement row) is a Frank browser click-through, batched with this phase's DoD verification. |
| O | **Bug fix, immediate: tenant's `IDENTITY_INTERNAL_URL` is missing from `applications/cupboard/overlays/tenant/configmap.yaml`**, so the ban-appeal lookup falls back to `http://127.0.0.1:8083` (code default) and cannot work in-cluster - the appeal picker/validation path has been silently broken on staging since PR3. One-line v-deployments fix, shipped ahead of everything else (and a reminder that a NetworkPolicy rollout would have masked this as a network block; recon caught it first). |

## Thinnest end-to-end slice (PR2 core: "one player, exported then erased, across all stores")

```
seed a player with real spread: identity graph row + identifiers + sessions(ip) +
   chat + a ban (subject_hash) | auth player_account + steam/discord identities +
   sessions | tenant ticket + messages + entitlement(steam_id)
-> POST /auth/privacy/jobs {steam_id, discord_id, kind: export}
   -> coordinator fans out: identity /internal/privacy/export (hashes internally),
      auth self, tenant /internal/privacy/export -> gzip bundle on privacy_jobs,
      one-time download link
-> POST /auth/privacy/jobs {.., kind: erase} -> dry-run counts -> confirm
   -> per-service erase in one tx each: raw values NULLed, hashes kept,
      players.status='erased', ticket bodies markered, entitlement steam_id kept
-> PROOF: export re-run returns only tombstones; the BANNED player's reconnect is
   still rejected by the collector (subject_hash enforcement survives erasure);
   ban list UI shows the ban with an "[erased]" subject
```

This is DoD #1 nearly whole, it has zero Frank prerequisites, and it front-loads the
only novel machinery (coordinator fan-out, the erasure walkers, the enforcement-
survives-erasure invariant). Retention loops (PR1) are mechanically simpler and land
first as the warm-up.

## Service boundaries (delta)

| Service | Phase 7 delta |
|---|---|
| **auth** | Privacy coordinator: `privacy_jobs` table + worker, `/auth/privacy/*` operator routes, self walkers (accounts/identities/sessions), retention loop, soft-anonymize semantics (H). |
| **identity** | `/internal/privacy/{export,erase}` walkers (schema-inventory oracle, B2; both scopes, A2), retention loop (sessions, signals, chat, reports, name_history, bm job blobs, stream XTRIM), `merge.rs` repoint fix, PRIVACY_TOKEN guard. |
| **tenant** | `/internal/privacy/{export,erase}` walkers (tickets/messages/checkout/webhook payloads; entitlements steam_id retained), retention loop (webhook payloads), PRIVACY_TOKEN guard. |
| **collector** | Log-PII fix only (G). No Postgres, no player store. |
| **gateway / fleet / metrics** | No privacy surface (hold no player PII). Security-review + cardinality fixes as found. |
| **web** | Storefront `account/`: export download + delete-account flow. Admin: player-profile erasure/export actions (`players.erase` perm), privacy job status page, disclosure/privacy page (GDPR + CCPA wording incl. the no-sale no-op statement). |
| **bot** | Untouched (Discord content already flows only into tenant stores, covered there). |
| **v-deployments** | O fix; alert rules + runbooks; CNI runbook docs; NetworkPolicies; mesh (if Linkerd); prod manifest tree + cutover runbook. |

## PR sequence (branch `phase7` in both repos, logical PRs as commits like Phases 3-6)

| PR | Title | Proves / DoD | Frank-blocked? |
|----|-------|--------------|----------------|
| **PR1** | Retention/purge loops + log-PII/token fixes (G, incl. pending-invite revocation) + the `IDENTITY_INTERNAL_URL` fix (O) + the `merge.rs` missing-repoint fix (B2: notes/flags/bm_sync rows orphaned on merge) | Retention third of DoD #1; two log leaks closed (one a live credential); two live staging bugs fixed. | Window defaults proposed; Frank can adjust (#3) without blocking. |
| **PR2** | Export + erasure end-to-end (walkers, coordinator, jobs, PRIVACY_TOKEN, web surfaces, disclosure page) | ⭐ Completes DoD #1 in code; the slice above. | DSAR surface choice (#4) affects only which UI entry points ship; walkers are identical either way. |
| **PR3** | Security-review pass + fixes; Mimir cardinality pass | DoD #2 first half. | No |
| **PR4** | Alerts + runbooks (rules-cupboard expansion, `docs/runbooks/`) | DoD #2 second half. | No |
| **PR5** | CNI adoption: runbook in `cluster/talos/use1/`, rehearsed execution, soak | The DoD #3 prerequisite. | **Yes**: choice (#1) + maintenance window + talosctl. |
| **PR6** | NetworkPolicies: audit mode -> per-namespace enforce (I) | DoD #3 policies enforced. | After PR5; enforcement stepping needs no Frank action. |
| **PR7** | mTLS on `/internal/*` per #2 (mesh install or hand-rolled) | DoD #3 complete. | **Yes**: mechanism choice (#2). |
| **PR8** | Cutover readiness: prod manifest tree, Stripe prod plumbing (env names, no live values), cutover runbook + rehearsal, CERT_ISSUER flip, Phase 5 DoD #4, phase7-closeout.md | DoD #4; phase close. | **Yes**: #5, #6, live prices, DNS, click-throughs. |

PR1/PR2 are deliberately first: zero external dependencies, and they de-risk the only
new product machinery while Frank's infra decisions (#1/#2) are pending. PR3/PR4 can
interleave with the PR5 wait. PR6 must trail PR5 by a soak period; PR7 can build
against staging regardless of mechanism. PR8 last, as always, closing with the
runbook rehearsal.

## Schema / migration order

- `auth/0009_privacy_jobs.sql` - `privacy_jobs` (global, owner-pool; status/phase/
  cursor per the `bm_import_jobs` shape, requester + scope + audit columns, bundle
  bytea + expiry). PR2. Crash recovery is a stale-running reclaim primitive: rows
  stuck in `running` past a staleness window are set back to `queued` on each worker
  tick. No cursor columns are needed for this; the walkers are idempotent, so a full
  requeue is safe.
- `auth/0010_backfill_players_erase.sql` - `players.erase` permission catalog row +
  Owner/Admin grant backfill (the `0007_backfill_api_manage.sql` precedent). PR2.
- Erasure markers and NULLing are UPDATEs, not schema changes: no migrations needed
  in identity/tenant for the walkers themselves. Retention cutoffs are config, not
  schema.
- `crates/domain`: `permission.rs` += `PlayersErase` (PR2); web permissions mirror
  updated in the same PR (the Phase 6 `SupportRespond` lesson: check the mirror).

## Degradation matrix (target behavior; verified + recorded in PR8)

| Capability | Privacy worker down | Mesh/sidecar outage (if #2a) | NetworkPolicy misconfig | Redis down | CNPG down |
|---|---|---|---|---|---|
| Export/erasure jobs | queue; resume on restart (cursor) | internal calls fail closed; job resumes | same (fails closed, visible in Hubble/audit log) | unaffected (PG-only) | jobs stall, resume |
| Retention loops | tick skipped, next tick catches up (cutoff-based, no drift) | n/a (loop is in-process) | n/a | XTRIM skipped, PG purge unaffected | tick fails, logged |
| Ticket/billing/API (Phase 6 surfaces) | unaffected | degraded per pair; tokens still enforce auth | the risk PR6's audit mode exists to catch | Phase 6 matrix | Phase 6 matrix |
| One-time export download | n/a (link dies with the job row TTL; re-request re-exports) | unaffected (web->gateway->auth) | " | " | " |

Invariants: **a privacy-machinery failure never degrades a Phase 6 capability**
(walkers/loops are additive, own their pools, and no hot path calls them), and
**enforcement never depends on erasure state** (ban checks read `subject_hash`,
which erasure preserves by contract, decision B).

## Deploy / OpenBao additions (in `v-deployments`)

- **OpenBao**: patch `cupboard/staging/internal` += `privacy_token` (PR2; Frank OIDC
  browser approval, the standing gotcha: `bao kv patch -mount=kv`, role
  `global-admin`). `cupboard/production/*` paths created at PR8, populated only at
  cutover.
- **Overlay edits**: identity + tenant external-secrets += `PRIVACY_TOKEN`; auth
  external-secret += `PRIVACY_TOKEN`; retention-window env vars in the three
  configmaps (defaults in code, overrides optional); the O fix (tenant configmap +=
  `IDENTITY_INTERNAL_URL`).
- **New ArgoCD apps**: none for the privacy track. Linkerd (if #2a): a new
  `applications/linkerd/` + Application CR pair, injection by namespace annotation on
  the cupboard namespaces only. Cilium: NOT an ArgoCD app at install time (Talos
  machine-config / bootstrap concern, `cluster/talos/use1/`); adopting its manifests
  into GitOps later is optional and out of scope.
- **NetworkPolicies**: `networkpolicy.yaml` per cupboard overlay, plus the
  audit-mode toggles per rollout step (PR6).
- **CI**: unchanged (no new deployable in the phase).

## Cross-cutting (non-negotiable, as every phase)

- `privacy_jobs` is auth-schema, owner-pool, global (not tenant-scoped: a person
  spans tenants by design); every job transition writes audit rows. New tenant-visible
  actions (operator-triggered erasure) audit into the existing per-schema `audit_log`s
  with the acting operator.
- OTel spans on every walker + loop tick; counter metrics per purged table; the
  privacy worker gets a stall alert (L).
- Tests to name in reviews: **erasure keeps the ban enforcing** (hash lookup still
  rejects the connect after values are NULLed); **the schema-inventory oracle** (B2:
  an unclassified table in any walked schema fails CI); **tenant-scope containment**
  (A2: an operator-scoped erasure touches zero global rows and zero other-tenant
  rows, proven by row counts); retention boundary exactness (row at cutoff-1s
  survives, cutoff+1s purged); idempotent double-erasure; cross-tenant isolation of
  the operator surface (org A cannot erase via org B's surface); the one-time
  download link dies after first use; dry-run writes nothing; merge repoints
  notes/flags/bm rows (the B2 bug's regression test).
- No raw identifiers/emails/IPs in log fields or URIs (G), enforced in review.

## Deferred (carried to Phase 8, per the 2026-07-21 rescope)

Cluster capacity scale-up + the firehose load test; identity store isolation
(second CNPG cluster); **public internet exposure of `/api/v1`** + its prerequisites
(per-IP/global exchange cap, WAF/DDoS posture); Discord message-content intent
verification (>100 guilds); apex custom domains; Cloudflare WAF on custom-domain
hosts; object store for uploads; second cupboard-web Deployment split; identity
storefront player-stats endpoint; usage metering, GraphQL, ticket attachments,
service-fulfillment tooling + catalog expansion, Discord-side ban actioning,
sliding-window limiter, ticket-sync outbox, API-key IP allowlists/resource
scoping/auto-rotation, `/ticket open` cooldown, `XGROUP DELCONSUMER` hygiene,
reclaim-path single-attempt optimization for long bot outages (the last
phase6-closeout carry item). Upstream note carried verbatim from phase6-closeout:
the RustLens bot has the same ESM/pino OTel loader-hook flaw fixed in
`apps/bot/src/register-hook.ts`; different repo, tell-Frank item, not Phase 7 scope.
Additionally deferred from this phase's own scope: NetworkPolicies for the
non-cupboard namespaces (the CNI makes them possible; writing them is not Phase 7
work), an EU region / DPA + SCC legal paperwork (ARCHITECTURE #16 keeps the
pre-EU-onboarding privacy review as a launch-checklist item, not an engineering
deliverable), and automated DSAR intake (email parsing etc.; v1 intake is the
product surfaces + a runbook).
