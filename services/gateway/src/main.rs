//! Cupboard Gateway — the front door.
//!
//! Boots telemetry + Postgres, then serves: health probes, an unauthenticated
//! reverse-proxy of `/auth/*` to the auth service, and JWT-validated `/api/*` routes
//! that carry the verified [`Claims`] downstream. The RBAC permission gate and real
//! tenant data routes land in later steps/phases.

mod api_v1;
mod auth;
mod config;
mod proxy;

use axum::{
    extract::State,
    http::StatusCode,
    routing::{any, get},
    Extension, Json, Router,
};
use config::Config;
use cupboard_auth_core::{Claims, Keys};
use cupboard_domain::Permission;
use serde_json::json;
use sqlx::PgPool;
use std::net::SocketAddr;
use std::sync::Arc;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[derive(Clone)]
pub(crate) struct AppState {
    pub pool: PgPool,
    pub environment: String,
    /// Verify-only key set (auth holds the private signing key). `None` until the JWT
    /// public key is configured — protected routes then fail closed (503).
    pub keys: Option<Arc<Keys>>,
    /// Client for reverse-proxying to internal services.
    pub http: reqwest::Client,
    pub auth_service_url: String,
    pub fleet_service_url: String,
    pub identity_service_url: String,
    pub collector_service_url: String,
    pub metrics_service_url: String,
    pub tenant_service_url: String,
    /// Shared secret for auth's cluster-internal API-key exchange. `None` = exchange
    /// disabled: `/api/v1` requests needing a fresh exchange fail closed (503).
    pub internal_api_token: Option<String>,
    /// In-process cache of API-key exchanges for `/api/v1` (Phase 6 decision M).
    pub key_cache: Arc<api_v1::key_auth::KeyCache>,
    /// Redis fixed-window rate limiter for `/api/v1` (Phase 6 decision N). Disabled
    /// (no REDIS_URL) or unreachable = fail open.
    pub limiter: api_v1::rate_limit::Limiter,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = Config::from_env()?;

    // Hold the guard for the whole process; it drops at the end of `main` (after
    // the server stops), flushing any buffered spans and metrics.
    let _otel_guard = cupboard_telemetry::init("cupboard-gateway", config.otel_endpoint.as_deref());
    tracing::info!(env = %config.environment, "starting cupboard-gateway");

    let pool = cupboard_db::connect(&config.database_url, config.db_max_connections).await?;
    cupboard_db::run_migrations(&pool, &MIGRATOR).await?;

    let keys = match config.jwt_public_key_pem.as_deref() {
        Some(pem) => Some(Arc::new(Keys::verifier_from_ed_pem(pem)?)),
        None => {
            tracing::warn!(
                "JWT_PUBLIC_KEY_PEM not set — token-protected /api routes will return 503 \
                 until it is configured (the /auth proxy and health probes still work)"
            );
            None
        }
    };
    let limiter = match config.redis_url.as_deref() {
        Some(url) => api_v1::rate_limit::Limiter::new(url)?,
        None => {
            tracing::warn!(
                "REDIS_URL not set: the /api/v1 rate limiter is disabled and fails OPEN \
                 (requests pass unlimited)"
            );
            api_v1::rate_limit::Limiter::disabled()
        }
    };
    if config.internal_api_token.is_none() {
        tracing::warn!(
            "INTERNAL_API_TOKEN not set: the API-key exchange is disabled, so /api/v1 \
             requests needing a fresh exchange will return 503 until it is configured"
        );
    }

