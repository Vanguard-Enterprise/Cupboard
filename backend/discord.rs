//! Discord guilds an organization owns or manages.
//!
//! Cupboard adds its bot through Discord's OAuth2 install flow and talks to
//! Discord over REST only while an operator action needs it. It never keeps a
//! gateway connection open, so several environments can share one application.
use crate::{
    auth::{ApiError, ApiResult, AuthSession, account, forbidden, internal},
    team,
};
use axum::{
    Extension, Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sqlx::{FromRow, PgConnection, PgPool};
use std::{
    collections::HashMap,
    env,
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicI64, Ordering},
    },
    time::Duration,
};
use tower_sessions::Session;

const DISCORD_API: &str = "https://discord.com/api/v10";
// Discord failures answer 424, not 5xx: the web proxy replaces every 5xx with
// a generic outage message, and these messages tell the operator what to do.
const INSTALL_KEY: &str = "discord_install";
const INSTALL_TTL_SECONDS: i64 = 600;
const MAX_BODY: usize = 64 * 1024;
/// A guild object lists every role, emoji, and sticker, so busy guilds run
/// well past `MAX_BODY`. The bot install's token response embeds one too.
const GUILD_BODY: usize = 1 << 20;
/// Guild pages call Discord only when the stored snapshot is older than this.
const SNAPSHOT_FRESH_SECONDS: i64 = 600;
/// The most time a guild page spends on Discord, including waiting for
/// another request's refresh. The web proxy gives Discord routes 25 seconds,
/// so a slow Discord answers with a clear error instead of the proxy's
/// generic outage.
const DISCORD_DEADLINE: Duration = Duration::from_secs(20);
/// Installs give Discord this long for the code exchange, the installer
/// lookup, and the guild read together. Revoking the installer's token has
/// its own budget on top, so a slow Discord never skips it, and the total
/// still fits the proxy's 25 seconds.
const INSTALL_DEADLINE: Duration = Duration::from_secs(15);
const REVOKE_TIMEOUT: Duration = Duration::from_secs(4);
/// How long a removal waits for an install or refresh of the same guild.
/// With the bot's 10-second leave request it stays inside the proxy's 25.
const REMOVE_LOCK_WAIT: Duration = Duration::from_secs(10);
/// How long to stop calling Discord when it rate limits without saying.
const DEFAULT_BACKOFF_SECONDS: i64 = 60;
/// application/x-www-form-urlencoded leaves these unreserved bytes as they are.
const FORM: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'*')
    .remove(b'-')
    .remove(b'.')
    .remove(b'_');

/// Credentials for the environment's Discord application. Absent when the
/// environment has no Discord application, which turns guild installs off.
#[derive(Clone)]
pub struct DiscordConfig(Arc<Settings>);

struct Settings {
    application_id: String,
    bot_token: String,
    client_secret: String,
    redirect_uri: String,
    /// Prepended to the install state so the development relay can return the
    /// operator to the worktree that started the install.
    state_prefix: String,
    api: String,
    /// Unix time until which Discord asked Cupboard to stop sending any
    /// reads, after a global rate limit. Pages serve stored snapshots until
    /// then instead of piling on.
    rate_limited_until: AtomicI64,
    /// The same, per guild, for limits Discord scopes to one guild's routes.
    guild_cooldowns: Mutex<HashMap<String, i64>>,
    /// Refreshes, installs, and removals of one guild take turns. A request
    /// that arrives during a refresh waits, then reads the snapshot it
    /// stored, and an install can't save a guild the bot has just left.
    guild_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl Settings {
    fn guild_lock(&self, guild_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self
            .guild_locks
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        // Locks are only handed out under this mutex, so a lock nobody else
        // holds a reference to is idle and can go, removed guilds included.
        locks.retain(|_, lock| Arc::strong_count(lock) > 1);
        locks.entry(guild_id.to_owned()).or_default().clone()
    }
}

impl DiscordConfig {
    /// Reads `CUPBOARD_DISCORD_*`. Returns `Ok(None)` when none are set and an
    /// error when only some are, so a typo never silently disables installs.
    pub fn from_env() -> Result<Option<Self>, &'static str> {
        let read = |name| env::var(name).ok().filter(|v: &String| !v.is_empty());
        let values = [
            read("CUPBOARD_DISCORD_APPLICATION_ID"),
            read("CUPBOARD_DISCORD_BOT_TOKEN"),
            read("CUPBOARD_DISCORD_CLIENT_SECRET"),
            read("CUPBOARD_DISCORD_REDIRECT_URI"),
        ];
        if values.iter().all(Option::is_none) {
            return Ok(None);
        }
        let [
            Some(application_id),
            Some(bot_token),
            Some(client_secret),
            Some(redirect_uri),
        ] = values
        else {
            return Err(
                "Set all of CUPBOARD_DISCORD_APPLICATION_ID, CUPBOARD_DISCORD_BOT_TOKEN, CUPBOARD_DISCORD_CLIENT_SECRET, and CUPBOARD_DISCORD_REDIRECT_URI, or none of them",
            );
        };
        if !snowflake(&application_id) {
            return Err("CUPBOARD_DISCORD_APPLICATION_ID must be a Discord application ID");
        }
        let prefix = read("CUPBOARD_DISCORD_STATE_PREFIX").unwrap_or_default();
        if !prefix
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.')
        {
            return Err("CUPBOARD_DISCORD_STATE_PREFIX may contain only letters, digits, and dots");
        }
        Ok(Some(Self::new(
            application_id,
            bot_token,
            client_secret,
            redirect_uri,
            prefix,
            DISCORD_API.into(),
        )))
    }

