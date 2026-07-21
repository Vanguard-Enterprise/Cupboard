//! Ticket HTTP surfaces (Phase 6 PR3): the operator surface (gateway `/tickets/*`,
//! `support.respond`) and the player surface (gateway `/player/*` passthrough, player
//! JWT). The bot's `/internal/tickets/*` routes are PR5.
//!
//! Every mutation writes an audit row in the same transaction, then publishes its
//! stream event strictly POST-commit through `domain::tickets::publish_event` (which
//! owns the internal-note and discord-origin exclusions).

use crate::domain::{audit, tickets};
use crate::error::AppError;
use crate::http::player::Player;
use crate::http::AuthClaims;
use crate::state::AppState;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use cupboard_domain::{Permission, TenantId};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

/// Input bounds. Generous for support prose, small enough to keep rows and Discord
/// relays sane (Discord caps messages at 2000 chars; the bot chunks longer bodies).
const MAX_SUBJECT: usize = 200;
const MAX_CATEGORY: usize = 100;
const MAX_BODY: usize = 4000;

fn validate_body(body: &str) -> Result<&str, AppError> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err(AppError::BadRequest(
            "message body must not be empty".into(),
        ));
    }
    if trimmed.chars().count() > MAX_BODY {
        return Err(AppError::BadRequest(format!(
            "message body must be at most {MAX_BODY} characters"
        )));
    }
    Ok(trimmed)
}

fn validate_status(status: &str) -> Result<(), AppError> {
    if tickets::STATUSES.contains(&status) {
        Ok(())
    } else {
        Err(AppError::BadRequest(
            "status must be one of open, pending, resolved, closed".into(),
        ))
    }
}

/// Operator tokens carry no display name (claims are id-based); render a stable,
/// abbreviated actor tag. The web UI resolves real names from the org directory it
/// already has; richer relay fidelity (a display claim) is a later auth concern.
fn staff_display(claims: &AuthClaims) -> String {
    format!("staff-{}", &claims.0.sub.0.simple().to_string()[..8])
}

/// Player display for messages/events: the verified Steam id when linked (staff can
/// paste it straight into their tools), else a generic tag. Player tokens carry no
/// persona name.
fn player_display(player: &Player) -> String {
    player.0.steam_id.clone().unwrap_or_else(|| "player".into())
}

// ============================ Operator surface ============================

#[derive(Deserialize)]
pub struct ListQuery {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default, rename = "type")]
    pub ticket_type: Option<String>,
}

/// GET /tickets?status=&type=: the org's tickets, filtered, newest first.
pub async fn list(
    State(state): State<AppState>,
    claims: AuthClaims,
    Query(q): Query<ListQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let org = claims.require(Permission::SupportRespond)?;
    if let Some(s) = q.status.as_deref() {
        validate_status(s)?;
    }
    if let Some(t) = q.ticket_type.as_deref() {
        if !tickets::TYPES.contains(&t) {
            return Err(AppError::BadRequest(
                "type must be one of general, ban_appeal".into(),
            ));
        }
    }
    let mut tx = cupboard_db::begin_tenant_tx(&state.app_pool, TenantId::from(org)).await?;
    let list = tickets::list_in_tx(&mut tx, q.status.as_deref(), q.ticket_type.as_deref()).await?;
    tx.commit().await?;
    Ok(Json(json!({ "tickets": list })))
}

/// GET /tickets/{id}: full ticket (incl. ban snapshot) + every message, internal notes
/// included (this is the staff view), ordered by id.
pub async fn get_ticket(
    State(state): State<AppState>,
    claims: AuthClaims,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    let org = claims.require(Permission::SupportRespond)?;
    let mut tx = cupboard_db::begin_tenant_tx(&state.app_pool, TenantId::from(org)).await?;
    let ticket = tickets::get_in_tx(&mut tx, id)
        .await?
        .ok_or_else(|| AppError::NotFound("no such ticket".into()))?;
    let messages = tickets::list_messages_in_tx(&mut tx, id, true).await?;
    tx.commit().await?;
    Ok(Json(json!({ "ticket": ticket, "messages": messages })))
}

#[derive(Deserialize)]
pub struct OperatorMessageRequest {
    pub body: String,
    #[serde(default)]
    pub internal: bool,
}

