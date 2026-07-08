//! Player-facing storefront endpoints (checkout + entitlements). These arrive via the
//! gateway's unauthenticated `/player/*` passthrough; the tenant service verifies the
//! PLAYER access token itself with the disjoint player keypair, so an operator token is
//! rejected here by construction. All 503 when player auth is unconfigured.

use crate::domain::{entitlements, store};
use crate::error::AppError;
use crate::providers::{
    build_client, CheckoutRequest, CheckoutStep, ProviderError, ProviderKind, StoreProvider,
};
use crate::state::AppState;
use axum::extract::{FromRequestParts, Path, State};
use axum::http::header;
use axum::http::request::Parts;
use axum::Json;
use cupboard_auth_core::PlayerClaims;
use cupboard_domain::TenantId;
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

/// Extractor that verifies the `Authorization: Bearer <player-jwt>` and yields the player
/// claims. Uses the player keypair; 503 when player auth is unconfigured.
pub struct Player(pub PlayerClaims);

impl FromRequestParts<AppState> for Player {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let keys = state
            .player_keys
            .as_ref()
            .ok_or_else(|| AppError::Unavailable("player features are not configured".into()))?;
        let token = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.strip_prefix("Bearer "))
            .ok_or_else(|| AppError::Unauthorized("missing player token".into()))?;
        let claims = keys
            .decode(token)
            .map_err(|_| AppError::Unauthorized("invalid or expired player token".into()))?;
        Ok(Player(claims))
    }
}

#[derive(Deserialize)]
pub struct CheckoutRequestBody {
    pub product_external_id: String,
    #[serde(default = "one")]
    pub quantity: i32,
    /// Where the provider returns the buyer after checkout (the storefront's own URLs,
    /// supplied by the web BFF from its verified host).
    pub return_url: String,
    pub cancel_url: String,
}

fn one() -> i32 {
    1
}

/// Validate a provider return/cancel URL. The provider redirects the buyer's browser
/// here after checkout, so an unvalidated value is an open redirect. Require https AND
/// that the URL's host is a storefront owned by THIS player's tenant (resolved
/// authoritatively), so the buyer can only ever be sent back to their own site.
async fn validate_storefront_url(
    state: &AppState,
    tenant: Uuid,
    url: &str,
    field: &str,
) -> Result<(), AppError> {
    let parsed = reqwest::Url::parse(url)
        .map_err(|_| AppError::BadRequest(format!("{field} is not a valid URL")))?;
    if parsed.scheme() != "https" {
        return Err(AppError::BadRequest(format!(
            "{field} must be an https URL"
        )));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| AppError::BadRequest(format!("{field} has no host")))?;
    let resolved =
        match crate::http::public::normalize_and_classify(host, &state.config.sites_suffix) {
            Some((_, crate::domain::sites::SiteLocator::DefaultSubdomain(slug))) => {
                crate::domain::sites::resolve_by_slug(&state.owner_pool, &slug).await?
            }
            // Resolve against the normalized host (a trailing-dot FQDN like
            // `store.example.com.` must match the stored `store.example.com`).
            Some((norm_host, crate::domain::sites::SiteLocator::Custom)) => {
                crate::domain::domains::resolve_by_domain(&state.owner_pool, &norm_host).await?
            }
            None => None,
        };
    match resolved {
        Some(site) if site.tenant_id == tenant => Ok(()),
        _ => Err(AppError::BadRequest(format!(
            "{field} must be your own storefront"
        ))),
    }
}

/// POST /player/checkout: begin a purchase and return the provider's hosted-checkout URL.
pub async fn checkout(
    State(state): State<AppState>,
    player: Player,
    Json(req): Json<CheckoutRequestBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    let claims = &player.0;
    let steam_id = claims
        .steam_id
        .clone()
        .ok_or_else(|| AppError::BadRequest("your account has no linked Steam id".into()))?;
    if !(1..=100).contains(&req.quantity) {
        return Err(AppError::BadRequest(
            "quantity must be between 1 and 100".into(),
        ));
    }
    let tenant_id = claims.tenant.0;
    validate_storefront_url(&state, tenant_id, &req.return_url, "return_url").await?;
    validate_storefront_url(&state, tenant_id, &req.cancel_url, "cancel_url").await?;

    let master_key = state
        .config
        .tenant_master_key
        .ok_or_else(|| AppError::Unavailable("store integration is not configured".into()))?;

    let tenant = TenantId::from(claims.tenant);
    let conn = store::get_connection(&state.app_pool, tenant)
        .await?
        .filter(|c| c.status == "connected")
        .ok_or_else(|| AppError::BadRequest("this store is not accepting checkouts".into()))?;
    let secret = decrypt_credential(&conn, &master_key)?;
    let provider = conn
        .provider
        .parse::<ProviderKind>()
        .map_err(|_| AppError::Internal(anyhow::anyhow!("unknown provider")))?;

    // Create the session first: a two-step (Tebex) checkout needs the session id to build
    // the continue URL it hands the provider as the post-auth returnUrl. For PayNow this is
    // still just the breadcrumb, now with the id returned to the storefront.
    let session_id = entitlements::create_checkout(
        &state.app_pool,
        tenant,
        entitlements::NewCheckout {
            connection_id: conn.id,
            player_account_id: Some(claims.sub),
            steam_id: steam_id.clone(),
            product_external_id: req.product_external_id.clone(),
            quantity: req.quantity,
        },
        None,
    )
    .await?;
    let continue_url = format!(
        "{}/store/checkout/{}/continue",
        origin_of(&req.return_url)
            .ok_or_else(|| AppError::BadRequest("return_url has no origin".into()))?,
        session_id
    );

    // A per-request client (fresh rate limiter) is intentional here: checkout is
    // user-driven and low-frequency (a couple of calls per human purchase), unlike the
    // runner's high-frequency polling where one shared limiter per credential matters.
    let client = build_client(
        provider,
        secret,
        conn.store_external_id.clone(),
        &state.config.provider_bases(),
    );
    let begin = client
        .begin_checkout(&CheckoutRequest {
            steam_id,
            product_external_id: req.product_external_id,
            quantity: req.quantity,
            return_url: req.return_url,
            cancel_url: req.cancel_url,
            continue_url,
        })
        .await
        .map_err(checkout_error)?;

    if let Some(pref) = begin.provider_ref.as_deref() {
        if let Err(e) =
            entitlements::set_checkout_provider_ref(&state.app_pool, tenant, session_id, pref).await
        {
            tracing::warn!(error = ?e, "failed to record checkout provider_ref");
        }
    }

    Ok(Json(json!({
        "redirect_url": begin.redirect_url,
        "step": step_str(begin.step),
        "session_id": session_id,
    })))
}

