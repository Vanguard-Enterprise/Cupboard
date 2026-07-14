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
