//! Support tickets (Phase 6 PR3, decisions A/B/C/E/F/G): one ticket store in the
//! tenant schema serving both the operator and player web surfaces, the ban-appeal
//! link to identity over internal HTTP, and the post-commit stream publish the Discord
//! bot consumes (PR4/PR5).
//!
//! All request-path access runs on the app pool inside `begin_tenant_tx` (RLS). The
//! stream publish is strictly best-effort AFTER the commit (decision G: web tickets
//! never depend on Redis), and the two publish invariants (no internal notes, no
//! `origin='discord'` echoes) are enforced in [`publish_event`] itself, not at call
//! sites.

use crate::error::AppError;
use chrono::{DateTime, Utc};
use cupboard_bus::Bus;
use cupboard_domain::{TicketEvent, TicketEventKind, TICKET_STREAM};
use serde::Serialize;
use sqlx::{Acquire as _, Postgres, Transaction};
use std::time::Duration;
use uuid::Uuid;

/// `XADD MAXLEN ~` cap for [`TICKET_STREAM`] (the collector `push_stream_maxlen`
/// convention). Ticket traffic is low-volume; 10k entries bound Redis if the bot
/// consumer stalls, at the cost of the thread lagging (web remains canonical).
pub const TICKET_STREAM_MAXLEN: usize = 10_000;

/// The status vocabulary (matches the migration CHECK). Transitions are any-to-any in
/// v1; no-op writes are silently accepted upstream.
pub const STATUSES: [&str; 4] = ["open", "pending", "resolved", "closed"];

/// The ticket-type vocabulary (matches the migration CHECK).
pub const TYPES: [&str; 2] = ["general", "ban_appeal"];

/// A ticket list row (operator list + player "my tickets"), including the derived
/// `last_message_at`.
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct TicketSummary {
    pub id: Uuid,
    #[serde(rename = "type")]
    pub ticket_type: String,
    pub status: String,
    pub category: Option<String>,
    pub subject: String,
    pub player_account_id: Option<Uuid>,
    pub ban_id: Option<Uuid>,
    pub assignee_user_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub last_message_at: Option<DateTime<Utc>>,
}

/// The full ticket detail, including the denormalized ban snapshot (decision C).
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct Ticket {
    pub id: Uuid,
    #[serde(rename = "type")]
    pub ticket_type: String,
    pub status: String,
    pub category: Option<String>,
    pub subject: String,
    pub player_account_id: Option<Uuid>,
    pub opener_discord_user_id: Option<String>,
    pub ban_id: Option<Uuid>,
    pub ban_snapshot: Option<serde_json::Value>,
    pub assignee_user_id: Option<Uuid>,
    pub discord_channel_id: Option<String>,
    pub discord_thread_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// One ticket message, in its wire shape (uuidv7 `id` is the ordering key).
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct TicketMessage {
    pub id: Uuid,
    pub author_kind: String,
    pub author_id: Option<Uuid>,
    pub author_display: String,
    pub body: String,
    pub internal: bool,
    pub origin: String,
    pub created_at: DateTime<Utc>,
}

const TICKET_COLS: &str = "id, type AS ticket_type, status, category, subject, \
     player_account_id, opener_discord_user_id, ban_id, ban_snapshot, assignee_user_id, \
     discord_channel_id, discord_thread_id, created_at, updated_at";

const MESSAGE_COLS: &str =
    "id, author_kind, author_id, author_display, body, internal, origin, created_at";

const SUMMARY_COLS: &str = "t.id, t.type AS ticket_type, t.status, t.category, t.subject, \
     t.player_account_id, t.ban_id, t.assignee_user_id, t.created_at, t.updated_at, \
     (SELECT max(m.created_at) FROM ticket_messages m WHERE m.ticket_id = t.id) \
         AS last_message_at";

/// Player-facing summary: `last_message_at` ignores internal notes, so staff-side
/// activity timing never leaks to players (their timestamps only move when something
/// they can see happened; note inserts also skip the `updated_at` touch, below).
const PLAYER_SUMMARY_COLS: &str = "t.id, t.type AS ticket_type, t.status, t.category, \
     t.subject, t.player_account_id, t.ban_id, t.assignee_user_id, t.created_at, \
     t.updated_at, \
     (SELECT max(m.created_at) FROM ticket_messages m \
       WHERE m.ticket_id = t.id AND NOT m.internal) AS last_message_at";

/// Whether a database error is a violation of the one-open-appeal-per-ban partial
/// unique index (`ux_tickets_one_open_appeal`).
fn is_one_open_appeal_violation(e: &sqlx::Error) -> bool {
    e.as_database_error().and_then(|d| d.constraint()) == Some("ux_tickets_one_open_appeal")
}

// ============================ Reads ============================

/// The operator ticket list, optionally filtered, newest first (uuidv7 id order =
/// creation order). Runs inside an RLS-scoped transaction supplied by the caller.
pub async fn list_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    status: Option<&str>,
    ticket_type: Option<&str>,
) -> Result<Vec<TicketSummary>, sqlx::Error> {
    sqlx::query_as(&format!(
        "SELECT {SUMMARY_COLS} FROM tickets t \
         WHERE ($1::text IS NULL OR t.status = $1) \
           AND ($2::text IS NULL OR t.type = $2) \
         ORDER BY t.id DESC"
    ))
    .bind(status)
    .bind(ticket_type)
    .fetch_all(&mut **tx)
    .await
}