/// POST /player/checkout/{session}/continue: finish a two-step (Tebex) checkout after the
/// buyer completed the provider auth roundtrip. Returns the hosted-checkout URL.
pub async fn checkout_continue(
    State(state): State<AppState>,
    player: Player,
    Path(session_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    let claims = &player.0;
    let tenant = TenantId::from(claims.tenant);
    let master_key = state
        .config
        .tenant_master_key
        .ok_or_else(|| AppError::Unavailable("store integration is not configured".into()))?;

    let session = entitlements::get_checkout_session(&state.app_pool, tenant, session_id)
        .await?
        .ok_or_else(|| AppError::NotFound("no such checkout".into()))?;
    // Authorize: the session must belong to this player. The account-id binding is
    // authoritative when set (so another account with the same Steam id cannot hijack it);
    // fall back to the Steam id only for a session created before any account link.
    let owns = match session.player_account_id {
        Some(pid) => pid == claims.sub,
        None => claims.steam_id.is_some() && session.steam_id == claims.steam_id,
    };
    if !owns {
        return Err(AppError::Unauthorized("not your checkout".into()));
    }
    let basket = session
        .provider_ref
        .ok_or_else(|| AppError::BadRequest("this checkout has no pending basket".into()))?;

    let conn = store::get_connection(&state.app_pool, tenant)
        .await?
        .filter(|c| c.status == "connected" && c.id == session.connection_id)
        .ok_or_else(|| AppError::BadRequest("this store is not accepting checkouts".into()))?;
    let secret = decrypt_credential(&conn, &master_key)?;
    let provider = conn
        .provider
        .parse::<ProviderKind>()
        .map_err(|_| AppError::Internal(anyhow::anyhow!("unknown provider")))?;

    let steam_id = claims
        .steam_id
        .clone()
        .or_else(|| session.steam_id.clone())
        .unwrap_or_default();
    let client = build_client(
        provider,
        secret,
        conn.store_external_id.clone(),
        &state.config.provider_bases(),
    );
    let begin = client
        .continue_checkout(
            &basket,
            &CheckoutRequest {
                steam_id,
                product_external_id: session.product_external_id,
                quantity: session.quantity,
                return_url: String::new(),
                cancel_url: String::new(),
                continue_url: String::new(),
            },
        )
        .await
        .map_err(checkout_error)?;

    Ok(Json(json!({ "redirect_url": begin.redirect_url })))
}

/// Decrypt a connection's sealed credential (PayNow API key / Tebex Game Server secret).
fn decrypt_credential(
    conn: &store::StoreConnection,
    master_key: &[u8; 32],
) -> Result<String, AppError> {
    let (Some(enc), Some(dek)) = (conn.api_key_enc.clone(), conn.api_key_dek.clone()) else {
        return Err(AppError::BadRequest("this store is not connected".into()));
    };
    String::from_utf8(
        cupboard_crypto::open(
            master_key,
            &cupboard_crypto::Envelope {
                wrapped_dek: dek,
                ciphertext: enc,
            },
        )
        .map_err(|e| AppError::Internal(anyhow::Error::new(e)))?,
    )
    .map_err(|_| AppError::Internal(anyhow::anyhow!("stored credential is not UTF-8")))
}

/// The scheme+host(+port) origin of a URL (used to build the continue URL on the buyer's
/// own storefront host); `None` for opaque origins.
fn origin_of(url: &str) -> Option<String> {
    let origin = reqwest::Url::parse(url).ok()?.origin();
    origin.is_tuple().then(|| origin.ascii_serialization())
}

fn step_str(step: CheckoutStep) -> &'static str {
    match step {
        CheckoutStep::Final => "final",
        CheckoutStep::NeedsProviderAuth => "needs_provider_auth",
    }
}

fn checkout_error(e: ProviderError) -> AppError {
    match e {
        ProviderError::Auth(m) => {
            tracing::warn!(error = %m, "provider auth error during checkout");
            AppError::Unavailable("the store is temporarily unavailable".into())
        }
        ProviderError::Rejected(m) => AppError::BadRequest(m),
        ProviderError::Transient(m) => {
            tracing::warn!(error = %m, "transient provider error during checkout");
            AppError::Unavailable("could not start checkout; please try again".into())
        }
    }
}

/// GET /player/entitlements: the player's active entitlements for their tenant.
pub async fn entitlements(
    State(state): State<AppState>,
    player: Player,
) -> Result<Json<serde_json::Value>, AppError> {
    let claims = &player.0;
    let Some(steam_id) = claims.steam_id.clone() else {
        return Ok(Json(json!({ "entitlements": [] })));
    };
    let list =
        entitlements::list_active_for_steam(&state.owner_pool, claims.tenant.0, &steam_id).await?;
    Ok(Json(json!({ "entitlements": list })))
}