/// POST /tickets/{id}/messages {body, internal}: append a staff reply (or an internal
/// note, which never leaves the staff surface).
pub async fn post_message(
    State(state): State<AppState>,
    claims: AuthClaims,
    Path(id): Path<Uuid>,
    Json(req): Json<OperatorMessageRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), AppError> {
    let org = claims.require(Permission::SupportRespond)?;
    let body = validate_body(&req.body)?;

    let mut tx = cupboard_db::begin_tenant_tx(&state.app_pool, TenantId::from(org)).await?;
    let ticket = tickets::get_in_tx(&mut tx, id)
        .await?
        .ok_or_else(|| AppError::NotFound("no such ticket".into()))?;
    let msg = tickets::insert_message_in_tx(
        &mut tx,
        org.0,
        ticket.id,
        &tickets::NewMessage {
            author_kind: "staff",
            author_id: Some(claims.0.sub.0),
            author_display: &staff_display(&claims),
            body,
            internal: req.internal,
            origin: "web",
        },
    )
    .await?;
    audit::record_in_tx(
        &mut tx,
        org.0,
        Some(claims.0.sub.0),
        "tickets.message_created",
        Some("ticket"),
        Some(ticket.id),
        Some(json!({ "message_id": msg.id, "internal": msg.internal })),
    )
    .await?;
    tx.commit().await?;

    tickets::publish_event(
        &state.bus,
        tickets::message_event(org.0, ticket.id, &msg),
        msg.internal,
    )
    .await;
    Ok((StatusCode::CREATED, Json(json!({ "message": msg }))))
}

#[derive(Deserialize)]
pub struct StatusRequest {
    pub status: String,
}

