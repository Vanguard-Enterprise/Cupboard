# Identity & Moderation — data schema

> The BM-replacement core (Phase 2). Implements Decisions 13–19: global Cupboard
> Player ID, automatic advisory links, identifier-level bans + evasion alerts, RLS
> isolation, and PII/enforcement-key separation. DDL is PostgreSQL (CNPG); illustrative,
> not final migrations.

## The central idea: two layers in one database

| Layer | Tables | Visibility | Writers |
|---|---|---|---|
| **Global identity** | `players`, `player_identifiers`, `identity_signals`, `player_links`, `name_history`, `merge_log` | **Shared across all tenants** (the cross-network graph — this is the moat) | System only (Collector + linking engine) |
| **Per-tenant** | `player_sessions`, `bans`, `ban_pool_shares`, `ban_evasion_alerts`, `player_notes`, `player_flags`, `manual_links`, `audit_log` | **Private to the tenant** (RLS), optionally shared via pools | Tenant staff + system |

Global tables carry **no `tenant_id`** and are readable by everyone — alt detection
benefits from every tenant's data (the user's explicit "more data wins" choice).
Per-tenant tables enforce `tenant_id` via **Row-Level Security**; the app sets
`SET LOCAL app.current_tenant = '<uuid>'` inside each request transaction, and
policies filter on it. System services connect with a role that bypasses RLS.

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid / digest
-- IDs: uuid (consider uuidv7 for index locality once on a PG version that has it).
```

---

## Global identity layer

### players — the canonical identity (the "Cupboard Player ID")

```sql
CREATE TABLE players (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- the Cupboard Player ID (opaque)
    display_id   bigint GENERATED ALWAYS AS IDENTITY,          -- short public id (BM-style)
    status       text NOT NULL DEFAULT 'active'                -- active | merged | erased
                 CHECK (status IN ('active','merged','erased')),
    merged_into  uuid REFERENCES players(id),                  -- set when this record was merged away
    first_seen_at timestamptz,
    last_seen_at  timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
```

A **player is not a Steam ID** — it owns identifiers. Two *alts* are two distinct
players connected by `player_links`; a *merge* collapses two records that are truly
the same account (`merged_into`).

### player_identifiers — unique identity keys (Steam / EAC / Discord)

```sql
CREATE TABLE player_identifiers (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id   uuid NOT NULL REFERENCES players(id),
    type        text NOT NULL CHECK (type IN ('steam','eac','discord')),
    value       text,            -- raw value (PII) — NULLed on erasure
    value_hash  bytea NOT NULL,  -- HMAC(value, pepper) — durable; survives erasure
    confidence  real NOT NULL DEFAULT 1.0,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now()
);
-- One owner per strong identifier (this is the dedup that makes the ID global):
CREATE UNIQUE INDEX ux_identifier_value ON player_identifiers (type, value_hash);
CREATE INDEX ix_identifier_player ON player_identifiers (player_id);
```

### identity_signals — shared/linking signals (IP, Steam owner / family-share)

These are **many-to-many** (an IP or a game-owner account is shared by many players),
so they live apart from the unique keys and *drive link detection*.

```sql
CREATE TABLE identity_signals (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id   uuid NOT NULL REFERENCES players(id),
    type        text NOT NULL CHECK (type IN ('ip','steam_owner')),
    value       text,            -- raw (PII for ip) — NULLed on erasure
    value_hash  bytea NOT NULL,  -- HMAC(value, pepper)
    sighting_count integer NOT NULL DEFAULT 1,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_signal_player_value ON identity_signals (player_id, type, value_hash);
CREATE INDEX ix_signal_value ON identity_signals (type, value_hash);  -- "who else shares this IP?"
```

### player_links — automatic, advisory alt-links

```sql
CREATE TABLE player_links (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    player_a      uuid NOT NULL REFERENCES players(id),  -- store with player_a < player_b
    player_b      uuid NOT NULL REFERENCES players(id),
    confidence    real NOT NULL,                          -- 0..1, weighted from signals
    signals       jsonb NOT NULL,                         -- {shared_ip:[...], shared_owner:true, ...}
    first_detected_at timestamptz NOT NULL DEFAULT now(),
    last_evaluated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (player_a < player_b)
);
CREATE UNIQUE INDEX ux_link_pair ON player_links (player_a, player_b);
CREATE INDEX ix_link_a ON player_links (player_a);
CREATE INDEX ix_link_b ON player_links (player_b);
```

Links are **advisory only** — since bans are identifier-level, a false-positive link
never auto-bans anyone; it only drives evasion alerts.

### name_history & merge_log

```sql
CREATE TABLE name_history (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id   uuid NOT NULL REFERENCES players(id),
    name        text,            -- PII-ish — NULLed/redacted on erasure
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (player_id, name)
);

CREATE TABLE merge_log (              -- audit + best-effort reversibility
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    from_player uuid NOT NULL,
    into_player uuid NOT NULL,
    performed_by uuid,               -- staff user (Auth), or null = system
    reason      text,
    snapshot    jsonb,               -- repointed rows, to support un-merge
    created_at  timestamptz NOT NULL DEFAULT now()
);
```

---

## Per-tenant layer (RLS)

Every table below has `tenant_id uuid NOT NULL` and an RLS policy
`USING (tenant_id = current_setting('app.current_tenant')::uuid)`. Shown once:

```sql
ALTER TABLE bans ENABLE ROW LEVEL SECURITY;
CREATE POLICY bans_tenant_isolation ON bans
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
-- (repeat per tenant table)
```

### player_sessions — a tenant's observation of a player on their server

```sql
CREATE TABLE player_sessions (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    server_id     uuid NOT NULL,        -- owned by Fleet
    player_id     uuid NOT NULL REFERENCES players(id),
    connected_at  timestamptz NOT NULL,
    disconnected_at timestamptz,
    ip            text,                 -- PII — NULLed on erasure/retention
    ip_hash       bytea,
    name          text,
    playtime_secs integer
);
CREATE INDEX ix_session_tenant_server_time ON player_sessions (tenant_id, server_id, connected_at DESC);
CREATE INDEX ix_session_player ON player_sessions (player_id);
```

Each session **feeds the global graph**: upsert the IP into `identity_signals`, the
name into `name_history`, refresh `players.last_seen_at`.

### bans — identifier-level, with the durable enforcement key

```sql
CREATE TABLE bans (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    subject_type  text NOT NULL CHECK (subject_type IN ('steam','eac')),
    subject_value text,                 -- PII — NULLed on erasure
    subject_hash  bytea NOT NULL,       -- HMAC(value, pepper) — THE enforcement key, survives erasure
    player_id     uuid REFERENCES players(id),  -- context only; NULLed on erasure
    scope         text NOT NULL DEFAULT 'network' CHECK (scope IN ('network','server')),
    server_id     uuid,                 -- required when scope = 'server'
    reason        text,
    evidence      jsonb,                -- refs to chat/combat logs, screenshots
    issued_by     uuid,                 -- staff user (Auth)
    issued_at     timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz,          -- NULL = permanent
    status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','revoked')),
    revoked_by    uuid, revoked_at timestamptz, revoke_reason text,
    origin        text NOT NULL DEFAULT 'cupboard'  -- cupboard | bm | pool
);
-- Hot path: connect-time enforcement lookup.
CREATE INDEX ix_ban_enforcement ON bans (tenant_id, subject_hash) WHERE status = 'active';
CREATE INDEX ix_ban_player ON bans (tenant_id, player_id);
```

> **The pepper is deterministic, not per-row.** `subject_hash = HMAC-SHA256(value,
> pepper)` with a single secret pepper from Vault, so the *same* Steam ID always
> hashes the same — that's what lets connect-time lookups and ban-matching keep
> working after the raw value is erased. (A per-row random salt would break matching.)

### evasion, notes, flags, manual links

```sql
CREATE TABLE ban_evasion_alerts (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    ban_id        uuid NOT NULL REFERENCES bans(id),
    suspect_player uuid NOT NULL REFERENCES players(id),
    via_link      uuid,                 -- player_links.id or manual_links.id that triggered it
    via_kind      text CHECK (via_kind IN ('auto','manual')),
    detected_at   timestamptz NOT NULL DEFAULT now(),
    status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','actioned'))
);

CREATE TABLE player_notes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL, player_id uuid NOT NULL REFERENCES players(id),
    author uuid, body text, pinned boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE player_flags (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL, player_id uuid NOT NULL REFERENCES players(id),
    label text NOT NULL, color text, created_by uuid,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Per-org PRIVATE links (do NOT enter the global graph)
CREATE TABLE manual_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    player_a uuid NOT NULL REFERENCES players(id),
    player_b uuid NOT NULL REFERENCES players(id),
    reason text, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (player_a < player_b)
);
```

### sharing pools & audit

```sql
CREATE TABLE sharing_pools (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL, owner_tenant uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pool_members (
    pool_id uuid NOT NULL REFERENCES sharing_pools(id),
    tenant_id uuid NOT NULL, role text NOT NULL DEFAULT 'member',
    status text NOT NULL DEFAULT 'active', joined_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (pool_id, tenant_id)
);
CREATE TABLE ban_pool_shares (        -- which bans a tenant shares into which pool
    ban_id uuid NOT NULL REFERENCES bans(id),
    pool_id uuid NOT NULL REFERENCES sharing_pools(id),
    PRIMARY KEY (ban_id, pool_id)
);

CREATE TABLE audit_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid,                   -- NULL = system/global action
    actor_id uuid, action text NOT NULL,
    target_type text, target_id uuid, metadata jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_tenant_time ON audit_log (tenant_id, created_at DESC);
```

---

## Key flows

**Ingestion upsert** (per observed player in a session/event):
1. Resolve player: look up `player_identifiers` by `(type='steam', value_hash)`. Miss → create `players` row + the identifier.
2. Upsert `identity_signals` for IP + owner (bump `sighting_count`, `last_seen_at`).
3. Upsert `name_history`; write `player_sessions`; refresh `players.last_seen_at`.
4. Enqueue the player for **link re-evaluation**.

**Link detection** (async, off the Redis Streams firehose): for a player, find others
sharing strong+weak signals and score:
`confidence = 1 − Π(1 − wᵢ)` over matched signals, with example weights
`steam_owner 0.6, eac 0.7, shared_ip 0.3 (time-decayed), name 0.1`. Upsert
`player_links` above a surfacing threshold. Never merges automatically.

**Ban enforcement** (connect-time hot path): hash the incoming Steam ID →
`SELECT 1 FROM bans WHERE tenant_id=$1 AND subject_hash=$2 AND status='active'`
(plus bans shared into pools the tenant subscribes to). Block via plugin/RCON.

**Evasion detection:** on connect, gather the player's links (global `player_links` +
the tenant's `manual_links`); if any *linked* player has an active ban on this tenant,
create a `ban_evasion_alerts` row (default: alert/flag, **not** auto-ban; configurable).

**Merge:** repoint identifiers/signals/sessions/etc. from `from_player` to
`into_player`, set `from_player.status='merged', merged_into=into_player`, write
`merge_log` with a snapshot for un-merge.

**Erasure (GDPR):** NULL `value`/`name`/`subject_value`/`ip` and `players` PII; **keep
all `*_hash` columns** so links + bans still function; set `players.status='erased'`.
**Retention worker:** purge `player_sessions` / `identity_signals` past the retention
window (hashes can be retained longer if needed for enforcement).

---

## Open questions

- **uuid vs uuidv7** for PKs (index locality on the high-write `sessions`/`signals`).
- **Identity store isolation** — when write volume warrants, move the global identity
  tables to their own CNPG cluster (Decision: deferred, see ARCHITECTURE §9).
- **Signal retention vs enforcement** — how long to keep IP hashes purely for linking.
- **Pool ban precedence** — if a pool ban and a local revoke disagree, which wins?
- **Un-merge** — is best-effort snapshot enough, or do we need full reversibility?
