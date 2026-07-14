//! Runtime configuration, read from the environment (Vault → ExternalSecret → env
//! in-cluster; a local `.env`/shell for development).

use std::env;

/// Discord OAuth credentials. Present only when all three vars are set; otherwise the
/// Discord login routes return 503 and email/password still works.
#[derive(Debug, Clone)]
pub struct DiscordConfig {
    pub client_id: String,
    pub client_secret: String,
    /// The absolute callback URL registered with Discord (e.g.
    /// `https://cupboard-staging.vngenterprise.com/auth/discord/callback`).
    pub redirect_uri: String,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub bind_addr: String,
    /// Owner-role connection — migrations + cross-tenant/system operations (RLS-exempt).
    pub database_url: String,
    /// `cupboard_app` (non-owner) connection — request-scoped tenant access (RLS applies).
    /// Falls back to the owner URL in local dev (logged), where RLS then does not isolate.
    pub database_url_app: String,
    pub db_max_connections: u32,
    pub environment: String,
    pub otel_endpoint: Option<String>,

    /// Ed25519 PKCS#8 private key (PEM) — signs access tokens.
    pub jwt_private_key_pem: String,
    /// Ed25519 public key (PEM) — verifies access tokens (also shared with the gateway).
    pub jwt_public_key_pem: String,
    pub access_token_ttl_secs: i64,
    pub refresh_token_ttl_secs: i64,

    /// Process-wide secret for keyed-hashing refresh and invite tokens at rest.
    pub token_pepper: String,
    /// Shared secret REQUIRED from callers of auth's own `/internal/*` server routes
    /// (the API-key exchange; `x-internal-token` header). `None` disables those routes
    /// (fail closed). Distinct from the outbound copy nested in
    /// [`PlayerAuthConfig::internal_api_token`], which auth presents to the tenant
    /// service; both read the same `INTERNAL_API_TOKEN` env var.
    pub internal_api_token: Option<String>,
    /// DISTINCT secret required from the plan-mirror writer (the tenant service) on
    /// `PUT /internal/orgs/{id}/plan`. Deliberately NOT the widely-shared
    /// `INTERNAL_API_TOKEN` (decision K): a plan write is a privilege-escalation
    /// primitive, so only tenant and auth hold this one. `None` disables the route
    /// (fail closed).
    pub plan_write_token: Option<String>,
    /// Base URL of the public dashboard, for building invite/OAuth links.
    pub public_base_url: String,

    pub discord: Option<DiscordConfig>,
    /// 64+ byte key (base64) for signing OAuth state/PKCE cookies. Required when Discord
    /// is configured.
    pub cookie_signing_key: Option<String>,

    /// Player (storefront customer) auth config. `None` disables the `/auth/player/*`
    /// routes (503); operator auth is unaffected.
    pub player: Option<PlayerAuthConfig>,
    /// Steam Web API key for player profile enrichment (persona name + avatar). Optional:
    /// login works without it, degrading to a steamid-only display name.
    pub steam_web_api_key: Option<String>,
}

/// Config for the player-facing auth surface (Steam OpenID + player Discord OAuth + the
/// one-time-code handoff). Present only when the player JWT keypair and the central
/// callback host are configured.
#[derive(Debug, Clone)]
pub struct PlayerAuthConfig {
    /// Ed25519 PKCS#8 private key (PEM) - signs PLAYER access tokens. DISJOINT from the
    /// operator JWT keypair (that separation is the security boundary between the two
    /// token populations).
    pub jwt_private_key_pem: String,
    /// Ed25519 public key (PEM) - the tenant service + web BFF verify player tokens.
    pub jwt_public_key_pem: String,
    /// The central public host that serves the player OAuth callbacks, e.g.
    /// `https://cupboard-login.vngenterprise.com`. Steam `return_to` (and, in PR7, the
    /// player Discord `redirect_uri`) point here; the browser is handed back to the
    /// tenant site via a one-time code.
    pub callback_base_url: String,
    /// Internal base URL of the tenant service, used to authoritatively resolve a
    /// storefront host to its owning tenant during the Steam callback (so a login code
    /// can only ever be issued for a real registered storefront, never an
    /// attacker-supplied host). Required for player login.
    pub tenant_internal_url: String,
    /// Shared secret presented (`X-Internal-Token`) to the tenant service's internal
    /// host-resolution endpoint. Required for player login.
    pub internal_api_token: String,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let database_url =
            env::var("DATABASE_URL").map_err(|_| anyhow::anyhow!("DATABASE_URL is required"))?;
        // App pool defaults to the owner URL for single-role local dev; in staging/prod
        // this MUST be the cupboard_app role for RLS to actually isolate tenants.
        let database_url_app = match env::var("DATABASE_URL_APP") {
            Ok(url) => url,
            Err(_) => {
                tracing::warn!(
                    "DATABASE_URL_APP unset — falling back to the owner role; RLS will NOT \
                     isolate tenants on the app pool. Set the cupboard_app URL outside dev."
                );
                database_url.clone()
            }
        };