/// POST /tickets/{id}/status {status}: any-to-any transition among the four statuses
/// (v1); a no-op write is accepted silently (204, no audit, no event).
pub async fn set_status(
    State(state): State<AppState>,
    claims: AuthClaims,
    Path(id): Path<Uuid>,
    Json(req): Json<StatusRequest>,
) -> Result<StatusCode, AppError> {
    let org = claims.require(Permission::SupportRespond)?;
    validate_status(&req.status)?;

    let mut tx = cupboard_db::begin_tenant_tx(&state.app_pool, TenantId::from(org)).await?;
    let ticket = tickets::get_in_tx(&mut tx, id)
        .await?
        .ok_or_else(|| AppError::NotFound("no such ticket".into()))?;
    if ticket.status == req.status {
        tx.rollback().await?;
        return Ok(StatusCode::NO_CONTENT);
    }
    tickets::set_status_in_tx(&mut tx, ticket.id, &req.status).await?;
    audit::record_in_tx(
        &mut tx,
        org.0,
        Some(claims.0.sub.0),
        "tickets.status_changed",
        Some("ticket"),
        Some(ticket.id),
        Some(json!({ "from": ticket.status, "to": req.status })),
    )
    .await?;
    tx.commit().await?;

    tickets::publish_event(
        &state.bus,
        tickets::status_event(org.0, ticket.id, &req.status),
        false,
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct AssignRequest {
    /// `null` (or absent) clears the assignee.
    #[serde(default)]
    pub assignee_user_id: Option<Uuid>,
}

/// POST /tickets/{id}/assign {assignee_user_id|null}: set or clear the assignee. A
/// no-op write is accepted silently; assignment is web-side workflow state, so no
/// stream event (the contract publishes created/message/status only).
/// v1 accepts any uuid without validating org membership (the UI only ever sends the
/// operator's own id; a directory check is a later auth concern).
pub async fn assign(
    State(state): State<AppState>,
    claims: AuthClaims,
    Path(id): Path<Uuid>,
    Json(req): Json<AssignRequest>,
) -> Result<StatusCode, AppError> {
    let org = claims.require(Permission::SupportRespond)?;
    let mut tx = cupboard_db::begin_tenant_tx(&state.app_pool, TenantId::from(org)).await?;
    let ticket = tickets::get_in_tx(&mut tx, id)
        .await?
        .ok_or_else(|| AppError::NotFound("no such ticket".into()))?;
    if ticket.assignee_user_id == req.assignee_user_id {
        tx.rollback().await?;
        return Ok(StatusCode::NO_CONTENT);
    }
    tickets::set_assignee_in_tx(&mut tx, ticket.id, req.assignee_user_id).await?;
    audit::record_in_tx(
        &mut tx,
        org.0,
        Some(claims.0.sub.0),
        "tickets.assigned",
        Some("ticket"),
        Some(ticket.id),
        Some(json!({ "assignee_user_id": req.assignee_user_id })),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ============================ Player surface ============================

/// GET /player/tickets: the player's own tickets only (tenant via RLS + explicit
/// `player_account_id = sub`).
pub async fn player_list(
    State(state): State<AppState>,
    player: Player,
) -> Result<Json<serde_json::Value>, AppError> {
    let tenant = TenantId::from(player.0.tenant);
    let mut tx = cupboard_db::begin_tenant_tx(&state.app_pool, tenant).await?;
    let list = tickets::list_for_player_in_tx(&mut tx, player.0.sub).await?;
    tx.commit().await?;
    Ok(Json(json!({ "tickets": list })))
}

/// Fetch a ticket ONLY if it belongs to this player; anything else is a uniform 404
/// (no existence probe across players or tenants).
async fn get_own_ticket_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    player: &Player,
    id: Uuid,
) -> Result<tickets::Ticket, AppError> {
    tickets::get_in_tx(tx, id)
        .await?
        .filter(|t| t.player_account_id == Some(player.0.sub))
        .ok_or_else(|| AppError::NotFound("no such ticket".into()))
}

/// GET /player/tickets/{id}: the ticket + its messages EXCLUDING internal staff notes.
pub async fn player_get(
    State(state): State<AppState>,
    player: Player,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    let tenant = TenantId::from(player.0.tenant);
    let mut tx = cupboard_db::begin_tenant_tx(&state.app_pool, tenant).await?;
    let ticket = get_own_ticket_in_tx(&mut tx, &player, id).await?;
    let messages = tickets::list_messages_in_tx(&mut tx, id, false).await?;
    tx.commit().await?;
    Ok(Json(json!({ "ticket": ticket, "messages": messages })))
}

#[derive(Deserialize)]
pub struct PlayerCreateRequest {
    #[serde(rename = "type")]
    pub ticket_type: String,
    #[serde(default)]
    pub category: Option<String>,
    pub subject: String,
    pub body: String,
    #[serde(default)]
    pub ban_id: Option<Uuid>,
}

/// POST /player/tickets: open a ticket (general, or a ban appeal linked to one of the
/// player's OWN active bans). The opening body lands as the first message; only
/// `ticket.created` is published (the bot backfills bodies when it creates the thread,
/// so a paired `ticket.message` would relay the opener twice).
pub async fn player_create(
    State(state): State<AppState>,
    player: Player,
    Json(req): Json<PlayerCreateRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), AppError> {
    let claims = &player.0;
    let tenant = TenantId::from(claims.tenant);

    if !tickets::TYPES.contains(&req.ticket_type.as_str()) {
        return Err(AppError::BadRequest(
            "type must be \"general\" or \"ban_appeal\"".into(),
        ));
    }
    let subject = req.subject.trim();
    if subject.is_empty() || subject.chars().count() > MAX_SUBJECT {
        return Err(AppError::BadRequest(format!(
            "subject must be 1 to {MAX_SUBJECT} characters"
        )));
    }
    let body = validate_body(&req.body)?;
    let category = req
        .category
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty());
    if category.is_some_and(|c| c.chars().count() > MAX_CATEGORY) {
        return Err(AppError::BadRequest(format!(
            "category must be at most {MAX_CATEGORY} characters"
        )));
    }

    // Ban appeals: the client-supplied ban_id is NEVER trusted; it must be one of THIS
    // player's active bans per identity (decision C), and the matching ban object is
    // denormalized into ban_snapshot at open. A general ticket ignores any ban_id.
    let (ban_id, ban_snapshot) = if req.ticket_type == "ban_appeal" {
        let ban_id = req
            .ban_id
            .ok_or_else(|| AppError::BadRequest("ban_id is required for a ban appeal".into()))?;
        // No linked Steam id = no active bans can be theirs; same 403 as a foreign ban.
        let bans = match claims.steam_id.as_deref() {
            Some(steam_id) => {
                tickets::fetch_active_bans(&state.http, &state.config, claims.tenant.0, steam_id)
                    .await?
            }
            None => Vec::new(),
        };
        let ban = bans
            .iter()
            .find(|b| b.get("id").and_then(|i| i.as_str()) == Some(ban_id.to_string().as_str()))
            .ok_or_else(|| {
                AppError::Forbidden("that ban is not an active ban on your account".into())
            })?;
        (Some(ban_id), Some(ban.clone()))
    } else {
        (None, None)
    };

    let display = player_display(&player);
    let mut tx = cupboard_db::begin_tenant_tx(&state.app_pool, tenant).await?;
    let ticket = tickets::insert_ticket_in_tx(
        &mut tx,
        claims.tenant.0,
        &tickets::NewTicket {
            ticket_type: &req.ticket_type,
            category,
            subject,
            player_account_id: Some(claims.sub),
            opener_discord_user_id: None,
            ban_id,
            ban_snapshot,
        },
    )
    .await?;
    tickets::insert_message_in_tx(
        &mut tx,
        claims.tenant.0,
        ticket.id,
        &tickets::NewMessage {
            author_kind: "player",
            author_id: Some(claims.sub),
            author_display: &display,
            body,
            internal: false,
            origin: "web",
        },
    )
    .await?;
    audit::record_in_tx(
        &mut tx,
        claims.tenant.0,
        Some(claims.sub),
        "tickets.created",
        Some("ticket"),
        Some(ticket.id),
        Some(json!({ "type": ticket.ticket_type, "ban_id": ticket.ban_id })),
    )
    .await?;
    tx.commit().await?;

    tickets::publish_event(
        &state.bus,
        tickets::created_event(claims.tenant.0, &ticket, &display),
        false,
    )
    .await;
    Ok((StatusCode::CREATED, Json(json!({ "ticket": ticket }))))
}

#[derive(Deserialize)]
pub struct PlayerMessageRequest {
    pub body: String,
}

/// POST /player/tickets/{id}/messages {body}: append a player reply. A message on a
/// resolved/closed ticket REOPENS it to `open` (the common support pattern: the player
/// coming back means the matter is not settled), and that transition publishes its own
/// `ticket.status` alongside the `ticket.message`. When the ticket is a resolved
/// appeal and ANOTHER open appeal already covers the same ban, the reopen is skipped
/// (via `try_reopen_in_tx`) so the message still lands rather than 500ing the player.
pub async fn player_post_message(
    State(state): State<AppState>,
    player: Player,
    Path(id): Path<Uuid>,
    Json(req): Json<PlayerMessageRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), AppError> {
    let claims = &player.0;
    let tenant = TenantId::from(claims.tenant);
    let body = validate_body(&req.body)?;

    let mut tx = cupboard_db::begin_tenant_tx(&state.app_pool, tenant).await?;
    let ticket = get_own_ticket_in_tx(&mut tx, &player, id).await?;
    let msg = tickets::insert_message_in_tx(
        &mut tx,
        claims.tenant.0,
        ticket.id,
        &tickets::NewMessage {
            author_kind: "player",
            author_id: Some(claims.sub),
            author_display: &player_display(&player),
            body,
            internal: false,
            origin: "web",
        },
    )
    .await?;
    let mut reopened = matches!(ticket.status.as_str(), "resolved" | "closed");
    if reopened {
        reopened = tickets::try_reopen_in_tx(&mut tx, ticket.id).await?;
    }
    if reopened {
        audit::record_in_tx(
            &mut tx,
            claims.tenant.0,
            Some(claims.sub),
            "tickets.status_changed",
            Some("ticket"),
            Some(ticket.id),
            Some(json!({ "from": ticket.status, "to": "open", "reason": "player_message" })),
        )
        .await?;
    }
    audit::record_in_tx(
        &mut tx,
        claims.tenant.0,
        Some(claims.sub),
        "tickets.message_created",
        Some("ticket"),
        Some(ticket.id),
        Some(json!({ "message_id": msg.id, "internal": false })),
    )
    .await?;
    tx.commit().await?;

    tickets::publish_event(
        &state.bus,
        tickets::message_event(claims.tenant.0, ticket.id, &msg),
        msg.internal,
    )
    .await;
    if reopened {
        tickets::publish_event(
            &state.bus,
            tickets::status_event(claims.tenant.0, ticket.id, "open"),
            false,
        )
        .await;
    }
    Ok((StatusCode::CREATED, Json(json!({ "message": msg }))))
}

/// GET /player/bans/active: the player's active bans (the storefront appeal picker,
/// decision C). Empty when the account has no linked Steam id.
pub async fn player_active_bans(
    State(state): State<AppState>,
    player: Player,
) -> Result<Json<serde_json::Value>, AppError> {
    let claims = &player.0;
    let Some(steam_id) = claims.steam_id.as_deref() else {
        return Ok(Json(json!({ "bans": [] })));
    };
    let bans =
        tickets::fetch_active_bans(&state.http, &state.config, claims.tenant.0, steam_id).await?;
    Ok(Json(json!({ "bans": bans })))
}

// ============================ Discord bind (decisions D/E) ============================

/// Guard for the `/internal/tickets/*` surface: accepts ONLY the DISTINCT
/// `BOT_API_TOKEN` (decision E: the bot never holds the shared `INTERNAL_API_TOKEN`,
/// so a compromised bot cannot reach the wider internal surface). The disjointness is
/// deliberately bidirectional even though decision E only mandates the bot direction:
/// the SHARED token does not work on these routes either, keeping the two credential
/// planes fully separate (a leak of the widely-held shared token gains nothing here).
/// Same shape as `check_internal_token`: constant-time compare, fail closed (503) when
/// the token is unconfigured, 401 on mismatch.
///
/// Applied STRUCTURALLY as a `route_layer` on the `/internal/tickets` route group in
/// `http/mod.rs`, not called per handler: PR5 adds more bot routes under the prefix
/// and each must be guarded by construction, not by remembering a call.
pub async fn require_bot_token(
    State(state): State<AppState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Result<axum::response::Response, AppError> {
    let expected = state
        .config
        .bot_api_token
        .as_deref()
        .ok_or_else(|| AppError::Unavailable("bot internal API disabled".into()))?;
    let presented = req
        .headers()
        .get("x-internal-token")
        .and_then(|h| h.to_str().ok())
        .unwrap_or_default();
    if cupboard_crypto::constant_time_eq(presented.as_bytes(), expected.as_bytes()) {
        Ok(next.run(req).await)
    } else {
        Err(AppError::Unauthorized("invalid bot token".into()))
    }
}

/// POST /tickets/discord/bind-code (operator, support.respond): mint the one-time
/// guild-bind code (decision D). The plaintext is returned exactly once and never
/// logged; only its sha256 is stored. Minting replaces any outstanding code for the
/// tenant, so at most one code is live.
pub async fn mint_bind_code(
    State(state): State<AppState>,
    claims: AuthClaims,
) -> Result<(StatusCode, Json<serde_json::Value>), AppError> {
    let org = claims.require(Permission::SupportRespond)?;
    // Owner pool: ticket_bind_codes has no app-role grant (bind is bot/owner-side).
    let mut tx = state.owner_pool.begin().await?;
    let (code, expires_at) = tickets::mint_bind_code_in_tx(&mut tx, org.0, claims.0.sub.0).await?;
    audit::record_in_tx(
        &mut tx,
        org.0,
        Some(claims.0.sub.0),
        "tickets.discord_bind_code_created",
        Some("discord_guild"),
        None,
        Some(json!({ "expires_at": expires_at.to_rfc3339() })),
    )
    .await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "code": code, "expires_at": expires_at.to_rfc3339() })),
    ))
}

