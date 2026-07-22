# Phase 6 closeout: Support + billing + public API

Status as of 2026-07-21: **CLOSED. Phase 6 is live on use1 staging and all three DoD
criteria are verified against the running deployment** (see "Live verification" below).
All 6 logical PRs shipped via PR #9 (merge commit `8f3b891`), each followed by an
adversarial code review whose findings were fixed and regression-tested before the
commit. This document is the record of what shipped, the live verification evidence,
the degradation matrix, the security model, and the deferred work.

Commit trail on `phase6`: `5268cc0` plan, `0246615` PR1 (API keys), `5c966b3` + `8e9c45f`
PR2 (billing: subscriptions then one-off services), `cb2e311` PR3 (web tickets), `4f60655`
PR4 (bot foundation), `23266b0` PR5 (two-way sync), `cc7b0ae` PR6 (public API breadth).
Companion manifests shipped via the v-deployments PR #29 (gateway/tenant/auth secret
wiring, Stripe price IDs, the `cupboard-bot` overlay + Application CR), merged together
with the Phase 6 images.

## Live verification (2026-07-21, use1 staging)

Go-live executed per the runbook below: `plan_write_token` + `bot_api_token` patched into
`kv/cupboard/staging/internal` (version 2, `api_token` preserved), the `cupboard-bot`
Application CR applied manually (Synced/Healthy, ExternalSecrets SecretSynced, pod
Running), and auth/tenant/gateway rollout-restarted to pick up the completed secrets
(their pods had started before the token patch, so envFrom was stale; the images were
already the Phase 6 merge digests).

- **DoD #1 VERIFIED**: `/cupboard setup` bound the test guild (bot log `guild bound`,
  guild `1521507229176434688`, tickets channel recorded), and a Discord reply relayed
  into a web ticket (`discord message relayed`, ticket `019f86c4-...`,
  `author_kind=player`, `deduped:false`), completing the two-way loop against live
  Discord.