    pub fn new(
        application_id: String,
        bot_token: String,
        client_secret: String,
        redirect_uri: String,
        state_prefix: String,
        api: String,
    ) -> Self {
        Self(Arc::new(Settings {
            application_id,
            bot_token,
            client_secret,
            redirect_uri,
            state_prefix,
            api: api.trim_end_matches('/').to_owned(),
            rate_limited_until: AtomicI64::new(0),
            guild_cooldowns: Mutex::default(),
            guild_locks: Mutex::default(),
        }))
    }
}

#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
struct Guild {
    id: String,
    name: String,
    icon_hash: Option<String>,
    banner_hash: Option<String>,
    home_header_hash: Option<String>,
    access: String,
    member_count: Option<i32>,
    connected_at: i64,
}

#[derive(Serialize, Deserialize)]
struct PendingInstall {
    state: String,
    organization_id: String,
    expires_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstallInput {
    code: String,
    state: String,
    guild_id: Option<String>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    guild: Option<IdOnly>,
}
#[derive(Deserialize)]
struct IdOnly {
    id: String,
}
#[derive(Deserialize)]
struct DiscordGuild {
    id: String,
    name: String,
    icon: Option<String>,
    banner: Option<String>,
    home_header: Option<String>,
    owner_id: String,
    approximate_member_count: Option<i64>,
}

pub fn routes() -> Router<PgPool> {
    Router::new()
        .route("/app-api/discord/guilds", get(list))
        .route("/app-api/discord/install/start", post(start))
        .route("/app-api/discord/install", post(install))
        .route("/app-api/discord/guilds/{id}", get(overview))
        .route("/app-api/discord/guilds/{id}/remove", post(remove))
}

fn snowflake(value: &str) -> bool {
    (17..=20).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_digit())
}

fn image_hash(value: Option<String>) -> Option<String> {
    value.filter(|hash| {
        let hex = hash.strip_prefix("a_").unwrap_or(hash);
        hex.len() == 32 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    })
}

fn now() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

fn encode(value: &str) -> String {
    utf8_percent_encode(value, FORM).to_string()
}