/// GET /tickets/discord (operator, support.respond): the tenant's Discord binding
/// status for the admin UI.
pub async fn discord_status(
    State(state): State<AppState>,
    claims: AuthClaims,
) -> Result<Json<serde_json::Value>, AppError> {
    let org = claims.require(Permission::SupportRespond)?;
    let mut tx = cupboard_db::begin_tenant_tx(&state.app_pool, TenantId::from(org)).await?;
    let config = tickets::get_discord_config_in_tx(&mut tx, org.0).await?;
    tx.commit().await?;
    Ok(Json(match config {
        Some(c) => json!({
            "linked": c.status == "linked",
            "guild_id": c.guild_id,
            "tickets_channel_id": c.tickets_channel_id,
            "staff_role_id": c.staff_role_id,
            "linked_at": c.linked_at.to_rfc3339(),
        }),
        None => json!({ "linked": false }),
    }))
}

#[derive(Deserialize)]
pub struct DiscordBindRequest {
    pub code: String,
    pub guild_id: String,
    pub tickets_channel_id: String,
    #[serde(default)]
    pub staff_role_id: Option<String>,
}

/// POST /internal/tickets/discord/bind (bot; the route group's `require_bot_token`
/// layer has already vetted the caller): redeem a one-time code and link the guild.
/// 401 (generically) for an invalid, expired, or already-used code; 409 when the
/// guild is already linked to a DIFFERENT tenant.
pub async fn internal_discord_bind(
    State(state): State<AppState>,
    Json(req): Json<DiscordBindRequest>,
) -> Result<StatusCode, AppError> {
    if req.code.trim().is_empty()
        || req.guild_id.trim().is_empty()
        || req.tickets_channel_id.trim().is_empty()
    {
        return Err(AppError::BadRequest(
            "code, guild_id, and tickets_channel_id are required".into(),
        ));
    }
    tickets::bind_discord_guild(
        &state.owner_pool,
        req.code.trim(),
        req.guild_id.trim(),
        req.tickets_channel_id.trim(),
        req.staff_role_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

// ============================ Bot relay surface (PR5, decisions D/E/F) ============================
//
// Every route here lives INSIDE the `/internal/tickets` nested router, so the
// structural `require_bot_token` layer has vetted the caller before any handler runs.
// The bot presents ONLY a guild_id; the tenant is resolved server-side from the guild
// binding (decision D) and every ticket access then runs RLS-scoped to that tenant, so
// a valid ticket id from another tenant is a uniform 404. Nothing on this surface
// publishes to the stream: these writes ARE the Discord side (decision F).

/// Resolve the guild's bound tenant (404 for an unknown/unlinked guild) and open the
/// RLS-scoped transaction every bot route works inside.
async fn guild_tenant_tx(
    state: &AppState,
    guild_id: &str,
) -> Result<(Uuid, sqlx::Transaction<'static, sqlx::Postgres>), AppError> {
    let tenant = tickets::resolve_tenant_by_guild(&state.owner_pool, guild_id)
        .await?
        .ok_or_else(|| AppError::NotFound("unknown guild".into()))?;
    let tx = cupboard_db::begin_tenant_tx(&state.app_pool, TenantId(tenant)).await?;
    Ok((tenant, tx))
}

#[derive(Deserialize)]
pub struct GuildQuery {
    pub guild_id: String,
}

#[derive(Deserialize)]
pub struct InternalOpenRequest {
    pub guild_id: String,
    pub opener_discord_user_id: String,
    pub opener_display: String,
    pub subject: String,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
}

/// POST /internal/tickets: open a general ticket from Discord (`/ticket open`). The
/// opening body, when present, lands as the first message with `origin='discord'` and
/// NO discord_message_id (a slash command is an interaction, not a message). Nothing
/// publishes: the bot already has everything it relayed here.
pub async fn internal_open_ticket(
    State(state): State<AppState>,
    Json(req): Json<InternalOpenRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), AppError> {
    let subject = req.subject.trim();
    if subject.is_empty() || subject.chars().count() > MAX_SUBJECT {
        return Err(AppError::BadRequest(format!(
            "subject must be 1 to {MAX_SUBJECT} characters"
        )));
    }
    let opener_id = req.opener_discord_user_id.trim();
    let opener_display = req.opener_display.trim();
    if opener_id.is_empty() || opener_display.is_empty() {
        return Err(AppError::BadRequest(
            "opener_discord_user_id and opener_display are required".into(),
        ));
    }
    let category = req
        .category
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty());
    if category.is_some_and(|c| c.chars().count() > MAX_CATEGORY) {
        return Err(AppError::BadRequest(format!(
            "category must be at most {MAX_CATEGORY} characters"
        )));
    }
    let body = match req.body.as_deref() {
        Some(b) if !b.trim().is_empty() => Some(validate_body(b)?),
        _ => None,
    };

    let (tenant, mut tx) = guild_tenant_tx(&state, req.guild_id.trim()).await?;
    let ticket = tickets::insert_ticket_in_tx(
        &mut tx,
        tenant,
        &tickets::NewTicket {
            ticket_type: "general",
            category,
            subject,
            player_account_id: None,
            opener_discord_user_id: Some(opener_id),
            ban_id: None,
            ban_snapshot: None,
        },
    )
    .await?;
    if let Some(body) = body {
        tickets::insert_message_in_tx(
            &mut tx,
            tenant,
            ticket.id,
            &tickets::NewMessage {
                author_kind: "player",
                author_id: None,
                author_display: opener_display,
                body,
                internal: false,
                origin: "discord",
            },
        )
        .await?;
    }
    audit::record_in_tx(
        &mut tx,
        tenant,
        None,
        "tickets.created",
        Some("ticket"),
        Some(ticket.id),
        Some(json!({
            "type": "general",
            "origin": "discord",
            "opener_discord_user_id": opener_id,
        })),
    )
    .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(json!({ "ticket": ticket }))))
}