/// The player's own tickets, newest first. RLS scopes the tenant; the explicit
/// `player_account_id` predicate scopes the player within it.
pub async fn list_for_player_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    player_account_id: Uuid,
) -> Result<Vec<TicketSummary>, sqlx::Error> {
    sqlx::query_as(&format!(
        "SELECT {PLAYER_SUMMARY_COLS} FROM tickets t \
         WHERE t.player_account_id = $1 \
         ORDER BY t.id DESC"
    ))
    .bind(player_account_id)
    .fetch_all(&mut **tx)
    .await
}

/// One ticket by id (RLS scopes the tenant; `None` includes other tenants' tickets).
pub async fn get_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> Result<Option<Ticket>, sqlx::Error> {
    sqlx::query_as(&format!("SELECT {TICKET_COLS} FROM tickets WHERE id = $1"))
        .bind(id)
        .fetch_optional(&mut **tx)
        .await
}

/// A ticket's messages ordered by id (uuidv7 = chronological). `include_internal =
/// false` is the player view: staff notes are excluded at the query, never filtered
/// client-side.
pub async fn list_messages_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    ticket_id: Uuid,
    include_internal: bool,
) -> Result<Vec<TicketMessage>, sqlx::Error> {
    sqlx::query_as(&format!(
        "SELECT {MESSAGE_COLS} FROM ticket_messages \
         WHERE ticket_id = $1 AND ($2 OR NOT internal) \
         ORDER BY id"
    ))
    .bind(ticket_id)
    .bind(include_internal)
    .fetch_all(&mut **tx)
    .await
}

// ============================ Writes ============================

/// A ticket to open (web player surface, PR3; Discord `/ticket open` via the bot's
/// internal route, PR5: `opener_discord_user_id` set, `player_account_id` null).
#[derive(Debug)]
pub struct NewTicket<'a> {
    pub ticket_type: &'a str,
    pub category: Option<&'a str>,
    pub subject: &'a str,
    pub player_account_id: Option<Uuid>,
    pub opener_discord_user_id: Option<&'a str>,
    pub ban_id: Option<Uuid>,
    pub ban_snapshot: Option<serde_json::Value>,
}

/// Insert a ticket. A violation of the one-open-appeal-per-ban partial unique index
/// surfaces as a friendly 409 conflict envelope.
pub async fn insert_ticket_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    new: &NewTicket<'_>,
) -> Result<Ticket, AppError> {
    sqlx::query_as(&format!(
        "INSERT INTO tickets \
             (tenant_id, type, category, subject, player_account_id, \
              opener_discord_user_id, ban_id, ban_snapshot) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
         RETURNING {TICKET_COLS}"
    ))
    .bind(tenant_id)
    .bind(new.ticket_type)
    .bind(new.category)
    .bind(new.subject)
    .bind(new.player_account_id)
    .bind(new.opener_discord_user_id)
    .bind(new.ban_id)
    .bind(&new.ban_snapshot)
    .fetch_one(&mut **tx)
    .await
    .map_err(|e| {
        if is_one_open_appeal_violation(&e) {
            AppError::Conflict(
                "an appeal for this ban is already open; add to the existing ticket instead".into(),
            )
        } else {
            e.into()
        }
    })
}

