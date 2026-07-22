//! HTTP surface: router assembly, health probes, and the access-token extractor.

mod billing;
mod domains;
mod internal;
mod player;
mod privacy;
pub mod public;
mod sites;
mod store;
mod tickets;
mod webhooks;

use crate::error::AppError;
use crate::state::AppState;
use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::{header, StatusCode};
use axum::routing::get;
use axum::{Json, Router};
use cupboard_auth_core::Claims;
use cupboard_domain::{OrgId, Permission};
use serde_json::json;
use tower_http::trace::{DefaultMakeSpan, TraceLayer};
use tracing::Level;

/// Assemble the tenant service router.
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        // Operator site management (tenant-scoped, JWT + RBAC via the gateway's
        // `/sites/*` route; this service re-validates and enforces `sites.edit`).
        .route(
            "/sites",
            get(sites::get_site)
                .post(sites::create)
                .patch(sites::update),
        )
        // Custom domains (part of the site surface; `sites.edit`).
        .route("/sites/domains", get(domains::list).post(domains::add))
        .route(
            "/sites/domains/{id}",
            axum::routing::delete(domains::remove),
        )
        .route(
            "/sites/domains/{id}/retry",
            axum::routing::post(domains::retry),
        )
        // Operator store management (gateway `/store/*` route; `store.manage`).
        .route("/store", get(store::get_store))
        .route(
            "/store/connection",
            axum::routing::post(store::connect).delete(store::disconnect),
        )
        .route("/store/sync", axum::routing::post(store::sync_now))
        .route(
            "/store/webhook-secret",
            axum::routing::post(store::set_webhook_secret),
        )
        .route("/store/products", get(store::list_products))
        .route("/store/entitlements", get(store::list_entitlements))
        // Operator platform billing (gateway `/billing/*` route; `billing.manage`).
        .route("/billing/subscription", get(billing::get_subscription))
        .route("/billing/checkout", axum::routing::post(billing::checkout))
        .route("/billing/services", get(billing::services))
        .route(
            "/billing/services/checkout",
            axum::routing::post(billing::services_checkout),
        )
        .route("/billing/portal", axum::routing::post(billing::portal))
        // Operator support tickets (gateway `/tickets/*` route; `support.respond`).
        .route("/tickets", get(tickets::list))
        .route("/tickets/{id}", get(tickets::get_ticket))
        .route(
            "/tickets/{id}/messages",
            axum::routing::post(tickets::post_message),
        )
        .route(
            "/tickets/{id}/status",
            axum::routing::post(tickets::set_status),
        )
        .route("/tickets/{id}/assign", axum::routing::post(tickets::assign))
        // Discord binding for tickets (decision D): status + one-time bind-code mint.
        // Static `/tickets/discord` wins over the `/tickets/{id}` capture in axum.
        .route("/tickets/discord", get(tickets::discord_status))
        .route(
            "/tickets/discord/bind-code",
            axum::routing::post(tickets::mint_bind_code),
        )
        // Player-facing storefront actions (gateway `/player/*` passthrough; the tenant
        // service verifies the PLAYER token itself with the disjoint player keypair).
        .route("/player/checkout", axum::routing::post(player::checkout))
        .route(
            "/player/checkout/{session}/continue",
            axum::routing::post(player::checkout_continue),
        )
        .route("/player/entitlements", get(player::entitlements))
        // Player support tickets + the active-bans appeal picker (same passthrough).
        .route(
            "/player/tickets",
            get(tickets::player_list).post(tickets::player_create),
        )
        .route("/player/tickets/{id}", get(tickets::player_get))
        .route(
            "/player/tickets/{id}/messages",
            axum::routing::post(tickets::player_post_message),
        )
        .route("/player/bans/active", get(tickets::player_active_bans))
        // Provider webhook receiver (NOT via the gateway; public `cupboard-hooks` host,
        // per-connection URL, raw-body HMAC).
        .route(
            "/webhooks/{provider}/{connection_id}",
            axum::routing::post(webhooks::receive),
        )
        // Stripe platform-billing webhook (single merchant, fixed URL on the same
        // public hooks host; raw-body HMAC, Phase 6 decision H).
        .route(
            "/webhooks/stripe",
            axum::routing::post(webhooks::receive_stripe),
        )
        // Public, unauthenticated reads for the storefront SSR path (via the gateway's
        // `/public/*` route; cluster-internal callers only, never internet-exposed).
        .route("/public/sites/resolve", get(public::resolve))
        .route("/public/store/catalog", get(public::catalog))
        // Cross-service internal endpoint: authoritative host -> tenant resolution the
        // auth service uses to validate a storefront host during player login. Not via
        // the gateway; X-Internal-Token guarded.
        .route("/internal/sites/resolve", get(internal::resolve_site))
        // Bot-facing internal surface (decision E): guarded by the DISTINCT
        // BOT_API_TOKEN, never the shared token (and vice versa). The guard is a
        // route_layer on the whole `/internal/tickets` group, so every route PR5 adds
        // under the prefix is covered by construction, not by a per-handler call.
        .nest(
            "/internal/tickets",
            Router::new()
                // Open from Discord (`/ticket open`); the nest root maps to
                // `POST /internal/tickets`.
                .route("/", axum::routing::post(tickets::internal_open_ticket))
                .route(
                    "/discord/bind",
                    axum::routing::post(tickets::internal_discord_bind),
                )
                // Boot-time config hydration for the bot (guild -> tenant/channel/role).
                .route("/discord/config", get(tickets::internal_get_config))
                // Thread -> ticket resolution for the relay (static segment wins
                // over the `{id}` capture).
                .route(
                    "/by-thread/{thread_id}",
                    get(tickets::internal_get_by_thread),
                )
                // Lazy thread creation + backfill (internal notes excluded).
                .route("/{id}", get(tickets::internal_get_ticket))
                .route(
                    "/{id}/messages",
                    axum::routing::post(tickets::internal_post_message),
                )
                // Record the created thread; DELETE is deleted-thread recovery (the
                // bot clears on Unknown Channel and lazy creation rebuilds).
                .route(
                    "/{id}/discord-thread",
                    axum::routing::post(tickets::internal_set_thread)
                        .delete(tickets::internal_clear_thread),
                )
                // `/ticket close` (v1: "closed" only; other transitions are web-side).
                .route(
                    "/{id}/status",
                    axum::routing::post(tickets::internal_set_status),
                )
                .route_layer(axum::middleware::from_fn_with_state(
                    state.clone(),
                    tickets::require_bot_token,
                )),
        )
        // Privacy walkers (Phase 7 decisions A/F): called only by the auth-owned
        // coordinator, guarded by the DISTINCT PRIVACY_TOKEN plane (never the shared
        // or bot tokens). Structural route_layer, the bot-surface precedent.
        .nest(
            "/internal/privacy",
            Router::new()
                .route("/export", axum::routing::post(privacy::export))
                .route("/erase", axum::routing::post(privacy::erase))
                .route_layer(axum::middleware::from_fn_with_state(
                    state.clone(),
                    privacy::check_privacy_token,
                )),
        )
        // `route_layer` so metrics see the matched-path template (bounded cardinality).
        .route_layer(axum::middleware::from_fn(cupboard_telemetry::http::track))
        .layer(TraceLayer::new_for_http().make_span_with(DefaultMakeSpan::new().level(Level::INFO)))
        .with_state(state)
}