/// GET /internal/tickets/{id}?guild_id=: the ticket + its messages for lazy thread
/// creation and backfill. Internal staff notes are excluded at the SQL level (the
/// player-read precedent): they must never reach Discord.
pub async fn internal_get_ticket(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(q): Query<GuildQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let (_tenant, mut tx) = guild_tenant_tx(&state, q.guild_id.trim()).await?;
    let ticket = tickets::get_in_tx(&mut tx, id)
        .await?
        .ok_or_else(|| AppError::NotFound("no such ticket".into()))?;
    let messages = tickets::list_messages_in_tx(&mut tx, id, false).await?;
    tx.commit().await?;
    Ok(Json(json!({ "ticket": ticket, "messages": messages })))
}

/// GET /internal/tickets/by-thread/{thread_id}?guild_id=: thread -> ticket resolution
/// so the bot can relay Discord replies after a restart (its in-memory map is gone).
pub async fn internal_get_by_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Query(q): Query<GuildQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let (_tenant, mut tx) = guild_tenant_tx(&state, q.guild_id.trim()).await?;
    let ticket = tickets::find_by_thread_in_tx(&mut tx, thread_id.trim())
        .await?
        .ok_or_else(|| AppError::NotFound("no such ticket".into()))?;
    tx.commit().await?;
    Ok(Json(json!({ "ticket": ticket })))
}

