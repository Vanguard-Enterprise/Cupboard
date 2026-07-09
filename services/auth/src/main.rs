//! Cupboard Auth — operator accounts, sessions/JWT, tenant orgs, custom RBAC, and
//! staff invites (Phase 1).
//!
//! Boots telemetry, opens two Postgres pools (owner for migrations/system work,
//! `cupboard_app` for RLS-scoped request work), ensures and migrates the service-owned
//! `auth` schema, seeds the permission catalog from code, then serves the HTTP API.

use anyhow::Context as _;
use axum_extra::extract::cookie::Key;
use base64::Engine as _;
use cupboard_auth::config::Config;
use cupboard_auth::http;
use cupboard_auth::state::AppState;
use cupboard_auth_core::Keys;
use cupboard_domain::Permission;
use sqlx::PgPool;
use std::net::SocketAddr;
use std::sync::Arc;

/// Auth owns the `auth` Postgres schema; pinning the search path keeps its objects and
/// its `_sqlx_migrations` ledger isolated from the gateway's in the shared database.
const SEARCH_PATH: &str = "auth,public";

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = Config::from_env()?;

    let _otel_guard = cupboard_telemetry::init("cupboard-auth", config.otel_endpoint.as_deref());
    tracing::info!(env = %config.environment, "starting cupboard-auth");

    // Owner pool: migrations + cross-tenant/system operations.
    let owner_pool =
        cupboard_db::connect_scoped(&config.database_url, config.db_max_connections, SEARCH_PATH)
            .await?;
    // Ensure the schema exists before the migrator tries to create its ledger in it.
    sqlx::query("CREATE SCHEMA IF NOT EXISTS auth")
        .execute(&owner_pool)
        .await
        .context("create auth schema")?;
    cupboard_db::run_migrations(&owner_pool, &MIGRATOR).await?;
    seed_permission_catalog(&owner_pool).await?;

    // App pool: request-scoped tenant access (RLS enforced via the non-owner role).
    let app_pool = cupboard_db::connect_scoped(
        &config.database_url_app,
        config.db_max_connections,
        SEARCH_PATH,
    )
    .await?;

    let keys = Keys::from_ed_pem(&config.jwt_private_key_pem, &config.jwt_public_key_pem)
        .context("load Ed25519 JWT keys")?;
    let player_keys = match &config.player {
        Some(p) => {
            let pk = cupboard_auth_core::PlayerKeys::from_ed_pem(
                &p.jwt_private_key_pem,
                &p.jwt_public_key_pem,
            )
            .context("load Ed25519 PLAYER JWT keys")?;
            tracing::info!("player auth enabled (/auth/player/*)");
            Some(Arc::new(pk))
        }
        None => None,
    };
    let cookie_key = build_cookie_key(&config)?;
    let http_client = reqwest::Client::builder()
        .build()
        .context("build HTTP client")?;

    let state = AppState {
        owner_pool,
        app_pool,
        keys: Arc::new(keys),
        player_keys,
        config: Arc::new(config.clone()),
        http: http_client,
        cookie_key,
    };

    let app = http::router(state);

    let addr: SocketAddr = config.bind_addr.parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "auth listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    tracing::info!("auth stopped; flushing telemetry");
    Ok(())
}

/// Upsert the code-defined permission catalog into the reference table so the dashboard
/// can list it and `role_permissions` can FK it. Idempotent; runs every boot.
async fn seed_permission_catalog(pool: &PgPool) -> anyhow::Result<()> {
    for p in Permission::ALL {
        sqlx::query(
            "INSERT INTO permission_catalog (permission, area, description) VALUES ($1, $2, $3) \
             ON CONFLICT (permission) DO UPDATE \
             SET area = EXCLUDED.area, description = EXCLUDED.description",
        )
        .bind(p.as_str())
        .bind(p.area())
        .bind(p.description())
        .execute(pool)
        .await?;
    }
    tracing::info!(count = Permission::ALL.len(), "permission catalog seeded");
    Ok(())
}

/// Build the signed-cookie key for OAuth state from `COOKIE_SIGNING_KEY` (base64, ≥64
/// bytes). `None` when unset (Discord disabled).
fn build_cookie_key(config: &Config) -> anyhow::Result<Option<Key>> {
    match &config.cookie_signing_key {
        Some(b64) => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64.trim())
                .context("COOKIE_SIGNING_KEY must be valid base64")?;
            if bytes.len() < 64 {
                anyhow::bail!("COOKIE_SIGNING_KEY must decode to at least 64 bytes");
            }
            Ok(Some(Key::from(&bytes)))
        }
        None => Ok(None),
    }
}

/// Resolves on SIGTERM (Kubernetes) or Ctrl-C, letting in-flight requests drain.
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
