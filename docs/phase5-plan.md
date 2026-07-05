# Cupboard Phase 5 - Implementation Plan (Commerce + white-label sites)

> Turns ROADMAP Phase 5 ("Commerce + white-label sites", size XL) + ARCHITECTURE
> "Commerce & billing" / "White-label sites" / "Custom-domain TLS" (decisions #11, #23-27)
> into a sequenced, de-risked build. Follows the shape that worked for Phases 2-4.
> **Status (2026-07-05):** plan approved (port-80 forward + Tebex-in-phase confirmed);
> PR1 in progress on branch `phase5`.

## Definition of Done (from ROADMAP)

1. **Custom domain**: a tenant connects their own domain, auto-TLS via cert-manager
   HTTP-01, the site serves on it.
2. **Themed site**: the tenant picks a theme, customizes config, the public site renders
   SSR by hostname.
3. **Store**: the catalog renders from the tenant's PayNow/Tebex store on the
   Cupboard-hosted site.
4. **Player checkout**: a player logs in via Steam on the tenant site and reaches
   provider checkout.

The #1 risk cluster is **public exposure**: before this phase the platform is 100%
internal-only (gateway + web both behind traefik-internal). Phase 5 adds three public
surfaces (storefront hosts, webhook receiver, player-auth callback host). The
default-subdomain path (`{slug}.sites.vngenterprise.com`) needs zero Frank-side
prerequisites (existing DNS-01 issuer + traefik-external + a Cloudflare wildcard DNS
record), so it ships first; custom-domain HTTP-01 (blocked on the router port-80 forward
and a stable edge hostname) is built mid-phase and verified when unblocked.

## Resolved decisions (2026-07-05)

| # | Decision |
|---|----------|
| A | **New service `services/tenant`** (fleet's lib+bin shape). Schema `tenant`, `cupboard`/`cupboard_app` role pair like identity, standard RLS recipe + explicit `WHERE tenant_id` defense-in-depth. New envs as PRs land: `SITES_SUFFIX`, `REDIS_URL` (PR1), `TENANT_MASTER_KEY` (PR2), `PLAYER_JWT_PUBLIC_KEY_PEM` (PR3+), `PUBLIC_WEBHOOK_BASE` (PR4), `EDGE_HOSTNAME` (PR5). |
| B | **Store-provider adapter trait** in `services/tenant/src/providers/`: `probe`, `fetch_catalog` (full-list; neither provider paginates catalogs), `register_webhook` (PayNow via API; Tebex returns manual instructions), `verify_and_parse_webhook` (pure/sync), `begin_checkout`, `continue_checkout` (Tebex basket-auth leg), `reconcile`. Creds envelope-encrypted exactly like BM tokens; injectable base URLs + stub servers for e2e (bmapi precedent); bmapi-style sliding-window limiter (Tebex 500 req/5 min per key; PayNow undocumented, conservative). |
| C | **Checkout asymmetry**: `CheckoutBegin { redirect_url, step }` + `checkout_sessions`. PayNow: we verify Steam ourselves, upsert customer by steam_id, create checkout server-side, redirect. Tebex: basket -> provider-side Steam auth (`returnUrl` back to `/store/checkout/{session}/continue`) -> add packages -> `links.checkout`. Fallback seam: Tebex plugin buy-now `POST /checkout`. v1 = buy-now per product, carts later. |
| D | **Catalog = DB cache, full-list content-hash diff**; 5-min runner refresh + "Sync now"; soft-delete absent products. The storefront never makes a live provider call on a request path. |
| E | **Entitlement ledger** + `store_webhook_events` dedupe (unique (connection_id, event_id); verify sig -> insert-or-skip -> apply in same tx) + **15-min reconcile poll** as the webhook-loss backstop (retry schedules unpublished; Tebex deactivates failing endpoints). Provider-wins conflict rule (no local edits exist). |
| F | **Webhook receiver on the tenant service directly** (not the gateway): raw-body HMAC integrity, no JWT semantics, URL stability. Public IngressRoute `cupboard-hooks.vngenterprise.com` + `PathPrefix(/webhooks/)`; per-connection URLs `/webhooks/{provider}/{connection_id}`. PayNow: HMAC-SHA256(`"{ts}.{raw}"`) base64 + 5-min skew + event_id dedupe. Tebex: HMAC-SHA256(secret, sha256_hex(raw)) + IP allowlist + `validation.webhook` handshake. |
| G | **Per-connection runner = BM supervisor/runner clone** (claim/heartbeat, `FOR UPDATE SKIP LOCKED`, 120s stale takeover; conditional spawn on `TENANT_MASTER_KEY`): one runner per provider key makes the process-local limiter globally correct. Domains use a lighter 30s batch-claim loop (short idempotent steps: DNS check, CR create, cert poll). |
| H | **Sites**: one per org (v1), slug globally unique (DNS label, reserved list in code). `site_domains` state machine `pending_dns -> verifying -> dns_ok -> issuing -> active` (+`failed_dns`/`failed_issuance`/`disabled`), 5 domains/tenant cap, issuance backoff 1m/5m/30m/2h/12h (LE: 5 failed validations/hostname/hour). |
| I | **Site resolution**: `GET /public/sites/resolve?host=` handles default subdomains (slug parse) and custom domains (active lookup); Redis cache TTL 60s positive / 30s negative, eager DEL on edits. Unknown-host traffic is negative-cached (no per-request DB load from junk). |
| J | **Web host routing**: root `middleware.ts` — admin hosts pass through (direct `/storefront/*` paths 404); every other host rewrites to `/storefront/{host}{path}` + stamps `x-cb-site-host`; the storefront layout 404s unless its `[host]` segment equals that header (host-spoofing guard). Traefik only routes storefront hosts publicly (defense in depth). |
| K | **Theming**: registry `apps/web/src/themes/registry.ts` (theme_id -> components + CSS variables); storefronts are not locked to the admin dark palette. 2 themes v1 (Ember dark in PR1, Slate light in PR7 to prove pluggability). Unknown theme ids fall back to the default (a stale DB value can never break rendering). |
| L | **Player accounts (auth, global)**: `player_accounts`/`player_identities`/`player_sessions`. **Token separation is cryptographic**: player JWTs use a SEPARATE Ed25519 keypair (operator `Claims` validation requires only exp+sub and ignores unknown fields, so claim-shape discrimination alone is unsafe). Operator services never load the player public key. Cookies disjoint (`cb_player_*` on storefront hosts only). |
| M | **Steam OpenID hand-rolled** (`services/auth/src/http/openid_steam.rs`): `check_authentication` round-trip, claimed_id regex -> steamid64, exact return_to match, response-nonce replay table. crates.io candidates are all stale micro-crates (checked 2026-07-05). Persona/avatar via `GetPlayerSummaries` (optional `STEAM_WEB_API_KEY`). |
| N | **One-time-code handoff** (Discord redirect-URI constraint; Steam shares the path): central public host `cupboard-login.vngenterprise.com` serves only the OAuth callbacks; callback verifies, resolves/creates the player, mints a 32-byte code (SHA-256 hash stored, TTL 60s, host-bound, `DELETE .. RETURNING` single-use), 302s to `https://{site_host}/login/complete?code=`; the web BFF exchanges it server-side and sets player cookies on the tenant host. |
| O | **k8s cert automation** (`kube` crate): tenant-service SA creates `Certificate` + `IngressRoute` CRs **in the `cupboard-web` namespace** (same namespace as the target Service; `tls.secretName` resolves locally, no cross-namespace service refs). Role/RoleBinding there grants create/get/list/delete on `certificates.cert-manager.io` + `ingressroutes.traefik.io` (zitadel cert-job precedent). New `ClusterIssuer letsencrypt-http01` (solver class traefik-external) + an LE-staging twin for dry runs. |
| P | **Gateway routes**: `/sites`, `/sites/{*path}`, `/store/{*path}` behind `require_auth` (tenant service enforces `sites.edit`/`store.manage`); `/public/{*path}`, `/player/{*path}` unauthenticated passthrough (cluster-internal callers; the tenant service verifies player JWTs itself). Player auth start/exchange ride the existing `/auth/{*path}`. Webhooks bypass the gateway entirely. |
| Q | **No permission backfill**: `store.manage`/`sites.edit` shipped in Phase 1 (`e4a8c01`) inside the Owner/Admin templates, so every org materialized them at creation. Only the web permission mirror + nav gating needed. |
| R | **Admin surfaces**: `(app)/site` (theme/config/publish + default-host link), `(app)/site/domains` (PR5), `(app)/store` (PR2+: connection wizard w/ probe, catalog + sync status, entitlements), player profiles gain an Entitlements card via BFF read-through (no bus events, no identity schema change this phase). |

## Thinnest end-to-end slice (PR1: "a public tenant site renders by hostname")

```
admin web: create site, pick theme -> POST /sites (gateway, sites.edit) -> tenant svc
-> browser: https://{slug}.sites.vngenterprise.com
   (CF wildcard DNS -> traefik-external, tls = *.sites wildcard via existing DNS-01)
-> web middleware.ts: host not admin -> rewrite /storefront/{host} + x-cb-site-host
-> storefront layout: guard header==segment -> gateway /public/sites/resolve?host=
   (tenant svc, Redis 60s) -> themed homepage SSR with tenant colors/logo/content
```

Most foundational (every later feature renders through this pipe) and the riskiest
unblocked work (first public exposure, full new-service bootstrap, host-rewrite edge
cases). Deliberately excluded: store pages, player login, custom domains, second theme.

## Service boundaries (delta from Phase 4)

| Service | Phase 5 delta |
|---|---|
| **tenant** (new) | Commerce (connections/creds, adapters, catalog cache, checkout sessions, entitlements, webhooks, runners) + Sites (sites/site_domains, resolve, domain loop, k8s CRs). |
| **auth** | Player accounts, Steam OpenID, player Discord OAuth, separate player JWT keypair, `/auth/player/*`. Operator auth untouched. |
| **gateway** | `/sites`, `/store` (require_auth) + `/public`, `/player` (passthrough) -> tenant. |
| **identity** | Optional `GET /internal/players/by-identifier` (PR7 stretch). |
| **web** | `middleware.ts` host routing, `storefront/[host]` group + theme registry, admin site/store/domains pages, permissions mirror. |
| **fleet, collector, metrics, bot** | Unchanged. |

## Schema / migration order

- `tenant/0001_sites.sql` - `sites`, `audit_log` (+RLS). PR1.
- `tenant/0002_store.sql` - `store_connections` (envelope creds, webhook secret, lease
  columns, settings, cursors), `store_products`, `store_categories` (+RLS). PR2.
- `auth/0003_player_accounts.sql` - `player_accounts`, `player_identities`,
  `player_sessions`, `player_login_codes`, `openid_replay` (global; no RLS, like
  `users`/`sessions`). PR3.
- `tenant/0003_entitlements.sql` - `checkout_sessions`, `entitlements`,
  `store_webhook_events` (+RLS). PR4.
- `tenant/0004_domains.sql` - `site_domains` state machine (+RLS). PR5.

## PR sequence (one `phase5` branch, draft PR, logical PRs as commits like Phases 3-4)

| PR | Title | Proves | Frank-blocked? |
|----|-------|--------|----------------|
| **PR1** | Public site by hostname | ⭐ First public surface + the SSR pipe. DoD #2. | No |
| **PR2** | PayNow store connected (adapter + catalog) | ⭐ Riskiest commerce machinery. DoD #3. | Light: PayNow test store + key |
| **PR3** | Player login via Steam | ⭐ Security-critical token separation. Half of DoD #4. | No |
| **PR4** | Checkout + entitlement ledger | Completes DoD #4. | No (test mode fires real webhooks) |
| **PR5** | Custom domains + auto-TLS | DoD #1 headline; code lands regardless, verification waits. | **Yes**: router port-80, edge hostname, test domain |
| **PR6** | Tebex adapter breadth | Adapter absorbs the asymmetric provider. | Light: Tebex webstore (~1 day review) |
| **PR7** | Breadth + UX (theme 2, entitlements card, Discord link) | Operator- and player-grade surfaces. | Discord redirect (optional) |
| **PR8** | Staging closeout + live DoD + degradation matrix | DoD verified end to end. | Inherits PR5 prereqs |

PR5 prerequisites are requested at PR1 time so the wait overlaps PR2-PR4.

## Deploy / OpenBao additions (in `v-deployments`)

- New app `argocd/applications/use1/cupboard-tenant.yaml` + overlay
  `applications/cupboard/overlays/tenant`; CI build matrix gains `cupboard-tenant`.
  Gotcha: the `use1` app-of-apps is `syncPolicy: None` - apply the new Application CR
  manually.
- OpenBao (`bao kv patch`, never `put`): `cupboard/staging/tenant -> master_key` (PR2);
  `cupboard/staging/auth` += `player_jwt_private_pem`/`player_jwt_public_pem` (PR3);
  optional `STEAM_WEB_API_KEY`.
- PR1 ingress: `Certificate *.sites.vngenterprise.com` (existing DNS-01 issuer),
  Cloudflare wildcard DNS record (proxied), public IngressRoute on traefik-external
  routing storefront hosts -> cupboard-web; web configmap gains
  `ADMIN_HOSTS`/`SITES_SUFFIX`; gateway configmap gains `TENANT_SERVICE_URL`.
- PR4/PR3 ingress: `cupboard-hooks` host -> cupboard-tenant (webhooks path only);
  `cupboard-login` host -> cupboard-auth (two callback paths only).
- PR5: `ClusterIssuer letsencrypt-http01` (+ LE-staging twin), SA/Role/RoleBinding
  (Role in the cupboard-web namespace), edge hostname in cloudflare-ddns
  `records.json` (grey-cloud), router 80 -> 10.1.50.175 (out-of-band).
- One cupboard-web Deployment serves both admin (internal ingress) and storefronts
  (public ingress) in staging; a second Deployment of the same image is the documented
  production scaling seam.

## Degradation matrix (target behavior; verified + recorded in PR8)

| Capability | Provider down | Webhooks failing | Cert issuance failing | DNS misconfigured | No store | Player not logged in |
|---|---|---|---|---|---|---|
| Site rendering (default subdomain) | ok (cache) | ok | ok | ok | ok (store hidden) | ok |
| Site rendering (custom domain) | ok | ok | `failed_issuance` + guidance; **default subdomain keeps serving** | `failed_dns` + instructions, rechecked | ok | ok |
| Store pages | stale cache, `last_synced_at` shown | ok | ok | ok | hidden | browse ok; buy prompts login |
| Checkout | fails fast, friendly retry | unaffected (provider-side) | ok | ok | n/a | redirect to login, then resume |
| Entitlement ledger | reconcile skips tick, error surfaced | **reconcile backstop converges <= 15 min** | ok | ok | empty | n/a |
| Player login | ok (independent) | n/a | ok (central host on wildcard) | ok | ok | - |

Invariants: **no provider failure ever breaks site rendering** (provider I/O only in
runners + checkout begin); **no cert/DNS failure ever breaks default-subdomain serving**.

## Cross-cutting (non-negotiable, as every phase)

- RLS on every new tenant table + isolation tests; audit rows for site/store/domain
  mutations (tenant-schema `audit_log`); OTel spans on runners; provider credentials and
  webhook secrets are write-only (never returned by any API, never logged).
- Player/operator token cross-rejection tests in both directions (PR3).
- Provider tokens are never identity proof (PayNow customer tokens are mintable from a
  bare steam id); Cupboard always verifies Steam itself.

## Remaining open questions (non-blocking; decide as we reach them)

- Tebex basket-auth UX on a real Rust store (fallback: plugin buy-now checkout);
  SteamID64 field format in Tebex payloads - verify empirically in PR6.
- Apex custom domains cannot CNAME (dynamic public IP): v1 docs steer tenants to a
  subdomain; ALIAS/static-IP support later.
- Custom-domain traffic bypasses Cloudflare (DNS-only is required for HTTP-01): no
  WAF/DDoS on those hosts. Accepted for staging; production hardening item.
- No object store for logo/asset uploads: v1 takes URLs only (minio/R2 later).
- Production sites base domain (staging uses `sites.vngenterprise.com`): launch decision.