#[derive(Deserialize)]
pub struct InternalMessageRequest {
    pub guild_id: String,
    pub discord_message_id: String,
    pub author_display: String,
    pub author_kind: String,
    pub body: String,
}

/// POST /internal/tickets/{id}/messages: relay one Discord message into the ticket.
/// Deliveries are at-least-once, so a replayed discord_message_id dedupes to
/// 200 {deduped:true} instead of a second row. A message on a resolved/closed ticket
/// reopens it per the PR3 player-message semantics (same savepoint guard: a sibling
/// open appeal skips the reopen, the message still lands). No stream events for any
/// of this (decision F).
pub async fn internal_post_message(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(req): Json<InternalMessageRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), AppError> {
    if !matches!(req.author_kind.as_str(), "player" | "staff") {
        return Err(AppError::BadRequest(
            "author_kind must be \"player\" or \"staff\"".into(),
        ));
    }
    let body = validate_body(&req.body)?;
    let discord_message_id = req.discord_message_id.trim();
    let author_display = req.author_display.trim();
    if discord_message_id.is_empty() || author_display.is_empty() {
        return Err(AppError::BadRequest(
            "discord_message_id and author_display are required".into(),
        ));
    }

    let (tenant, mut tx) = guild_tenant_tx(&state, req.guild_id.trim()).await?;
    let ticket = tickets::get_in_tx(&mut tx, id)
        .await?
        .ok_or_else(|| AppError::NotFound("no such ticket".into()))?;
    let Some(msg) = tickets::insert_discord_message_in_tx(
        &mut tx,
        tenant,
        ticket.id,
        &tickets::NewDiscordMessage {
            author_kind: &req.author_kind,
            author_display,
            body,
            discord_message_id,
        },
    )
    .await?
    else {
        // Replayed delivery: nothing changed, nothing to commit.
        tx.rollback().await?;
        return Ok((StatusCode::OK, Json(json!({ "deduped": true }))));
    };
    let mut reopened = matches!(ticket.status.as_str(), "resolved" | "closed");
    if reopened {
        reopened = tickets::try_reopen_in_tx(&mut tx, ticket.id).await?;
    }
    if reopened {
        audit::record_in_tx(
            &mut tx,
            tenant,
            None,
            "tickets.status_changed",
            Some("ticket"),
            Some(ticket.id),
            Some(json!({ "from": ticket.status, "to": "open", "reason": "discord_message" })),
        )
        .await?;
    }
    audit::record_in_tx(
        &mut tx,
        tenant,
        None,
        "tickets.message_created",
        Some("ticket"),
        Some(ticket.id),
        Some(json!({
            "message_id": msg.id,
            "internal": false,
            "origin": "discord",
            "discord_message_id": discord_message_id,
        })),
    )
    .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(json!({ "message": msg }))))
}

