use crate::{
    auth::{ApiError, ApiResult, AuthSession, account, bounded, forbidden, internal, invalid},
    pelican::PanelPolicy,
    secrets::SecretKey,
    team,
};
use axum::{
    Extension, Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use hmac::{Hmac, Mac};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::Sha256;
use sqlx::{FromRow, PgConnection, PgPool, Postgres, Transaction};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Mutex,
    time::{Duration, Instant},
};
use tower_sessions::Session;

/// Events Cupboard can detect today, with the severity shown to operators.
pub(crate) const EVENTS: &[(&str, &str)] = &[
    ("server.offline", "critical"),
    ("server.recovered", "info"),
    ("machine.offline", "critical"),
    ("machine.recovered", "info"),
    ("pelican.failed", "warning"),
    ("pelican.recovered", "info"),
    ("member.joined", "info"),
    ("member.removed", "warning"),
];
/// A new channel receives outage alerts until the operator changes its routing.
const DEFAULT_ROUTES: &[&str] = &["server.offline", "machine.offline", "pelican.failed"];
const MAX_CHANNELS: i64 = 10;
const MAX_ATTEMPTS: i32 = 5;
const RETENTION_DAYS: [i32; 3] = [7, 30, 90];
/// A healthy agent reports well inside the offline threshold, so this wait lets
/// fleets report in after Cupboard or its database was unavailable.
const REPORT_GRACE: Duration = Duration::from_secs(90);
/// Covers DNS resolution as well as the request, which has its own timeout.
const SEND_DEADLINE: Duration = Duration::from_secs(10);
const MANAGE: &[&str] = &["organization.manage"];
// The export returns data that other routes protect with their own permissions.
const EXPORT: &[&str] = &[
    "organization.manage",
    "servers.view",
    "infrastructure.view",
    "integrations.manage",
];
// Readers share the organization row with long connection checks. Writers
// serialize with each other without blocking the foreign keys alerts insert.
const READ: &str = "SELECT id FROM organizations WHERE id=$1 FOR SHARE";
const WRITE: &str = "SELECT id FROM organizations WHERE id=$1 FOR NO KEY UPDATE";
// One test per organization keeps a hanging endpoint from using the shared limit.
static TEST_SENDS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(8);
static TESTING: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());
static DELIVERIES: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

pub fn routes() -> Router<PgPool> {
    Router::new()
        .route("/app-api/alerts", get(read))
        .route("/app-api/alerts/settings", post(save_settings))
        .route("/app-api/alerts/channels", post(create_channel))
        .route("/app-api/alerts/channels/{id}", post(update_channel))
        .route("/app-api/alerts/channels/{id}/remove", post(remove_channel))
        .route("/app-api/alerts/channels/{id}/test", post(test_channel))
        .route("/app-api/alerts/channels/{id}/rotate", post(rotate_channel))
        .route("/app-api/organization/export", get(export))
}

#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
struct Channel {
    id: String,
    kind: String,
    name: String,
    destination: String,
    created_at: i64,
    last_delivery_at: Option<i64>,
    last_delivery_ok: Option<bool>,
    last_error: Option<String>,
}
#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
struct Event {
    id: String,
    event: String,
    severity: String,
    title: String,
    detail: String,
    created_at: i64,
    deliveries: Value,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Alerts {
    revision: i64,
    retention_days: i32,
    routes: BTreeMap<String, Vec<String>>,
    channels: Vec<Channel>,
    events: Vec<Event>,
}
struct Settings {
    revision: i64,
    routes: BTreeMap<String, Vec<String>>,
    retention_days: i32,
}

// Alerts change shared delivery targets, so they require organization management.
async fn access<'a>(
    pool: &'a PgPool,
    auth: &AuthSession,
    session: &Session,
    headers: &HeaderMap,
    lock: &'static str,
    required: &[&str],
) -> ApiResult<(Transaction<'a, Postgres>, String)> {
    let user = account(auth)?;
    let org = team::organization_id(session).await?;
    if headers
        .get("x-cupboard-organization")
        .and_then(|v| v.to_str().ok())
        != Some(org.as_str())
    {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "The active organization changed. Refresh the page before managing alerts.",
        ));
    }
    let mut tx = pool.begin().await?;
    sqlx::query(lock).bind(&org).execute(&mut *tx).await?;
    let ctx = team::context_on(&mut tx, &user.id, &org).await?;
    if !required
        .iter()
        .all(|required| ctx.permissions.iter().any(|p| p == required))
    {
        return Err(forbidden());
    }
    Ok((tx, ctx.organization_id))
}
fn conflict() -> ApiError {
    ApiError(
        StatusCode::CONFLICT,
        "Alert settings changed in another session. Reload them before saving again.",
    )
}
fn not_found() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "Alert channel not found.")
}
async fn settings(conn: &mut PgConnection, org: &str) -> ApiResult<Settings> {
    let row: Option<(i64, Value, i32)> = sqlx::query_as(
        "SELECT revision,routes,retention_days FROM alert_settings WHERE organization_id=$1",
    )
    .bind(org)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(match row {
        Some((revision, routes, retention_days)) => Settings {
            revision,
            routes: serde_json::from_value(routes).map_err(|_| internal())?,
            retention_days,
        },
        None => Settings {
            revision: 0,
            routes: BTreeMap::new(),
            retention_days: 30,
        },
    })
}
async fn write_settings(
    conn: &mut PgConnection,
    org: &str,
    routes: &BTreeMap<String, Vec<String>>,
    retention_days: i32,
) -> ApiResult<()> {
    sqlx::query("INSERT INTO alert_settings(organization_id,revision,routes,retention_days) VALUES($1,1,$2,$3) ON CONFLICT(organization_id) DO UPDATE SET revision=alert_settings.revision+1,routes=EXCLUDED.routes,retention_days=EXCLUDED.retention_days")
        .bind(org)
        .bind(serde_json::to_value(routes).map_err(|_| internal())?)
        .bind(retention_days)
        .execute(conn)
        .await?;
    Ok(())
}
async fn state(conn: &mut PgConnection, org: &str) -> ApiResult<Alerts> {
    let settings = settings(conn, org).await?;
    let channels = sqlx::query_as("SELECT id,kind,name,destination,created_at,last_delivery_at,last_delivery_ok,last_error FROM alert_channels WHERE organization_id=$1 ORDER BY created_at,id")
        .bind(org)
        .fetch_all(&mut *conn)
        .await?;
    let events = sqlx::query_as("SELECT e.id,e.event,e.severity,e.title,e.detail,e.created_at,COALESCE((SELECT json_agg(json_build_object('channelId',d.channel_id,'status',d.status,'attempts',d.attempts,'error',d.error,'completedAt',d.completed_at,'channelName',d.channel_name) ORDER BY d.channel_id) FROM alert_deliveries d WHERE d.organization_id=e.organization_id AND d.event_id=e.id),'[]'::json) AS deliveries FROM alert_events e WHERE e.organization_id=$1 ORDER BY e.created_at DESC,e.id DESC LIMIT 50")
        .bind(org)
        .fetch_all(&mut *conn)
        .await?;
    Ok(Alerts {
        revision: settings.revision,
        retention_days: settings.retention_days,
        routes: settings.routes,
        channels,
        events,
    })
}