/// Liveness: process is up.
async fn healthz(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "service": "cupboard-tenant",
        "environment": state.config.environment,
    }))
}

/// Readiness: the (owner) database answers.
async fn readyz(State(state): State<AppState>) -> (StatusCode, Json<serde_json::Value>) {
    match sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.owner_pool)
        .await
    {
        Ok(_) => (StatusCode::OK, Json(json!({"status": "ready"}))),
        Err(e) => {
            tracing::warn!(error = %e, "readiness check failed");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"status": "not_ready", "reason": "database"})),
            )
        }
    }
}

/// Extractor that verifies the `Authorization: Bearer <jwt>` operator access token and
/// yields its claims. The tenant service validates tokens itself (not just the gateway)
/// so its endpoints are safe even when reached directly. Player tokens (Phase 5 PR3+) are
/// signed with a different keypair and therefore fail verification here by construction.
pub struct AuthClaims(pub Claims);

impl AuthClaims {
    /// The org the token is scoped to, or 400 if the caller holds an org-less token.
    pub fn org(&self) -> Result<OrgId, AppError> {
        self.0.org.ok_or_else(|| {
            AppError::BadRequest(
                "no organization selected; obtain an org-scoped token first".into(),
            )
        })
    }

    /// Require `perm` in the token's active org, returning that org on success.
    pub fn require(&self, perm: Permission) -> Result<OrgId, AppError> {
        let org = self.org()?;
        if self.0.has_permission(perm) {
            Ok(org)
        } else {
            Err(AppError::Forbidden(format!("missing permission: {perm}")))
        }
    }
}

impl FromRequestParts<AppState> for AuthClaims {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.strip_prefix("Bearer "))
            .ok_or_else(|| AppError::Unauthorized("missing bearer token".into()))?;
        let claims = state
            .keys
            .decode(token)
            .map_err(|_| AppError::Unauthorized("invalid or expired token".into()))?;
        Ok(AuthClaims(claims))
    }
}
