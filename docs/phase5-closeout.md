# Phase 5 closeout: Commerce + white-label sites

Status as of 2026-07-08. Phase 5 is **code-complete**: all 8 PRs are on branch `phase5`
(draft PR #8), each followed by a high-effort code review whose findings were fixed and
regression-tested before the next PR. The **live Definition-of-Done run is pending** a set
of operator-side prerequisites (router port-80 forward, a test custom domain, PayNow/Tebex
test stores, and OpenBao secrets). This document is the go-live runbook + the verified
degradation matrix + the exact remaining prerequisites.

Local verification baseline: 224 workspace tests green, clippy + fmt clean, web `tsc` +
`build` clean. The v-deployments manifests live on branch `cupboard-phase5` (not merged;
they must go live together with the Phase 5 images, since the public IngressRoutes must not
precede the middleware-bearing web image).

## Definition of Done

> A tenant connects a custom domain (auto-TLS), picks a theme, the store renders from
> PayNow/Tebex, and a player logs in via Steam and reaches checkout.

| # | Criterion | Code status | What the LIVE run needs | Backed locally by |
|---|-----------|-------------|-------------------------|-------------------|
| 1 | Custom domain -> auto-TLS -> site serves on it | Complete (PR5) | Router `internet:80 -> 10.1.50.175`, a DNS-only test domain CNAMEd to the edge host, `CERT_ISSUER` flipped to prod after a staging-issuer dry run | `domains_e2e` (state machine pending_dns -> failed_dns -> issuing -> active -> resolve -> disabled -> teardown), `domain_cap_and_isolation` |
| 2 | Pick a theme, public site renders SSR by hostname | Complete (PR1, PR7) | Default-subdomain site reachable in a browser (needs the merge/deploy) | PR1 storefront SSR + host-spoofing tests; Slate theme added (PR7) |
| 3 | Store renders from the tenant's PayNow/Tebex store | Complete (PR2, PR6) | A PayNow test store (API key) and/or a Tebex test webstore (Headless + Game-Server keys); confirm the (defensively parsed) live payload shapes | `store_e2e` (connect/probe, catalog hash-diff + sweep, public catalog), `tebex_e2e` (connect -> catalog -> checkout -> webhook -> reconcile) |
| 4 | Player logs in via Steam and reaches provider checkout | Complete (PR3, PR4, PR6) | A live Steam login + a test-mode purchase firing a real webhook -> entitlement row | `player_login` (OTC handoff, host-binding, operator/player token cross-rejection), `checkout_webhook_e2e` (checkout -> signed webhook -> dedupe -> reconcile) |

## Secrets checklist (OpenBao)

Status: **the required keys are populated (2026-07-08)**. Addr
`https://openbao.vngenterprise.com`, mount `kv`. When adding to an existing path use
`bao kv patch` (never `put`, which drops sibling keys); a brand-new path uses `put`.

| Key path | Property | Consumed as | Status |
|----------|----------|-------------|--------|
| `cupboard/staging/tenant` | `master_key` | `TENANT_MASTER_KEY` (tenant) | ✅ populated 2026-07-08 (32-byte base64). Envelope key for provider creds + webhook secrets. Absent -> commerce disabled. |
| `cupboard/staging/auth` | `player_jwt_private_key`, `player_jwt_public_key` | player JWT keypair (auth signs; tenant + web verify) | ✅ populated 2026-07-08 (Ed25519 PKCS#8 pair, DISJOINT from the operator keypair). Absent -> `/auth/player/*` + `/player/*` 503. |
| `cupboard/staging/internal` | `api_token` | `INTERNAL_API_TOKEN` (auth + tenant) | ✅ already present. Guards the auth->tenant host-resolution call; fails closed. |
| `cupboard/staging/auth` | `steam_web_api_key` | `STEAM_WEB_API_KEY` (auth) | OPTIONAL, not set. Persona/avatar enrichment; login degrades to steamid-only. |

Already present (pre-Phase-5): `cupboard/staging/pg/{cupboard,cupboard_app}`,
`cupboard/staging/redis`, `cupboard/staging/auth/{jwt_private_key,jwt_public_key,token_pepper}`.
Verified via a `vault-global-admin` OIDC login (2026-07-08).

Per-tenant provider secrets (PayNow API key, Tebex Game-Server secret + webhook secret) are
NOT OpenBao keys: operators enter them in the admin UI and they are sealed under
`TENANT_MASTER_KEY`. Player Discord linking additionally needs `DISCORD_CLIENT_ID` /
`DISCORD_CLIENT_SECRET` on `cupboard-auth` (not yet wired to an ExternalSecret; optional,
add when enabling Discord).

## Go-live runbook (ordered)

1. **Populate the OpenBao keys** above (re-auth first). Generate the player keypair with
   `openssl genpkey -algorithm ed25519` (private) + `openssl pkey -pubout` (public); the
   master key with 32 random bytes base64; the internal token with any long random string.
2. **Create the `pg/cupboard_app` role** BEFORE the tenant/auth migrate against the app pool
   (Phase 1 grant gotcha, see [[cupboard-phase1]]).
3. **Router + DNS** (custom-domain prerequisites): forward `internet:80 -> 10.1.50.175`
   (external Traefik LB); confirm the existing `:443` forward target; ensure
   `edge.vngenterprise.com` resolves grey-cloud (DNS-only) to the dynamic public IP via
   cloudflare-ddns; CNAME a DNS-only test subdomain of an owned zone (e.g. `hyplex.gg`) at
   the edge host.
4. **Merge v-deployments `cupboard-phase5` -> main** and **Cupboard `phase5` -> main** (the
   CI build-push matrix builds the tenant/auth/gateway images; the web job builds
   cupboard-web). The public IngressRoutes and the new tenant image ship together.
5. **Apply the new Application CR** `argocd/applications/use1/cupboard-tenant.yaml` manually
   (app-of-apps syncPolicy is None for new apps).
6. **Verify the default-subdomain site** renders in a browser (DoD #2) and that the store
   pages render once a provider store is connected (DoD #3).
7. **Custom-domain dry run** on the LE **staging** issuer (current `CERT_ISSUER`): add the
   test domain in the admin UI, watch it walk pending_dns -> issuing -> active, confirm the
   Certificate + IngressRoute CRs appear in `cupboard-web`, and the site serves on it
   (untrusted staging cert is expected).
8. **Flip to the prod issuer** once the staging dry run is clean: set
   `CERT_ISSUER=letsencrypt-http01` in `applications/cupboard/overlays/tenant/configmap.yaml`
   (from `letsencrypt-http01-staging`), commit, let ArgoCD roll it; re-issue the test domain
   and confirm a trusted cert (DoD #1). Prod LE allows 5 failed validations/hostname/hour,
   so only flip after staging is green.
9. **DoD #3 / #4 live**: connect a PayNow (and/or Tebex) test store, confirm the catalog
   renders; log in via Steam on the tenant site; run a test-mode purchase and confirm the
   real webhook lands an entitlement row (and the reconcile poll converges).
10. **Exercise the degradation matrix** (below) against the live deployment: kill a provider
    stub / break DNS / paste a wrong webhook secret and confirm site rendering never breaks.
11. **Observability**: confirm metrics + traces for the tenant service appear in Grafana
    (the service already emits OTel like the rest of the fleet).
12. **Tick the ROADMAP** Phase 5 DoD and mark PR #8 ready / merge.

## Degradation matrix (verified)

Invariants (proven by construction + tests): **no provider failure ever breaks site
rendering** (provider I/O lives only in the runners + the checkout-begin/continue request
path, never in the SSR resolve path), and **no cert/DNS failure ever breaks
default-subdomain serving** (custom-domain machinery is a separate loop that only ever adds
per-domain CRs).

| Capability | Provider down | Webhooks failing / deactivated | Cert issuance failing | DNS misconfigured | No store connected | Player not logged in |
|---|---|---|---|---|---|---|
| Site (default subdomain) | ok (cache + admin staleness) | ok | ok (never touches custom-domain machinery) | ok | ok (store hidden) | ok |
| Site (custom domain) | ok | ok | stays `failed_issuance` with guidance; **default subdomain keeps serving** | `failed_dns` + instructions, rechecked with backoff | ok | ok |
| Store pages | stale cache + `catalog_synced_at` shown; runner backs off | ok | ok | ok | hidden (404) | browse ok; buy prompts login |
| Checkout | fails fast, friendly retry | unaffected (provider-side) | ok | ok | n/a | 302 to /login then resume |
| Entitlement ledger | reconcile skips a tick, `last_error` surfaced | **reconcile is the backstop; converges <= 15 min**; webhook health in admin | ok | ok | empty | n/a |
| Player login | ok (independent) | n/a | ok (central host on the wildcard) | ok | ok | - |

Evidence for the key cells:
- **Provider down / catalog stale**: `sync_catalog` defers on transient/rejected errors
  (`defer_sync_fenced`) and marks the connection `error` on auth failure (hiding the public
  catalog) without ever touching the SSR resolve path; the public catalog is served only
  from the DB cache (`public_catalog`), never a live provider call. Proven by
  `store_e2e::connect_probe_failure_modes` + `connect_sync_diff_sweep_and_public_catalog`.
- **Webhooks failing -> reconcile backstop**: the runner reconciles every 15 min
  (`reconcile_entitlements`); the ledger converges via content-hash upsert whether a row
  arrives by webhook or reconcile. Tebex, whose reconcile shape differs from its webhooks,
  never drives the absent-sweep (`ProviderKind::reconcile_sweeps`). Proven by
  `checkout_webhook_e2e` + `tebex_e2e`.
- **Cert/DNS failing never breaks default serving**: `resolve_by_domain` only returns
  `active` domains; a domain stuck in `failed_dns`/`failed_issuance` simply is not resolved,
  and the default-subdomain path (`resolve_by_slug`) is independent. The active-domain
  recheck never downgrades a live domain on a transient control-plane error (PR5 review fix).
  Proven by `domains_e2e`.
- **Wrong/absent webhook secret**: the receiver rejects (401) a bad signature and 404s a
  disconnected or secret-less connection; a PayNow secret cannot be clobbered by the manual
  Tebex webhook-secret path (`webhook_secret_is_tebex_only`).
- **Player-token isolation**: operator and player tokens are mutually rejected at the
  signature layer (`operator_and_player_tokens_are_mutually_rejected`).

## Remaining operator (Frank) prerequisites

1. ~~OpenBao secrets~~ **DONE 2026-07-08** (tenant `master_key` + auth player keypair
   populated; internal `api_token` already present).
2. **Router `internet:80 -> 10.1.50.175`** (+ confirm the `:443` forward) for HTTP-01.
3. **A DNS-only test custom domain** CNAMEd to `edge.vngenterprise.com`.
4. **A PayNow test store** (API key, free test mode) and/or **a Tebex test webstore**
   (Headless + Game-Server keys; store creation is ~1-day review). These also let us confirm
   the defensively-parsed live payload shapes (a documented PR2/PR6 verify item), and the
   Tebex basket `ip_address` placeholder.
5. (Optional) **Steam Web API key**; **a Discord application** + `DISCORD_CLIENT_ID/SECRET`
   + the `cupboard-login/.../discord/callback` redirect URI to enable player Discord linking.

## Deferred (carried past Phase 5)

- Identity storefront player-stats endpoint (an explicit PR7 stretch item).
- Apex custom domains cannot CNAME a dynamic IP: v1 steers to subdomains (ALIAS/static-IP
  later). Custom-domain traffic is DNS-only (bypasses Cloudflare) so no WAF/DDoS on those
  hosts: accepted for staging, a production-hardening item.
- No object store for logo/asset uploads: v1 takes URLs only.
- A production product domain (vngenterprise.com is fine for staging) is a Phase 7/launch
  decision.
- Second cupboard-web Deployment (admin vs storefront split) is a documented production
  scaling seam; one Deployment serves both tiers in staging.