/// A message to append (PR3 writes `origin='web'`; `discord`/`system` origins arrive
/// with the bot's internal routes in PR5).
#[derive(Debug)]
pub struct NewMessage<'a> {
    pub author_kind: &'a str,
    pub author_id: Option<Uuid>,
    pub author_display: &'a str,
    pub body: &'a str,
    pub internal: bool,
    pub origin: &'a str,
}

/// Append a message and touch the ticket's `updated_at` in the same transaction.
/// Internal notes deliberately do NOT touch `updated_at`: the player detail response
/// includes it, so a note bumping it would leak staff activity timing (the operator
/// list orders by id and derives its own unfiltered `last_message_at`, so nothing
/// staff-side depends on the touch).
pub async fn insert_message_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    ticket_id: Uuid,
    msg: &NewMessage<'_>,
) -> Result<TicketMessage, sqlx::Error> {
    let inserted: TicketMessage = sqlx::query_as(&format!(
        "INSERT INTO ticket_messages \
             (ticket_id, tenant_id, author_kind, author_id, author_display, body, \
              internal, origin) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
         RETURNING {MESSAGE_COLS}"
    ))
    .bind(ticket_id)
    .bind(tenant_id)
    .bind(msg.author_kind)
    .bind(msg.author_id)
    .bind(msg.author_display)
    .bind(msg.body)
    .bind(msg.internal)
    .bind(msg.origin)
    .fetch_one(&mut **tx)
    .await?;
    if !msg.internal {
        sqlx::query("UPDATE tickets SET updated_at = now() WHERE id = $1")
            .bind(ticket_id)
            .execute(&mut **tx)
            .await?;
    }
    Ok(inserted)
}

/// A Discord-relayed message (bot internal route, PR5). Always `origin='discord'`,
/// never internal, no platform author id; `author_kind` is the bot's staff-role
/// determination, validated to `player`/`staff` at the HTTP layer.
#[derive(Debug)]
pub struct NewDiscordMessage<'a> {
    pub author_kind: &'a str,
    pub author_display: &'a str,
    pub body: &'a str,
    pub discord_message_id: &'a str,
}

/// Insert a Discord-relayed message idempotently: Discord deliveries are
/// at-least-once, so a replayed `discord_message_id` lands on the partial unique
/// `(tenant_id, discord_message_id)` and dedupes to `None` (decision F). Only a REAL
/// insert touches the ticket's `updated_at`.
pub async fn insert_discord_message_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    ticket_id: Uuid,
    msg: &NewDiscordMessage<'_>,
) -> Result<Option<TicketMessage>, sqlx::Error> {
    let inserted: Option<TicketMessage> = sqlx::query_as(&format!(
        "INSERT INTO ticket_messages \
             (ticket_id, tenant_id, author_kind, author_id, author_display, body, \
              internal, origin, discord_message_id) \
         VALUES ($1, $2, $3, NULL, $4, $5, false, 'discord', $6) \
         ON CONFLICT (tenant_id, discord_message_id) WHERE discord_message_id IS NOT NULL \
             DO NOTHING \
         RETURNING {MESSAGE_COLS}"
    ))
    .bind(ticket_id)
    .bind(tenant_id)
    .bind(msg.author_kind)
    .bind(msg.author_display)
    .bind(msg.body)
    .bind(msg.discord_message_id)
    .fetch_optional(&mut **tx)
    .await?;
    if inserted.is_some() {
        sqlx::query("UPDATE tickets SET updated_at = now() WHERE id = $1")
            .bind(ticket_id)
            .execute(&mut **tx)
            .await?;
    }
    Ok(inserted)
}

/// The ticket a Discord thread is recorded on, if any (RLS scopes the tenant; the
/// relay resolves every incoming Discord reply through this, index in 0007).
pub async fn find_by_thread_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    thread_id: &str,
) -> Result<Option<Ticket>, sqlx::Error> {
    sqlx::query_as(&format!(
        "SELECT {TICKET_COLS} FROM tickets WHERE discord_thread_id = $1 LIMIT 1"
    ))
    .bind(thread_id)
    .fetch_optional(&mut **tx)
    .await
}

