# Cupboard Phase 6 - Implementation Plan (Support + billing + public API)

> Turns ROADMAP Phase 6 ("Support + billing + public API", size L) + ARCHITECTURE
> "Support (tickets)" / "Commerce & billing" / "Public API" (decisions #4, #9, #24,
> #28-#30, #32, #33) into a sequenced, de-risked build. Follows the shape that worked
> for Phases 2-5. Inputs: the 2026-07-13 scouting briefs, `docs/phase5-closeout.md`.
> **Status (2026-07-14):** FINAL. Adversarial review fixes applied; Frank's answers
> folded in (one-off services IN scope, see "Resolved with Frank"); tiers named and
> priced; ALL operator prerequisites satisfied 2026-07-14 (Stripe test objects +
> secrets in OpenBao, Customer Portal configured, bot installed in a test guild).
> Ready to start PR1.

## Definition of Done (from ROADMAP)

1. **Ticket, both surfaces**: a player opens a ticket from web AND from Discord;
   messages sync two-way (private thread per ticket).
2. **Paid plan**: a tenant subscribes to a paid plan via Stripe Billing; plan gating
   and rate-limit tiers reflect it.
3. **API key**: a per-tenant scoped key makes a scoped, rate-limited call against
   `/api/v1/*` (OpenAPI via utoipa at the gateway).

The #1 risk cluster is **new principal plumbing**: Phase 6 introduces the platform's
fourth principal (API keys) against a hard constraint - downstream services
independently verify the operator Ed25519 signature, so a gateway-validated key
cannot simply inject headers. The second risk is the **bot**: a greenfield TS
deployable in a repo that has never shipped a non-frontend Node service, carrying
the only genuinely new distributed-sync topology (web <-> Discord). Revenue-critical
work (billing, API) is therefore sequenced first and is fully independent of the
bot; if the bot slips, DoD #2 and #3 still land. Honest sizing: the roadmap says L,
but three workstreams plus a new deployable is L trending XL - the bot is the swing
factor, and the PR order is built so it can slip without blocking revenue.
Notably, Phase 6 adds **zero new public ingress hosts** (Stripe webhooks ride the
existing `cupboard-hooks` PathPrefix; the bot is outbound-only) and **zero new Rust
services**.

## Resolved with Frank (2026-07-13)

1. **Pricing / tier structure: APPROVED; naming and pricing final (2026-07-14).**
   Three tiers - **Free** (default, no Stripe object), **Team**, **Enterprise** -
   gating rate limit (60/300/1000 req/min), API-key count (1/5/20), and
   custom-domain cap (1/3/10, replacing the flat 5 from Phase 5 decision H; caps
   enforced on NEW adds only, domains existing at rollout are grandfathered, never
   disabled). Pricing: Team $10/month (`price_1TsoVRQ8u2sG5NBcfNULAcK0`),
   Enterprise $50/month (`price_1TsoVbQ8u2sG5NBctEl6IPhi`). These are Stripe
   TEST-mode objects; production products/prices are a Phase 7 cutover item (see
   Deferred).
2. **One-off services: manual-invoice recommendation REJECTED; self-serve one-time
   purchases are IN SCOPE.** Orgs buy what they need when they need it, in product:
   Stripe Checkout in payment mode alongside the subscription flow, a code-defined
   service catalog, and a `billing_purchases` ledger (decisions H, I, J, R carry
   the details). Purchase is self-serve; fulfillment stays manual/human. v1 sells
   **Custom Design only**, $250 one-time (TEST-mode
   `price_1TsoXCQ8u2sG5NBcn8SGPh6i`); migration assistance is deferred per Frank
   ("skip it, we will do it later").
3. **Discord install model: APPROVED as recommended.** One shared Cupboard bot
   (single `DISCORD_BOT_TOKEN` on the existing Discord application, which already
   holds the OAuth creds) invited into each tenant's guild via a standard invite
   link, then bound by a one-time code (`/cupboard setup <code>`, minted in the
   admin UI - the Phase 5 one-time-code pattern). The message-content privileged
   intent requires Discord verification past 100 guilds: accepted as a pre-launch
   task, not a Phase 6 blocker.

## Resolved decisions (2026-07-13)

| # | Decision |
|---|----------|
| A | **Tickets live in the tenant service** (ARCHITECTURE §4 already assigns Support there, "split later"). A new `services/support` would cost an overlay + ArgoCD app + namespace + CI matrix entry + secret wiring and would still need player-JWT verification, `/internal/*`, and storefront plumbing that tenant already has. Tenant-service bloat is real (commerce + sites + support) but is the documented split-later seam, not a Phase 6 problem. New modules `src/domain/tickets.rs`, `src/http/tickets.rs` (+ player/internal route additions). |
| B | **One ticket store (decision #28), two tables** in the tenant schema, standard RLS recipe: `tickets` (id uuidv7, tenant_id, type `general\|ban_appeal`, status `open\|pending\|resolved\|closed`, category, subject, player_account_id nullable, opener_discord_user_id nullable, ban_id uuid nullable (identity's `bans.id`, NO cross-schema FK), assignee_user_id, discord_channel_id/discord_thread_id nullable, created/updated) and `ticket_messages` (id uuidv7 = ordering key, ticket_id, tenant_id, author_kind `player\|staff\|system`, author_id, author_display, body, `internal bool` (staff notes: web-only, NEVER published to the stream), `origin 'web'\|'discord'\|'system'`, discord_message_id nullable, created_at). Dedupe: unique index on `(tenant_id, discord_message_id)` where not null. One open appeal per ban: partial unique index on `(tenant_id, ban_id)` where type='ban_appeal' and status in ('open','pending'). Audit rows in the existing tenant `audit_log`. |
| C | **Appeal-to-ban link crosses to identity over internal HTTP** (the tenant<->auth `/internal/*` precedent, `INTERNAL_API_TOKEN`). Identity gains `GET /internal/bans/{id}?tenant_id=` (summary for validation + rendering) and `GET /internal/bans/active?tenant_id=&steam_id=` (the storefront "appeal this ban" picker; the logged-in player's steam_id comes from `PlayerClaims`, identity hashes it to `subject_hash` for the lookup). Tenant stores `ban_id` + a denormalized summary snapshot (subject, reason, status at open). Staff "action the ban from the ticket" is web-side only in v1: the `(app)/tickets/[id]` page embeds the ban card via BFF read-through of the existing `/bans` routes (the Phase 5 entitlements-card precedent); no new cross-service write path, Discord-side ban actioning deferred. |
| D | **Discord model: private thread per ticket** under one operator-configured tickets channel (threads avoid the 500-channel guild cap and inherit simpler perms than channel-per-ticket; decision #29 allows either). Config table `ticket_discord_configs` (tenant_id unique, guild_id unique GLOBAL - one guild binds one tenant, resolved server-side, never trusted from the bot payload -, tickets_channel_id, staff_role_id, status, linked_by, linked_at). Install per Resolved with Frank #3: shared bot + invite link + one-time-code bind; the bind code lives in `ticket_bind_codes` (tenant schema: code_hash, tenant_id, created_by, expires_at; single-use `DELETE .. RETURNING`, the Phase 5 one-time-code precedent). |
| E | **Bot transport is asymmetric**: platform -> bot via a new Redis Stream `TICKET_STREAM = "cupboard:tickets"` (added to `crates/domain/src/events.rs`; tenant publishes `publish_capped` post-commit, best-effort - the first producer besides collector, consumer group `bot` via ioredis XREADGROUP, same one-JSON-`data`-field envelope as `crates/bus`); bot -> platform via internal HTTP to the tenant service (`TENANT_INTERNAL_URL`), authenticated with a **distinct `BOT_API_TOKEN`**, NOT the shared `INTERNAL_API_TOKEN`: the bot is the largest new attack surface (an internet-connected Node process parsing untrusted Discord content), NetworkPolicies are silent no-ops on flannel until Phase 7, and the shared token (already held by auth, tenant, fleet, identity, collector, now gateway too) would hand a compromised bot the full internal surface including identity `/internal/enforce` and self-serve plan escalation. The tenant service accepts `BOT_API_TOKEN` ONLY on `/internal/tickets/*`; all other `/internal/*` routes keep the shared token. Rejected: polling (latency, load) and bot-side HTTP push for outbound (would make web ticket writes synchronously depend on the bot). Events: `ticket.created`, `ticket.message`, `ticket.status` - never messages with `internal=true`, never `origin='discord'` messages (see F). Delivery caveat: `ensure_group` creates the consumer group at `$`, so events published BEFORE the bot first boots are never delivered; the bot therefore creates threads lazily - on a `ticket.message` for a ticket with no `discord_thread_id`, it fetches `GET /internal/tickets/{id}` and creates the thread (with a backfill of recent messages) before relaying. New bot-facing internal routes on tenant: `POST /internal/tickets` (open from Discord), `POST /internal/tickets/{id}/messages`, `POST /internal/tickets/{id}/discord-thread` (record created thread id), `POST /internal/tickets/discord/bind` (one-time-code guild bind), `GET /internal/tickets/{id}`. |
| F | **Echo-guard + idempotency** (the identity BM outbox is prior art; this is its lighter cousin). Loop prevention is origin-based: the tenant service never publishes `origin='discord'` messages to the stream (the bot already has them), and the bot ignores its own Discord messages (author id == bot user) plus all messages outside known ticket threads. Discord -> web dedupe: the bot POSTs with `discord_message_id`; insert is `ON CONFLICT DO NOTHING` on the unique index. Web -> Discord dedupe: at-least-once stream delivery; the bot checks the fence, posts to Discord FIRST, then sets the fence `SET bot:relayed:{message_id} NX EX 86400` (the TTL keeps fence keys from accumulating unboundedly), then XACKs. Ordering is deliberate: a crash between post and fence duplicates a message text in the thread on redelivery - accepted, harmless (the web store stays canonical) - whereas fence-before-post would silently DROP messages on a crash between fence and post (redelivery sees the fence, skips, acks), which is worse. |
| G | **Degradation: web tickets never depend on Discord.** Stream publish is fire-and-forget post-commit (failure logged, ticket write already committed). Bot down: web fully functional; the consumer group retains undelivered entries and the backlog replays on reconnect (capped stream means very old events can trim - the thread lags, web remains canonical). Discord API down: bot retries with backoff, acks only on success. No outbox in v1; upgrade path documented if gaps bite. |
| H | **Billing lives in the tenant service** (it is the Commerce owner and already has the webhook receiver host, the `store_webhook_events` dedupe shape, and the reconcile-loop pattern to mirror; auth stays pure identity/RBAC). Stripe is single-merchant: `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` are platform secrets from new OpenBao path `cupboard/staging/stripe` (NOT envelope-encrypted - envelope crypto is for tenant-supplied creds). **No runner/supervisor clone**: that machinery exists for hundreds of per-tenant creds; Stripe gets one plain 15-min reconcile loop that must converge cancellations, not just upgrades: list subscriptions with `status=all` (Stripe's default listing EXCLUDES canceled subscriptions, so a naive list+upsert could never downgrade an org whose `customer.subscription.deleted` webhook was lost), upsert, sweep local active rows absent from a completed walk (the `sweep_absent_actives` precedent, `services/tenant/src/domain/entitlements.rs` / `store/runner.rs`), then re-push the mirror INCLUDING downgrades to free. The same tick backstops one-off purchases: list Checkout Sessions completed in the last 24h with `mode=payment` and upsert any `billing_purchases` row a lost webhook missed (money must not depend on webhook delivery). Webhook receiver `POST /webhooks/stripe` on tenant :8080 - the existing `cupboard-hooks.vngenterprise.com` IngressRoute already matches `PathPrefix(/webhooks/)`, so **no new host, DNS, or ingress change**; verify `Stripe-Signature` over the raw body (t + v1 HMAC, 5-min skew), dedupe on Stripe `event.id` in new `billing_webhook_events` (global unique event_id; same verify -> INSERT ON CONFLICT -> apply-in-same-tx flow as Phase 5 decision E). Events consumed: `checkout.session.completed` (`mode=subscription` -> subscription upsert; `mode=payment` -> `billing_purchases` row), `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`, `charge.refunded` (payment_intent -> purchase row -> status `refunded`). Refunds are deliberately webhook-only, no reconcile sweep - the cheapest option consistent with this decision: refunds are initiated by Cupboard staff in the Stripe dashboard (so we see them), and a stale `paid` row gates nothing since fulfillment is manual. |
| I | **Plan model: `org_subscriptions` table in the tenant schema** (tenant_id PK = org id, stripe_customer_id, stripe_subscription_id, plan, status `active\|trialing\|past_due\|canceled`, current_period_end, updated_at), NOT a column on `organizations` (that lives in the auth schema and auth must not own Stripe state). **Plan catalog is code-defined** (`crates/domain/src/plan.rs`: enum `Plan { Free, Team, Enterprise }` + a `PlanLimits` table: rate/min, max keys, max domains), mapped to Stripe price IDs via config (`STRIPE_PRICE_TEAM`, `STRIPE_PRICE_ENTERPRISE` in the tenant configmap; test-mode values recorded in Resolved with Frank #1). Stripe is payment truth; code is gating truth. Free tier = absence of a subscription row. Gating semantics by status: `active`/`trialing` gate as the paid plan; `past_due` keeps paid gating for a 7-day grace window (Stripe retries run), after which it is treated as free; `canceled` is free immediately. **One-off services (Resolved with Frank #2) mirror the same code-defined approach**: a `ServiceItem` catalog beside the plan catalog in `crates/domain/src/plan.rs` (key, name, description, price-id env var); v1 sells `custom_design` ONLY (migration assistance deferred per Frank, see Deferred), mapped via `STRIPE_PRICE_CUSTOM_DESIGN` (the `STRIPE_PRICE_<SERVICE>` configmap pattern); the catalog card states that fulfillment is manual/human even though purchase is self-serve. Ledger: `billing_purchases` in the tenant schema (id uuidv7, tenant_id, service_key, stripe_checkout_session_id, stripe_payment_intent_id, amount, currency, status `paid\|refunded`, purchased_at; standard RLS recipe). Rejected: Stripe-price-driven catalogs (gating and catalog logic would depend on Stripe metadata reads). |
| J | **Subscribe = Stripe Checkout (subscription mode); one-off services = Stripe Checkout (payment mode); manage/cancel/payment method = Stripe Customer Portal.** All are hosted-redirect handoffs mirroring the Phase 5 checkout pattern (`lib/checkout-actions.ts` redirect-to-provider). Tenant routes (gateway `/billing/{*path}`, require_auth; service enforces `billing.manage`): `GET /billing/subscription`, `POST /billing/checkout` (plan), `GET /billing/services` (catalog + purchase history), `POST /billing/services/checkout` (service key in body), `POST /billing/portal`. A SEPARATE services-checkout route rather than overloading `POST /billing/checkout`: plan checkout validates against `Plan` and touches `org_subscriptions`, service checkout validates against `ServiceItem` and touches `billing_purchases` - two trivial handlers beat one bimodal one. Return URLs land on `(app)/billing?flag=...`; the webhook (with the reconcile backstop, decision H), not the return page, is the source of truth for both modes (Phase 5 breadcrumb precedent). |
| K | **Plan propagation = local mirror + JWT claim, no auth hot-path dependency on tenant.** On any subscription change (webhook or reconcile), tenant pushes the resolved plan to auth via new `PUT /internal/orgs/{id}/plan` (auth's FIRST internal server endpoint; guarded by a **distinct `PLAN_WRITE_TOKEN`** held only by tenant and auth, per decision E's token-scoping rationale - a plan write is a privilege escalation primitive and must not ride the widely-shared `INTERNAL_API_TOKEN`; the exchange endpoint, called only by the gateway, keeps the shared token); auth stores it in new auth-schema table `org_plans` (organization_id PK, plan, status, updated_at) and mints a new claim: `Claims.plan: Option<String>` with `#[serde(default)]` (wire-compatible; absent = free; verified against `crates/auth-core` - `org`/`perms` already use the same pattern). Gateway reads the claim for gating + tier. Staleness bound = access-token TTL (~15 min operator, 5 min API-key); the 15-min reconcile re-push heals a lost mirror write. Rejected: auth calling tenant at mint time (puts a cross-service call in the token hot path and couples auth availability to tenant). |
| L | **API keys are owned by auth** (table `api_keys` in the auth schema: id uuidv7, organization_id (auth-schema naming convention), name, token_prefix (first 8 chars, for the list UI), key_hash bytea unique, scopes text[], created_by, created_at, expires_at nullable, revoked_at nullable, last_used_at; RLS for the management surface, owner-pool hash lookup for verification). Format: `cb_` + `crypto::random_token()` (256-bit base64url); at rest `crypto::hash_token(token, pepper)` reusing auth's existing `token_pepper` (keyed HMAC-SHA256 precedent - NOT the unkeyed sha256 of ingest tokens, NOT argon2). One-time reveal (ingest-token precedent, copied verbatim in the UI). **Scopes = existing `Permission` strings**, chosen at creation, **capped to the creating operator's own resolved permissions**. Mint-time capping alone is NOT a lifecycle guarantee (a later demotion or removal of the creator, who saw the plaintext, would otherwise leave admin-grade keys alive forever), so key lifecycle is tied to membership lifecycle at the exchange (decision M): a removed creator means dead keys, a demoted creator means shrunk keys. With that, the no-escalation claim holds end to end. Single org per key (RLS `set_tenant` reuse downstream, unchanged). Management routes on auth (ride the existing gateway `/auth/{*path}` passthrough; auth self-gates on new `api.manage`): `GET/POST /auth/api-keys`, `POST /auth/api-keys/{id}/revoke`. |
| M | **API-key principal = auth-minted short-lived operator JWT (option a, mint endpoint variant).** Gateway middleware `require_api_key` on `/api/v1/*`: extract `Authorization: Bearer cb_...`, check an in-process cache keyed by SHA-256(token); on miss, `POST /internal/api-keys/exchange {token}` to auth, which does hash_token lookup + revocation/expiry check + **membership-lifecycle check**: exchange REFUSES to mint if `created_by`'s membership in the key's org is gone (staff removal kills their keys automatically, <= 5 min cache lag), and re-caps effective perms to the intersection of the key's scopes and the creator's CURRENT resolved permissions (demotion shrinks keys; the per-mint `resolve_permissions` DB hit already happens here). It then mints a **5-minute** operator-signed JWT: `sub` = api_key id (audits show the key id as actor - documented), `org` = key org, `perms` = effective scopes, `plan` from `org_plans`, `sid` = key id, plus a serde-default `kind: "api_key"` claim (wire-compatible, ignored by validation) so downstream audit writes can stamp `{"actor_kind":"api_key"}` into `audit_log.metadata` - future-proofing for Phase 7 GDPR/audit tooling, where key-id actors must be distinguishable from user ids. Gateway caches the minted JWT until exp minus 30s and forwards it as the downstream Bearer. Invalid tokens are **negative-cached** (401 by token hash, ~60s) so a stream of unique garbage keys cannot bypass the limiter into uncached auth round trips. Consequences defended: the Ed25519 private key stays ONLY in auth (preserves the locked "gateway compromise cannot forge" invariant in `crates/auth-core`); zero changes to any downstream extractor, permission check, or `begin_tenant_tx`/`set_tenant` RLS path; revocation latency <= 5 min (cache + TTL). Rejected: (a-prime) signing key at the gateway (breaks the invariant); (b) a third principal type in every downstream service (N services x extractor surface); (c) gateway-as-internal-client (turns the narrow `/internal/*` contract into a full shadow API, shared-secret trust instead of signatures). |
| N | **Rate limiting: Redis fixed-window INCR at the gateway, keyed per-org.** New gateway redis dep (`ConnectionManager`, `REDIS_URL` - first time on the gateway); key `ratelimit:{org}:{unix_minute}`, INCR + EXPIRE-on-first (small Lua for atomicity), limit from the `plan` claim via `PlanLimits`. Over limit: 429 + `Retry-After` (seconds to window end) + `X-RateLimit-Limit/Remaining/Reset`. Fixed window over sliding: one round trip, and the worst case (2x burst at a boundary) is a fairness concern, not a security one; sliding-window Lua is a documented upgrade. Per-org, not per-key: limits are a plan entitlement, and per-key would let an org multiply quota by minting keys. Redis down: **fail open** with a counter metric + log (availability over billing fairness). Scope: `/api/v1/*` only in v1; dashboard traffic is not limited. |
| O | **utoipa 5.x + utoipa-axum, proven in PR1, breadth in PR6.** `/api/v1/*` is an **explicit typed facade** at the gateway (module `services/gateway/src/api_v1/`), not a blind `{*path}` proxy: each endpoint is a small annotated handler with its own request/response DTOs that calls downstream and re-shapes - this is what makes OpenAPI generation, a stable versioned contract, and a uniform envelope possible. Doc served at `GET /api/v1/openapi.json` + Scalar HTML at `GET /api/v1/docs` (utoipa-scalar; lighter than swagger-ui). v1 documents ONLY `/api/v1/*`. Dependency risk: the workspace pins `time` 0.3.51 (cookie vs simple_asn1 squeeze) - PR1 exists partly to prove utoipa's transitive deps compile against the pin before any breadth is built on it. |
| P | **v1 surface + envelope.** Ships: `GET /api/v1/bans`, `POST /api/v1/bans`, `POST /api/v1/bans/{id}/revoke` (the BM-parity headline, scopes `bans.view/create/revoke`), `GET /api/v1/players`, `GET /api/v1/players/{id}` (`players.view`; PII fields only with `players.view_pii` scope), `GET /api/v1/servers` (`servers.view`), `GET /api/v1/entitlements` (`store.manage`). Errors: the facade adopts the downstream `{"error": <code>, "message": <msg>}` envelope (identity/tenant/fleet `AppError` shape) for every response it originates, including 401/403/429 - the gateway's bare-StatusCode habit stops at the v1 boundary. Versioning: breaking changes mean `/api/v2`; additive fields are fair game. **Reachability, stated plainly**: the gateway's IngressRoute is traefik-internal (NetBird VPN), so staging `/api/v1`, the OpenAPI doc, and the Scalar UI are VPN-only by inheritance - no internet integration can call them, and DoD #3 is verified from inside the VPN. Public exposure (a new external IngressRoute or a path-scoped route on an existing public host) is a deliberate Phase 7 cutover item, not an accident of this plan (see Deferred). |
| Q | **Permissions: one new `Permission::ApiManage` = `"api.manage"`** (area `api`), added to `ALL` + the Admin template + web mirror, with backfill migration `services/auth/migrations/0007_backfill_api_manage.sql` (the `0002_backfill_integrations_manage.sql` precedent: upsert catalog row, grant to Owner + Admin roles in existing orgs). `support.respond` and `billing.manage` shipped in Phase 1 templates (verified in `crates/domain/src/permission.rs` + org-creation materialization), so NO backfill for those - but `SupportRespond` must be ADDED to `apps/web/src/lib/permissions.ts` (confirmed missing; `BillingManage` is already mirrored). |
| R | **Web surfaces**: `(app)/tickets` + `(app)/tickets/[id]` (gated `SupportRespond`; list/filter, thread view, internal-note toggle, status/assign, embedded ban card for appeals), `(app)/billing` (gated `BillingManage`; plan card, Checkout/Portal buttons, invoice status flag banners, and a **Services section**: `ServiceItem` catalog cards with buy buttons + a purchase-history table from `billing_purchases`, "fulfillment is manual" stated on the card), `(app)/api-keys` (gated new `ApiManage`; create with scope picker capped to own perms, one-time reveal, revoke), storefront `storefront/[host]/tickets/` + `tickets/[id]` (player surface, `getPlayer()` guard like `account/`, ban-appeal entry from active bans via decision C lookup, "Your tickets" card on `account/page.tsx`). All existing conventions: Server Actions returning `{error}/{ok}`, hand-rolled tables, `?flag=` banners. |

## Thinnest end-to-end slice (PR1: "an API key makes a scoped, rate-limited call")

```
admin web: (app)/api-keys -> POST /auth/api-keys (api.manage; scopes capped to own
   perms) -> auth stores hash_token(cb_..., token_pepper) -> plaintext shown ONCE
-> curl -H "Authorization: Bearer cb_..." https://gateway/api/v1/bans
-> gateway require_api_key: cache miss -> POST auth /internal/api-keys/exchange
   -> auth verifies hash, mints 5-min Ed25519 operator JWT (sub=key_id, org, perms=
   scopes, plan=free default) -> gateway caches + attaches as downstream Bearer
-> gateway rate_limit: INCR ratelimit:{org}:{minute} vs free-tier limit (Redis)
-> api_v1::list_bans facade handler -> identity GET /bans (unchanged AuthClaims
   verify + RLS set_tenant) -> {"error","message"}-enveloped JSON + X-RateLimit-*
   (61st call in the minute: 429 + Retry-After)
```

This is DoD #3 whole, it has **zero Frank prerequisites**, and it deliberately
front-loads every piece of novel architecture at once: the exchange-mint principal
(decision M), auth's first internal endpoint, the gateway's first redis dependency
and limiter (N), the first utoipa-annotated facade endpoint against the `time` pin
(O), the `plan` claim plumbing with its free default (K), and the `api.manage`
backfill (Q). Billing (PR2) then only swaps the hardcoded free tier for real
subscription state. Deliberately excluded: every other v1 endpoint, Stripe,
tickets, the bot.

## Service boundaries (delta from Phase 5)

| Service | Phase 6 delta |
|---|---|
| **tenant** | Tickets (tables, operator/player/internal routes, TICKET_STREAM publish) + Billing (org_subscriptions, billing_purchases, Stripe client for both checkout modes, /webhooks/stripe receiver + dedupe, reconcile loop incl. purchase backstop, plan-mirror push, /billing + /billing/services routes). First bus producer outside collector. |
| **auth** | `api_keys` table + management routes + exchange mint; `org_plans` mirror; FIRST `/internal/*` server surface (`PUT /internal/orgs/{id}/plan`, `POST /internal/api-keys/exchange`); `plan` claim in `Claims`; `api.manage` catalog + backfill. |
| **gateway** | `/api/v1/*` typed facade + utoipa/Scalar docs; `require_api_key` + exchange cache; Redis rate limiter (new redis dep); new proxy routes `/tickets{,/*path}`, `/billing/{*path}` (require_auth -> tenant). |
| **identity** | Two internal read endpoints: `GET /internal/bans/{id}`, `GET /internal/bans/active` (ban-appeal link, decision C). Nothing else. |
| **bot** (new) | `apps/bot`: TS/discord.js (decision #9); consumes `cupboard:tickets`, relays to private threads, relays Discord messages back over tenant `/internal/tickets/*`; `/cupboard setup` bind, `/ticket open|close` commands. |
| **web** | `(app)/tickets`, `(app)/billing`, `(app)/api-keys`, storefront `tickets/`; permissions mirror gains `SupportRespond` + `ApiManage`. |
| **fleet, collector, metrics** | Unchanged (fleet is read via the v1 facade only). |

## Schema / migration order

- `auth/0006_api_keys.sql` - `api_keys` (+RLS, app-role grants). PR1.
- `auth/0007_backfill_api_manage.sql` - catalog upsert + Owner/Admin grant backfill. PR1.
- `auth/0008_org_plans.sql` - `org_plans` mirror (written by the internal endpoint via owner pool). PR2.
- `tenant/0005_billing.sql` - `org_subscriptions`, `billing_webhook_events`, `billing_purchases` (+RLS). PR2.
- `tenant/0006_tickets.sql` - `tickets`, `ticket_messages`, `ticket_discord_configs`, `ticket_bind_codes` (+RLS, dedupe + one-open-appeal partial unique indexes). PR3.
- `crates/domain`: `plan.rs` (PR1: enum + limits, free default), `events.rs` += `TICKET_STREAM` (PR3), `permission.rs` += `ApiManage` (PR1).

## PR sequence (one `phase6` branch, draft PR, logical PRs as commits like Phases 3-5)

| PR | Title | Proves / DoD | Frank-blocked? |
|----|-------|--------------|----------------|
| **PR1** | API keys end-to-end (exchange mint + limiter + facade + utoipa seed) | ⭐ All DoD #3; the novel principal + gateway redis + `time`-pin proof. | No. (The early-request tactic already paid off: every PR2/PR4 operator prerequisite was completed 2026-07-14, before coding starts.) |
| **PR2** | Stripe billing: subscriptions + one-off services (both checkout modes, webhook + dedupe, reconcile + purchase backstop, purchases ledger, plan mirror + claim, tiered limits) | ⭐ All DoD #2; revenue path; plan gating live (key/domain caps + tiers); a self-serve service purchase lands in `billing_purchases`. Built as TWO commit-level slices: subscriptions FIRST (DoD #2), services second - DoD #2 never waits on the services scope. | No - prerequisites completed 2026-07-14: test keys + webhook signing secret in OpenBao (`cupboard/staging/stripe`); Team/Enterprise/Custom Design price IDs known (Resolved with Frank #1/#2); Customer Portal configured in the test-mode dashboard. |
| **PR3** | Tickets, web-only (tables, player + operator surfaces, appeal-ban link, stream publish) | Half of DoD #1; the one-ticket-store model + identity internal endpoints; stream publish is in place (note: PR3-era events are NOT replayed to the bot - the consumer group is created at `$` on first bot boot; PR5's lazy thread creation covers pre-boot tickets, decision E). | No |
| **PR4** | Bot foundation (`apps/bot`, deploy, guild bind via one-time code) | The new deployable through CI/ArgoCD; `/cupboard setup` binds a guild. | No - prerequisites completed 2026-07-14: bot token in OpenBao (`cupboard/staging/bot`), intents toggled, bot installed in a test guild (Resolved with Frank #3). |
| **PR5** | Two-way sync (threads per ticket, relay both ways, echo-guard, `/ticket open`) | Completes DoD #1 (Discord-opened ticket, synced). | No (PR4 prerequisites already satisfied) |
| **PR6** | Public API breadth (players/servers/entitlements endpoints, full OpenAPI doc + Scalar, envelope polish) | The documented v1 contract. | No |
| **PR7** | Closeout: plan-gate breadth, degradation matrix run, staging DoD, phase6-closeout.md | All three DoD verified live end to end, PLUS a live one-time service purchase (additive to DoD #2: Checkout payment mode -> webhook -> `billing_purchases` row -> history table). | No (all prerequisites satisfied 2026-07-14) |

PR1 was designed to carry no external dependency so the Stripe and Discord waits could
overlap coding (the Phase 5 early-request precedent); in the event, Frank completed
every prerequisite on 2026-07-14, before PR1, so NO PR now waits on an operator
action. PR3 lands before the bot exists
by design: web tickets must be complete and self-sufficient (decision G) before any
Discord machinery consumes them. Sizing honesty after Frank's answers: the one-off
services decision makes PR2 the fattest PR in the phase (a second checkout mode, the
service catalog, the purchases ledger + refund path + reconcile backstop, and a UI
section); the two-slice split above keeps the DoD #2 subscription flow in front, and
the added scope pushes the phase further toward the XL end already flagged in the
risk framing - still with billing/API never blocked behind the bot.

## Deploy / OpenBao additions (in `v-deployments`)

- **New deployable `cupboard-bot`** (the only one): Application CR
  `argocd/applications/use1/cupboard-bot.yaml` + overlay
  `applications/cupboard/overlays/bot/` modeled on `applications/rustlens/overlays/bot/`
  (headless worker: no ports/probes, 1 replica in v1 - Discord gateway events would
  duplicate across replicas; the stream consumer group is the later scale-out seam).
  Configmap: `TENANT_INTERNAL_URL`, OTel env per the rustlens bot. ExternalSecret:
  `DISCORD_BOT_TOKEN` (new path `cupboard/staging/bot`, `bao kv put`), `REDIS_URL`,
  `BOT_API_TOKEN` (decision E: the bot never holds the shared `INTERNAL_API_TOKEN`).
  CI: new Node job `build-push-bot` (context `apps/bot`, like
  `build-push-web`); `apps/bot/Dockerfile` = 3-stage node:22-slim, `node dist/index.js`,
  uid 10001. Gotcha: apply the new Application CR manually the first time (the
  phase5-closeout runbook is authoritative over the app-of-apps YAML appearance).
- **OpenBao** (`bao kv patch` for existing paths, `put` only for new):
  new `cupboard/staging/stripe` -> `secret_key`, `webhook_signing_secret` (PR2);
  new `cupboard/staging/bot` -> `discord_token` (PR4); patch
  `cupboard/staging/internal` += `plan_write_token` (PR2) and `bot_api_token` (PR4),
  the scoped tokens from decisions E/K. The `stripe` and `bot` paths were populated
  2026-07-14 (test keys, webhook signing secret, bot token). Path note: the CLI
  addresses the `kv/` mount explicitly (`bao kv put -mount=kv cupboard/staging/...`),
  while ExternalSecrets reference `cupboard/staging/...` relative to the
  `vault-backend` ClusterSecretStore. No changes to `cupboard/staging/auth`
  (key hashing reuses the existing `token_pepper`).
- **Overlay edits, no new ingress**: gateway external-secret += `REDIS_URL` +
  `INTERNAL_API_TOKEN`, configmap unchanged (AUTH_SERVICE_URL already present) (PR1);
  tenant external-secret += `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `PLAN_WRITE_TOKEN` (PR2) + `BOT_API_TOKEN` (PR4); auth external-secret +=
  `PLAN_WRITE_TOKEN` (PR2); tenant configmap += `STRIPE_PRICE_TEAM`,
  `STRIPE_PRICE_ENTERPRISE`, `STRIPE_PRICE_CUSTOM_DESIGN` (PR2). The Stripe endpoint is
  registered in the Stripe dashboard as
  `https://cupboard-hooks.vngenterprise.com/webhooks/stripe` - the existing
  `ingress-webhooks.yaml` `PathPrefix(/webhooks/)` already routes it. CI Rust matrix:
  unchanged (no new Rust service).
- **Discord application** (Frank, out-of-band): enable the bot user on the existing
  application (same app that holds the OAuth creds - linked player Discord IDs map
  straight to guild members), copy the token to OpenBao, toggle the message-content
  intent, invite the bot to a test guild with `bot` + `applications.commands` scopes.

## Degradation matrix (target behavior; verified + recorded in PR7)

| Capability | Bot down | Discord API down | Stripe down | Stripe webhooks failing | Redis down | Auth exchange down |
|---|---|---|---|---|---|---|
| Web tickets (open/reply/notes) | **ok** (publish is fire-and-forget) | ok | ok | ok | ok minus sync (publish fails, logged) | ok |
| Discord ticket sync | lags; backlog replays via consumer group | bot retries w/ backoff, acks on success | ok | ok | lags until Redis returns | ok |
| Subscribe / manage plan / buy service | ok | ok | checkout/portal fail fast, friendly retry; **existing plans + recorded purchases unaffected** (local mirror + ledger) | **reconcile converges <= 15 min** (subscriptions AND missed purchase completions; refunds webhook-only, decision H) + mirror re-push | ok | ok |
| Plan gating / claims | ok | ok | ok (mirror is local to auth) | stale <= 15 min + token TTL | ok | ok |
| `/api/v1/*` calls | ok | ok | ok | ok | **limiter fails OPEN** (metric + log) | cached keys keep working <= 5 min; new keys 503 |
| Admin dashboard / storefronts | ok | ok | ok | ok | ok (site cache already optional) | ok |

Invariants: **no Discord failure ever breaks web tickets** (Discord I/O lives only in
the bot; the tenant service never calls Discord); **no Stripe failure ever degrades an
already-subscribed tenant** (gating reads the local `org_plans` mirror, never Stripe).

## Cross-cutting (non-negotiable, as every phase)

- RLS on every new tenant-scoped table + isolation tests; audit rows for ticket,
  billing, and key mutations (schema-local `audit_log`s; API-key actors audit as the
  key id per decision M). OTel spans on the reconcile loop, the exchange path, and
  the limiter.
- Key plaintext and Stripe secrets are write-only: never returned by any API after
  reveal, never logged. The bot token never transits the platform (Vault -> bot env).
- Tests to name in reviews: scope-cap enforcement at key creation; revoked-key 401
  within TTL; 429 + Retry-After at the boundary; webhook signature reject + replayed
  event.id no-op; appeal-ticket cross-tenant isolation; echo-guard (a relayed Discord
  message never re-publishes); internal-note never appears in stream payloads.

## Deferred

Carried past Phase 5 (still open, unchanged): identity storefront player-stats
endpoint; apex custom domains (CNAME-on-dynamic-IP); Cloudflare WAF on custom-domain
hosts; object store for uploads; production base domain; second cupboard-web
Deployment split.

Phase 6 consciously postpones:
- **Usage metering** beyond rate limiting (ARCHITECTURE §7 mentions it; needs a
  counting pipeline, not a limiter) and per-key quotas/limits (per-org only in v1).
- **GraphQL** (deferred in ARCHITECTURE §3 stack table).
- **Ticket attachments/uploads** - no object store exists (Phase 5 deferral); v1
  tickets are text-only, Discord-side attachments relay as URLs.
- **Service fulfillment tooling** (purchase -> task/status tracking for the humans
  doing the work) - purchases are self-serve in v1 (Resolved with Frank #2) but
  fulfillment is tracked outside the product. Catalog expansion is deferred with it:
  **migration assistance** first (cut from v1 per Frank, "skip it, we will do it
  later"), then anything beyond `custom_design`; each addition is config-plus-code.
- **Discord-side ban actioning** from appeal threads (web ticket view only, decision C)
  and Discord notification breadth (DM-on-status-change etc.).
- **Sliding-window limiter** (fixed window v1, decision N) and rate-limit headers on
  non-v1 routes.
- **Transactional outbox for ticket sync** (best-effort publish v1, decision G).
- **API-key IP allowlists, resource-scoped keys** (per-server scoping), and key
  auto-rotation.
- **Public (internet) exposure of `/api/v1` + the OpenAPI docs** - staging inherits
  the gateway's traefik-internal (VPN-only) IngressRoute (decision P); exposing the
  public API to actual internet integrations is a deliberate Phase 7 cutover item
  (new external IngressRoute or path-scoped route on an existing public host, with
  the WAF/DDoS posture decided alongside).
- **Stripe Tax/VAT configuration + production Stripe products/prices** - every
  price ID in this plan is a TEST-mode object; creating the production products and
  prices (and Tax posture) happens alongside the production Stripe account at the
  Phase 7 cutover.
- **mTLS replacing `INTERNAL_API_TOKEN`** - already on the Phase 7 backlog; Phase 6
  widens the internal surface (auth server-side, bot client) under the same token
  model knowingly.
- **Message-content intent verification** (>100 guilds) - pre-launch task.