#[derive(Deserialize)]
pub struct InternalThreadRequest {
    pub guild_id: String,
    pub discord_channel_id: String,
    pub discord_thread_id: String,
}

/// POST /internal/tickets/{id}/discord-thread: record the thread the bot created for
/// this ticket. Idempotent 204 when the same ids are already recorded; 409 when a
/// DIFFERENT thread is (a bot bug guard: a ticket maps to exactly one thread).
pub async fn internal_set_thread(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(req): Json<InternalThreadRequest>,
) -> Result<StatusCode, AppError> {
    let channel_id = req.discord_channel_id.trim();
    let thread_id = req.discord_thread_id.trim();
    if channel_id.is_empty() || thread_id.is_empty() {
        return Err(AppError::BadRequest(
            "discord_channel_id and discord_thread_id are required".into(),
        ));
    }

    let (tenant, mut tx) = guild_tenant_tx(&state, req.guild_id.trim()).await?;
    let ticket = tickets::get_in_tx(&mut tx, id)
        .await?
        .ok_or_else(|| AppError::NotFound("no such ticket".into()))?;
    if tickets::record_discord_thread_in_tx(&mut tx, ticket.id, channel_id, thread_id).await? {
        audit::record_in_tx(
            &mut tx,
            tenant,
            None,
            "tickets.discord_thread_recorded",
            Some("ticket"),
            Some(ticket.id),
            Some(json!({
                "discord_channel_id": channel_id,
                "discord_thread_id": thread_id,
            })),
        )
        .await?;
        tx.commit().await?;
        return Ok(StatusCode::NO_CONTENT);
    }
    tx.rollback().await?;
    // Guarded write declined: a thread is already recorded. Same ids = idempotent
    // retry; different ids = a bot bug (double thread creation), surfaced loudly.
    if ticket.discord_thread_id.as_deref() == Some(thread_id)
        && ticket.discord_channel_id.as_deref() == Some(channel_id)
    {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::Conflict(
            "a different Discord thread is already recorded for this ticket".into(),
        ))
    }
}