/// Record the Discord channel/thread the bot created for a ticket. Guarded: only
/// writes when no thread is recorded yet (rows_affected = 0 means the caller must
/// compare against the stored ids: identical = idempotent no-op, different = a bot
/// bug surfaced as 409).
pub async fn record_discord_thread_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    ticket_id: Uuid,
    channel_id: &str,
    thread_id: &str,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "UPDATE tickets SET discord_channel_id = $2, discord_thread_id = $3 \
         WHERE id = $1 AND discord_thread_id IS NULL",
    )
    .bind(ticket_id)
    .bind(channel_id)
    .bind(thread_id)
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected() == 1)
}

/// Clear a ticket's recorded Discord channel/thread (deleted-thread recovery: a
/// Discord admin deleted the thread, so the guarded `record_discord_thread_in_tx`
/// would otherwise refuse a replacement forever). Returns whether anything was
/// recorded (false = already clear, the caller's idempotent no-op).
pub async fn clear_discord_thread_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    ticket_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "UPDATE tickets SET discord_channel_id = NULL, discord_thread_id = NULL \
         WHERE id = $1 AND discord_thread_id IS NOT NULL",
    )
    .bind(ticket_id)
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected() == 1)
}

/// Set a ticket's status (+ `updated_at`). The caller decides no-op/transition policy.
/// Reopening a resolved/closed appeal can violate the one-open-appeal index when a
/// sibling appeal for the same ban is already open; that surfaces as a friendly 409
/// (the operator path), not a 500.
pub async fn set_status_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    ticket_id: Uuid,
    status: &str,
) -> Result<(), AppError> {
    sqlx::query("UPDATE tickets SET status = $2, updated_at = now() WHERE id = $1")
        .bind(ticket_id)
        .bind(status)
        .execute(&mut **tx)
        .await
        .map_err(|e| {
            if is_one_open_appeal_violation(&e) {
                AppError::Conflict(
                    "another appeal for this ban is already open; resolve it first".into(),
                )
            } else {
                e.into()
            }
        })?;
    Ok(())
}

/// Reopen a resolved/closed ticket to `open`, tolerating the one-open-appeal index:
/// when a sibling appeal for the same ban is already open/pending, the reopen is
/// SKIPPED (the open state is already covered) instead of failing the caller's whole
/// transaction, so the message that triggered it still lands. Runs the UPDATE under a
/// savepoint: a constraint violation would otherwise poison the outer transaction.
/// Returns whether the reopen was applied (callers publish `ticket.status` only then).
pub async fn try_reopen_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    ticket_id: Uuid,
) -> Result<bool, AppError> {
    let mut sp = tx.begin().await?;
    let result =
        sqlx::query("UPDATE tickets SET status = 'open', updated_at = now() WHERE id = $1")
            .bind(ticket_id)
            .execute(&mut *sp)
            .await;
    match result {
        Ok(_) => {
            sp.commit().await?;
            Ok(true)
        }
        Err(e) if is_one_open_appeal_violation(&e) => {
            sp.rollback().await?;
            tracing::info!(
                ticket = %ticket_id,
                "skipping reopen: a sibling open appeal covers this ban"
            );
            Ok(false)
        }
        Err(e) => Err(e.into()),
    }
}

/// Set (or clear) a ticket's assignee (+ `updated_at`).
pub async fn set_assignee_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    ticket_id: Uuid,
    assignee_user_id: Option<Uuid>,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE tickets SET assignee_user_id = $2, updated_at = now() WHERE id = $1")
        .bind(ticket_id)
        .bind(assignee_user_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

// ============================ Discord guild bind (decision D) ============================

/// How long a minted guild-bind code stays redeemable.
pub const BIND_CODE_TTL_SECS: i64 = 15 * 60;

/// The per-tenant Discord binding, as the operator status endpoint reports it.
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct DiscordConfig {
    pub guild_id: String,
    pub tickets_channel_id: Option<String>,
    pub staff_role_id: Option<String>,
    pub status: String,
    pub linked_at: DateTime<Utc>,
}

/// The tenant's Discord binding, if any (request path: app pool has SELECT).
pub async fn get_discord_config_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
) -> Result<Option<DiscordConfig>, sqlx::Error> {
    sqlx::query_as(
        "SELECT guild_id, tickets_channel_id, staff_role_id, status, linked_at \
         FROM ticket_discord_configs WHERE tenant_id = $1",
    )
    .bind(tenant_id)
    .fetch_optional(&mut **tx)
    .await
}