async fn read(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    headers: HeaderMap,
) -> ApiResult<Json<Alerts>> {
    let (mut tx, org) = access(&pool, &auth, &session, &headers, READ, MANAGE).await?;
    let alerts = state(&mut tx, &org).await?;
    tx.commit().await?;
    Ok(Json(alerts))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SaveSettings {
    revision: i64,
    routes: BTreeMap<String, Vec<String>>,
    retention_days: i32,
}
async fn save_settings(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    headers: HeaderMap,
    input: Result<Json<SaveSettings>, axum::extract::rejection::JsonRejection>,
) -> ApiResult<Json<Alerts>> {
    let (mut tx, org) = access(&pool, &auth, &session, &headers, WRITE, MANAGE).await?;
    let Json(input) = input.map_err(|_| invalid("Enter valid alert settings."))?;
    if settings(&mut tx, &org).await?.revision != input.revision {
        return Err(conflict());
    }
    if !RETENTION_DAYS.contains(&input.retention_days) {
        return Err(invalid("Keep alert history for 7, 30, or 90 days."));
    }
    let channels: Vec<String> =
        sqlx::query_scalar("SELECT id FROM alert_channels WHERE organization_id=$1")
            .bind(&org)
            .fetch_all(&mut *tx)
            .await?;
    let mut routes = BTreeMap::new();
    for (event, mut ids) in input.routes {
        if !EVENTS.iter().any(|(key, _)| *key == event) {
            return Err(invalid("Choose alerts from the supported list."));
        }
        if ids.iter().any(|id| !channels.contains(id)) {
            return Err(conflict());
        }
        ids.sort();
        ids.dedup();
        if !ids.is_empty() {
            routes.insert(event, ids);
        }
    }
    write_settings(&mut tx, &org, &routes, input.retention_days).await?;
    let alerts = state(&mut tx, &org).await?;
    tx.commit().await?;
    Ok(Json(alerts))
}

/// Validate a delivery URL. Returns the URL and a display hint that omits secrets.
pub(crate) fn destination(
    kind: &str,
    value: &str,
    policy: &PanelPolicy,
) -> Result<(Url, String), &'static str> {
    let value = value.trim();
    #[cfg(test)]
    if policy.test_origin.as_deref() == Some(value) {
        let url = Url::parse(value).map_err(|_| "Invalid test URL.")?;
        let hint = url.host_str().unwrap_or_default().to_owned();
        return Ok((url, hint));
    }
    let _ = policy;
    let url = Url::parse(value).map_err(|_| "Enter a complete HTTPS URL.")?;
    if value.len() > 2048
        || url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.port_or_known_default() != Some(443)
    {
        return Err("Use an HTTPS URL on port 443 without login details or a fragment.");
    }
    let host = url.host_str().unwrap_or_default().to_owned();
    match kind {
        "discord" => {
            let segments: Vec<&str> = url
                .path_segments()
                .map(Iterator::collect)
                .unwrap_or_default();
            let valid = matches!(
                host.as_str(),
                "discord.com" | "discordapp.com" | "ptb.discord.com" | "canary.discord.com"
            ) && url.query().is_none()
                && segments.len() == 4
                && segments[0] == "api"
                && segments[1] == "webhooks"
                && (1..=25).contains(&segments[2].len())
                && segments[2].bytes().all(|b| b.is_ascii_digit())
                && (1..=100).contains(&segments[3].len())
                && segments[3]
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
            if !valid {
                return Err(
                    "Paste the webhook URL Discord shows in Server settings, Integrations, Webhooks.",
                );
            }
            let id = segments[2];
            Ok((
                url.clone(),
                format!("Webhook ending {}", &id[id.len().saturating_sub(4)..]),
            ))
        }
        "webhook" => Ok((url, host)),
        _ => Err("Choose Discord or webhook."),
    }
}
fn channel_name(value: &str) -> ApiResult<String> {
    let name = bounded(value, 80, "Enter a channel name of 1 to 80 characters.")?;
    if name.chars().any(char::is_control) {
        return Err(invalid("Enter a channel name of 1 to 80 characters."));
    }
    Ok(name)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NewChannel {
    revision: i64,
    kind: String,
    name: String,
    url: String,
}
async fn create_channel(
    State(pool): State<PgPool>,
    Extension(key): Extension<SecretKey>,
    policy: Option<Extension<PanelPolicy>>,
    auth: AuthSession,
    session: Session,
    headers: HeaderMap,
    input: Result<Json<NewChannel>, axum::extract::rejection::JsonRejection>,
) -> ApiResult<Json<Value>> {
    let (mut tx, org) = access(&pool, &auth, &session, &headers, WRITE, MANAGE).await?;
    let Json(input) = input.map_err(|_| invalid("Enter valid channel details."))?;
    let current = settings(&mut tx, &org).await?;
    if current.revision != input.revision {
        return Err(conflict());
    }
    let name = channel_name(&input.name)?;
    let policy = policy.map(|p| p.0).unwrap_or_default();
    let (url, hint) = destination(&input.kind, &input.url, &policy).map_err(invalid)?;
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM alert_channels WHERE organization_id=$1")
            .bind(&org)
            .fetch_one(&mut *tx)
            .await?;
    if count >= MAX_CHANNELS {
        return Err(invalid(
            "An organization can have at most 10 alert channels.",
        ));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let encrypted = key.encrypt(url.as_str(), &org, &id, "alert-url")?;
    let signing_secret =
        (input.kind == "webhook").then(|| format!("whsec_{}", crate::auth::secret()));
    let signing_encrypted = signing_secret
        .as_deref()
        .map(|secret| key.encrypt(secret, &org, &id, "alert-signing"))
        .transpose()?;
    sqlx::query("INSERT INTO alert_channels(organization_id,id,kind,name,destination,url_encrypted,signing_secret_encrypted,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint)")
        .bind(&org)
        .bind(&id)
        .bind(&input.kind)
        .bind(name)
        .bind(hint)
        .bind(encrypted)
        .bind(signing_encrypted)
        .execute(&mut *tx)
        .await?;
    let mut routes = current.routes;
    for event in DEFAULT_ROUTES {
        routes
            .entry((*event).to_owned())
            .or_default()
            .push(id.clone());
    }
    write_settings(&mut tx, &org, &routes, current.retention_days).await?;
    let alerts = state(&mut tx, &org).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"alerts": alerts, "channelId": id, "signingSecret": signing_secret}),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChannelChange {
    revision: i64,
    name: String,
    url: Option<String>,
}
#[allow(clippy::too_many_arguments)]
async fn update_channel(
    State(pool): State<PgPool>,
    Extension(key): Extension<SecretKey>,
    policy: Option<Extension<PanelPolicy>>,
    auth: AuthSession,
    session: Session,
    headers: HeaderMap,
    Path(id): Path<String>,
    input: Result<Json<ChannelChange>, axum::extract::rejection::JsonRejection>,
) -> ApiResult<Json<Alerts>> {
    let (mut tx, org) = access(&pool, &auth, &session, &headers, WRITE, MANAGE).await?;
    let Json(input) = input.map_err(|_| invalid("Enter valid channel details."))?;
    let current = settings(&mut tx, &org).await?;
    if current.revision != input.revision {
        return Err(conflict());
    }
    let kind: String =
        sqlx::query_scalar("SELECT kind FROM alert_channels WHERE organization_id=$1 AND id=$2")
            .bind(&org)
            .bind(&id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(not_found)?;
    let name = channel_name(&input.name)?;
    match input.url.filter(|url| !url.trim().is_empty()) {
        Some(url) => {
            let policy = policy.map(|p| p.0).unwrap_or_default();
            let (url, hint) = destination(&kind, &url, &policy).map_err(invalid)?;
            let encrypted = key.encrypt(url.as_str(), &org, &id, "alert-url")?;
            sqlx::query("UPDATE alert_channels SET name=$3,destination=$4,url_encrypted=$5,last_delivery_at=NULL,last_delivery_ok=NULL,last_error=NULL WHERE organization_id=$1 AND id=$2")
                .bind(&org).bind(&id).bind(name).bind(hint).bind(encrypted).execute(&mut *tx).await?;
        }
        None => {
            sqlx::query("UPDATE alert_channels SET name=$3 WHERE organization_id=$1 AND id=$2")
                .bind(&org)
                .bind(&id)
                .bind(name)
                .execute(&mut *tx)
                .await?;
        }
    }
    write_settings(&mut tx, &org, &current.routes, current.retention_days).await?;
    let alerts = state(&mut tx, &org).await?;
    tx.commit().await?;
    Ok(Json(alerts))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Revision {
    revision: i64,
}
async fn remove_channel(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    headers: HeaderMap,
    Path(id): Path<String>,
    input: Result<Json<Revision>, axum::extract::rejection::JsonRejection>,
) -> ApiResult<Json<Alerts>> {
    let (mut tx, org) = access(&pool, &auth, &session, &headers, WRITE, MANAGE).await?;
    let Json(input) = input.map_err(|_| invalid("Enter a valid revision."))?;
    let current = settings(&mut tx, &org).await?;
    if current.revision != input.revision {
        return Err(conflict());
    }
    // Finished deliveries stay as history; waiting ones have nowhere to go.
    sqlx::query("DELETE FROM alert_deliveries WHERE organization_id=$1 AND channel_id=$2 AND status='pending'")
        .bind(&org)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    let removed = sqlx::query("DELETE FROM alert_channels WHERE organization_id=$1 AND id=$2")
        .bind(&org)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    if removed.rows_affected() == 0 {
        return Err(not_found());
    }
    let mut routes = current.routes;
    for ids in routes.values_mut() {
        ids.retain(|channel| channel != &id);
    }
    routes.retain(|_, ids| !ids.is_empty());
    write_settings(&mut tx, &org, &routes, current.retention_days).await?;
    let alerts = state(&mut tx, &org).await?;
    tx.commit().await?;
    Ok(Json(alerts))
}

/// Replace a webhook's signing secret. The new secret is shown once.
async fn rotate_channel(
    State(pool): State<PgPool>,
    Extension(key): Extension<SecretKey>,
    auth: AuthSession,
    session: Session,
    headers: HeaderMap,
    Path(id): Path<String>,
    input: Result<Json<Revision>, axum::extract::rejection::JsonRejection>,
) -> ApiResult<Json<Value>> {
    let (mut tx, org) = access(&pool, &auth, &session, &headers, WRITE, MANAGE).await?;
    let Json(input) = input.map_err(|_| invalid("Enter a valid revision."))?;
    let current = settings(&mut tx, &org).await?;
    if current.revision != input.revision {
        return Err(conflict());
    }
    let kind: String =
        sqlx::query_scalar("SELECT kind FROM alert_channels WHERE organization_id=$1 AND id=$2")
            .bind(&org)
            .bind(&id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(not_found)?;
    if kind != "webhook" {
        return Err(invalid("Only webhook channels have a signing secret."));
    }
    let secret = format!("whsec_{}", crate::auth::secret());
    let encrypted = key.encrypt(&secret, &org, &id, "alert-signing")?;
    sqlx::query(
        "UPDATE alert_channels SET signing_secret_encrypted=$3 WHERE organization_id=$1 AND id=$2",
    )
    .bind(&org)
    .bind(&id)
    .bind(encrypted)
    .execute(&mut *tx)
    .await?;
    write_settings(&mut tx, &org, &current.routes, current.retention_days).await?;
    let alerts = state(&mut tx, &org).await?;
    tx.commit().await?;
    Ok(Json(json!({"alerts": alerts, "signingSecret": secret})))
}

/// Holds an organization's single test-send slot until dropped.
pub(crate) struct TestSlot(String);
impl TestSlot {
    pub(crate) fn acquire(org: &str) -> Option<Self> {
        let mut testing = TESTING.lock().unwrap_or_else(|e| e.into_inner());
        testing.insert(org.to_owned()).then(|| Self(org.to_owned()))
    }
}
impl Drop for TestSlot {
    fn drop(&mut self) {
        TESTING
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
    }
}

#[derive(FromRow)]
struct Target {
    kind: String,
    url_encrypted: Vec<u8>,
    signing_secret_encrypted: Option<Vec<u8>>,
}
struct Decrypted {
    kind: String,
    url: String,
    signing_secret: Option<String>,
}
fn decrypt(key: &SecretKey, org: &str, id: &str, target: Target) -> Option<Decrypted> {
    let text = |bytes: &[u8], purpose| {
        key.decrypt(bytes, org, id, purpose)
            .ok()
            .and_then(|v| String::from_utf8(v).ok())
    };
    Some(Decrypted {
        url: text(&target.url_encrypted, "alert-url")?,
        signing_secret: match &target.signing_secret_encrypted {
            Some(bytes) => Some(text(bytes, "alert-signing")?),
            None => None,
        },
        kind: target.kind,
    })
}

async fn test_channel(
    State(pool): State<PgPool>,
    Extension(key): Extension<SecretKey>,
    policy: Option<Extension<PanelPolicy>>,
    auth: AuthSession,
    session: Session,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let (mut tx, org) = access(&pool, &auth, &session, &headers, READ, MANAGE).await?;
    let target: Target = sqlx::query_as("SELECT kind,url_encrypted,signing_secret_encrypted FROM alert_channels WHERE organization_id=$1 AND id=$2")
        .bind(&org)
        .bind(&id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(not_found)?;
    let organization: String = sqlx::query_scalar("SELECT name FROM organizations WHERE id=$1")
        .bind(&org)
        .fetch_one(&mut *tx)
        .await?;
    // Release the organization lock before network I/O.
    tx.commit().await?;
    let busy = || {
        ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Test alerts are busy. Try again shortly.",
        )
    };
    let _slot = TestSlot::acquire(&org).ok_or_else(busy)?;
    let _permit = TEST_SENDS.try_acquire().map_err(|_| busy())?;
    let policy = policy.map(|p| p.0).unwrap_or_default();
    let result = match decrypt(&key, &org, &id, target) {
        Some(target) => {
            let message = Message {
                id: &uuid::Uuid::new_v4().to_string(),
                event: "test",
                severity: "info",
                title: "Test alert from Cupboard",
                detail: "This channel is set up to receive Cupboard alerts.",
                created_at: now(),
                organization_id: &org,
                organization_name: &organization,
                test: true,
            };
            send(&target, &message, &policy).await
        }
        None => Err(Failure::Permanent(
            "The saved destination could not be read. Replace its URL.".into(),
        )),
    };
    let (mut tx, current_org) = access(&pool, &auth, &session, &headers, READ, MANAGE).await?;
    if current_org != org {
        return Err(conflict());
    }
    let error = result.err().map(Failure::message);
    sqlx::query("UPDATE alert_channels SET last_delivery_at=$3,last_delivery_ok=$4,last_error=$5 WHERE organization_id=$1 AND id=$2")
        .bind(&org)
        .bind(&id)
        .bind(now())
        .bind(error.is_none())
        .bind(&error)
        .execute(&mut *tx)
        .await?;
    let alerts = state(&mut tx, &org).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"alerts": alerts, "delivered": error.is_none(), "error": error}),
    ))
}