#[derive(Deserialize)]
pub struct InternalStatusRequest {
    pub guild_id: String,
    pub status: String,
}

/// POST /internal/tickets/{id}/status: `/ticket close` from Discord. v1 accepts ONLY
/// "closed": Discord-side status control is deliberately minimal (close confirms a
/// finished conversation in the thread; every other transition is the web surface's
/// job). Same operator-path semantics: silent 204 no-op, set_status's sibling-appeal
/// 409 mapping (unreachable for "closed", kept for uniformity), and a NORMAL
/// ticket.status publish; the origin restriction is for relayed message content, and
/// the bot posting the resulting status line in the thread is desirable confirmation.
pub async fn internal_set_status(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(req): Json<InternalStatusRequest>,
) -> Result<StatusCode, AppError> {
    if req.status != "closed" {
        return Err(AppError::BadRequest(
            "only \"closed\" is supported from Discord; other status changes are \
             web-side"
                .into(),
        ));
    }
    let (tenant, mut tx) = guild_tenant_tx(&state, req.guild_id.trim()).await?;
    let ticket = tickets::get_in_tx(&mut tx, id)
        .await?
        .ok_or_else(|| AppError::NotFound("no such ticket".into()))?;
    if ticket.status == req.status {
        tx.rollback().await?;
        return Ok(StatusCode::NO_CONTENT);
    }
    tickets::set_status_in_tx(&mut tx, ticket.id, &req.status).await?;
    audit::record_in_tx(
        &mut tx,
        tenant,
        None,
        "tickets.status_changed",
        Some("ticket"),
        Some(ticket.id),
        Some(json!({ "from": ticket.status, "to": req.status, "origin": "discord" })),
    )
    .await?;
    tx.commit().await?;

    tickets::publish_event(
        &state.bus,
        tickets::status_event(tenant, ticket.id, &req.status),
        false,
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

/// GET /internal/tickets/discord/config?guild_id=: the guild's binding, so the bot can
/// hydrate its guild -> tenant/channel/role caches on boot instead of probing (its
/// restart config-amnesia fix). Returning tenant_id to the bot is fine: stream events
/// already carry it and the bot needs the mapping to route.
pub async fn internal_get_config(
    State(state): State<AppState>,
    Query(q): Query<GuildQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let binding = tickets::get_guild_binding(&state.owner_pool, q.guild_id.trim())
        .await?
        .ok_or_else(|| AppError::NotFound("unknown guild".into()))?;
    Ok(Json(json!({
        "tenant_id": binding.tenant_id,
        "tickets_channel_id": binding.tickets_channel_id,
        "staff_role_id": binding.staff_role_id,
    })))
}

/// DELETE /internal/tickets/{id}/discord-thread {guild_id}: deleted-thread recovery.
/// A Discord admin deleting the ticket thread would otherwise strand the ticket: the
/// guarded record refuses replacements forever. The bot calls this on Discord's
/// Unknown Channel (10003); lazy creation then rebuilds the thread with backfill.
/// Idempotent 204 when nothing is recorded.
pub async fn internal_clear_thread(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(req): Json<GuildQuery>,
) -> Result<StatusCode, AppError> {
    let (tenant, mut tx) = guild_tenant_tx(&state, req.guild_id.trim()).await?;
    let ticket = tickets::get_in_tx(&mut tx, id)
        .await?
        .ok_or_else(|| AppError::NotFound("no such ticket".into()))?;
    if !tickets::clear_discord_thread_in_tx(&mut tx, ticket.id).await? {
        tx.rollback().await?;
        return Ok(StatusCode::NO_CONTENT);
    }
    audit::record_in_tx(
        &mut tx,
        tenant,
        None,
        "tickets.discord_thread_cleared",
        Some("ticket"),
        Some(ticket.id),
        Some(json!({
            "reason": "discord_thread_deleted",
            "discord_channel_id": ticket.discord_channel_id,
            "discord_thread_id": ticket.discord_thread_id,
        })),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
