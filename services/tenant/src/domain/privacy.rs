//! Player privacy walkers (Phase 7 PR2, decisions A/A2/B/B2/D/F): per-player export
//! and erasure over the tenant schema, called by the auth-owned coordinator through
//! `/internal/privacy/*`. Runs on the OWNER pool: the walk is deliberately
//! cross-tenant for platform scope, and tenant scope is an explicit SQL filter, not
//! RLS.
//!
//! Erasure semantics (decision B): player-authored ticket messages and ticket
//! subjects are markered, `opener_discord_user_id`/`ban_snapshot`/checkout
//! `steam_id`/matched webhook payloads are NULLed, and `entitlements` are NEVER
//! touched (steam_id retained as proof-of-purchase, contract/legitimate-interest
//! basis). Every update carries an idempotency guard so a re-run counts zero.

use serde::Serialize;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

/// The marker written over erased player-authored text.
pub const ERASED: &str = "[erased]";

/// Privacy stance of one tenant-schema table (decision B2). The oracle test fails on
/// any table missing from [`CLASSIFIED`], so every migration must take a stance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Classification {
    /// Holds player data; covered by the export and erasure walk.
    Walked,
    /// Holds no player data (org/platform/infra rows only).
    NoPlayerData,
    /// Holds player-linked data retained under a stated lawful basis; exported where
    /// applicable, never erased.
    RetainedWithBasis,
}

/// Every tenant-schema table, classified (decision B2). Kept in lockstep with the
/// export/erase walk below; the schema-inventory oracle test enforces completeness
/// in both directions.
pub const CLASSIFIED: &[(&str, Classification)] = &[
    ("_sqlx_migrations", Classification::NoPlayerData),
    ("sites", Classification::NoPlayerData),
    // Operator/system action record; 2y retention window (decision E), audit of
    // erasure is itself a GDPR obligation (decision D). Erase audits carry the
    // surrogate player_account_id and per-table counts only; never raw identifiers
    // and never their digests (the id spaces are enumerable, so an unsalted hash
    // is reversible).
    ("audit_log", Classification::RetainedWithBasis),
    ("site_domains", Classification::NoPlayerData),
    ("store_connections", Classification::NoPlayerData),
    ("store_products", Classification::NoPlayerData),
    ("store_categories", Classification::NoPlayerData),
    ("checkout_sessions", Classification::Walked),
    // steam_id retained: proof-of-purchase + grant enforcement (decision B).
    ("entitlements", Classification::RetainedWithBasis),
    ("store_webhook_events", Classification::Walked),
    ("org_subscriptions", Classification::NoPlayerData),
    ("billing_pending_checkouts", Classification::NoPlayerData),
    ("billing_webhook_events", Classification::NoPlayerData),
    ("billing_purchases", Classification::NoPlayerData),
    ("tickets", Classification::Walked),
    ("ticket_messages", Classification::Walked),
    ("ticket_discord_configs", Classification::NoPlayerData),
    ("ticket_bind_codes", Classification::NoPlayerData),
];

/// Blast radius of a walk (decision A2): platform scope spans every tenant, tenant
/// scope filters to one org's rows.
#[derive(Debug, Clone, Copy)]
pub enum Scope {
    Platform,
    Tenant(Uuid),
}

impl Scope {
    fn tenant(&self) -> Option<Uuid> {
        match self {
            Scope::Platform => None,
            Scope::Tenant(t) => Some(*t),
        }
    }
}

/// The person being walked (the coordinator fan-out payload, decision A). At least
/// one identifier is present (the HTTP layer enforces it).
#[derive(Debug)]
pub struct Subject {
    pub steam_id: Option<String>,
    pub discord_id: Option<String>,
    pub player_account_id: Option<Uuid>,
}

/// Per-table would-be/affected row counts for an erasure. `entitlements` is absent
/// by contract: erasure never touches it.
#[derive(Debug, Serialize)]
pub struct EraseCounts {
    pub tickets: u64,
    pub ticket_messages: u64,
    pub checkout_sessions: u64,
    pub store_webhook_events: u64,
}