/// Resolve the tenant a Discord guild is bound to (decision D: the bot's internal
/// routes carry ONLY guild_id; the tenant is always resolved server-side from the
/// binding, never trusted from the payload). Cross-tenant lookup, owner pool.
pub async fn resolve_tenant_by_guild(
    owner_pool: &sqlx::PgPool,
    guild_id: &str,
) -> Result<Option<Uuid>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT tenant_id FROM ticket_discord_configs \
         WHERE guild_id = $1 AND status = 'linked'",
    )
    .bind(guild_id)
    .fetch_optional(owner_pool)
    .await
}

/// A guild's binding as the bot's config-hydration route reports it (PR5: the bot
/// enumerates its guilds on boot and asks for each binding, instead of keeping
/// restart-amnesiac caches or probing).
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct GuildBinding {
    pub tenant_id: Uuid,
    pub tickets_channel_id: Option<String>,
    pub staff_role_id: Option<String>,
}

/// The full binding for a guild (cross-tenant lookup, owner pool; linked only).
pub async fn get_guild_binding(
    owner_pool: &sqlx::PgPool,
    guild_id: &str,
) -> Result<Option<GuildBinding>, sqlx::Error> {
    sqlx::query_as(
        "SELECT tenant_id, tickets_channel_id, staff_role_id FROM ticket_discord_configs \
         WHERE guild_id = $1 AND status = 'linked'",
    )
    .bind(guild_id)
    .fetch_optional(owner_pool)
    .await
}

/// The bind-code hash contract pinned by the 0006 migration comment: UNKEYED sha256 of
/// the plaintext. The codes are 256-bit `random_token()` values, so the hash is
/// preimage-safe without a pepper (the ingest-token precedent).
fn bind_code_hash(code: &str) -> Vec<u8> {
    cupboard_crypto::sha256(code.as_bytes()).to_vec()
}

/// Mint a one-time guild-bind code for `tenant_id` (decision D; the Phase 5
/// one-time-code pattern). Any existing codes for the tenant are deleted first, so at
/// most ONE code is outstanding per tenant. Returns the plaintext (shown once, never
/// logged, never stored) and its expiry. Owner-pool transaction: `ticket_bind_codes`
/// deliberately has no app-role grant.
pub async fn mint_bind_code_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    created_by: Uuid,
) -> Result<(String, DateTime<Utc>), sqlx::Error> {
    // Serialize mints per tenant: DELETE-then-INSERT has nothing else to serialize on
    // (no unique on tenant_id), so two concurrent mints could otherwise both survive
    // and leave two live codes. Seed 3 in the per-tenant advisory-lock registry (see
    // http/billing.rs: 0 domains, 1 auth key cap, 2 billing checkout, 3 here).
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 3))")
        .bind(tenant_id)
        .execute(&mut **tx)
        .await?;
    sqlx::query("DELETE FROM ticket_bind_codes WHERE tenant_id = $1")
        .bind(tenant_id)
        .execute(&mut **tx)
        .await?;
    let code = cupboard_crypto::random_token();
    let expires_at = Utc::now() + chrono::Duration::seconds(BIND_CODE_TTL_SECS);
    sqlx::query(
        "INSERT INTO ticket_bind_codes (code_hash, tenant_id, created_by, expires_at) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(bind_code_hash(&code))
    .bind(tenant_id)
    .bind(created_by)
    .bind(expires_at)
    .execute(&mut **tx)
    .await?;
    Ok((code, expires_at))
}