    let state = AppState {
        pool,
        environment: config.environment.clone(),
        keys,
        // No redirect following: as a reverse proxy we must pass upstream 3xx responses
        // through to the client unchanged. Otherwise an auth OAuth-start endpoint that
        // returns 303 -> discord.com would be chased here and the provider's page returned
        // in place of the redirect, breaking the browser OAuth flow.
        http: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()?,
        auth_service_url: config.auth_service_url.clone(),
        fleet_service_url: config.fleet_service_url.clone(),
        identity_service_url: config.identity_service_url.clone(),
        collector_service_url: config.collector_service_url.clone(),
        metrics_service_url: config.metrics_service_url.clone(),
        tenant_service_url: config.tenant_service_url.clone(),
        internal_api_token: config.internal_api_token.clone(),
        key_cache: Arc::new(api_v1::key_auth::KeyCache::default()),
        limiter,
    };

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        // Unauthenticated passthrough to the auth service (login/signup precede a token).
        .route("/auth/{*path}", any(proxy::proxy_auth))
        // Push ingestion from game servers (plugin/perf mod). Not JWT-gated — the
        // collector authenticates per-server ingest tokens.
        .route("/ingest/{*path}", any(proxy::proxy_ingest))
        // Authenticated passthrough to the fleet service. `require_auth` validates the
        // token at the door; fleet re-validates and enforces `servers.*` RBAC.
        .route(
            "/fleet/{*path}",
            any(proxy::proxy_fleet).layer(axum::middleware::from_fn_with_state(
                state.clone(),
                auth::require_auth,
            )),
        )
        // Authenticated passthrough to the identity service (player list + profiles).
        // `/players` (list) and `/players/{id}` (profile) both need forwarding.
        .route(
            "/players",
            any(proxy::proxy_identity).layer(axum::middleware::from_fn_with_state(
                state.clone(),
                auth::require_auth,
            )),
        )
        .route(
            "/players/{*path}",
            any(proxy::proxy_identity).layer(axum::middleware::from_fn_with_state(
                state.clone(),
                auth::require_auth,
            )),
        )
        // Chat logs (identity service).
        .route(
            "/chat",
            any(proxy::proxy_identity).layer(axum::middleware::from_fn_with_state(
                state.clone(),
                auth::require_auth,
            )),
        )
        // Perf dashboards + recommendations (metrics service).
        .route(
            "/perf/{*path}",
            any(proxy::proxy_metrics).layer(axum::middleware::from_fn_with_state(
                state.clone(),
                auth::require_auth,
            )),
        )
        // F7 reports (identity service).
        .route(
            "/reports",
            any(proxy::proxy_identity).layer(axum::middleware::from_fn_with_state(
                state.clone(),
                auth::require_auth,
            )),
        )
        // Bans (identity service): list/create + revoke.
        .route(
            "/bans",
            any(proxy::proxy_identity).layer(axum::middleware::from_fn_with_state(
                state.clone(),
                auth::require_auth,
            )),
        )
        .route(
            "/bans/{*path}",
            any(proxy::proxy_identity).layer(axum::middleware::from_fn_with_state(
                state.clone(),
                auth::require_auth,
            )),
        )
        // Ban-evasion alerts (identity service).
        .route(
            "/evasion",
            any(proxy::proxy_identity).layer(axum::middleware::from_fn_with_state(
                state.clone(),
                auth::require_auth,
            )),
        )
        .route(
            "/evasion/{*path}",
            any(proxy::proxy_identity).layer(axum::middleware::from_fn_with_state(
                state.clone(),
                auth::require_auth,
            )),
        )
        // BattleMetrics integration (identity service): connection, import, sync.
        // Identity enforces `integrations.manage`.
        .route(
            "/integrations/{*path}",
            any(proxy::proxy_identity).layer(axum::middleware::from_fn_with_state(
                state.clone(),
                auth::require_auth,
            )),
        )
        // Store/commerce management (tenant service). Tenant enforces `store.manage`.
        .route(
            "/store",
            any(proxy::proxy_tenant).layer(axum::middleware::from_fn_with_state(
                state.clone(),
                auth::require_auth,
            )),
        )
        .route(
            "/store/{*path}",
            any(proxy::proxy_tenant).layer(axum::middleware::from_fn_with_state(
                state.clone(),
                auth::require_auth,
            )),
        )
        // Support tickets (tenant service). Tenant enforces `support.respond`; the
        // player ticket surface rides the existing `/player/{*path}` passthrough.
        .route(
            "/tickets",
            any(proxy::proxy_tenant).layer(axum::middleware::from_fn_with_state(
                state.clone(),
                auth::require_auth,
            )),
        )
        .route(
            "/tickets/{*path}",
            any(proxy::proxy_tenant).layer(axum::middleware::from_fn_with_state(
                state.clone(),
                auth::require_auth,
            )),
        )
        // Platform billing (tenant service). Tenant enforces `billing.manage`.
        .route(
            "/billing",
            any(proxy::proxy_tenant).layer(axum::middleware::from_fn_with_state(
                state.clone(),
                auth::require_auth,
            )),
        )
        .route(
            "/billing/{*path}",
            any(proxy::proxy_tenant).layer(axum::middleware::from_fn_with_state(
                state.clone(),
                auth::require_auth,
            )),
        )
        // White-label site management (tenant service). Tenant enforces `sites.edit`.
        .route(
            "/sites",
            any(proxy::proxy_tenant).layer(axum::middleware::from_fn_with_state(
                state.clone(),
                auth::require_auth,
            )),
        )
        .route(
            "/sites/{*path}",
            any(proxy::proxy_tenant).layer(axum::middleware::from_fn_with_state(
                state.clone(),
                auth::require_auth,
            )),
        )
        // Public storefront reads (tenant service): site resolution + (later) catalog.
        // Deliberately NOT behind the JWT gate: callers are the web app's SSR path for
        // public tenant sites; the tenant service rate/shape-guards these itself.
        .route("/public/{*path}", any(proxy::proxy_tenant))
        // Player storefront actions (checkout + entitlements) -> tenant. NOT behind the
        // operator JWT gate: the tenant service verifies the PLAYER token itself with the
        // disjoint player keypair (an operator token is rejected there).
        .route("/player/{*path}", any(proxy::proxy_tenant))
        // A JWT-validated route proving front-door auth; real /api routes follow.
        .route(
            "/api/whoami",
            get(whoami).layer(axum::middleware::from_fn_with_state(
                state.clone(),
                auth::require_auth,
            )),
        )
        // RBAC-gated example: requires `org.manage` in the token's active org. Demonstrates
        // the gateway permission gate that real downstream /api routes will reuse.
        .route(
            "/api/admin/ping",
            get(admin_ping)
                // Innermost: require `org.manage` against the injected claims.
                .layer(axum::middleware::from_fn(require_org_manage))
                // Outermost: validate the token and inject the claims first.
                .layer(axum::middleware::from_fn_with_state(
                    state.clone(),
                    auth::require_auth,
                )),
        )
        // The /api/v1 public-API facade (Phase 6): require_api_key -> rate_limit ->
        // typed endpoints, plus the unauthenticated OpenAPI/Scalar docs routes. See
        // api_v1::router for the middleware ordering and the envelope contract.
        .merge(api_v1::router(state.clone()))
        // `route_layer` so the metrics middleware sees the matched-path template
        // (bounded cardinality); see `cupboard_telemetry::http`.
        .route_layer(axum::middleware::from_fn(cupboard_telemetry::http::track))
        // INFO-level spans so the default `info` filter keeps them and they
        // export as traces (DefaultMakeSpan is DEBUG, which the filter drops).
        .layer(cupboard_telemetry::http::http_trace_layer())
        .with_state(state);

