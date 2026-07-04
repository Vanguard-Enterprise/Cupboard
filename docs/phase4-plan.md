# Cupboard Phase 4 - Implementation Plan (BattleMetrics import + two-way sync)

> Turns ROADMAP Phase 4 ("BattleMetrics migration", size L) + ARCHITECTURE
> "BattleMetrics import & sync" (decisions #20-22) into a sequenced, de-risked build.
> Follows the shape that worked for Phases 2 and 3.
> **Status (2026-07-04):** PR1-PR5 built, high-effort-reviewed, and pushed (draft PR #7).
> Each PR's review findings were fixed in dedicated commits (9 + 10 + 16 + PR5's pending).
> Remaining: PR6 (staging deploy: OpenBao `cupboard/staging/identity -> master_key`,
> `IDENTITY_MASTER_KEY` + `FLEET_INTERNAL_URL` envs; real-org import; degradation
> matrix) — gated on the Frank-side BM org bootstrap. Notable deltas from plan: flags
> import deferred to PR6 empirical validation (BM flags API unconfirmed); imports run
> in bounded slices so outbound pushes interleave; outbound enable implies sync
> enabled.

## Definition of Done (from ROADMAP)

Three escalating proofs, all against a real BM org:

1. **Import**: a tenant connects their BM token and their bans, players + identifiers,
   notes, and servers appear in Cupboard (maximal within the token's access, incl.
   subscribed shared ban lists; subset-selectable).
2. **Stays in sync, inbound**: a ban created/edited/deleted in BM shows up in Cupboard
   (create within ~a minute via the tail poll; edit/delete within the re-scan window).
3. **Stays in sync, outbound**: a ban created/revoked in Cupboard appears in / vanishes
   from the BM org, without echoing back as a phantom inbound change.

The #1 ROADMAP risk is the **no-`updatedAt` problem**: BM bans expose no last-modified
field, no changed-since filter, and no ban webhooks, so inbound sync has to be invented
as tail-poll + full re-scan with content-hash diffing. PR2 lands that machinery right
after the thinnest slice, before any breadth.

## Resolved decisions (2026-07-03)

| # | Decision |
|---|----------|
| A | **BM client is a new crate `crates/bmapi`** (precedent: `gameconn`). Hand-rolled minimal JSON:API serde (`Document<T>`/`Resource` + typed attribute structs, lenient `#[serde(default)]` relationships); injectable base URL so tests run against a stub. No third-party jsonapi crate. |
| B | **Client-side rate limiter**: dual fixed-window 8 req/s + 240 req/min per connection (headroom under BM's 45/s + 300/min; the per-second bucket is invisible in BM's headers). Honor `429` + `Retry-After` when present, else exponential backoff 1s to 60s with jitter. GETs retry up to 5x; mutations retry only on 429/pre-send failures, an ambiguous timeout marks the op `needs_verify` (existence check before re-issue; BM has no idempotency keys). |
| C | **One BM runner task per tenant connection** owns import execution, both sync loops, and outbox drain. Claimed atomically via `claimed_by`/`heartbeat_at` on `bm_connections` (30s heartbeat, 2 min stale takeover); supervisor reconcile loop in identity `main.rs` (collector pattern, 15s tick). One runner per token makes the process-local limiter globally correct; sync pauses while an import runs. |
| D | **Sidecar mapping, no new columns on `bans`**: `bm_sync_map` (tenant, entity_type, external_id, local_id, content_hash, meta jsonb, timestamps) covers ban/player/note/flag/ban_list/server uniformly, including fleet-owned servers. This satisfies ARCHITECTURE's origin + external_id + hash requirement with zero churn on hot tables. |
| E | **Token at rest**: envelope-encrypted (`crates/crypto::envelope`) in `bm_connections.token_enc/token_dek`; identity gains `IDENTITY_MASTER_KEY` (new OpenBao key `cupboard/staging/identity -> master_key`). `decode_master_key` moves from fleet into `crates/crypto` so both services share it. The token is write-only: no API ever returns it. |
| F | **Lose nothing on subjects**: `bans.subject_type` CHECK extends to `steam, eac, eos, beguid, ip, name`. A BM ban imports as one Cupboard ban on its primary identifier (precedence steam > eos > beguid > ip > name); the full BM identifier array + banList + orgWide live in `bm_sync_map.meta`. Per-identifier ban expansion is a flagged follow-up, not Phase 4. |
| G | **Import phases: servers -> ban_lists -> bans (per list) -> players+identifiers -> notes+flags.** Resumability unit is one page (<= 100 records) processed in a single owner-pool tx (upserts + map rows + cursor + counts): a crash loses at most one page. Cursor JSON `{phase, sub_id, next_url}` stores BM's `links.next` verbatim. |
| H | **Inbound sync = hash diff, not timestamps**: tail poll every 60s (`sort=-timestamp`, walk until an already-mapped uid with equal hash) catches new bans; full re-scan every 15 min (the import iterator re-run) catches edits (hash differs -> apply) and deletes (mapped-active but absent -> local revoke). Cadences live in `bm_connections.settings`. |
| I | **LWW concretized**: Cupboard bans are create/revoke-only, so the only real conflict is local-revoke-pending vs BM-edit-observed: the local revoke wins (most recent explicit operator action; its DELETE is already in the outbox) and a `bm_sync_conflicts` row records it (`local_won`). BM edits to untouched imported bans apply silently. |
| J | **Outbound = transactional outbox**: `bm_outbox` row written in the same tx as `bans::create`/`revoke` when outbound sync is on; the runner drains it. Create -> `POST /bans` on the tenant-chosen writable target list (scope network -> orgWide true; server -> BM server relationship via map). Revoke -> `DELETE /bans/{uid}`, falling back to `PATCH expires=now` if `ban:delete` is missing (probed once). v1 pushes steam-subject bans only. |
| K | **Echo guard = canonical content hash**: sha256 over canonical JSON of (reason, expires, sorted identifiers, note), one unit-tested fn in `bmapi`. Outbound writes store the response's hash in `bm_sync_map.content_hash`; inbound scans skip records whose hash matches. One mechanism serves as echo guard, no-op skip, and edit detector. |
| L | **Fleet touch = internal endpoint**: fleet migration 0004 adds `origin` + `external_id` (partial unique per tenant) to `servers`; new `POST /internal/servers/import` (existing `X-Internal-Token` pattern) upserts by external_id and returns the server uuid for mapping. Imported servers land `enabled=false`; the tenant fills RCON creds in the existing servers UI. |
| M | **New permission `integrations.manage`** (Owner + Admin templates), mirrored in `apps/web/src/lib/permissions.ts`; gates every `/integrations/*` endpoint including conflict resolution. |
| N | **Shared ban lists stay thin**: subscribed lists import as ordinary `bans` rows tagged via `bm_sync_map.meta` plus a `bm_ban_lists` row (`subscribed`, `perm_*` flags, `import_enabled` for subsetting). The Phase 2 `sharing_pools` stubs are untouched; `bm_ban_lists` is the documented seam for materializing a BM list as a Cupboard pool later. |
| O | **Backfill-push of existing Cupboard bans when enabling sync: opt-in wizard checkbox, default OFF.** Opt-in enqueues outbox rows for active non-bm-origin bans; the wizard validates the target list's `permCreate` first. |
| P | **Web surface `/integrations/battlemetrics`**; gateway adds one JWT-gated route `/integrations/{*path}` -> identity. Wizard is a staged client component + Server Actions (`useActionState` `{error}/{ok}` convention); progress polls every 3s. |

## Thinnest end-to-end slice (PR1: "first BM ban imported")

```
web: paste BM token + org id -> POST /integrations/bm/connection
  (seal token under IDENTITY_MASTER_KEY, probe GET /ban-lists -> status=connected)
-> "Run import" -> POST /integrations/bm/import
-> identity supervisor claims the connection -> runner paginates
   GET /bans?filter[banList]=...&page[size]=100 through the rate limiter
-> per page, one tx: upsert bans (origin='bm') + bm_sync_map rows + cursor + counts
-> web: bans page shows BM bans; progress endpoint shows live counts
```

Deliberately excluded from slice #1: players/notes/servers phases, both sync loops, the
real wizard UI, subset selection. Everything later widens this pipe or re-runs its
iterator on a schedule.

## Service boundaries (delta from Phase 3)

| Service | Phase 4 delta |
|---------|---------------|
| **identity** | Owns everything BM: connection + token (envelope), import jobs + runner/supervisor, sync loops, outbox, conflict log, notes/flags tables, `/integrations/*` API. |
| **fleet** | `servers.origin/external_id` + `POST /internal/servers/import` (upsert-by-external-id, `enabled=false`). |
| **gateway** | One new route group `/integrations/{*path}` -> identity (JWT-gated). |
| **web** | `/integrations/battlemetrics` wizard, sync status, conflict review; new permission mirror. |
| **auth, collector, metrics** | Unchanged. |

## Schema / migration order

- `identity/0009_bm_core.sql` - `bm_connections`, `bm_import_jobs`, `bm_sync_map`,
  `bm_ban_lists`; extend `bans.subject_type` CHECK. Completes DoD #1 storage.
- `identity/0010_bm_sync.sql` - `bm_sync_conflicts` (PR2), `bm_outbox` (PR3).
- `identity/0011_notes_flags.sql` - `player_notes`, `player_flags` (DDL per
  `docs/identity-schema.md` + `origin`). PR4.
- `fleet/0004_server_import.sql` - `origin`, `external_id`, partial unique
  `(tenant_id, external_id)`. PR4.

All tenant tables get RLS (embedded-migration convention; `tests/rls.rs`-style
isolation tests per table).

## PR sequence (each shippable to staging)

| PR | Title | Proves |
|----|-------|--------|
| **PR1** | First BM ban imported: `crates/bmapi`, identity 0009, `integrations.manage`, connection + import endpoints, supervisor + runner (ban_lists + bans phases), gateway route, minimal web page | ⭐ De-risks the whole BM integration (auth, pagination, rate limiter, identifier mapping). DoD #1 for bans. |
| **PR2** | Inbound ban sync: tail poll + full re-scan, hash edit/delete detection, conflict log, status endpoint + card, sync toggle | ⭐ DoD #2; the no-updatedAt machinery. |
| **PR3** | Outbound bans: transactional outbox, drainer (POST/DELETE, needs_verify), echo guard round-trip, opt-in backfill (default off) | DoD #3. |
| **PR4** | Import breadth: servers via fleet internal upsert, players + identifiers via `resolve_or_create_player`, notes/flags tables + phase, subset selection, pause/resume/cancel, stale-claim takeover | DoD #1 in full ("lose nothing"). |
| **PR5** | Web UX: 4-step wizard, sync status page, conflict review page | Operator-grade migration wedge. |
| **PR6** | Staging + closeout: OpenBao/ExternalSecret/env wiring, real-org import, live sync verification both directions, degradation matrix recorded | DoD verified end to end. |

No CI build-matrix change (no new service); identity's Cargo.toml gains
`cupboard-bmapi` (which carries the workspace `reqwest`).

## Deploy / OpenBao additions (in `v-deployments`, mirroring Phase 3)

- New OpenBao KV key `cupboard/staging/identity -> master_key` (32-byte base64;
  envelope master key for BM tokens); ExternalSecret + `IDENTITY_MASTER_KEY` env on the
  identity Deployment.
- Identity also needs `FLEET_INTERNAL_URL` + the existing internal token env to call
  fleet's `/internal/servers/import` (PR4).
- Recurring gotchas: `use1` app-of-apps is `syncPolicy: None` (apply changed Application
  CRs manually); use the direct `cupboard-rw` service, not the pooler, where
  `search_path` matters.

## Degradation matrix (target behavior; verified + recorded in PR6)

| Capability | No connection | Token 401 | Rate-limited | BM down | Sync disabled |
|---|---|---|---|---|---|
| Local ban create/revoke/enforce | ok | ok | ok | ok (outbox absorbs) | ok |
| Import job | wizard prompts | fails fast, `status=error`, resumable after token replace | auto-throttles | backoff, then `failed` with cursor kept | ok (import is independent) |
| Inbound sync | off | paused + banner | cadence stretches | ticks skipped, `last_error` surfaced | off |
| Outbound push | off | still enqueues (`pending`); drains after reconnect | delayed | retries indefinitely (capped backoff), operator retry button for `failed` | not enqueued |

Invariant: **no BM failure mode ever blocks local moderation or enforcement**. BM I/O
happens only inside the runner, never on a request path.

## Cross-cutting (non-negotiable, as every phase)

- RLS on every new tenant table + isolation tests; audit rows for connection
  create/update, import start/finish, sync-applied changes, conflict resolutions;
  OTel spans on runner phases; the BM token is write-only and never logged.
- PII posture: imported identifier values land exactly like native ingest
  (value + HMAC `value_hash` via the existing pepper), so Phase 7 GDPR tooling
  covers them with no special cases.

## Remaining open questions (non-blocking; decide as we reach them)

- [LORE] BM identifier visibility for players unknown to the org: verify counts on the
  real org in PR6.
- RCON creds via BM API unconfirmed: planned absent (imported servers `enabled=false`).
- EAC/EOS identifier mapping for Rust outbound: v1 is steam-only.
- `GET /bans/export` as a bulk accelerator for the bans phase: optimization seam only.
- Frank-side prerequisite: bootstrap a real BM org (attach the test server, seed
  bans/notes, mint an unrestricted token) in parallel with PR1-PR3.