/// Redeem a bind code and link the guild, atomically (owner-pool transaction:
/// config writes are owner-side per the 0006 grants).
///
///   * Single-use consume: `DELETE .. WHERE expires_at > now() RETURNING` (the
///     redeem_link_code precedent); invalid, expired, and already-used codes are the
///     same generic 401 (no oracle for which).
///   * Upsert on tenant_id: a rebind by the SAME tenant replaces its row, including a
///     move to a different guild. The GLOBAL guild unique still rejects a guild that
///     is already bound to a DIFFERENT tenant (409).
///   * Expired codes are pruned opportunistically, and an audit row (actor = the
///     operator who minted the code) commits with the bind.
pub async fn bind_discord_guild(
    owner_pool: &sqlx::PgPool,
    code: &str,
    guild_id: &str,
    tickets_channel_id: &str,
    staff_role_id: Option<&str>,
) -> Result<(), AppError> {
    let mut tx = owner_pool.begin().await?;
    let consumed: Option<(Uuid, Option<Uuid>)> = sqlx::query_as(
        "DELETE FROM ticket_bind_codes WHERE code_hash = $1 AND expires_at > now() \
         RETURNING tenant_id, created_by",
    )
    .bind(bind_code_hash(code))
    .fetch_optional(&mut *tx)
    .await?;
    let Some((tenant_id, created_by)) = consumed else {
        return Err(AppError::Unauthorized(
            "invalid or expired bind code".into(),
        ));
    };

    sqlx::query(
        "INSERT INTO ticket_discord_configs \
             (tenant_id, guild_id, tickets_channel_id, staff_role_id, status, \
              linked_by, linked_at) \
         VALUES ($1, $2, $3, $4, 'linked', $5, now()) \
         ON CONFLICT (tenant_id) DO UPDATE SET \
             guild_id = EXCLUDED.guild_id, \
             tickets_channel_id = EXCLUDED.tickets_channel_id, \
             staff_role_id = EXCLUDED.staff_role_id, \
             status = 'linked', \
             linked_by = EXCLUDED.linked_by, \
             linked_at = now()",
    )
    .bind(tenant_id)
    .bind(guild_id)
    .bind(tickets_channel_id)
    .bind(staff_role_id)
    .bind(created_by)
    .execute(&mut *tx)
    .await
    .map_err(|e| {
        if e.as_database_error().and_then(|d| d.constraint())
            == Some("ticket_discord_configs_guild_unique")
        {
            AppError::Conflict(
                "this Discord server is already linked to another organization".into(),
            )
        } else {
            AppError::from(e)
        }
    })?;
    crate::domain::audit::record_in_tx(
        &mut tx,
        tenant_id,
        created_by,
        "tickets.discord_linked",
        Some("discord_guild"),
        None,
        Some(serde_json::json!({
            "guild_id": guild_id,
            "tickets_channel_id": tickets_channel_id,
            "staff_role_id": staff_role_id,
        })),
    )
    .await?;
    tx.commit().await?;

    // Best-effort prune of expired codes (cheap; expiry index).
    let _ = sqlx::query("DELETE FROM ticket_bind_codes WHERE expires_at < now()")
        .execute(owner_pool)
        .await;
    Ok(())
}

// ============================ Identity ban link (decision C) ============================

/// Fetch the player's ACTIVE bans from identity's internal endpoint
/// (`POST /internal/bans/active` with a `{"tenant_id","steam_id"}` JSON body: POST so
/// the steam_id never rides a query string into identity's request-span/URI logging),
/// authenticated with the shared `INTERNAL_API_TOKEN`. Powers both the storefront
/// appeal picker and the server-side appeal validation (a client-supplied `ban_id` is
/// never trusted: it must appear in THIS player's active bans). Bans stay opaque JSON
/// here: identity owns the shape, tenant relays and snapshots it.
pub async fn fetch_active_bans(
    http: &reqwest::Client,
    config: &crate::config::Config,
    tenant_id: Uuid,
    steam_id: &str,
) -> Result<Vec<serde_json::Value>, AppError> {
    let token = config.internal_api_token.as_deref().ok_or_else(|| {
        AppError::Unavailable("ban lookups are not configured on this deployment".into())
    })?;
    let url = format!("{}/internal/bans/active", config.identity_internal_url);
    let resp = http
        .post(&url)
        .json(&serde_json::json!({
            "tenant_id": tenant_id,
            "steam_id": steam_id,
        }))
        .header("x-internal-token", token)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| {
            tracing::warn!(error = %e, "identity ban lookup unreachable");
            AppError::Unavailable("could not look up bans right now; try again".into())
        })?;
    if !resp.status().is_success() {
        tracing::warn!(status = %resp.status(), "identity ban lookup rejected");
        return Err(AppError::Unavailable(
            "could not look up bans right now; try again".into(),
        ));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("identity ban lookup body: {e}")))?;
    Ok(body
        .get("bans")
        .and_then(|b| b.as_array())
        .cloned()
        .unwrap_or_default())
}

