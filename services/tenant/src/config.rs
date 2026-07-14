//! Runtime configuration, read from the environment (Vault → ExternalSecret → env
//! in-cluster; a local `.env`/shell for development).

use std::env;

#[derive(Clone)]
pub struct Config {
    pub bind_addr: String,
    /// Owner-role connection: migrations + cross-tenant public reads (RLS-exempt).
    pub database_url: String,
    /// `cupboard_app` (non-owner) connection: request-scoped tenant CRUD (RLS applies).
    /// Falls back to the owner URL in local dev (logged), where RLS then does not isolate.
    pub database_url_app: String,
    pub db_max_connections: u32,
    pub environment: String,
    pub otel_endpoint: Option<String>,

    /// Ed25519 public key (PEM) for verifying operator access tokens minted by auth.
    /// Required: every non-public, non-health route is operator-authenticated.
    pub jwt_public_key_pem: String,

    /// Redis, for the site-resolve cache on the public SSR path. Optional: when unset the
    /// cache is disabled and every resolve hits Postgres (fine in dev, not in staging).
    pub redis_url: Option<String>,

    /// The base domain under which every tenant site gets its default hostname
    /// (`{slug}.{sites_suffix}`). Staging: `sites.vngenterprise.com`.
    pub sites_suffix: String,

    /// 32-byte envelope master key (base64, from Vault) wrapping per-connection store
    /// provider credentials. `None` disables the commerce integration entirely (no
    /// runner; connect endpoints 503) so the service ships before the Vault key exists.
    pub tenant_master_key: Option<[u8; 32]>,

    /// This replica's name, used as the store-runner claimer id (unique per replica).
    pub consumer_name: String,

    /// PayNow API base, injectable so tests run against the in-process stub.
    pub paynow_api_base: String,

    /// Tebex API bases, injectable so tests run against the in-process stub. Headless
    /// serves the catalog + checkout basket flow (public token in the path); the plugin
    /// (Game Server) base serves credential validation + the reconcile payments walk.
    pub tebex_headless_base: String,
    pub tebex_plugin_base: String,

    /// Shared secret the auth service presents (`X-Internal-Token`) to the cross-service
    /// `/internal/*` endpoints (host -> tenant resolution on the player-login path).
    /// `None` disables those endpoints (fail closed).
    pub internal_api_token: Option<String>,

    /// Ed25519 PUBLIC key (PEM) for verifying PLAYER access tokens (checkout +
    /// entitlement reads). Disjoint from the operator key. `None` disables the
    /// `/player/*` surface (503).
    pub player_jwt_public_key_pem: Option<String>,

    /// Public base URL where providers deliver webhooks (e.g.
    /// `https://cupboard-hooks.vngenterprise.com`). The runner registers a per-connection
    /// endpoint `{base}/webhooks/{provider}/{connection_id}`. `None` = no auto webhook
    /// registration (the reconcile poll still keeps the ledger current).
    pub public_webhook_base: Option<String>,

    /// The stable edge hostname operators CNAME their custom domains at (e.g.
    /// `edge.vngenterprise.com`). Shown in the domains UI; also DNS-resolved to the IPs
    /// a custom domain must point at before issuance is attempted.
    pub edge_hostname: Option<String>,
    /// Custom-domain TLS automation (cert-manager `Certificate` + Traefik `IngressRoute`
    /// created in this namespace). All must be set for the domain loop to run.
    pub cert_namespace: String,
    pub cert_issuer: String,
    pub web_service_name: String,
    pub web_service_port: u16,
    /// Ingress class annotation for the per-domain IngressRoute. Must match the external
    /// Traefik's kubernetescrd `ingressClass`, else the route is ignored (default cert + 404).
    pub ingress_class: String,

    /// Stripe platform billing (Phase 6 decision H; single merchant, OpenBao
    /// `cupboard/staging/stripe`, NOT envelope-encrypted). `None` disables billing:
    /// no reconcile loop, checkout/portal endpoints 503. Write-only: never logged,
    /// never returned by any API.
    pub stripe_secret_key: Option<String>,
    /// Webhook endpoint signing secret. `None` => `/webhooks/stripe` returns 503.
    pub stripe_webhook_secret: Option<String>,
    /// Stripe price ids mapping paid plans/services to the code-defined catalog
    /// (decision I). Custom Design is read now, consumed by PR2 slice 2.
    pub stripe_price_team: Option<String>,
    pub stripe_price_enterprise: Option<String>,
    pub stripe_price_custom_design: Option<String>,
    /// Stripe API base, injectable so tests run against the in-process stub.
    pub stripe_api_base: String,
    /// Auth service base URL for the plan-mirror push (decision K).
    pub auth_internal_url: String,
    /// The DISTINCT token guarding auth's `PUT /internal/orgs/{id}/plan` (decision K;
    /// never the shared INTERNAL_API_TOKEN). `None` => mirror pushes are skipped (logged).
    pub plan_write_token: Option<String>,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let database_url =
            env::var("DATABASE_URL").map_err(|_| anyhow::anyhow!("DATABASE_URL is required"))?;
        let database_url_app = match env::var("DATABASE_URL_APP") {
            Ok(url) => url,
            Err(_) => {
                tracing::warn!(
                    "DATABASE_URL_APP unset; falling back to the owner role. RLS will NOT \
                     isolate tenants on the app pool. Set the cupboard_app URL outside dev."
                );
                database_url.clone()
            }
        };