    let addr: SocketAddr = config.bind_addr.parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "gateway listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    tracing::info!("gateway stopped; flushing telemetry");
    Ok(())
}

/// Resolves when the process receives SIGTERM (Kubernetes pod termination) or
/// Ctrl-C, letting in-flight requests drain and telemetry flush before exit.
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("install Ctrl-C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received");
}

/// Liveness — process is up. Always 200 unless the process is dead.
async fn healthz(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "service": "cupboard-gateway",
        "environment": state.environment,
    }))
}

/// A minimal JWT-protected endpoint: echoes the verified claims. Proves the gateway
/// validates tokens and exposes the tenant/permission context to downstream handlers.
async fn whoami(Extension(claims): Extension<Claims>) -> Json<serde_json::Value> {
    Json(json!({
        "user_id": claims.sub,
        "org": claims.org,
        "permissions": claims.perms,
    }))
}

/// RBAC-gated demo endpoint — only reachable with `org.manage`; proves the gateway's
/// permission gate.
async fn admin_ping(Extension(claims): Extension<Claims>) -> Json<serde_json::Value> {
    Json(json!({ "pong": true, "org": claims.org }))
}

/// The gateway RBAC gate for the demo route: require `org.manage` in the (already
/// validated) claims. Real `/api/*` routes for downstream services replicate this with
/// their own required permission.
async fn require_org_manage(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Result<axum::response::Response, StatusCode> {
    // Compute the decision before moving `req` into `next.run`.
    let decision = match req.extensions().get::<Claims>() {
        Some(claims) if claims.has_permission(Permission::OrgManage) => Ok(()),
        Some(_) => Err(StatusCode::FORBIDDEN),
        None => Err(StatusCode::UNAUTHORIZED),
    };
    match decision {
        Ok(()) => Ok(next.run(req).await),
        Err(status) => Err(status),
    }
}

/// Readiness — dependencies reachable. 200 only if the database answers.
async fn readyz(State(state): State<AppState>) -> (StatusCode, Json<serde_json::Value>) {
    match sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.pool)
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