// ============================ Stream publish (decisions E/F/G) ============================

/// Build the `ticket.created` event (type, subject, category, opener display: enough
/// for the bot to open a thread; it backfills bodies over `GET /internal/tickets/{id}`).
pub fn created_event(tenant_id: Uuid, ticket: &Ticket, opener_display: &str) -> TicketEvent {
    TicketEvent {
        kind: TicketEventKind::Created,
        tenant_id: tenant_id.into(),
        ticket_id: ticket.id,
        ticket_type: Some(ticket.ticket_type.clone()),
        subject: Some(ticket.subject.clone()),
        category: ticket.category.clone(),
        opener_display: Some(opener_display.to_string()),
        message_id: None,
        author_kind: None,
        author_display: None,
        body: None,
        origin: None,
        status: None,
    }
}

/// Build the `ticket.message` event for one appended message.
pub fn message_event(tenant_id: Uuid, ticket_id: Uuid, msg: &TicketMessage) -> TicketEvent {
    TicketEvent {
        kind: TicketEventKind::Message,
        tenant_id: tenant_id.into(),
        ticket_id,
        ticket_type: None,
        subject: None,
        category: None,
        opener_display: None,
        message_id: Some(msg.id),
        author_kind: Some(msg.author_kind.clone()),
        author_display: Some(msg.author_display.clone()),
        body: Some(msg.body.clone()),
        origin: Some(msg.origin.clone()),
        status: None,
    }
}

/// Build the `ticket.status` event.
pub fn status_event(tenant_id: Uuid, ticket_id: Uuid, status: &str) -> TicketEvent {
    TicketEvent {
        kind: TicketEventKind::Status,
        tenant_id: tenant_id.into(),
        ticket_id,
        ticket_type: None,
        subject: None,
        category: None,
        opener_display: None,
        message_id: None,
        author_kind: None,
        author_display: None,
        body: None,
        origin: None,
        status: Some(status.to_string()),
    }
}

/// The ONLY publish path for ticket events: post-commit, fire-and-forget
/// (decision G: a failure is logged and swallowed, the web write already committed).
///
/// The two non-negotiables live HERE, not at call sites (decisions E/F):
///   * `internal` (the message's staff-note flag; `false` for created/status events)
///     drops the event: internal notes never reach the stream.
///   * `origin='discord'` drops the event: the bot already has those messages, and
///     echoing them back is the sync loop decision F exists to prevent.
pub async fn publish_event(bus: &Option<Bus>, event: TicketEvent, internal: bool) {
    if internal {
        return;
    }
    if event.origin.as_deref() == Some("discord") {
        return;
    }
    let Some(bus) = bus else {
        return;
    };
    // Bus is a cheap Clone over the multiplexed connection; publish_capped needs &mut.
    // The publish is awaited inline (event ordering matters, e.g. message-then-status
    // on reopen) but bounded: a black-holed Redis must delay a ticket response by at
    // most this timeout, never hang it.
    let mut bus = bus.clone();
    let publish = bus.publish_capped(TICKET_STREAM, TICKET_STREAM_MAXLEN, &event);
    match tokio::time::timeout(Duration::from_secs(3), publish).await {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => {
            tracing::warn!(
                error = %e,
                kind = ?event.kind,
                ticket = %event.ticket_id,
                "ticket event publish failed (the web write is already committed)"
            );
        }
        Err(_) => {
            tracing::warn!(
                kind = ?event.kind,
                ticket = %event.ticket_id,
                "ticket event publish timed out (the web write is already committed)"
            );
        }
    }
}
