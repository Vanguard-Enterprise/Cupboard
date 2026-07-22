//! Cupboard Tenant binary: see the crate docs (`lib.rs`) for the architecture. Boots
//! telemetry, opens two Postgres pools (owner for migrations + cross-tenant public site
//! resolution, `cupboard_app` for RLS-scoped operator CRUD), ensures and migrates the
//! service-owned `tenant` schema, connects the site-resolve cache, then serves HTTP.

use anyhow::Context as _;
use cupboard_auth_core::Keys;
use cupboard_tenant::cache::SiteCache;
use cupboard_tenant::config::Config;
use cupboard_tenant::http;
use cupboard_tenant::state::AppState;
use std::net::SocketAddr;
use std::sync::Arc;

/// Tenant owns the `tenant` Postgres schema; pinning the search path keeps its objects
/// and its `_sqlx_migrations` ledger isolated from other services in the shared database.
const SEARCH_PATH: &str = "tenant,public";

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = Config::from_env()?;

    let _otel_guard = cupboard_telemetry::init("cupboard-tenant", config.otel_endpoint.as_deref());
    tracing::info!(
        env = %config.environment,
        sites_suffix = %config.sites_suffix,
        "starting cupboard-tenant"
    );

    // Owner pool: migrations + cross-tenant public reads (site resolution).
    let owner_pool =
        cupboard_db::connect_scoped(&config.database_url, config.db_max_connections, SEARCH_PATH)
            .await?;
    sqlx::query("CREATE SCHEMA IF NOT EXISTS tenant")
        .execute(&owner_pool)
        .await
        .context("create tenant schema")?;
    cupboard_db::run_migrations(&owner_pool, &MIGRATOR).await?;

    // App pool: request-scoped tenant CRUD (RLS enforced via the non-owner role).
    let app_pool = cupboard_db::connect_scoped(
        &config.database_url_app,
        config.db_max_connections,
        SEARCH_PATH,
    )
    .await?;

    let keys = Keys::verifier_from_ed_pem(&config.jwt_public_key_pem)
        .context("load Ed25519 JWT verifier")?;

    // Site-resolve cache: best-effort. A missing REDIS_URL or an unreachable Redis only
    // costs cache hits, never availability: resolution falls back to Postgres, and the
    // connection is established lazily so a Redis outage at boot self-heals.
    let cache = match &config.redis_url {
        Some(url) => match SiteCache::new(url) {
            Ok(cache) => cache,
            Err(e) => {
                tracing::warn!(error = %e, "invalid REDIS_URL; site-resolve cache disabled");
                SiteCache::disabled()
            }
        },
        None => {
            tracing::warn!("REDIS_URL unset; site-resolve cache disabled");
            SiteCache::disabled()
        }
    };

    // Ticket event bus (Phase 6 decision E): best-effort, mirroring the cache branch.
    // Unset/unreachable Redis only costs Discord sync (decision G: web tickets never
    // depend on Redis); publish failures at runtime are logged and swallowed.
    let bus = match &config.redis_url {
        Some(url) => match cupboard_bus::Bus::connect(url).await {
            Ok(bus) => Some(bus),
            Err(e) => {
                tracing::warn!(error = %e, "Redis unreachable; ticket event publishing disabled");
                None
            }
        },
        None => {
            tracing::warn!("REDIS_URL unset; ticket event publishing disabled");
            None
        }
    };

    // Player token verifier (checkout + entitlement reads). Disjoint keypair from the
    // operator one; absent -> the /player/* surface returns 503.
    let player_keys = match &config.player_jwt_public_key_pem {
        Some(pem) => match cupboard_auth_core::PlayerKeys::verifier_from_ed_pem(pem) {
            Ok(k) => Some(Arc::new(k)),
            Err(e) => {
                tracing::warn!(error = %e, "invalid PLAYER_JWT_PUBLIC_KEY_PEM; player surface disabled");
                None
            }
        },
        None => None,
    };

    let state = AppState {
        owner_pool,
        app_pool,
        keys: Arc::new(keys),
        player_keys,
        cache,
        site_miss_budget: Arc::new(Default::default()),
        catalog_miss_budget: Arc::new(Default::default()),
        http: reqwest::Client::new(),
        bus,
        verified_prices: Arc::new(Default::default()),
        config: Arc::new(config.clone()),
    };

    // Store runner subsystem: only when the commerce master key is configured
    // (fail-safe like identity's BM supervisor).
    if config.tenant_master_key.is_some() {
        tokio::spawn(cupboard_tenant::store::supervisor::run(
            state.owner_pool.clone(),
            state.cache.clone(),
            Arc::new(config.clone()),
        ));
    }

    // Billing reconcile loop: one plain 15-minute loop, only when Stripe is configured
    // (Phase 6 decision H; the domains_loop seam, no supervisor machinery).
    if config.stripe_secret_key.is_some() {
        tokio::spawn(cupboard_tenant::billing_loop::run(
            state.owner_pool.clone(),
            state.http.clone(),
            Arc::new(config.clone()),
        ));
    }

    // Retention/purge loop (Phase 7 decisions #3/E): always on, needs only the owner
    // pool. Redis is optional; the stream trim skips with a log when it is absent.
    tokio::spawn(cupboard_tenant::retention_loop::run(
        state.owner_pool.clone(),
        Arc::new(config.clone()),
    ));

    // Custom-domain TLS loop: only when running in a cluster with the ServiceAccount
    // that can create Certificate/IngressRoute CRs. Absent (local/dev) => domains can be
    // added but stay pending; no automation runs.
    match cupboard_tenant::certmgr::KubeProvisioner::from_in_cluster(
        config.cert_namespace.clone(),
        config.cert_issuer.clone(),
        config.web_service_name.clone(),
        config.web_service_port,
        config.ingress_class.clone(),
    ) {
        Some(provisioner) => {
            tracing::info!(
                namespace = %config.cert_namespace,
                issuer = %config.cert_issuer,
                edge = config.edge_hostname.as_deref().unwrap_or("<none>"),
                "custom-domain TLS loop enabled"
            );
            tokio::spawn(cupboard_tenant::domains_loop::run(
                state.owner_pool.clone(),
                Arc::new(provisioner),
                state.cache.clone(),
                cupboard_tenant::domains_loop::DomainsConfig {
                    edge_hostname: config.edge_hostname.clone(),
                },
            ));
        }
        None => {
            tracing::info!("no in-cluster ServiceAccount; custom-domain TLS automation disabled");
        }
    }

    let app = http::router(state);

    let addr: SocketAddr = config.bind_addr.parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "tenant listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    tracing::info!("tenant stopped; flushing telemetry");
    Ok(())
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