        let jwt_public_key_pem = env::var("JWT_PUBLIC_KEY_PEM")
            .map_err(|_| anyhow::anyhow!("JWT_PUBLIC_KEY_PEM is required"))?;

        Ok(Self {
            bind_addr: env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into()),
            database_url,
            database_url_app,
            db_max_connections: env::var("DB_MAX_CONNECTIONS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(10),
            environment: env::var("ENVIRONMENT").unwrap_or_else(|_| "development".into()),
            otel_endpoint: env::var("OTEL_EXPORTER_OTLP_ENDPOINT").ok(),
            jwt_public_key_pem,
            redis_url: env::var("REDIS_URL").ok().filter(|s| !s.is_empty()),
            sites_suffix: env::var("SITES_SUFFIX")
                .ok()
                .filter(|s| !s.is_empty())
                .map(|s| s.trim_matches('.').to_ascii_lowercase())
                .unwrap_or_else(|| "sites.localhost".into()),
            tenant_master_key: match env::var("TENANT_MASTER_KEY") {
                Ok(b64) if !b64.is_empty() => Some(cupboard_crypto::decode_master_key(
                    &b64,
                    "TENANT_MASTER_KEY",
                )?),
                _ => {
                    tracing::warn!(
                        "TENANT_MASTER_KEY unset; store provider integration disabled \
                         (no runner, connect endpoints return 503)"
                    );
                    None
                }
            },
            consumer_name: env::var("CONSUMER_NAME")
                .or_else(|_| env::var("HOSTNAME"))
                .unwrap_or_else(|_| "tenant-1".into()),
            paynow_api_base: env::var("PAYNOW_API_BASE")
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| crate::providers::paynow::DEFAULT_BASE.into()),
            tebex_headless_base: env::var("TEBEX_HEADLESS_BASE")
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| crate::providers::tebex::DEFAULT_HEADLESS_BASE.into()),
            tebex_plugin_base: env::var("TEBEX_PLUGIN_BASE")
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| crate::providers::tebex::DEFAULT_PLUGIN_BASE.into()),
            internal_api_token: env::var("INTERNAL_API_TOKEN")
                .ok()
                .filter(|s| !s.is_empty()),
            player_jwt_public_key_pem: env::var("PLAYER_JWT_PUBLIC_KEY_PEM")
                .ok()
                .filter(|s| !s.is_empty()),
            public_webhook_base: env::var("PUBLIC_WEBHOOK_BASE")
                .ok()
                .filter(|s| !s.is_empty())
                .map(|s| s.trim_end_matches('/').to_string()),
            edge_hostname: env::var("EDGE_HOSTNAME").ok().filter(|s| !s.is_empty()),
            cert_namespace: env::var("CERT_NAMESPACE").unwrap_or_else(|_| "cupboard-web".into()),
            cert_issuer: env::var("CERT_ISSUER").unwrap_or_else(|_| "letsencrypt-http01".into()),
            web_service_name: env::var("WEB_SERVICE_NAME")
                .unwrap_or_else(|_| "cupboard-web".into()),
            web_service_port: env::var("WEB_SERVICE_PORT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(3000),
            ingress_class: env::var("TRAEFIK_INGRESS_CLASS")
                .unwrap_or_else(|_| "traefik-external".into()),
            stripe_secret_key: match env::var("STRIPE_SECRET_KEY") {
                Ok(k) if !k.is_empty() => Some(k),
                _ => {
                    tracing::warn!(
                        "STRIPE_SECRET_KEY unset; platform billing disabled \
                         (no reconcile loop, billing endpoints return 503)"
                    );
                    None
                }
            },
            stripe_webhook_secret: env::var("STRIPE_WEBHOOK_SECRET")
                .ok()
                .filter(|s| !s.is_empty()),
            stripe_price_team: env::var("STRIPE_PRICE_TEAM").ok().filter(|s| !s.is_empty()),
            stripe_price_enterprise: env::var("STRIPE_PRICE_ENTERPRISE")
                .ok()
                .filter(|s| !s.is_empty()),
            stripe_price_custom_design: env::var("STRIPE_PRICE_CUSTOM_DESIGN")
                .ok()
                .filter(|s| !s.is_empty()),
            stripe_api_base: env::var("STRIPE_API_BASE")
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| crate::stripe::DEFAULT_API_BASE.into()),
            auth_internal_url: env::var("AUTH_INTERNAL_URL")
                .ok()
                .filter(|s| !s.is_empty())
                .map(|s| s.trim_end_matches('/').to_string())
                .unwrap_or_else(|| "http://127.0.0.1:8081".into()),
            plan_write_token: env::var("PLAN_WRITE_TOKEN").ok().filter(|s| !s.is_empty()),
        })
    }

    /// Injectable provider API bases for building store clients.
    pub fn provider_bases(&self) -> crate::providers::ProviderBases {
        crate::providers::ProviderBases {
            paynow_api_base: self.paynow_api_base.clone(),
            tebex_headless_base: self.tebex_headless_base.clone(),
            tebex_plugin_base: self.tebex_plugin_base.clone(),
        }
    }
}