// Shared row-selection predicates. Null binds fall out of the OR (SQL NULL compare
// is never true), so one statement serves every identifier combination.
const TICKET_MATCH: &str = "($1::uuid IS NULL OR tenant_id = $1) \
     AND (player_account_id = $2::uuid OR opener_discord_user_id = $3::text)";

// Player-authored only: staff replies and system notes are the org's record, not the
// subject's. The ticket-membership arm additionally requires author_id IS NULL and is
// limited to the SUBJECT'S OWN tickets: private threads make NULL-author rows in the
// subject's tickets almost always the subject's Discord-relayed messages, while
// player-authored messages in OTHER tickets are third-party content that must not
// ship in an Art. 15 bundle (nor be erased as the subject's words).
const MESSAGE_MATCH: &str = "($1::uuid IS NULL OR tenant_id = $1) \
     AND author_kind = 'player' \
     AND (author_id = $2::uuid \
          OR (author_id IS NULL AND ticket_id = ANY($3::uuid[])))";

const CHECKOUT_MATCH: &str = "($1::uuid IS NULL OR tenant_id = $1) \
     AND (player_account_id = $2::uuid OR steam_id = $3::text)";

const ENTITLEMENT_MATCH: &str = "($1::uuid IS NULL OR tenant_id = $1) \
     AND (steam_id = $3::text OR player_account_id = $2::uuid)";

// Supplementary value sweep (decision B): any payload whose text contains the raw
// steam id. strpos on a NULL payload yields NULL, so erased rows never re-match.
const WEBHOOK_MATCH: &str = "($1::uuid IS NULL OR tenant_id = $1) \
     AND $2::text IS NOT NULL AND strpos(payload::text, $2) > 0";

/// Tickets opened by the player (account match or Discord opener match), in scope.
/// Resolved FIRST in every walk: message matching and erasure both hang off it, and
/// erasure NULLs `opener_discord_user_id`, which would otherwise unmatch mid-walk.
async fn matched_ticket_ids(
    tx: &mut Transaction<'_, Postgres>,
    scope: Scope,
    subject: &Subject,
) -> Result<Vec<Uuid>, sqlx::Error> {
    sqlx::query_scalar(&format!("SELECT id FROM tickets WHERE {TICKET_MATCH}"))
        .bind(scope.tenant())
        .bind(subject.player_account_id)
        .bind(subject.discord_id.as_deref())
        .fetch_all(&mut **tx)
        .await
}

/// Export every in-scope row for the subject as `{ "<table>": [row objects] }`.
/// Includes `entitlements` (the access right covers retained data) and the webhook
/// value sweep; keys are always present so the coordinator sees a stable shape.
pub async fn export(
    pool: &PgPool,
    scope: Scope,
    subject: &Subject,
) -> Result<serde_json::Value, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let ticket_ids = matched_ticket_ids(&mut tx, scope, subject).await?;

    let tickets: Vec<serde_json::Value> =
        sqlx::query_scalar("SELECT to_jsonb(t) FROM tickets t WHERE t.id = ANY($1::uuid[])")
            .bind(&ticket_ids)
            .fetch_all(&mut *tx)
            .await?;
    let messages: Vec<serde_json::Value> = sqlx::query_scalar(&format!(
        "SELECT to_jsonb(m) FROM ticket_messages m WHERE {MESSAGE_MATCH}"
    ))
    .bind(scope.tenant())
    .bind(subject.player_account_id)
    .bind(&ticket_ids)
    .fetch_all(&mut *tx)
    .await?;
    let checkouts: Vec<serde_json::Value> = sqlx::query_scalar(&format!(
        "SELECT to_jsonb(c) FROM checkout_sessions c WHERE {CHECKOUT_MATCH}"
    ))
    .bind(scope.tenant())
    .bind(subject.player_account_id)
    .bind(subject.steam_id.as_deref())
    .fetch_all(&mut *tx)
    .await?;
    let entitlements: Vec<serde_json::Value> = sqlx::query_scalar(&format!(
        "SELECT to_jsonb(e) FROM entitlements e WHERE {ENTITLEMENT_MATCH}"
    ))
    .bind(scope.tenant())
    .bind(subject.player_account_id)
    .bind(subject.steam_id.as_deref())
    .fetch_all(&mut *tx)
    .await?;
    let webhook_events: Vec<serde_json::Value> = sqlx::query_scalar(&format!(
        "SELECT to_jsonb(w) FROM store_webhook_events w WHERE {WEBHOOK_MATCH}"
    ))
    .bind(scope.tenant())
    .bind(subject.steam_id.as_deref())
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(serde_json::json!({
        "tickets": tickets,
        "ticket_messages": messages,
        "checkout_sessions": checkouts,
        "entitlements": entitlements,
        "store_webhook_events": webhook_events,
    }))
}

