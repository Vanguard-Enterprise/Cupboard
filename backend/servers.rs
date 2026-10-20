use crate::secrets::SecretKey;
use crate::{
    auth::{ApiError, ApiResult, AuthSession, account, forbidden, internal},
    team,
};
use axum::{
    Extension, Json, Router,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use std::collections::BTreeMap;
use tower_sessions::Session;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NewServer {
    name: String,
    rcon_host: String,
    rcon_port: i32,
    rcon_password: String,
    a2s_host: String,
    a2s_port: i32,
}
#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
struct Server {
    id: String,
    name: String,
    rcon_host: Option<String>,
    rcon_port: Option<i32>,
    a2s_host: Option<String>,
    a2s_port: Option<i32>,
    checked_at: Option<i64>,
    rcon_status: Option<String>,
    a2s_status: Option<String>,
    players: Option<i64>,
    players_at: Option<i64>,
    players_source: Option<String>,
    panel_server_uuid: Option<String>,
}
#[derive(Debug)]
struct Validation(BTreeMap<&'static str, &'static str>);
impl IntoResponse for Validation {
    fn into_response(self) -> Response {
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(serde_json::json!({"error":"Check the highlighted fields.","fields":self.0})),
        )
            .into_response()
    }
}
pub(crate) fn host(value: &str) -> bool {
    if value.parse::<std::net::IpAddr>().is_ok() {
        return true;
    }
    value.len() <= 253
        && !value.is_empty()
        && value.split('.').all(|part| {
            !part.is_empty()
                && part.len() <= 63
                && !part.starts_with('-')
                && !part.ends_with('-')
                && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}
impl NewServer {
    fn validate(&mut self) -> Result<(), Validation> {
        self.name = self.name.trim().to_owned();
        self.rcon_host = self.rcon_host.trim().to_owned();
        self.a2s_host = self.a2s_host.trim().to_owned();
        let mut fields = BTreeMap::new();
        if self.name.is_empty()
            || self.name.chars().count() > 80
            || self.name.chars().any(char::is_control)
        {
            fields.insert("name", "Enter a server name of 1 to 80 characters.");
        }
        for (field, value) in [("rconHost", &self.rcon_host), ("a2sHost", &self.a2s_host)] {
            if !host(value) {
                fields.insert(
                    field,
                    "Enter an IP address or hostname without a scheme or port.",
                );
            }
        }
        for (field, value) in [("rconPort", self.rcon_port), ("a2sPort", self.a2s_port)] {
            if !(1..=65535).contains(&value) {
                fields.insert(field, "Enter a port from 1 to 65535.");
            }
        }
        if self.rcon_password.is_empty()
            || self.rcon_password.len() > 1024
            || self.rcon_password.chars().any(char::is_control)
        {
            fields.insert(
                "rconPassword",
                "Enter an RCON password of at most 1024 bytes without control characters.",
            );
        }
        if fields.is_empty() {
            Ok(())
        } else {
            Err(Validation(fields))
        }
    }
}
pub fn routes() -> Router<PgPool> {
    Router::new()
        .route("/app-api/servers", get(list).post(create))
        .route("/app-api/servers/{id}/check", post(check))
        .route("/app-api/servers/health", get(health))
}
async fn list(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
) -> ApiResult<Json<Vec<Server>>> {
    Ok(Json(read_servers(&pool, &auth, &session).await?.1))
}
async fn health(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
) -> ApiResult<Json<serde_json::Value>> {
    let (org, servers) = read_servers(&pool, &auth, &session).await?;
    Ok(Json(
        serde_json::json!({"organizationId": org, "servers": servers}),
    ))
}
async fn read_servers(
    pool: &PgPool,
    auth: &AuthSession,
    session: &Session,
) -> ApiResult<(String, Vec<Server>)> {
    let user = account(auth)?;
    let org = team::organization_id(session).await?;
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT id FROM organizations WHERE id=$1 FOR SHARE")
        .bind(&org)
        .execute(&mut *tx)
        .await?;
    let ctx = team::context_on(&mut tx, &user.id, &org).await?;
    if !ctx.permissions.iter().any(|p| p == "servers.view") {
        return Err(forbidden());
    }
    let servers = sqlx::query_as("SELECT id,name,rcon_host,rcon_port,a2s_host,a2s_port,checked_at,rcon_status,a2s_status,players,players_at,players_source,panel_server_uuid FROM servers WHERE organization_id=$1 ORDER BY created_at,id").bind(&ctx.organization_id).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    Ok((ctx.organization_id, servers))
}
async fn create(
    State(pool): State<PgPool>,
    Extension(key): Extension<SecretKey>,
    auth: AuthSession,
    session: Session,
    input: Result<Json<NewServer>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Server>, Response> {
    let user = account(&auth).map_err(IntoResponse::into_response)?;
    let org = team::organization_id(&session)
        .await
        .map_err(IntoResponse::into_response)?;
    let mut tx = pool.begin().await.map_err(|_| internal().into_response())?;
    sqlx::query("SELECT id FROM organizations WHERE id=$1 FOR SHARE")
        .bind(&org)
        .execute(&mut *tx)
        .await
        .map_err(|_| internal().into_response())?;
    let ctx = team::context_on(&mut tx, &user.id, &org)
        .await
        .map_err(IntoResponse::into_response)?;
    if !ctx.permissions.iter().any(|p| p == "servers.manage") {
        return Err(forbidden().into_response());
    }
    let Json(mut input) = input.map_err(|_| {
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(serde_json::json!({"error":"Enter valid server connection details."})),
        )
            .into_response()
    })?;
    input.validate().map_err(IntoResponse::into_response)?;
    let id = uuid::Uuid::new_v4().to_string();
    let encrypted = key
        .encrypt(&input.rcon_password, &ctx.organization_id, &id, "rcon")
        .map_err(IntoResponse::into_response)?;
    let result=sqlx::query_as("INSERT INTO servers(id,organization_id,name,rcon_host,rcon_port,rcon_password_encrypted,a2s_host,a2s_port) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,name,rcon_host,rcon_port,a2s_host,a2s_port,checked_at,rcon_status,a2s_status,players,players_at,players_source,panel_server_uuid")
        .bind(id).bind(&ctx.organization_id).bind(input.name).bind(input.rcon_host).bind(input.rcon_port).bind(encrypted).bind(input.a2s_host).bind(input.a2s_port).fetch_one(&mut *tx).await.map_err(|_|internal().into_response())?;
    tx.commit().await.map_err(|_| internal().into_response())?;
    Ok(Json(result))
}
// Keep one database connection available for ordinary API work during probes.
static CHECKS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
async fn check(
    State(pool): State<PgPool>,
    Extension(key): Extension<SecretKey>,
    auth: AuthSession,
    session: Session,
    Path(id): Path<String>,
) -> ApiResult<Json<Server>> {
    let user = account(&auth)?;
    let org = team::organization_id(&session).await?;
    let _permit = CHECKS.try_acquire().map_err(|_| {
        ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Connection checks are busy. Try again shortly.",
        )
    })?;
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT id FROM organizations WHERE id=$1 FOR SHARE")
        .bind(&org)
        .execute(&mut *tx)
        .await?;
    let ctx = team::context_on(&mut tx, &user.id, &org).await?;
    if !ctx.permissions.iter().any(|p| p == "servers.manage") {
        return Err(forbidden());
    }
    let server: Server = sqlx::query_as("SELECT id,name,rcon_host,rcon_port,a2s_host,a2s_port,checked_at,rcon_status,a2s_status,players,players_at,players_source,panel_server_uuid FROM servers WHERE organization_id=$1 AND id=$2")
        .bind(&ctx.organization_id).bind(&id).fetch_optional(&mut *tx).await?.ok_or(ApiError(StatusCode::NOT_FOUND, "Server not found."))?;
    let locked: bool =
        sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 6))")
            .bind(&id)
            .fetch_one(&mut *tx)
            .await?;
    if !locked {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "A connection check is already running for this server.",
        ));
    }
    let result = probe(&mut tx, &key, &ctx.organization_id, &server).await?;
    tx.commit().await?;
    Ok(Json(result))
}