fn form(fields: &[(&str, &str)]) -> String {
    fields
        .iter()
        .map(|(key, value)| format!("{key}={}", encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

/// Confirms the page's organization is the session's and the operator holds
/// `permission` there. Returns a connection holding no transaction.
async fn access(
    pool: &PgPool,
    auth: &AuthSession,
    session: &Session,
    headers: &HeaderMap,
    permission: &str,
) -> ApiResult<(sqlx::pool::PoolConnection<sqlx::Postgres>, String)> {
    let user = account(auth)?;
    let org = team::organization_id(session).await?;
    if headers
        .get("x-cupboard-organization")
        .and_then(|value| value.to_str().ok())
        != Some(org.as_str())
    {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "The active organization changed. Refresh the page before changing Discord guilds.",
        ));
    }
    let mut conn = pool.acquire().await?;
    let ctx = team::context_on(&mut conn, &user.id, &org).await?;
    if !ctx.permissions.iter().any(|p| p == permission) {
        return Err(forbidden());
    }
    Ok((conn, ctx.organization_id))
}

fn unconfigured() -> ApiError {
    ApiError(
        StatusCode::FAILED_DEPENDENCY,
        "Discord isn't set up for this Cupboard environment.",
    )
}

fn discord_failed() -> ApiError {
    ApiError(
        StatusCode::FAILED_DEPENDENCY,
        "Discord didn't confirm the installation. Add the guild again.",
    )
}

async fn list(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    headers: HeaderMap,
) -> ApiResult<Json<Vec<Guild>>> {
    let (mut conn, org) = access(&pool, &auth, &session, &headers, "community.view").await?;
    Ok(Json(guilds(&mut conn, &org).await?))
}

async fn guilds(conn: &mut PgConnection, org: &str) -> ApiResult<Vec<Guild>> {
    Ok(sqlx::query_as("SELECT guild_id AS id,name,icon_hash,banner_hash,home_header_hash,access,member_count,(EXTRACT(EPOCH FROM connected_at)*1000)::bigint AS connected_at FROM discord_guilds WHERE organization_id=$1 ORDER BY lower(name),guild_id")
        .bind(org)
        .fetch_all(conn)
        .await?)
}

async fn start(
    State(pool): State<PgPool>,
    config: Option<Extension<DiscordConfig>>,
    auth: AuthSession,
    session: Session,
    headers: HeaderMap,
) -> ApiResult<Json<serde_json::Value>> {
    let (_, org) = access(&pool, &auth, &session, &headers, "integrations.manage").await?;
    let Some(Extension(DiscordConfig(config))) = config else {
        return Err(unconfigured());
    };
    // Discord sends the browser back to the redirect URI's host. Only that
    // host has this session's cookie, so the install must start there.
    let host = |url: &str| reqwest::Url::parse(url).ok()?.host_str().map(str::to_owned);
    let origin = headers
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .and_then(host);
    if origin.is_none() || origin != host(&config.redirect_uri) {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Discord returns to a different address than this page. Open Cupboard at the address it was set up with, then add the guild.",
        ));
    }
    let state = format!("{}{}", config.state_prefix, crate::auth::secret());
    session
        .insert(
            INSTALL_KEY,
            PendingInstall {
                state: state.clone(),
                organization_id: org,
                expires_at: now() + INSTALL_TTL_SECONDS,
            },
        )
        .await
        .map_err(|_| internal())?;
    // Only `bot` and `identify`: the bot asks for no guild permissions until a
    // feature needs one, and `identify` tells owners apart from managers.
    let url = format!(
        "https://discord.com/oauth2/authorize?client_id={}&scope={}&response_type=code&redirect_uri={}&state={}&integration_type=0",
        config.application_id,
        encode("bot identify"),
        encode(&config.redirect_uri),
        encode(&state),
    );
    Ok(Json(serde_json::json!({ "url": url })))
}

fn client() -> ApiResult<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .user_agent("DiscordBot (https://cupboard.invalid, 1.0)")
        .build()
        .map_err(|_| internal())
}

async fn read<T: DeserializeOwned>(response: reqwest::Response, limit: usize) -> ApiResult<T> {
    let mut response = response.error_for_status().map_err(|_| discord_failed())?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| discord_failed())? {
        if bytes.len() + chunk.len() > limit {
            return Err(discord_failed());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| discord_failed())
}

/// Runs install work against the install deadline.
async fn by<T>(
    deadline: tokio::time::Instant,
    work: impl Future<Output = ApiResult<T>>,
) -> ApiResult<T> {
    tokio::time::timeout_at(deadline, work)
        .await
        .unwrap_or_else(|_| Err(discord_failed()))
}

/// Exchanges the install's code, identifies the installer, and reads the
/// guild Discord added the bot to. Returns holding the guild's turn, so a
/// removal can't make the bot leave between this read and the save.
async fn exchange(
    config: &Settings,
    input: &InstallInput,
) -> ApiResult<(
    IdOnly,
    String,
    DiscordGuild,
    tokio::sync::OwnedMutexGuard<()>,
)> {
    let deadline = tokio::time::Instant::now() + INSTALL_DEADLINE;
    let client = client()?;
    let token: TokenResponse = by(deadline, async {
        read(
            client
                .post(format!("{}/oauth2/token", config.api))
                .basic_auth(&config.application_id, Some(&config.client_secret))
                .header("content-type", "application/x-www-form-urlencoded")
                .body(form(&[
                    ("grant_type", "authorization_code"),
                    ("code", &input.code),
                    ("redirect_uri", &config.redirect_uri),
                ]))
                .send()
                .await
                .map_err(|_| discord_failed())?,
            GUILD_BODY,
        )
        .await
    })
    .await?;
    let installer: ApiResult<IdOnly> = by(deadline, async {
        read(
            client
                .get(format!("{}/users/@me", config.api))
                .bearer_auth(&token.access_token)
                .send()
                .await
                .map_err(|_| discord_failed())?,
            MAX_BODY,
        )
        .await
    })
    .await;
    // Cupboard needs the operator's token only for this request. Revoking
    // it runs outside the install deadline, so a slow lookup can't skip it.
    let revoke = client
        .post(format!("{}/oauth2/token/revoke", config.api))
        .basic_auth(&config.application_id, Some(&config.client_secret))
        .header("content-type", "application/x-www-form-urlencoded")
        .body(form(&[
            ("token", &token.access_token),
            ("token_type_hint", "access_token"),
        ]))
        .send();
    // Best effort: the bot is already in the guild, so a failed revoke must not
    // fail the install. The token is never stored, carries only `identify`,
    // and expires on its own.
    let revoking = tokio::time::Instant::now();
    let revoked = tokio::time::timeout(REVOKE_TIMEOUT, revoke).await;
    if !matches!(revoked, Ok(Ok(ref response)) if response.status().is_success()) {
        eprintln!("Discord didn't confirm revoking a guild installer's token.");
    }
    // Revoking has its own budget, so it doesn't eat into the guild read's.
    let deadline = deadline + revoking.elapsed();
    let installer = installer?;
    let Some(guild_id) = token.guild.map(|guild| guild.id) else {
        return Err(discord_failed());
    };
    if !snowflake(&guild_id) || input.guild_id.as_ref().is_some_and(|id| *id != guild_id) {
        return Err(discord_failed());
    }
    let turn = by(deadline, async {
        Ok(config.guild_lock(&guild_id).lock_owned().await)
    })
    .await?;
    let guild: DiscordGuild = by(deadline, async {
        read(
            client
                .get(format!("{}/guilds/{guild_id}?with_counts=true", config.api))
                .header("authorization", format!("Bot {}", config.bot_token))
                .send()
                .await
                .map_err(|_| discord_failed())?,
            GUILD_BODY,
        )
        .await
    })
    .await?;
    Ok((installer, guild_id, guild, turn))
}