/// Erase the subject's rows (decision B semantics) in ONE owner-pool transaction.
/// `dry_run` runs the IDENTICAL walk and then rolls the transaction back: exact
/// would-be counts, nothing written, not even audit. A real run commits and writes
/// one `player.erase` audit row (tenant scope: that tenant; platform scope: a
/// NULL-tenant platform row) carrying the target `player_account_id` and per-table
/// counts, never the raw identifiers.
pub async fn erase(
    pool: &PgPool,
    scope: Scope,
    subject: &Subject,
    dry_run: bool,
) -> Result<EraseCounts, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let ticket_ids = matched_ticket_ids(&mut tx, scope, subject).await?;

    let ticket_messages = sqlx::query(&format!(
        "UPDATE ticket_messages SET body = '{ERASED}', author_display = '{ERASED}' \
         WHERE {MESSAGE_MATCH} \
           AND NOT (body = '{ERASED}' AND author_display = '{ERASED}')"
    ))
    .bind(scope.tenant())
    .bind(subject.player_account_id)
    .bind(&ticket_ids)
    .execute(&mut *tx)
    .await?
    .rows_affected();

    // Subject is player-authored (markered, NOT NULL); the Discord opener id and the
    // denormalized ban snapshot are NULLed (both nullable per migration 0006).
    let tickets = sqlx::query(&format!(
        "UPDATE tickets SET subject = '{ERASED}', opener_discord_user_id = NULL, \
             ban_snapshot = NULL \
         WHERE id = ANY($1::uuid[]) \
           AND (subject <> '{ERASED}' OR opener_discord_user_id IS NOT NULL \
                OR ban_snapshot IS NOT NULL)"
    ))
    .bind(&ticket_ids)
    .execute(&mut *tx)
    .await?
    .rows_affected();

    // steam_id is nullable (migration 0003), so it is NULLed, not markered.
    let checkout_sessions = sqlx::query(&format!(
        "UPDATE checkout_sessions SET steam_id = NULL \
         WHERE {CHECKOUT_MATCH} AND steam_id IS NOT NULL"
    ))
    .bind(scope.tenant())
    .bind(subject.player_account_id)
    .bind(subject.steam_id.as_deref())
    .execute(&mut *tx)
    .await?
    .rows_affected();

    let store_webhook_events = sqlx::query(&format!(
        "UPDATE store_webhook_events SET payload = NULL WHERE {WEBHOOK_MATCH}"
    ))
    .bind(scope.tenant())
    .bind(subject.steam_id.as_deref())
    .execute(&mut *tx)
    .await?
    .rows_affected();

    let counts = EraseCounts {
        tickets,
        ticket_messages,
        checkout_sessions,
        store_webhook_events,
    };

    if dry_run {
        tx.rollback().await?;
        return Ok(counts);
    }

    // Audit in the same transaction (decision D). No identifier hashes here, not even
    // sha256: steam64 ids and Discord snowflakes live in a small enumerable space, so
    // an unsalted digest is reversible by brute force and would keep the identifier in
    // a 2y-retained table an erasure just scrubbed. The target_id (player_account_id)
    // plus the per-table counts are the audit record.
    sqlx::query(
        "INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id, metadata) \
         VALUES ($1, NULL, 'player.erase', 'player', $2, $3)",
    )
    .bind(scope.tenant())
    .bind(subject.player_account_id)
    .bind(serde_json::json!({
        "scope": match scope { Scope::Platform => "platform", Scope::Tenant(_) => "tenant" },
        "counts": counts,
    }))
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(counts)
}