pub(crate) struct Message<'a> {
    pub id: &'a str,
    pub event: &'a str,
    pub severity: &'a str,
    pub title: &'a str,
    pub detail: &'a str,
    pub created_at: i64,
    pub organization_id: &'a str,
    pub organization_name: &'a str,
    pub test: bool,
}
pub(crate) enum Failure {
    Retry(String),
    Permanent(String),
}
impl Failure {
    fn message(self) -> String {
        match self {
            Self::Retry(message) | Self::Permanent(message) => message,
        }
    }
}
fn truncate(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        value.to_owned()
    } else {
        let mut text: String = value.chars().take(max - 1).collect();
        text.push('…');
        text
    }
}
pub(crate) fn discord_body(message: &Message) -> Value {
    let color = match message.severity {
        "critical" => 0xd06a6a,
        "warning" => 0xc9a45d,
        _ => 0x7cb58d,
    };
    json!({
        "username": "Cupboard",
        "allowed_mentions": {"parse": []},
        "embeds": [{
            "title": truncate(message.title, 256),
            "description": truncate(message.detail, 2000),
            "color": color,
            "footer": {"text": truncate(message.organization_name, 200)},
        }],
    })
}
pub(crate) fn webhook_body(message: &Message) -> Value {
    json!({
        "id": message.id,
        "type": message.event,
        "severity": message.severity,
        "title": message.title,
        "detail": message.detail,
        "createdAt": message.created_at,
        "test": message.test,
        "organization": {"id": message.organization_id, "name": message.organization_name},
    })
}
/// `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, in the style receivers already verify.
pub(crate) fn signature(secret: &str, timestamp: i64, body: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key");
    mac.update(format!("{timestamp}.").as_bytes());
    mac.update(body);
    let digest = mac.finalize().into_bytes();
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("t={timestamp},v1={hex}")
}
async fn within(
    deadline: Duration,
    attempt: impl Future<Output = Result<(), Failure>>,
) -> Result<(), Failure> {
    tokio::time::timeout(deadline, attempt)
        .await
        .unwrap_or_else(|_| {
            Err(Failure::Retry(
                "The destination did not respond within 10 seconds.".into(),
            ))
        })
}
async fn send(
    target: &Decrypted,
    message: &Message<'_>,
    policy: &PanelPolicy,
) -> Result<(), Failure> {
    within(SEND_DEADLINE, attempt(target, message, policy)).await
}
async fn attempt(
    target: &Decrypted,
    message: &Message<'_>,
    policy: &PanelPolicy,
) -> Result<(), Failure> {
    let (url, _) = destination(&target.kind, &target.url, policy)
        .map_err(|_| Failure::Permanent("The saved destination is no longer allowed.".into()))?;
    let client = crate::pelican::panel_client(&url, policy)
        .await
        .map_err(|_| {
            Failure::Retry(
                "The destination could not be resolved to an allowed public address.".into(),
            )
        })?;
    let body = if target.kind == "discord" {
        discord_body(message)
    } else {
        webhook_body(message)
    };
    let body = serde_json::to_vec(&body)
        .map_err(|_| Failure::Permanent("The alert could not be encoded.".into()))?;
    let mut request = client
        .post(url)
        .header("content-type", "application/json")
        .header("user-agent", "Cupboard-Alerts/1.0");
    if let Some(secret) = &target.signing_secret {
        request = request
            .header("x-cupboard-event", message.event)
            .header("x-cupboard-delivery", message.id)
            .header(
                "x-cupboard-signature",
                signature(secret, now().div_euclid(1000), &body),
            );
    }
    // Error text from reqwest can include the URL, which may hold a webhook token.
    let response = request.body(body).send().await.map_err(|error| {
        Failure::Retry(if error.is_timeout() {
            "The destination did not respond within 10 seconds.".into()
        } else {
            "Could not reach the destination securely.".into()
        })
    })?;
    let status = response.status().as_u16();
    match status {
        200..=299 => Ok(()),
        300..=399 => Err(Failure::Permanent(
            "The destination redirected the request. Use its final URL.".into(),
        )),
        401 | 403 | 404 | 410 => Err(Failure::Permanent(format!(
            "The destination rejected the alert (HTTP {status}). Check that the URL is still valid."
        ))),
        408 | 429 | 500..=599 => Err(Failure::Retry(format!(
            "The destination is unavailable (HTTP {status})."
        ))),
        _ => Err(Failure::Permanent(format!(
            "The destination rejected the alert (HTTP {status})."
        ))),
    }
}