async fn install(
    State(pool): State<PgPool>,
    config: Option<Extension<DiscordConfig>>,
    auth: AuthSession,
    session: Session,
    headers: HeaderMap,
    input: Result<Json<InstallInput>, axum::extract::rejection::JsonRejection>,
) -> ApiResult<Json<Guild>> {
    let (conn, org) = access(&pool, &auth, &session, &headers, "integrations.manage").await?;
    // Hold no database connection while waiting on Discord or the guild lock.
    drop(conn);
    let Some(Extension(DiscordConfig(config))) = config else {
        return Err(unconfigured());
    };
    // The state is single use: remove it before anything can fail.
    let pending: Option<PendingInstall> =
        session.remove(INSTALL_KEY).await.map_err(|_| internal())?;
    let Json(input) = input.map_err(|_| {
        ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Discord returned an incomplete installation.",
        )
    })?;
    if !pending.is_some_and(|pending| {
        pending.state == input.state && pending.organization_id == org && pending.expires_at > now()
    }) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "This Discord installation expired or was started elsewhere. Add the guild again.",
        ));
    }
    if input.code.is_empty() || input.code.len() > 256 {
        return Err(discord_failed());
    }
    let (installer, guild_id, guild, _turn) = exchange(&config, &input).await?;
    let name = guild.name.trim();
    if guild.id != guild_id || name.is_empty() || name.chars().count() > 100 {
        return Err(discord_failed());
    }
    let access = if guild.owner_id == installer.id {
        "owner"
    } else {
        "manager"
    };
    let members = guild
        .approximate_member_count
        .and_then(|count| i32::try_from(count).ok())
        .filter(|count| *count >= 0);
    let mut conn = pool.acquire().await?;
    let saved = sqlx::query_as("INSERT INTO discord_guilds(organization_id,guild_id,name,icon_hash,banner_hash,home_header_hash,access,member_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(organization_id,guild_id) DO UPDATE SET name=EXCLUDED.name,icon_hash=EXCLUDED.icon_hash,banner_hash=EXCLUDED.banner_hash,home_header_hash=EXCLUDED.home_header_hash,access=EXCLUDED.access,member_count=EXCLUDED.member_count RETURNING guild_id AS id,name,icon_hash,banner_hash,home_header_hash,access,member_count,(EXTRACT(EPOCH FROM connected_at)*1000)::bigint AS connected_at")
        .bind(&org)
        .bind(&guild.id)
        .bind(name)
        .bind(image_hash(guild.icon))
        .bind(image_hash(guild.banner))
        .bind(image_hash(guild.home_header))
        .bind(access)
        .bind(members)
        .fetch_one(&mut *conn)
        .await?;
    Ok(Json(saved))
}