async fn probe(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    key: &SecretKey,
    org: &str,
    server: &Server,
) -> ApiResult<Server> {
    let encrypted: Option<Vec<u8>> = sqlx::query_scalar(
        "SELECT rcon_password_encrypted FROM servers WHERE organization_id=$1 AND id=$2",
    )
    .bind(org)
    .bind(&server.id)
    .fetch_one(&mut **tx)
    .await?;
    let password = encrypted
        .as_ref()
        .and_then(|encrypted| key.decrypt(encrypted, org, &server.id, "rcon").ok())
        .and_then(|p| String::from_utf8(p).ok());
    let (rcon, a2s) = tokio::join!(
        async {
            match (password, server.rcon_host.as_ref(), server.rcon_port) {
                (Some(password), Some(host), Some(port)) => {
                    crate::connectivity::rcon(host, port, &password).await
                }
                _ => crate::connectivity::Outcome::InvalidConfiguration,
            }
        },
        async {
            match (server.a2s_host.as_ref(), server.a2s_port) {
                (Some(host), Some(port)) => crate::connectivity::a2s(host, port).await,
                _ => crate::connectivity::Outcome::InvalidConfiguration,
            }
        }
    );
    let observation = match (rcon, a2s) {
        (crate::connectivity::Outcome::Connected(n), _) => Some((i64::from(n), "rcon")),
        (_, crate::connectivity::Outcome::Connected(n)) => Some((i64::from(n), "a2s")),
        _ => None,
    };
    let result = sqlx::query_as("UPDATE servers SET checked_at=(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint,rcon_status=$3,a2s_status=$4,players=COALESCE($5,players),players_at=CASE WHEN $5::bigint IS NOT NULL THEN (EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint ELSE players_at END,players_source=COALESCE($6,players_source) WHERE organization_id=$1 AND id=$2 RETURNING id,name,rcon_host,rcon_port,a2s_host,a2s_port,checked_at,rcon_status,a2s_status,players,players_at,players_source,panel_server_uuid")
        .bind(org).bind(&server.id).bind(rcon.as_str()).bind(a2s.as_str()).bind(observation.map(|v| v.0)).bind(observation.map(|v| v.1)).fetch_one(&mut **tx).await?;
    Ok(result)
}
/// Poll within the API runtime. The database lock and freshness check prevent
/// duplicate probes across replicas and operator-triggered checks.
pub async fn monitor(pool: PgPool, key: SecretKey) {
    loop {
        if let Err(_error) = poll_due(&pool, &key).await {
            eprintln!("Server health refresh failed; retrying shortly.");
        }
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
}
async fn poll_due(pool: &PgPool, key: &SecretKey) -> ApiResult<()> {
    let due: Vec<(String, String)> = sqlx::query_as("SELECT organization_id,id FROM servers WHERE rcon_host IS NOT NULL AND a2s_host IS NOT NULL AND (checked_at IS NULL OR checked_at < (EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint-30000) ORDER BY checked_at NULLS FIRST,id LIMIT 16")
        .fetch_all(pool).await?;
    futures_util::stream::StreamExt::for_each_concurrent(
        futures_util::stream::iter(due),
        2,
        |(org, id)| async move {
            if poll_server(pool, key, &org, &id).await.is_err() {
                eprintln!("Server health observation could not be saved.");
            }
        },
    )
    .await;
    Ok(())
}
pub(crate) async fn poll_server(
    pool: &PgPool,
    key: &SecretKey,
    org: &str,
    id: &str,
) -> ApiResult<()> {
    let Ok(_permit) = CHECKS.try_acquire() else {
        return Ok(());
    };
    let mut tx = pool.begin().await?;
    let locked: bool =
        sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 6))")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    if !locked {
        return Ok(());
    }
    let server: Option<Server> = sqlx::query_as("SELECT id,name,rcon_host,rcon_port,a2s_host,a2s_port,checked_at,rcon_status,a2s_status,players,players_at,players_source,panel_server_uuid FROM servers WHERE organization_id=$1 AND id=$2 AND (checked_at IS NULL OR checked_at < (EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint-30000)")
        .bind(org).bind(id).fetch_optional(&mut *tx).await?;
    if let Some(server) = server {
        probe(&mut tx, key, org, &server).await?;
    }
    tx.commit().await?;
    Ok(())
}