        let discord = match (
            env::var("DISCORD_CLIENT_ID"),
            env::var("DISCORD_CLIENT_SECRET"),
            env::var("DISCORD_REDIRECT_URI"),
        ) {
            (Ok(client_id), Ok(client_secret), Ok(redirect_uri)) => Some(DiscordConfig {
                client_id,
                client_secret,
                redirect_uri,
            }),
            _ => {
                tracing::info!("Discord OAuth not configured; email/password login only");
                None
            }
        };

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

            jwt_private_key_pem: env::var("JWT_PRIVATE_KEY_PEM")
                .map_err(|_| anyhow::anyhow!("JWT_PRIVATE_KEY_PEM is required"))?,
            jwt_public_key_pem: env::var("JWT_PUBLIC_KEY_PEM")
                .map_err(|_| anyhow::anyhow!("JWT_PUBLIC_KEY_PEM is required"))?,
            access_token_ttl_secs: env::var("ACCESS_TOKEN_TTL_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(900), // 15 minutes
            refresh_token_ttl_secs: env::var("REFRESH_TOKEN_TTL_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(60 * 60 * 24 * 30), // 30 days

            token_pepper: env::var("TOKEN_PEPPER")
                .map_err(|_| anyhow::anyhow!("TOKEN_PEPPER is required"))?,
            internal_api_token: env::var("INTERNAL_API_TOKEN")
                .ok()
                .filter(|s| !s.is_empty()),
            plan_write_token: env::var("PLAN_WRITE_TOKEN").ok().filter(|s| !s.is_empty()),
            public_base_url: env::var("PUBLIC_BASE_URL")
                .unwrap_or_else(|_| "http://localhost:3000".into()),

            discord,
            cookie_signing_key: env::var("COOKIE_SIGNING_KEY").ok(),
            player: PlayerAuthConfig::from_env(),
            steam_web_api_key: env::var("STEAM_WEB_API_KEY").ok().filter(|s| !s.is_empty()),
        })
    }
}

impl PlayerAuthConfig {
    /// Assembled only when the player keypair, callback host, AND the tenant-service
    /// internal URL + token are all present. The tenant resolution is a security
    /// requirement (host validation), so player auth stays disabled without it rather
    /// than falling back to trusting an unvalidated host.
    fn from_env() -> Option<Self> {
        let (private, public, callback, tenant_url, token) = match (
            env::var("PLAYER_JWT_PRIVATE_KEY_PEM"),
            env::var("PLAYER_JWT_PUBLIC_KEY_PEM"),
            env::var("PLAYER_AUTH_CALLBACK_BASE_URL"),
            env::var("TENANT_INTERNAL_URL"),
            env::var("INTERNAL_API_TOKEN"),
        ) {
            (Ok(pr), Ok(pu), Ok(cb), Ok(tu), Ok(tok))
                if !pr.is_empty()
                    && !pu.is_empty()
                    && !cb.is_empty()
                    && !tu.is_empty()
                    && !tok.is_empty() =>
            {
                (pr, pu, cb, tu, tok)
            }
            _ => {
                tracing::info!(
                    "player auth not configured (PLAYER_JWT_* / callback host / \
                     TENANT_INTERNAL_URL / INTERNAL_API_TOKEN unset); /auth/player/* disabled"
                );
                return None;
            }
        };
        Some(PlayerAuthConfig {
            jwt_private_key_pem: private,
            jwt_public_key_pem: public,
            callback_base_url: callback.trim_end_matches('/').to_string(),
            tenant_internal_url: tenant_url.trim_end_matches('/').to_string(),
            internal_api_token: token,
        })
    }
}