- **DoD #2 VERIFIED**: a test-mode subscription checkout created the org-stamped
  subscription; a live plan change (Team to Enterprise via the Stripe API) fired
  `customer.subscription.updated` through `/webhooks/stripe` (tenant log
  `stripe webhook processed` then `plan mirror pushed ... plan=enterprise
  status=active`), and the gating tier flipped live (see DoD #3 headers). One noted gap:
  the ADDITIVE one-off `custom_design` purchase click-through was NOT run live (no
  payment-mode Checkout session exists in the test account); that path remains
  stub-verified only (`service_checkout_and_purchase_lifecycle`,
  `purchases_backstop_lands_sessions_the_webhook_missed`) and is a 2-minute browser
  click whenever wanted. The DoD criterion itself (subscribe + gating reflects it) is
  fully met.
- **DoD #3 VERIFIED**: a real dashboard-minted API key called `GET /api/v1/bans` through
  the live gateway: 200 with the enveloped JSON and `X-RateLimit-Limit: 1000` /
  `X-RateLimit-Remaining: 999`, proving the exchange mint, the plan claim (Enterprise
  tier), and the limiter chain end to end. Credential planes spot-checked live: the
  bot-token route answers 401 without the token; a garbage `cb_` key gets the enveloped
  401 via a real exchange round-trip; `/api/v1/openapi.json` serves all six paths. The
  429 boundary and fail-open behavior remain covered by the automated gateway suite
  (`free_tier_limit_enforced_exactly_at_the_boundary`,
  `limiter_fails_open_when_redis_is_unreachable`).

Post-verification note: the API key used for the DoD #3 check transited a chat transcript
and should be revoked and re-minted.

Verification baseline (final workspace gate, on CI-parity containers): 302 Rust tests
green, clippy + fmt clean; bot 103 vitest green; web `tsc` + `build` clean. Phase 6 adds
**zero new public ingress hosts** (Stripe webhooks ride the existing `cupboard-hooks`
`PathPrefix(/webhooks/)`; the bot is outbound-only) and **zero new Rust services** (tickets
and billing land in the tenant service, API keys and the plan mirror in auth, the facade
and limiter in the gateway).

## Definition of Done

| # | Criterion | Code status | Backed in-process by | What the LIVE run still needs |
|---|-----------|-------------|----------------------|-------------------------------|
| 1 | Ticket on both surfaces (web AND Discord), two-way sync, private thread per ticket | Complete (PR3, PR4, PR5) | 13 tenant ticket e2e tests + 103 bot vitest tests, including loop-prevention and at-least-once delivery (see below) | A staging run against a real Discord test guild (thread creation, relay both ways, `/ticket open`, `/cupboard setup` bind) |
| 2 | Paid plan via Stripe; gating + rate-limit tiers reflect it | Complete (PR2) | 18 billing e2e webhook/reconcile tests + the plan-claim/limit tests in the auth and gateway suites, all against Stripe API stubs | A live test-mode Checkout click-through (subscription and a one-off service purchase) firing real webhooks into `/webhooks/stripe` |
| 3 | Per-tenant scoped, rate-limited API key against `/api/v1/*` | Complete (PR1, PR6) | Fully verified in-process: exchange mint, limiter boundary, scope gating, the typed facade, and PII nulling (gateway `api_v1` suite + auth `api_keys` suite) | A staging `curl` from inside the VPN against the gateway's traefik-internal `/api/v1` |

Evidence for DoD #1 (both surfaces, loop prevention, at-least-once): the 13 tests in
`services/tenant/tests/tickets_e2e.rs` cover origin-based echo-guard
(`discord_messages_dedupe_reopen_and_stay_off_the_stream`,
`stream_publishes_created_and_message_but_never_discord_origin`), the internal-note
boundary (`internal_notes_never_reach_players_or_the_stream`), lazy thread creation with
backfill (`discord_open_backfill_thread_and_guild_isolation`), and the one-time-code guild
bind (`bind_code_lifecycle_and_credential_planes`). On the bot side, the 103 vitest cases
include the at-least-once fence ordering (`relay.test.ts`: "posts to Discord FIRST, then
sets the fence", "a fence hit skips the post AND the re-mark"), the self-message loop guard
(`message-listener.test.ts`: "ignores the bot's own messages", "ignores messages outside
threads"), and the pending-not-ack redelivery semantics (`consumer.test.ts`: "leaves the
entry PENDING (no ack) when RelayError retries exhaust"). None of this has run against live
Discord yet.

Evidence for DoD #2: `services/tenant/tests/billing_e2e.rs` proves signature verification
and replay dedupe (`webhook_rejects_bad_signature_stale_timestamp_and_dedupes_replays`),
the subscription upsert + plan mirror push (`checkout_flow_upserts_subscription_and_pushes_mirror`),
tier gating (`domain_cap_follows_the_plan_claim`), and the reconcile backstop
(`reconcile_sweeps_lost_cancellation_only_after_a_complete_walk`,
`purchases_backstop_lands_sessions_the_webhook_missed`). Live test-mode checkout is pending.

Evidence for DoD #3: `services/gateway/src/api_v1/tests.rs` proves the exchange principal
(`cached_jwt_is_reused_and_bans_reshape_through_the_facade`), the limiter boundary
(`free_tier_limit_enforced_exactly_at_the_boundary`), scope gating
(`missing_scope_is_403_in_the_envelope`, `every_endpoint_gates_its_scope_with_the_403_envelope`),
and negative caching (`auth_rejections_are_negative_cached_by_token_hash`);
`services/auth/tests/api_keys.rs` proves scope capping and lifecycle
(`creation_caps_scopes_to_the_creators_permissions`, `exchange_refuses_when_the_creators_membership_is_gone`,
`demotion_shrinks_the_minted_permissions_to_the_intersection`). Staging `curl` is pending.

## Go-live runbook (ordered)

OpenBao addr `https://openbao.vngenterprise.com`, mount `kv`. Existing paths use `bao kv
patch` (never `put`, which drops sibling keys); a brand-new path uses `put`. The `stripe`
and `bot` paths were already populated 2026-07-14 (test keys, webhook signing secret, bot
token); this runbook adds only the two scoped internal tokens plus the bot-token rotation.

1. **[FRANK, browser OIDC approval]** Patch the two scoped internal tokens into the existing
   internal path (both are long random strings):
   `bao kv patch -mount=kv cupboard/staging/internal plan_write_token=<random> bot_api_token=<random>`.
   `plan_write_token` guards tenant -> auth `PUT /internal/orgs/{id}/plan`; `bot_api_token`
   guards the bot -> tenant `/internal/tickets/*` surface (decisions E and K: neither may
   ride the widely-shared `INTERNAL_API_TOKEN`).
2. **[FRANK]** Rotate the Discord bot token (it transited chat during setup and must be
   considered burned): regenerate it on the Discord application, then
   `bao kv patch -mount=kv cupboard/staging/bot discord_token=<new>`.
3. **[FRANK]** Merge both PRs: v-deployments `phase6` -> main (PR #29) and Cupboard `phase6`
   -> main (PR #9). The images and the manifests ship together.
4. CI builds the full matrix, including the new Node `build-push-bot` job (context
   `apps/bot`, 3-stage `node:22-slim`, uid 10001). No new Rust service, so the Rust matrix
   is unchanged.
5. **[FRANK, device-code login]** Apply the new Application CR one time by hand:
   `kubectl apply -f argocd/applications/use1/cupboard-bot.yaml`. The app-of-apps
   syncPolicy does not adopt new Application CRs (the Phase 5 `cupboard-tenant` precedent;
   the closeout runbook is authoritative over the YAML's mere presence).
6. Verify the ExternalSecrets sync for the new/changed keys: `cupboard-bot` gets
   `DISCORD_BOT_TOKEN` + `BOT_API_TOKEN` + `REDIS_URL`; tenant gains `STRIPE_SECRET_KEY`,
   `STRIPE_WEBHOOK_SECRET`, `PLAN_WRITE_TOKEN`, `BOT_API_TOKEN`; auth gains
   `PLAN_WRITE_TOKEN`; gateway gains `REDIS_URL` + `INTERNAL_API_TOKEN`. Confirm each
   ExternalSecret reports `SecretSynced`.
7. **Stripe dashboard**: the webhook endpoint
   `https://cupboard-hooks.vngenterprise.com/webhooks/stripe` is registered per the plan
   (verify it is present and enabled for the consumed event types); the Customer Portal was
   configured in the test-mode dashboard 2026-07-14 (verify).
8. **Staging DoD verification** (the three click-throughs/curls):
   - **[FRANK, browser + Discord]** DoD #1: open a ticket from the storefront, confirm it
     appears in the Discord test guild thread; reply from Discord, confirm it lands on the
     web thread; run `/ticket open` and `/cupboard setup <code>` in the guild.
   - **[FRANK, browser]** DoD #2: subscribe to Team via Checkout, confirm the plan card and
     tier limits flip; buy the Custom Design one-off, confirm the `billing_purchases` row
     and the history table.
   - DoD #3: from inside the VPN, `curl -H "Authorization: Bearer cb_..." .../api/v1/bans`
     and confirm the enveloped JSON + `X-RateLimit-*` headers, then confirm the 429 at the
     free-tier boundary.
9. **Degradation spot-checks live** (the highest-value cells, worth running against the
   deployment): bot down during web ticket writes (writes stay green, backlog replays on
   reconnect); Redis down and a `/api/v1` call (limiter fails open, metric + log); a Stripe
   webhook replay (dedupes to a no-op on `event.id`); kill the bot mid-relay and watch the
   pending stream entry redeliver (harmless duplicate text at worst, never a drop).

## Degradation matrix (verified)

Invariants (proven by construction + tests): **no Discord failure ever breaks web tickets**
(Discord I/O lives only in the bot; the tenant service never calls Discord), and **no
Stripe failure ever degrades an already-subscribed tenant** (gating reads the local
`org_plans` mirror, never Stripe). Each cell below is annotated with HOW it is backed:
a named automated test, a design property, or a pending-live spot-check.

| Capability | Bot down | Discord API down | Stripe down | Stripe webhooks failing | Redis down | Auth exchange down |
|---|---|---|---|---|---|---|
| Web tickets (open/reply/notes) | **ok** | ok | ok | ok | ok minus sync | ok |
| Discord ticket sync | lags, replays | retries w/ backoff | ok | ok | lags | ok |
| Subscribe / manage plan / buy service | ok | ok | fail fast, retry | reconcile converges <= 15 min | ok | ok |
| Plan gating / claims | ok | ok | ok | stale <= 15 min + TTL | ok | ok |
| `/api/v1/*` calls | ok | ok | ok | ok | **limiter fails OPEN** | cached keys ok <= 5 min; new keys 503 |
| Admin dashboard / storefronts | ok | ok | ok | ok | ok | ok |

How each non-trivial cell is backed:

- **Web tickets, bot down / Redis down**: design property (decision G) plus test. Stream
  publish is fire-and-forget post-commit (`publish_capped`), so the ticket row is already
  committed before the publish is attempted; a publish failure is logged and the write
  stands. Backed by `tickets_e2e::stream_publishes_created_and_message_but_never_discord_origin`
  (write commits and the event is only best-effort published). Bot-down replay is a design
  property of the `bot` consumer group (undelivered entries retained). Live spot-check
  listed in runbook step 9.
- **Web tickets, Discord API down / Stripe / auth exchange**: design property. The tenant
  service holds no Discord, Stripe, or exchange dependency on the ticket write path;
  operator/player JWTs, not the exchange, authenticate ticket routes.
- **Discord ticket sync, bot down**: `consumer.test.ts` "leaves the entry PENDING (no ack)
  when RelayError retries exhaust", "sweeps periodically, not just at boot", and "walks the
  full cursor even across empty pages, and processes claimed entries" (backlog replays on
  reconnect via the consumer group and the reclaim sweep).
- **Discord ticket sync, Discord API down**: `consumer.test.ts` "a transient failure then
  success acks exactly once" plus `relay.test.ts` retryable-RelayError cases ("throws a
  retryable RelayError when the client is not ready"): the bot acks only on success.
- **Subscribe/plan/service, Stripe down**: design property. Checkout and Portal are
  hosted-redirect handoffs that fail fast; existing gating reads the local mirror + ledger,
  never Stripe on the read path. Live spot-check optional.
- **Subscribe/plan/service, webhooks failing**: `billing_e2e::reconcile_sweeps_lost_cancellation_only_after_a_complete_walk`
  (subscriptions), `billing_e2e::purchases_backstop_lands_sessions_the_webhook_missed`
  (one-off purchases). The 15-min reconcile is the backstop for both; refunds are
  deliberately webhook-only (decision H).
- **Plan gating / claims, webhooks failing**: design property + test. Gating reads the
  local `org_plans` mirror; staleness is bounded by the access-token TTL and healed by the
  reconcile re-push. Backed by `api_keys::plan_claim_is_minted_from_the_mirror_at_every_mint_site`
  and the `past_due` grace tests (`invoice_payment_failed_marks_past_due_but_keeps_paid_gating_in_grace`,
  `past_due_since_survives_repeats_and_clears_on_recovery`).
- **`/api/v1/*`, Redis down**: `api_v1::tests::limiter_fails_open_when_redis_is_unreachable`
  (availability over billing fairness, with a counter metric + log).
- **`/api/v1/*`, auth exchange down**: `api_v1::tests::exchange_failures_are_503_and_never_negative_cached`
  (only a 401 verdict is negative-cached; transport failures and 5xx surface as 503) and
  `cached_jwt_is_reused_and_bans_reshape_through_the_facade` (already-cached keys keep
  working until exp minus 30s).
- **Admin dashboard / storefronts, all columns**: design property. None of Phase 6's new
  dependencies sit on the SSR resolve path; the site cache was already optional (Phase 5).

## Security / token model

**Four principals.** The platform now authenticates four distinct actor kinds: (1)
**operator** users (Ed25519 operator JWT, minted by auth), (2) **players** (separate player
JWT keypair, disjoint from the operator keypair, mutually rejected at the signature layer),
(3) **game-server agents** (ingest tokens, unkeyed-sha256, pre-Phase-6), and (4) the new
**API key** integration principal introduced this phase (`cb_...`, exchanged for a
short-lived operator JWT, decision M). The Ed25519 private key stays ONLY in auth, so the
"gateway compromise cannot forge" invariant survives Phase 6 intact.

**Credential planes (internal service-to-service).** Four deliberately distinct planes,
each scoped to blast-radius:

- `INTERNAL_API_TOKEN` (shared): the broad `/internal/*` surface (auth, tenant, fleet,
  identity, collector, and now gateway for the exchange call). Fails closed.
- `PLAN_WRITE_TOKEN` (tenant -> auth only): guards `PUT /internal/orgs/{id}/plan`. A plan
  write is a privilege-escalation primitive and must not ride the shared token (decision K).
- `BOT_API_TOKEN` (bot -> tenant only): the tenant service accepts it ONLY on
  `/internal/tickets/*`; every other `/internal/*` route keeps the shared token. The bot is
  the largest new attack surface (an internet-connected Node process parsing untrusted
  Discord content), so it never holds the shared token (decision E).
- **API keys + exchange** (integration -> gateway -> auth): `cb_` + 256-bit token, stored
  as `hash_token(token, token_pepper)` (keyed HMAC-SHA256, reusing auth's existing pepper).
  The gateway's `require_api_key` exchanges the token at auth's `POST
  /internal/api-keys/exchange`, which does the hash lookup, revocation/expiry check, and a
  membership-lifecycle re-cap (a removed creator kills their keys; a demotion shrinks them),
  then mints a 5-minute operator JWT. Scopes are `Permission` strings, capped at creation to
  the creator's own resolved permissions and re-capped at every exchange.

Credential-plane separation is proven by `tickets_e2e::bind_code_lifecycle_and_credential_planes`
(bot token accepted on `/internal/tickets/*`, rejected elsewhere; shared token rejected on
the bot routes) and `api_keys::plan_write_is_guarded_validated_and_upserts`.

**Advisory-lock seed registry.** Per-tenant serialization uses
`pg_advisory_xact_lock(hashtextextended($tenant, seed))` with a documented seed registry so
two concurrent operations on the same tenant never collide across features:

| Seed | Purpose | Location |
|------|---------|----------|
| 0 | custom-domain add (cap enforcement) | `services/tenant/src/domain/domains.rs` |
| 1 | API-key creation (per-org key cap) | `services/auth/src/domain/api_keys.rs` (auth schema) |
| 2 | billing checkout (subscription/service) | `services/tenant/src/http/billing.rs` |
| 3 | ticket bind-code mint (single live code) | `services/tenant/src/domain/tickets.rs` |

**PII scope boundary (PR6 decision).** The v1 facade treats PII by two different rules,
deliberately. The `players` surface is **gated**: IPs and raw identifier values are nulled
unless the key carries `players.view_pii` (verified by
`api_v1::tests::player_list_ip_is_nulled_without_view_pii` and
`player_profile_pii_is_gated_at_the_facade`). The `bans.*` and `store.manage` surfaces are
**documented as PII-bearing, not nulled**: bans expose banned players' raw identifiers and
the steam_id-to-player_id linkage, and entitlements expose steam_id values; this is stated
on the OpenAPI tags so key issuers scope accordingly, rather than silently stripped
(verified by `openapi_documents_the_pii_boundary_and_optional_revoke_body`). The distinction
is intentional: a bans/entitlements consumer needs the identifier to do its job, whereas a
generic player list does not.

## Deferred

Carried past Phase 5 (still open, unchanged): identity storefront player-stats endpoint;
apex custom domains (CNAME-on-dynamic-IP); Cloudflare WAF on custom-domain hosts; object
store for uploads; production base domain; second cupboard-web Deployment split.

Deferred at Phase 6 (from the plan): usage metering beyond rate limiting and per-key
quotas; GraphQL; ticket attachments/uploads (text-only v1, Discord attachments relay as
URLs); service-fulfillment tooling and catalog expansion beyond `custom_design` (migration
assistance first, cut from v1 per Frank); Discord-side ban actioning from appeal threads
and Discord notification breadth; a sliding-window limiter (fixed-window v1) and
rate-limit headers on non-v1 routes; a transactional outbox for ticket sync (best-effort
publish v1); API-key IP allowlists, resource-scoped keys, and key auto-rotation; **public
(internet) exposure of `/api/v1` + the OpenAPI docs** (staging inherits the gateway's
traefik-internal VPN-only IngressRoute, so DoD #3 is verified from inside the VPN; internet
exposure is a Phase 7 cutover with the WAF/DDoS posture decided alongside); Stripe Tax/VAT
+ production Stripe products/prices (every price ID this phase is a TEST-mode object); mTLS
replacing `INTERNAL_API_TOKEN`; message-content-intent verification (>100 guilds).

Added during implementation (carry to Phase 7):

- **Per-IP / global exchange rate cap** before Phase 7 public `/api/v1` exposure. The
  negative cache defuses REPEATS of one garbage token but not a stream of UNIQUE garbage
  keys, each of which forces an uncached auth round trip; behind the VPN this is contained,
  but a public boundary needs a cap in front of the exchange (noted in
  `services/gateway/src/api_v1/key_auth.rs`).
- **`XGROUP DELCONSUMER` hygiene** for dead bot consumer names, so per-boot consumer names
  do not accumulate on the `cupboard:tickets` stream over time.
- **Per-user `/ticket open` cooldown** to blunt ticket-spam from a single Discord user.
- **Reclaim-path single-attempt optimization** for long bot outages (the current sweep
  reclaims and reprocesses; a single-attempt fast path would cut redundant work on a large
  backlog).
- **Production Stripe prices** for the checkout price sanity check: a mismatch check runs at
  checkout today (done, `billing_e2e::service_price_mismatch_refuses_checkout_and_match_is_cached`,
  `unknown_price_id_preserves_prior_plan_and_floors_without_knowledge`), but the configured
  prices are TEST-mode and the production values are a Phase 7 cutover item.
- **RustLens bot ESM/pino OTel loader-hook flaw** (upstream note, different repo): the same
  import-in-the-middle registration gap fixed here in `apps/bot/src/register-hook.ts` exists
  in the RustLens bot and should be fixed there too.

## Phase 5 leftovers still open

Two Phase 5 go-live items remain unfinished and are unaffected by Phase 6:

1. **`CERT_ISSUER` staging-to-prod flip**: the custom-domain issuer is still on
   `letsencrypt-http01-staging`; flipping to `letsencrypt-http01` (and re-issuing a trusted
   cert) after a clean staging dry run remains open (Phase 5 runbook step 8).
2. **Phase 5 DoD #4 browser click-through**: a live Steam login + test-mode purchase firing
   a real webhook into an entitlement row was never run end to end in a browser.

## Notable engineering decisions log

- **Exchange 403-vs-401 negative-cache protection**: only a 401 (auth looked the key up and
  rejected it) is negative-cached by token hash for ~60s; a 403 means auth rejected the
  gateway's own credential, and transport failures / 5xx are NEVER cached, so a downstream
  outage cannot poison valid keys. `services/gateway/src/api_v1/key_auth.rs`.
- **Reconcile winner-selection + sweep guards**: the reconcile walk lists subscriptions with
  `status=all` (Stripe's default excludes canceled, which would strand a lost
  `subscription.deleted`), sweeps local active rows absent from a COMPLETE walk only, refuses
  to sweep on an empty walk, and never lets a stale cancellation clobber a live
  resubscription. `services/tenant/src/domain/billing.rs`.
- **`past_due_since` grace anchor**: the 7-day paid-gating grace is anchored on the moment of
  transition into `past_due` (set once via COALESCE, cleared on recovery), not on
  `current_period_end`, so repeated `invoice.payment_failed` events do not extend the grace.
  `services/tenant/src/domain/billing.rs`.
- **ESM loader hook**: the bot is pure ESM, so pino and the OTel instrumentations only wrap
  when import-in-the-middle is registered via `node --import ./dist/register-hook.js`;
  without it the logger never gets its trace mixin. `apps/bot/src/register-hook.ts`.
- **Decision-F post-then-fence with pending-not-ack semantics**: the bot posts to Discord
  FIRST, then sets the fence `SET bot:relayed:{id} NX EX 86400`, then XACKs; a crash between
  post and fence duplicates harmless text on redelivery, whereas fence-before-post would
  silently DROP messages. A `RelayError` leaves the entry PENDING (unacked) so the consumer
  group redelivers. `apps/bot/src/relay.ts` + `consumer.ts`.
- **Facade PII boundary**: `players` IPs and raw identifiers are nulled without
  `players.view_pii`; `bans.*` and `store.manage` are documented as PII-bearing on the
  OpenAPI tags rather than stripped, because their consumers need the identifier.
  `services/gateway/src/api_v1/`.
</content>
</invoke>