/// Record an alert and queue its deliveries in the caller's transaction, so the
/// alert exists only if the state change that caused it is committed.
pub(crate) async fn record(
    conn: &mut PgConnection,
    org: &str,
    event: &str,
    title: &str,
    detail: &str,
) -> ApiResult<()> {
    let severity = EVENTS
        .iter()
        .find(|(key, _)| *key == event)
        .map(|(_, severity)| *severity)
        .ok_or_else(internal)?;
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO alert_events(organization_id,id,event,severity,title,detail,created_at) VALUES($1,$2,$3,$4,$5,$6,(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint)")
        .bind(org)
        .bind(&id)
        .bind(event)
        .bind(severity)
        .bind(truncate(title, 200))
        .bind(truncate(detail, 1000))
        .execute(&mut *conn)
        .await?;
    sqlx::query("INSERT INTO alert_deliveries(organization_id,event_id,channel_id,channel_name,status,next_attempt_at) SELECT $1,$2,c.id,c.name,'pending',(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint FROM alert_settings s CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(s.routes->$3,'[]'::jsonb)) AS r(channel_id) JOIN alert_channels c ON c.organization_id=s.organization_id AND c.id=r.channel_id WHERE s.organization_id=$1")
        .bind(org)
        .bind(&id)
        .bind(event)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Detect stale machines, deliver queued alerts, and prune expired history.
/// Delivery runs on its own so a slow queue cannot delay outage detection.
pub async fn monitor(pool: PgPool, key: SecretKey, policy: PanelPolicy) {
    tokio::join!(watch(&pool), drain(&pool, &key, &policy));
}
/// Holds machine sweeps back until agents have had time to report. An outage of
/// Cupboard itself must not read as every machine going offline.
pub(crate) struct SweepGate(Instant);
impl SweepGate {
    pub(crate) fn new(now: Instant) -> Self {
        Self(now + REPORT_GRACE)
    }
    pub(crate) fn open(&self, now: Instant) -> bool {
        now >= self.0
    }
}
async fn watch(pool: &PgPool) {
    let mut gate = SweepGate::new(Instant::now());
    let mut tick: u32 = 0;
    loop {
        if gate.open(Instant::now()) && sweep_machines(pool).await.is_err() {
            eprintln!("Machine alert check failed; retrying shortly.");
            gate = SweepGate::new(Instant::now());
        }
        if tick.is_multiple_of(60) && prune(pool).await.is_err() {
            eprintln!("Alert history cleanup failed; retrying later.");
        }
        tick = tick.wrapping_add(1);
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}
async fn drain(pool: &PgPool, key: &SecretKey, policy: &PanelPolicy) {
    loop {
        match deliver_due(pool, key, policy).await {
            Ok(true) => continue,
            Ok(false) => {}
            Err(_) => eprintln!("Alert delivery failed; retrying shortly."),
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}
pub(crate) async fn sweep_machines(pool: &PgPool) -> ApiResult<usize> {
    let mut tx = pool.begin().await?;
    // The guard on alert_offline makes concurrent replicas announce each outage once.
    // An agent that enrolled but never reported counts from its enrollment.
    let stale: Vec<(String, String)> = sqlx::query_as("UPDATE machines SET alert_offline=true WHERE agent_hash IS NOT NULL AND COALESCE(last_seen_at,enrolled_at) < (EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint-90000 AND NOT alert_offline RETURNING organization_id,name")
        .fetch_all(&mut *tx)
        .await?;
    for (org, name) in &stale {
        record(
            &mut tx,
            org,
            "machine.offline",
            &format!("{name} stopped reporting"),
            "The Cupboard agent has not sent a health report for 90 seconds. The machine may be offline, or the agent may have stopped.",
        )
        .await?;
    }
    tx.commit().await?;
    Ok(stale.len())
}
#[derive(FromRow)]
struct Claim {
    organization_id: String,
    event_id: String,
    channel_id: String,
    attempts: i32,
}
pub(crate) async fn deliver_due(
    pool: &PgPool,
    key: &SecretKey,
    policy: &PanelPolicy,
) -> ApiResult<bool> {
    // A claim leases each delivery for a minute so a crashed replica's work is retried.
    // Each organization takes a turn, so one backlog cannot hold up another's alerts.
    let claims: Vec<Claim> = sqlx::query_as("WITH ranked AS (SELECT organization_id,event_id,channel_id,next_attempt_at,row_number() OVER (PARTITION BY organization_id ORDER BY next_attempt_at,event_id,channel_id) AS turn FROM alert_deliveries WHERE status='pending' AND next_attempt_at<=$1), due AS (SELECT p.organization_id,p.event_id,p.channel_id FROM alert_deliveries p JOIN ranked r USING (organization_id,event_id,channel_id) WHERE p.status='pending' AND p.next_attempt_at<=$1 ORDER BY r.turn,r.next_attempt_at LIMIT 8 FOR UPDATE OF p SKIP LOCKED) UPDATE alert_deliveries d SET next_attempt_at=$1+60000,attempts=d.attempts+1 FROM due WHERE d.organization_id=due.organization_id AND d.event_id=due.event_id AND d.channel_id=due.channel_id RETURNING d.organization_id,d.event_id,d.channel_id,d.attempts")
        .bind(now())
        .fetch_all(pool)
        .await?;
    if claims.is_empty() {
        return Ok(false);
    }
    let results: Vec<ApiResult<()>> = futures_util::future::join_all(
        claims
            .into_iter()
            .map(|claim| deliver(pool, key, policy, claim)),
    )
    .await;
    results.into_iter().collect::<ApiResult<Vec<_>>>()?;
    Ok(true)
}
#[derive(FromRow)]
struct Pending {
    kind: String,
    url_encrypted: Vec<u8>,
    signing_secret_encrypted: Option<Vec<u8>>,
    event: String,
    severity: String,
    title: String,
    detail: String,
    created_at: i64,
    organization_name: String,
}
fn backoff(attempts: i32) -> i64 {
    match attempts {
        1 => 30_000,
        2 => 120_000,
        3 => 600_000,
        _ => 1_800_000,
    }
}
async fn deliver(
    pool: &PgPool,
    key: &SecretKey,
    policy: &PanelPolicy,
    claim: Claim,
) -> ApiResult<()> {
    let pending: Option<Pending> = sqlx::query_as("SELECT c.kind,c.url_encrypted,c.signing_secret_encrypted,e.event,e.severity,e.title,e.detail,e.created_at,o.name AS organization_name FROM alert_deliveries d JOIN alert_channels c ON c.organization_id=d.organization_id AND c.id=d.channel_id JOIN alert_events e ON e.organization_id=d.organization_id AND e.id=d.event_id JOIN organizations o ON o.id=d.organization_id WHERE d.organization_id=$1 AND d.event_id=$2 AND d.channel_id=$3 AND d.status='pending' AND d.attempts=$4")
        .bind(&claim.organization_id)
        .bind(&claim.event_id)
        .bind(&claim.channel_id)
        .bind(claim.attempts)
        .fetch_optional(pool)
        .await?;
    let Some(pending) = pending else {
        return Ok(());
    };
    let _permit = DELIVERIES.acquire().await.map_err(|_| internal())?;
    let target = Target {
        kind: pending.kind,
        url_encrypted: pending.url_encrypted,
        signing_secret_encrypted: pending.signing_secret_encrypted,
    };
    let result = match decrypt(key, &claim.organization_id, &claim.channel_id, target) {
        Some(target) => {
            let message = Message {
                id: &claim.event_id,
                event: &pending.event,
                severity: &pending.severity,
                title: &pending.title,
                detail: &pending.detail,
                created_at: pending.created_at,
                organization_id: &claim.organization_id,
                organization_name: &pending.organization_name,
                test: false,
            };
            send(&target, &message, policy).await
        }
        None => Err(Failure::Permanent(
            "The saved destination could not be read. Replace its URL.".into(),
        )),
    };
    let at = now();
    let (status, error, next) = match result {
        Ok(()) => ("sent", None, at),
        Err(Failure::Retry(error)) if claim.attempts < MAX_ATTEMPTS => {
            ("pending", Some(error), at + backoff(claim.attempts))
        }
        Err(failure) => ("failed", Some(failure.message()), at),
    };
    let mut tx = pool.begin().await?;
    // Only the current claim may publish; a newer claim or a removed channel wins.
    let updated = sqlx::query("UPDATE alert_deliveries SET status=$5,error=$6,next_attempt_at=$7,completed_at=CASE WHEN $5='pending' THEN NULL ELSE $8 END WHERE organization_id=$1 AND event_id=$2 AND channel_id=$3 AND attempts=$4 AND status='pending'")
        .bind(&claim.organization_id)
        .bind(&claim.event_id)
        .bind(&claim.channel_id)
        .bind(claim.attempts)
        .bind(status)
        .bind(&error)
        .bind(next)
        .bind(at)
        .execute(&mut *tx)
        .await?;
    if updated.rows_affected() == 1 {
        sqlx::query("UPDATE alert_channels SET last_delivery_at=$3,last_delivery_ok=$4,last_error=$5 WHERE organization_id=$1 AND id=$2")
            .bind(&claim.organization_id)
            .bind(&claim.channel_id)
            .bind(at)
            .bind(error.is_none())
            .bind(&error)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}
pub(crate) async fn prune(pool: &PgPool) -> ApiResult<u64> {
    let removed = sqlx::query("DELETE FROM alert_events e WHERE e.created_at < $1 - COALESCE((SELECT s.retention_days FROM alert_settings s WHERE s.organization_id=e.organization_id),30)::bigint*86400000")
        .bind(now())
        .execute(pool)
        .await?;
    Ok(removed.rows_affected())
}

async fn export(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    let (mut tx, org) = access(&pool, &auth, &session, &headers, READ, EXPORT).await?;
    // Configuration only: credentials, tokens, webhook URLs, and file contents are excluded.
    let section = |sql: &'static str| sqlx::query_scalar::<_, Value>(sql).bind(org.clone());
    let organization =
        section("SELECT json_build_object('id',id,'name',name) FROM organizations WHERE id=$1")
            .fetch_one(&mut *tx)
            .await?;
    let roles = section("SELECT COALESCE(json_agg(json_build_object('id',id,'name',name,'description',description,'permissions',permissions,'position',position) ORDER BY position),'[]'::json) FROM organization_roles WHERE organization_id=$1").fetch_one(&mut *tx).await?;
    let members = section("SELECT COALESCE(json_agg(json_build_object('name',m.name,'email',m.email,'status',m.status,'roleIds',ARRAY(SELECT role_id FROM organization_member_roles mr WHERE mr.organization_id=m.organization_id AND mr.member_id=m.id ORDER BY role_id)) ORDER BY m.name,m.id),'[]'::json) FROM organization_members m WHERE m.organization_id=$1").fetch_one(&mut *tx).await?;
    let servers = section("SELECT COALESCE(json_agg(json_build_object('id',id,'name',name,'rconHost',rcon_host,'rconPort',rcon_port,'a2sHost',a2s_host,'a2sPort',a2s_port,'pelicanServerUuid',panel_server_uuid) ORDER BY created_at,id),'[]'::json) FROM servers WHERE organization_id=$1").fetch_one(&mut *tx).await?;
    let machines = section("SELECT COALESCE(json_agg(json_build_object('id',id,'name',name,'address',address,'provider',provider,'notes',notes,'tags',tags,'enrolled',agent_hash IS NOT NULL) ORDER BY created_at,id),'[]'::json) FROM machines WHERE organization_id=$1").fetch_one(&mut *tx).await?;
    let pelican = section("SELECT COALESCE((SELECT json_build_object('panelUrl',panel_url,'lastCheckedAt',checked_at,'lastSuccessAt',last_success_at) FROM pelican_connections WHERE organization_id=$1),'null'::json)").fetch_one(&mut *tx).await?;
    let files = section("SELECT json_build_object('count',count(*),'bytes',COALESCE(sum(size),0)) FROM organization_files WHERE organization_id=$1 AND ready").fetch_one(&mut *tx).await?;
    let channels = section("SELECT COALESCE(json_agg(json_build_object('id',id,'kind',kind,'name',name,'destination',destination) ORDER BY created_at,id),'[]'::json) FROM alert_channels WHERE organization_id=$1").fetch_one(&mut *tx).await?;
    let current = settings(&mut tx, &org).await?;
    tx.commit().await?;
    Ok(Json(json!({
        "format": "cupboard-organization-export",
        "version": 1,
        "exportedAt": now(),
        "organization": organization,
        "roles": roles,
        "members": members,
        "servers": servers,
        "machines": machines,
        "pelicanConnection": pelican,
        "files": files,
        "alerts": {
            "channels": channels,
            "routes": current.routes,
            "retentionDays": current.retention_days,
        },
    })))
}

fn now() -> i64 {
    time::OffsetDateTime::now_utc()
        .unix_timestamp_nanos()
        .div_euclid(1_000_000) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn machine_sweeps_wait_for_agents_to_report() {
        let start = Instant::now();
        let gate = SweepGate::new(start);
        assert!(!gate.open(start));
        assert!(!gate.open(start + REPORT_GRACE - Duration::from_secs(1)));
        assert!(gate.open(start + REPORT_GRACE));
    }

    #[tokio::test]
    async fn a_stalled_send_fails_with_a_retry_at_its_deadline() {
        let result = within(
            Duration::from_millis(10),
            std::future::pending::<Result<(), Failure>>(),
        )
        .await;
        assert!(matches!(result, Err(Failure::Retry(_))));
    }

    #[test]
    fn test_slots_are_held_per_organization() {
        let first = TestSlot::acquire("slot-org-a").unwrap();
        assert!(TestSlot::acquire("slot-org-a").is_none());
        let other = TestSlot::acquire("slot-org-b");
        assert!(other.is_some());
        drop(first);
        assert!(TestSlot::acquire("slot-org-a").is_some());
    }

    #[test]
    fn destinations_accept_only_safe_discord_and_https_webhooks() {
        let policy = PanelPolicy::default();
        let (url, hint) = destination(
            "discord",
            "https://discord.com/api/webhooks/123456789012345678/abc_DEF-123",
            &policy,
        )
        .unwrap();
        assert_eq!(url.host_str(), Some("discord.com"));
        assert_eq!(hint, "Webhook ending 5678");
        assert!(!hint.contains("abc_DEF"));
        for value in [
            "http://discord.com/api/webhooks/1/token",
            "https://discord.com.evil.example/api/webhooks/1/token",
            "https://evil.example/api/webhooks/1/token",
            "https://discord.com/api/webhooks/not-digits/token",
            "https://discord.com/api/webhooks/1/token?wait=true",
            "https://discord.com/api/webhooks/1/token/extra",
            "https://user:pass@discord.com/api/webhooks/1/token",
            "https://discord.com:8443/api/webhooks/1/token",
        ] {
            assert!(destination("discord", value, &policy).is_err(), "{value}");
        }
        let (_, hint) = destination(
            "webhook",
            "https://hooks.example.com/alerts?token=secret",
            &policy,
        )
        .unwrap();
        assert_eq!(hint, "hooks.example.com");
        for value in [
            "http://hooks.example.com/alerts",
            "https://hooks.example.com:8443/alerts",
            "https://user@hooks.example.com/alerts",
            "https://hooks.example.com/alerts#fragment",
            "hooks.example.com/alerts",
        ] {
            assert!(destination("webhook", value, &policy).is_err(), "{value}");
        }
        assert!(destination("email", "https://hooks.example.com", &policy).is_err());
    }

    #[test]
    fn payloads_are_bounded_signed_and_never_mention_everyone() {
        let long = "x".repeat(3000);
        let message = Message {
            id: "event",
            event: "server.offline",
            severity: "critical",
            title: &long,
            detail: &long,
            created_at: 1_700_000_000_000,
            organization_id: "org",
            organization_name: "Northstar",
            test: false,
        };
        let discord = discord_body(&message);
        assert_eq!(discord["allowed_mentions"]["parse"], json!([]));
        assert_eq!(
            discord["embeds"][0]["title"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            256
        );
        assert_eq!(
            discord["embeds"][0]["description"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            2000
        );
        assert_eq!(discord["embeds"][0]["color"], 0xd06a6a);
        let webhook = webhook_body(&message);
        assert_eq!(webhook["type"], "server.offline");
        assert_eq!(webhook["organization"]["name"], "Northstar");
        // Matches an independently computed HMAC-SHA256 for this key and payload.
        assert_eq!(
            signature("whsec_test", 1_700_000_000, b"{}"),
            "t=1700000000,v1=35495024f4ef3f94e5a93e22221544c4b75e9a42300cd965ab81cb85cd994e91"
        );
    }

    #[test]
    fn every_default_route_is_a_supported_event() {
        for event in DEFAULT_ROUTES {
            assert!(EVENTS.iter().any(|(key, _)| key == event));
        }
        assert_eq!(backoff(1), 30_000);
        assert_eq!(backoff(9), 1_800_000);
    }
}