async fn remove(
    State(pool): State<PgPool>,
    config: Option<Extension<DiscordConfig>>,
    auth: AuthSession,
    session: Session,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<Guild>>> {
    let (mut conn, org) = access(&pool, &auth, &session, &headers, "integrations.manage").await?;
    if !snowflake(&id) {
        return Err(ApiError(StatusCode::NOT_FOUND, "Discord guild not found."));
    }
    let linked: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM discord_guilds WHERE organization_id=$1 AND guild_id=$2)",
    )
    .bind(&org)
    .bind(&id)
    .fetch_one(&mut *conn)
    .await?;
    if !linked {
        return Err(ApiError(StatusCode::NOT_FOUND, "Discord guild not found."));
    }
    let Some(Extension(DiscordConfig(config))) = config else {
        return Err(unconfigured());
    };
    // Hold no database connection while waiting on the lock or Discord.
    drop(conn);
    // Wait for any install or refresh of this guild to finish first.
    let lock = config.guild_lock(&id);
    let Ok(_turn) = tokio::time::timeout(REMOVE_LOCK_WAIT, lock.lock()).await else {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Another change to this guild is still running. Try again in a moment.",
        ));
    };
    // The bot leaves before Cupboard forgets the guild, so a guild is never
    // unlisted while the bot stays in it. Discord answers 404 when the bot
    // already left, which counts as done.
    let left = client()?
        .delete(format!("{}/users/@me/guilds/{id}", config.api))
        .header("authorization", format!("Bot {}", config.bot_token))
        .send()
        .await
        .is_ok_and(|response| {
            response.status().is_success() || response.status() == StatusCode::NOT_FOUND
        });
    if !left {
        return Err(ApiError(
            StatusCode::FAILED_DEPENDENCY,
            "Discord didn't confirm the bot left the guild. The guild is still listed. Try again.",
        ));
    }
    // Without the bot the guild is unusable everywhere, so every organization
    // that linked it loses it.
    let mut conn = pool.acquire().await?;
    let mut tx = sqlx::Connection::begin(&mut *conn).await?;
    sqlx::query("DELETE FROM discord_guilds WHERE guild_id=$1")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM discord_guild_snapshots WHERE guild_id=$1")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(guilds(&mut conn, &org).await?))
}

const VIEW_CHANNEL: u64 = 1 << 10;
const ADMINISTRATOR: u64 = 1 << 3;
const MAX_MEMBERS: usize = 1000;

fn guild_gone() -> ApiError {
    ApiError(
        StatusCode::CONFLICT,
        "The Cupboard bot is no longer in this guild. Remove the guild, then add it again.",
    )
}

/// Reads one Discord resource with the bot token. `Ok(None)` means Discord
/// refused it (missing permission or unknown resource), which callers treat
/// as data the bot cannot see.
async fn bot_get(
    client: &reqwest::Client,
    config: &Settings,
    path: String,
    limit: usize,
) -> ApiResult<Option<Value>> {
    let guild = path
        .strip_prefix("guilds/")
        .and_then(|rest| rest.split(['/', '?']).next())
        .unwrap_or_default()
        .to_owned();
    let cooling = || {
        config
            .guild_cooldowns
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&guild)
            .is_some_and(|until| *until > now())
    };
    if config.rate_limited_until.load(Ordering::Relaxed) > now() || cooling() {
        return Err(rate_limited());
    }
    let send = || {
        client
            .get(format!("{}/{path}", config.api))
            .header("authorization", format!("Bot {}", config.bot_token))
            .send()
    };
    let mut response = send().await.map_err(|_| discord_unavailable())?;
    for attempt in 0..2 {
        if response.status() != StatusCode::TOO_MANY_REQUESTS {
            break;
        }
        let wait = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|seconds| seconds.is_finite() && *seconds >= 0.0);
        let global = response
            .headers()
            .get("x-ratelimit-global")
            .is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"true"))
            || response
                .headers()
                .get("x-ratelimit-scope")
                .is_some_and(|v| v.as_bytes() == b"global");
        // Wait out one short limit. A long one, or a second in a row, pauses
        // reads until it ends: every read for a global limit, otherwise only
        // this guild's, since Discord limits each guild's routes separately.
        match wait {
            Some(seconds) if attempt == 0 && seconds <= 3.0 => {
                tokio::time::sleep(Duration::from_secs_f64(seconds)).await;
                response = send().await.map_err(|_| discord_unavailable())?;
            }
            _ => {
                let backoff = wait.map_or(DEFAULT_BACKOFF_SECONDS, |seconds| {
                    (seconds.ceil() as i64).clamp(1, 3600)
                });
                if global || guild.is_empty() {
                    config
                        .rate_limited_until
                        .fetch_max(now() + backoff, Ordering::Relaxed);
                } else {
                    let mut cooldowns = config
                        .guild_cooldowns
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner);
                    let current = now();
                    cooldowns.retain(|_, until| *until > current);
                    let until = cooldowns.entry(guild.clone()).or_default();
                    *until = (*until).max(current + backoff);
                }
                return Err(rate_limited());
            }
        }
    }
    let status = response.status();
    if status == StatusCode::FORBIDDEN || status == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(discord_unavailable());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| discord_unavailable())? {
        if bytes.len() + chunk.len() > limit {
            return Err(discord_unavailable());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| discord_unavailable())
}

fn rate_limited() -> ApiError {
    ApiError(
        StatusCode::FAILED_DEPENDENCY,
        "Discord is limiting how often Cupboard can read it. Try again in a minute.",
    )
}

fn discord_unavailable() -> ApiError {
    ApiError(
        StatusCode::FAILED_DEPENDENCY,
        "Discord didn't return this guild. Try again in a moment.",
    )
}

fn text(value: &Value, key: &str) -> Value {
    value
        .get(key)
        .and_then(Value::as_str)
        .map_or(Value::Null, |s| json!(s))
}

fn items(value: &Option<Value>) -> &[Value] {
    value
        .as_ref()
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// Discord snowflakes carry their creation time.
fn created_at(id: &str) -> Value {
    id.parse::<u64>()
        .map_or(Value::Null, |id| json!((id >> 22) + 1_420_070_400_000))
}

struct Snapshot {
    data: Value,
    fetched_at: i64,
    age_seconds: i64,
}

async fn snapshot(pool: &PgPool, guild_id: &str) -> ApiResult<Option<Snapshot>> {
    let row: Option<(String, i64, i64)> = sqlx::query_as("SELECT data::text,(EXTRACT(EPOCH FROM fetched_at)*1000)::bigint,EXTRACT(EPOCH FROM now()-fetched_at)::bigint FROM discord_guild_snapshots WHERE guild_id=$1")
        .bind(guild_id)
        .fetch_optional(pool)
        .await?;
    Ok(row.and_then(|(data, fetched_at, age_seconds)| {
        Some(Snapshot {
            data: serde_json::from_str(&data).ok()?,
            fetched_at,
            age_seconds,
        })
    }))
}

/// Adds what differs between organizations and requests to a snapshot.
/// `stale` marks a snapshot served because Discord couldn't refresh it.
fn respond(snapshot: Snapshot, connected_at: i64, stale: bool) -> Json<Value> {
    let mut data = snapshot.data;
    data["guild"]["connectedAt"] = json!(connected_at);
    data["fetchedAt"] = json!(snapshot.fetched_at);
    data["stale"] = json!(stale);
    Json(data)
}

/// What Cupboard can read about a linked guild. Pages read the stored
/// snapshot; Discord is called only when the snapshot is stale, and a stale
/// snapshot still answers while Discord is rate limiting or unreachable.
async fn overview(
    State(pool): State<PgPool>,
    config: Option<Extension<DiscordConfig>>,
    auth: AuthSession,
    session: Session,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let (mut conn, org) = access(&pool, &auth, &session, &headers, "community.view").await?;
    let linked: Option<i64> = if snowflake(&id) {
        sqlx::query_scalar("SELECT (EXTRACT(EPOCH FROM connected_at)*1000)::bigint FROM discord_guilds WHERE organization_id=$1 AND guild_id=$2")
            .bind(&org)
            .bind(&id)
            .fetch_optional(&mut *conn)
            .await?
    } else {
        None
    };
    let Some(connected_at) = linked else {
        return Err(ApiError(StatusCode::NOT_FOUND, "Discord guild not found."));
    };
    drop(conn);
    let cached = match snapshot(&pool, &id).await? {
        Some(s) if s.age_seconds < SNAPSHOT_FRESH_SECONDS => {
            return Ok(respond(s, connected_at, false));
        }
        other => other,
    };
    let Some(Extension(DiscordConfig(config))) = config else {
        return cached
            .map(|s| respond(s, connected_at, true))
            .ok_or_else(unconfigured);
    };
    // Waiting for another request's refresh counts toward the deadline too.
    let deadline = tokio::time::Instant::now() + DISCORD_DEADLINE;
    let lock = config.guild_lock(&id);
    let Ok(_refreshing) = tokio::time::timeout_at(deadline, lock.lock()).await else {
        return cached
            .map(|s| respond(s, connected_at, true))
            .ok_or_else(discord_unavailable);
    };
    // Another request may have refreshed the guild while this one waited.
    let cached = match snapshot(&pool, &id).await? {
        Some(s) if s.age_seconds < SNAPSHOT_FRESH_SECONDS => {
            return Ok(respond(s, connected_at, false));
        }
        other => other.or(cached),
    };
    let read = tokio::time::timeout_at(deadline, read_guild(&config, &id))
        .await
        .unwrap_or_else(|_| Err(discord_unavailable()));
    match read {
        Ok(data) => {
            let fetched_at = store(&pool, &id, &data).await?;
            Ok(respond(
                Snapshot {
                    data,
                    fetched_at,
                    age_seconds: 0,
                },
                connected_at,
                false,
            ))
        }
        Err(error) if error.0 == StatusCode::CONFLICT => Err(error),
        Err(error) => cached.map(|s| respond(s, connected_at, true)).ok_or(error),
    }
}

/// Saves a fresh read and refreshes the guild's list entry from it. Writes
/// nothing once every organization removed the guild, so a read that races a
/// removal cannot bring its data back.
async fn store(pool: &PgPool, id: &str, data: &Value) -> ApiResult<i64> {
    let mut tx = pool.begin().await?;
    // Lock the guild's links before its snapshot, in the same order as
    // removal, so the two wait for each other instead of deadlocking. A
    // removal that commits first leaves no link to lock.
    let linked: Vec<i32> =
        sqlx::query_scalar("SELECT 1 FROM discord_guilds WHERE guild_id=$1 FOR UPDATE")
            .bind(id)
            .fetch_all(&mut *tx)
            .await?;
    if linked.is_empty() {
        return Ok(now() * 1000);
    }
    let fetched_at: i64 = sqlx::query_scalar("INSERT INTO discord_guild_snapshots(guild_id,data) VALUES($1,$2::jsonb) ON CONFLICT(guild_id) DO UPDATE SET data=EXCLUDED.data,fetched_at=now() RETURNING (EXTRACT(EPOCH FROM fetched_at)*1000)::bigint")
        .bind(id)
        .bind(data.to_string())
        .fetch_one(&mut *tx)
        .await?;
    let guild = &data["guild"];
    let name = guild["name"].as_str().map(str::trim).unwrap_or_default();
    if !name.is_empty() && name.chars().count() <= 100 {
        let members = guild["memberCount"]
            .as_u64()
            .and_then(|count| i32::try_from(count).ok());
        sqlx::query("UPDATE discord_guilds SET name=$2,icon_hash=$3,banner_hash=$4,home_header_hash=$5,member_count=$6 WHERE guild_id=$1")
            .bind(id)
            .bind(name)
            .bind(guild["iconHash"].as_str())
            .bind(guild["bannerHash"].as_str())
            .bind(guild["homeHeaderHash"].as_str())
            .bind(members)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(fetched_at)
}

/// Reads a guild from Discord and normalizes it for the guild page.
async fn read_guild(config: &Settings, id: &str) -> ApiResult<Value> {
    let client = client()?;
    let (guild, channels, members, events, threads) = tokio::join!(
        bot_get(
            &client,
            config,
            format!("guilds/{id}?with_counts=true"),
            GUILD_BODY
        ),
        bot_get(&client, config, format!("guilds/{id}/channels"), 1 << 20),
        bot_get(
            &client,
            config,
            format!("guilds/{id}/members?limit={MAX_MEMBERS}"),
            4 << 20
        ),
        bot_get(
            &client,
            config,
            format!("guilds/{id}/scheduled-events?with_user_count=true"),
            1 << 20
        ),
        bot_get(
            &client,
            config,
            format!("guilds/{id}/threads/active"),
            1 << 20
        ),
    );
    let Some(guild) = guild? else {
        return Err(guild_gone());
    };
    let (channels, members, events, threads) = (channels?, members?, events?, threads?);
    // Discord refuses the member list without the server members intent.
    // Unknown counts must not read as zero.
    let members_available = members.is_some();
    let total = guild
        .get("approximate_member_count")
        .and_then(Value::as_u64);

    let members: Vec<Value> = items(&members)
        .iter()
        .filter_map(|member| {
            let user = member.get("user")?;
            Some(json!({
                "id": text(user, "id"),
                "username": text(user, "username"),
                "displayName": member.get("nick").filter(|v| v.is_string())
                    .or_else(|| user.get("global_name").filter(|v| v.is_string()))
                    .or_else(|| user.get("username"))
                    .cloned()
                    .unwrap_or(Value::Null),
                "avatarHash": text(user, "avatar"),
                "bot": user.get("bot").and_then(Value::as_bool).unwrap_or(false),
                "joinedAt": text(member, "joined_at"),
                "roleIds": member.get("roles").cloned().unwrap_or(json!([])),
            }))
        })
        .collect();
    let roles: Vec<Value> = guild
        .get("roles")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .map(|role| {
            let role_id = role.get("id").and_then(Value::as_str).unwrap_or_default();
            let count = if !members_available {
                None
            } else if role_id == id {
                // Everyone holds @everyone, including members past the first
                // 1,000, so Discord's total is the better count.
                Some(total.map_or(members.len(), |total| total as usize))
            } else {
                Some(
                    members
                        .iter()
                        .filter(|member| {
                            member["roleIds"]
                                .as_array()
                                .is_some_and(|ids| ids.iter().any(|v| v == role_id))
                        })
                        .count(),
                )
            };
            json!({
                "id": role_id,
                "name": text(role, "name"),
                "color": role.get("color").and_then(Value::as_u64).unwrap_or(0),
                "position": role.get("position").and_then(Value::as_i64).unwrap_or(0),
                "hoist": role.get("hoist").and_then(Value::as_bool).unwrap_or(false),
                "managed": role.get("managed").and_then(Value::as_bool).unwrap_or(false),
                "mentionable": role.get("mentionable").and_then(Value::as_bool).unwrap_or(false),
                "everyone": role_id == id,
                "memberCount": count,
            })
        })
        .collect();
    // @everyone's server permissions. Discord always sends them; assume
    // visible if a response ever leaves them out.
    let everyone_base = guild
        .get("roles")
        .and_then(Value::as_array)
        .and_then(|roles| {
            roles
                .iter()
                .find(|role| role.get("id").and_then(Value::as_str) == Some(id))
        })
        .and_then(|role| role.get("permissions"))
        .and_then(Value::as_str)
        .and_then(|bits| bits.parse::<u64>().ok())
        .unwrap_or(VIEW_CHANNEL);
    let channels: Vec<Value> = items(&channels)
        .iter()
        .map(|channel| {
            // Discord starts from @everyone's server permissions, then
            // applies the channel's @everyone deny and allow, in that order.
            let everyone = channel
                .get("permission_overwrites")
                .and_then(Value::as_array)
                .and_then(|overwrites| {
                    overwrites
                        .iter()
                        .find(|o| o.get("id").and_then(Value::as_str) == Some(id))
                });
            let bits = |key: &str| {
                everyone
                    .and_then(|o| o.get(key))
                    .and_then(Value::as_str)
                    .and_then(|bits| bits.parse::<u64>().ok())
                    .unwrap_or(0)
            };
            let visible = (everyone_base & !bits("deny")) | bits("allow");
            let private = visible & (VIEW_CHANNEL | ADMINISTRATOR) == 0;
            json!({
                "id": text(channel, "id"),
                "name": text(channel, "name"),
                "type": channel.get("type").and_then(Value::as_u64).unwrap_or(0),
                "parentId": text(channel, "parent_id"),
                "position": channel.get("position").and_then(Value::as_i64).unwrap_or(0),
                "topic": text(channel, "topic"),
                "nsfw": channel.get("nsfw").and_then(Value::as_bool).unwrap_or(false),
                "private": private,
            })
        })
        .collect();
    let events: Vec<Value> = items(&events)
        .iter()
        .map(|event| {
            json!({
                "id": text(event, "id"),
                "name": text(event, "name"),
                "startsAt": text(event, "scheduled_start_time"),
                "status": event.get("status").and_then(Value::as_u64).unwrap_or(0),
                "userCount": event.get("user_count").and_then(Value::as_u64),
            })
        })
        .collect();
    let threads: Vec<Value> = threads
        .as_ref()
        .and_then(|t| t.get("threads"))
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .take(100)
        .map(|thread| {
            json!({
                "id": text(thread, "id"),
                "name": text(thread, "name"),
                "parentId": text(thread, "parent_id"),
                "messageCount": thread.get("message_count").and_then(Value::as_u64),
            })
        })
        .collect();
    let list = |key: &str, fields: &[&str]| -> Vec<Value> {
        guild
            .get(key)
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .map(|item| {
                Value::Object(
                    fields
                        .iter()
                        .map(|f| {
                            (
                                (*f).to_owned(),
                                item.get(*f).cloned().unwrap_or(Value::Null),
                            )
                        })
                        .collect(),
                )
            })
            .collect()
    };
    Ok(json!({
        "guild": {
            "id": id,
            "name": text(&guild, "name"),
            "description": text(&guild, "description"),
            "iconHash": image_hash(guild.get("icon").and_then(Value::as_str).map(str::to_owned)),
            "bannerHash": image_hash(guild.get("banner").and_then(Value::as_str).map(str::to_owned)),
            "homeHeaderHash": image_hash(guild.get("home_header").and_then(Value::as_str).map(str::to_owned)),
            "memberCount": guild.get("approximate_member_count").and_then(Value::as_u64),
            "onlineCount": guild.get("approximate_presence_count").and_then(Value::as_u64),
            "boostTier": guild.get("premium_tier").and_then(Value::as_u64).unwrap_or(0),
            "boostCount": guild.get("premium_subscription_count").and_then(Value::as_u64).unwrap_or(0),
            "verificationLevel": guild.get("verification_level").and_then(Value::as_u64).unwrap_or(0),
            "locale": text(&guild, "preferred_locale"),
            "features": guild.get("features").cloned().unwrap_or(json!([])),
            "createdAt": created_at(id),
        },
        "channels": channels,
        "roles": roles,
        "members": {
            "items": members,
            "available": members_available,
            "complete": members_available
                && (members.len() < MAX_MEMBERS
                    || total.is_none_or(|total| total as usize <= MAX_MEMBERS)),
        },
        "emojis": list("emojis", &["id", "name", "animated"]),
        "stickers": list("stickers", &["id", "name", "format_type"]),
        "events": events,
        "threads": threads,
    }))
}
