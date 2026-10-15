use crate::{
    auth::{ApiError, ApiResult, AuthSession, account, forbidden, internal, invalid},
    pelican::{PanelPolicy, panel_client, validate_url},
    secrets::SecretKey,
    team,
};
use axum::{
    Extension, Json, Router,
    extract::{OriginalUri, Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::time::Duration;
use tower_sessions::Session;
static OPERATIONS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
static BACKGROUND_OPERATIONS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);

pub fn routes() -> Router<PgPool> {
    Router::new()
        .route("/app-api/servers/pelican/candidates", get(candidates))
        .route("/app-api/servers/pelican/import", post(import))
        .route("/app-api/servers/{id}/panel/resources", get(resources))
        .route("/app-api/servers/{id}/panel/observation", get(resources))
        .route("/app-api/servers/{id}/panel/console", get(console))
        .route("/app-api/servers/{id}/panel/power", post(power))
        .route("/app-api/servers/{id}/panel/command", post(command))
}
struct Access {
    org: String,
    connection: String,
    revision: i64,
    url: reqwest::Url,
    secret: String,
    uuid: Option<String>,
}
async fn access(
    pool: &PgPool,
    key: &SecretKey,
    policy: &PanelPolicy,
    identity: (&AuthSession, &Session, &HeaderMap),
    id: Option<&str>,
    manage: bool,
) -> ApiResult<Access> {
    let (auth, session, headers) = identity;
    let user = account(auth)?;
    let org = team::organization_id(session).await?;
    if headers
        .get("x-cupboard-organization")
        .and_then(|v| v.to_str().ok())
        != Some(&org)
    {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "The active organization changed. Refresh the page.",
        ));
    }
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT id FROM organizations WHERE id=$1 FOR SHARE")
        .bind(&org)
        .execute(&mut *tx)
        .await?;
    let ctx = team::context_on(&mut tx, &user.id, &org).await?;
    let required = if manage {
        "servers.manage"
    } else {
        "servers.view"
    };
    if !ctx.permissions.iter().any(|p| p == required)
        || (id.is_none() && !ctx.permissions.iter().any(|p| p == "integrations.manage"))
    {
        return Err(forbidden());
    }
    type ConnectionRow = (String, i64, String, Vec<u8>, Option<String>);
    let row: Option<ConnectionRow> = if let Some(id) = id {
        sqlx::query_as("SELECT c.id,c.revision,c.panel_url,c.api_key_encrypted,s.panel_server_uuid FROM servers s JOIN pelican_connections c ON c.organization_id=s.organization_id AND c.id=s.panel_connection_id AND c.panel_url=s.panel_origin WHERE s.organization_id=$1 AND s.id=$2")
        .bind(&org).bind(id).fetch_optional(&mut *tx).await?
    } else {
        sqlx::query_as("SELECT id,revision,panel_url,api_key_encrypted,NULL::text FROM pelican_connections WHERE organization_id=$1").bind(&org).fetch_optional(&mut *tx).await?
    };
    let (connection, revision, url, encrypted, uuid) = row.ok_or(ApiError(
        StatusCode::CONFLICT,
        "Connect Pelican in Connections to use this server.",
    ))?;
    let secret = String::from_utf8(
        key.decrypt(&encrypted, &org, &connection, "pelican")
            .map_err(|_| internal())?,
    )
    .map_err(|_| internal())?;
    let url = validate_url(&url, policy)?;
    tx.commit().await?;
    Ok(Access {
        org,
        connection,
        revision,
        url,
        secret,
        uuid,
    })
}
async fn reauthorize(
    pool: &PgPool,
    key: &SecretKey,
    policy: &PanelPolicy,
    identity: (&AuthSession, &Session, &HeaderMap),
    id: Option<&str>,
    manage: bool,
    previous: &Access,
) -> ApiResult<Access> {
    let current = access(pool, key, policy, identity, id, manage).await?;
    if current.org != previous.org
        || current.connection != previous.connection
        || current.revision != previous.revision
        || current.uuid != previous.uuid
    {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "The panel connection changed. Refresh before trying again.",
        ));
    }
    Ok(current)
}
fn upstream() -> ApiError {
    ApiError(
        StatusCode::BAD_GATEWAY,
        "Pelican could not complete the request. Check panel access, permissions, and Wings connectivity.",
    )
}
async fn call(
    a: &Access,
    policy: &PanelPolicy,
    path: &str,
    body: Option<Value>,
) -> ApiResult<Value> {
    let _permit = OPERATIONS.try_acquire().map_err(|_| {
        ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Panel requests are busy. Try again shortly.",
        )
    })?;
    tokio::time::timeout(Duration::from_secs(15), async {
        let client = panel_client(&a.url, policy).await.map_err(|_| upstream())?;
        let url = a
            .url
            .join(&if path.starts_with('?') {
                format!("api/client{path}")
            } else {
                format!("api/client/{path}")
            })
            .map_err(|_| upstream())?;
        let request = if let Some(body) = body {
            client
                .post(url)
                .header("Content-Type", "application/json")
                .body(serde_json::to_vec(&body).map_err(|_| upstream())?)
        } else {
            client.get(url)
        };
        let mut response = request
            .bearer_auth(&a.secret)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|_| upstream())?;
        if response.status() == StatusCode::FORBIDDEN {
            return Err(ApiError(
                StatusCode::FORBIDDEN,
                "The Pelican account does not permit this action.",
            ));
        }
        if !response.status().is_success() {
            return Err(upstream());
        }
        if response.status() == StatusCode::NO_CONTENT {
            return Ok(json!({}));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| upstream())? {
            if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
                return Err(upstream());
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| upstream())
    })
    .await
    .map_err(|_| upstream())?
}
fn server_path(a: &Access, operation: &str) -> ApiResult<String> {
    let uuid = a.uuid.as_ref().ok_or_else(upstream)?;
    uuid::Uuid::parse_str(uuid).map_err(|_| upstream())?;
    Ok(format!("servers/{uuid}/{operation}"))
}
fn attributes(v: &Value) -> &Value {
    v.get("attributes").unwrap_or(v)
}
fn rust_server(s: &Value) -> bool {
    s["invocation"]
        .as_str()
        .unwrap_or("")
        .split(|c: char| !c.is_ascii_alphanumeric())
        .any(|token| token == "RustDedicated")
        || s["relationships"]["egg"]["attributes"]["name"]
            .as_str()
            .is_some_and(|n| n.eq_ignore_ascii_case("rust"))
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Candidate {
    uuid: String,
    name: String,
    node: String,
    imported: bool,
}
async fn candidates(
    State(pool): State<PgPool>,
    Extension(key): Extension<SecretKey>,
    Extension(policy): Extension<PanelPolicy>,
    auth: AuthSession,
    session: Session,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    let a = access(
        &pool,
        &key,
        &policy,
        (&auth, &session, &headers),
        None,
        true,
    )
    .await?;
    let mut result = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    for page in 1..=10 {
        let data = tokio::time::timeout_at(
            deadline,
            call(
                &a,
                &policy,
                &format!("?include=egg&per_page=100&page={page}"),
                None,
            ),
        )
        .await
        .map_err(|_| upstream())??;
        let entries = data["data"].as_array().ok_or_else(upstream)?;
        if entries.len() > 100 {
            return Err(upstream());
        }
        for entry in entries {
            let s = attributes(entry);
            if !rust_server(s) {
                continue;
            }
            let uuid = s["uuid"]
                .as_str()
                .filter(|s| uuid::Uuid::parse_str(s).is_ok())
                .ok_or_else(upstream)?;
            let name = s["name"]
                .as_str()
                .filter(|s| {
                    !s.is_empty() && s.chars().count() <= 80 && !s.chars().any(char::is_control)
                })
                .ok_or_else(upstream)?;

            result.push(Candidate {
                uuid: uuid.into(),
                name: name.into(),
                node: s["node"].as_str().unwrap_or("").chars().take(100).collect(),
                imported: false,
            });
        }
        let pages = data["meta"]["pagination"]["total_pages"]
            .as_u64()
            .filter(|p| *p > 0 && *p <= 10)
            .ok_or_else(upstream)?;
        if page >= pages {
            break;
        }
    }
    let uuids: Vec<_> = result
        .iter()
        .map(|candidate| candidate.uuid.clone())
        .collect();
    let imported: Vec<String> = sqlx::query_scalar("SELECT panel_server_uuid FROM servers WHERE organization_id=$1 AND panel_connection_id=$2 AND panel_origin=$3 AND panel_server_uuid=ANY($4)")
        .bind(&a.org).bind(&a.connection).bind(a.url.as_str()).bind(&uuids).fetch_all(&pool).await?;
    let imported: std::collections::HashSet<_> = imported.into_iter().collect();
    for candidate in &mut result {
        candidate.imported = imported.contains(&candidate.uuid);
    }
    reauthorize(
        &pool,
        &key,
        &policy,
        (&auth, &session, &headers),
        None,
        true,
        &a,
    )
    .await?;
    Ok(Json(
        json!({"connectionId":a.connection,"revision":a.revision,"servers":result}),
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Import {
    uuid: String,
    connection_id: String,
    revision: i64,
}
async fn import(
    State(pool): State<PgPool>,
    Extension(key): Extension<SecretKey>,
    Extension(policy): Extension<PanelPolicy>,
    auth: AuthSession,
    session: Session,
    headers: HeaderMap,
    Json(input): Json<Import>,
) -> ApiResult<Json<Value>> {
    uuid::Uuid::parse_str(&input.uuid).map_err(|_| invalid("Select a valid panel server."))?;
    let a = access(
        &pool,
        &key,
        &policy,
        (&auth, &session, &headers),
        None,
        true,
    )
    .await?;
    if a.connection != input.connection_id || a.revision != input.revision {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "The connection changed. Reload panel servers.",
        ));
    }
    let data = call(
        &a,
        &policy,
        &format!("servers/{}?include=egg", input.uuid),
        None,
    )
    .await?;
    let s = attributes(&data);
    if !rust_server(s) || s["uuid"].as_str() != Some(&input.uuid) {
        return Err(invalid("Only Rust servers can be imported into Cupboard."));
    }
    let name = s["name"]
        .as_str()
        .filter(|s| !s.is_empty() && s.chars().count() <= 80 && !s.chars().any(char::is_control))
        .ok_or_else(upstream)?;
    let identifier = s["identifier"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 64)
        .ok_or_else(upstream)?;
    reauthorize(
        &pool,
        &key,
        &policy,
        (&auth, &session, &headers),
        None,
        true,
        &a,
    )
    .await?;
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE")
        .bind(&a.org)
        .execute(&mut *tx)
        .await?;
    let user = account(&auth)?;
    let ctx = team::context_on(&mut tx, &user.id, &a.org).await?;
    if !ctx.permissions.iter().any(|p| p == "servers.manage")
        || !ctx.permissions.iter().any(|p| p == "integrations.manage")
    {
        return Err(forbidden());
    }
    let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pelican_connections WHERE organization_id=$1 AND id=$2 AND revision=$3)").bind(&a.org).bind(&a.connection).bind(a.revision).fetch_one(&mut *tx).await?;
    if !exists {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "The panel connection changed. Reload panel servers.",
        ));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let inferred = infer_connections(s);
    let (host, rcon_port, a2s_port, password) = match inferred {
        Some((host, rcon, a2s, password)) => (Some(host), Some(rcon), Some(a2s), Some(password)),
        None => (None, None, None, None),
    };
    let encrypted = password
        .map(|p| key.encrypt(&p, &a.org, &id, "rcon"))
        .transpose()?;
    let saved:String=sqlx::query_scalar("INSERT INTO servers(id,organization_id,name,rcon_host,rcon_port,rcon_password_encrypted,a2s_host,a2s_port,panel_connection_id,panel_server_uuid,panel_server_identifier,panel_origin) VALUES($1,$2,$3,$4,$5,$6,$4,$7,$8,$9,$10,$11) ON CONFLICT(organization_id,panel_origin,panel_server_uuid) DO UPDATE SET panel_connection_id=EXCLUDED.panel_connection_id,panel_server_identifier=EXCLUDED.panel_server_identifier RETURNING id")
        .bind(id).bind(&a.org).bind(name).bind(host).bind(rcon_port).bind(encrypted).bind(a2s_port).bind(&a.connection).bind(&input.uuid).bind(identifier).bind(a.url.as_str()).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({"id":saved})))
}
fn infer_connections(s: &Value) -> Option<(String, i32, i32, String)> {
    let vars = s["relationships"]["variables"]["data"].as_array()?;
    let variable = |names: &[&str]| -> Option<String> {
        vars.iter().find_map(|v| {
            let a = attributes(v);
            let env = a["env_variable"].as_str()?;
            if names.contains(&env) {
                a["server_value"].as_str().map(str::to_owned)
            } else {
                None
            }
        })
    };
    let rcon: i32 = variable(&["RCON_PORT"])?.parse().ok()?;
    let query: i32 = variable(&["QUERY_PORT", "A2S_PORT"])?.parse().ok()?;
    let password = variable(&["RCON_PASSWORD", "RCON_PASS"])?;
    if !(1..=65535).contains(&rcon)
        || !(1..=65535).contains(&query)
        || password.is_empty()
        || password.len() > 1024
        || password.chars().any(char::is_control)
    {
        return None;
    }
    let allocations = s["relationships"]["allocations"]["data"].as_array()?;
    let allocation = allocations
        .iter()
        .map(attributes)
        .find(|a| a["is_default"].as_bool() == Some(true))?;
    let host = allocation["ip"].as_str()?;
    let ip: std::net::IpAddr = host.parse().ok()?;
    if ip.is_unspecified() {
        return None;
    }
    Some((host.into(), rcon, query, password))
}
async fn resources(
    State(pool): State<PgPool>,
    Extension(key): Extension<SecretKey>,
    Extension(policy): Extension<PanelPolicy>,
    auth: AuthSession,
    session: Session,
    headers: HeaderMap,
    (Path(id), OriginalUri(uri)): (Path<String>, OriginalUri),
) -> ApiResult<Json<Value>> {
    let a = access(
        &pool,
        &key,
        &policy,
        (&auth, &session, &headers),
        Some(&id),
        false,
    )
    .await?;
    let _background = if uri.path().ends_with("/observation") {
        Some(
            tokio::time::timeout(Duration::from_secs(8), BACKGROUND_OPERATIONS.acquire())
                .await
                .map_err(|_| {
                    ApiError(
                        StatusCode::TOO_MANY_REQUESTS,
                        "Background panel refreshes are busy.",
                    )
                })?
                .map_err(|_| internal())?,
        )
    } else {
        None
    };
    let value = call(&a, &policy, &server_path(&a, "resources")?, None).await?;
    let s = attributes(&value);
    let r = &s["resources"];
    let mut metrics = serde_json::Map::new();
    for field in [
        "cpu_absolute",
        "memory_bytes",
        "disk_bytes",
        "network_rx_bytes",
        "network_tx_bytes",
        "uptime",
    ] {
        let number = r[field]
            .as_f64()
            .filter(|n| n.is_finite() && *n >= 0.0)
            .ok_or_else(upstream)?;
        metrics.insert(field.into(), json!(number));
    }
    let state = s["current_state"]
        .as_str()
        .filter(|v| {
            matches!(
                *v,
                "running" | "starting" | "stopping" | "offline" | "stopped"
            )
        })
        .ok_or_else(upstream)?;
    reauthorize(
        &pool,
        &key,
        &policy,
        (&auth, &session, &headers),
        Some(&id),
        false,
        &a,
    )
    .await?;
    Ok(Json(json!({"state":state,"resources":metrics})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Power {
    signal: String,
}
async fn power(
    State(pool): State<PgPool>,
    Extension(key): Extension<SecretKey>,
    Extension(policy): Extension<PanelPolicy>,
    auth: AuthSession,
    session: Session,
    headers: HeaderMap,
    (Path(id), Json(input)): (Path<String>, Json<Power>),
) -> ApiResult<Json<Value>> {
    if !matches!(input.signal.as_str(), "start" | "stop" | "restart") {
        return Err(invalid("Choose start, stop, or restart."));
    }
    let a = access(
        &pool,
        &key,
        &policy,
        (&auth, &session, &headers),
        Some(&id),
        true,
    )
    .await?;
    call(
        &a,
        &policy,
        &server_path(&a, "power")?,
        Some(json!({"signal":input.signal})),
    )
    .await?;
    reauthorize(
        &pool,
        &key,
        &policy,
        (&auth, &session, &headers),
        Some(&id),
        true,
        &a,
    )
    .await?;
    Ok(Json(json!({"accepted":true})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Command {
    command: String,
}
async fn command(
    State(pool): State<PgPool>,
    Extension(key): Extension<SecretKey>,
    Extension(policy): Extension<PanelPolicy>,
    auth: AuthSession,
    session: Session,
    headers: HeaderMap,
    (Path(id), Json(input)): (Path<String>, Json<Command>),
) -> ApiResult<Json<Value>> {
    if input.command.trim().is_empty()
        || input.command.len() > 1000
        || input.command.chars().any(char::is_control)
    {
        return Err(invalid(
            "Enter one console command, at most 1,000 characters.",
        ));
    }
    let a = access(
        &pool,
        &key,
        &policy,
        (&auth, &session, &headers),
        Some(&id),
        true,
    )
    .await?;
    call(
        &a,
        &policy,
        &server_path(&a, "command")?,
        Some(json!({"command":input.command})),
    )
    .await?;
    reauthorize(
        &pool,
        &key,
        &policy,
        (&auth, &session, &headers),
        Some(&id),
        true,
        &a,
    )
    .await?;
    Ok(Json(json!({"accepted":true})))
}
async fn console(
    State(pool): State<PgPool>,
    Extension(key): Extension<SecretKey>,
    Extension(policy): Extension<PanelPolicy>,
    auth: AuthSession,
    session: Session,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let a = access(
        &pool,
        &key,
        &policy,
        (&auth, &session, &headers),
        Some(&id),
        false,
    )
    .await?;
    let response = call(&a, &policy, &server_path(&a, "websocket")?, None).await?;
    let _permit = OPERATIONS.try_acquire().map_err(|_| {
        ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Console requests are busy. Try again shortly.",
        )
    })?;
    let mut logs = read_console(&a, &policy, &response).await?;
    let encrypted: Option<Vec<u8>> = sqlx::query_scalar(
        "SELECT rcon_password_encrypted FROM servers WHERE organization_id=$1 AND id=$2",
    )
    .bind(&a.org)
    .bind(&id)
    .fetch_one(&pool)
    .await?;
    if let Some(password) = encrypted
        .and_then(|v| key.decrypt(&v, &a.org, &id, "rcon").ok())
        .and_then(|v| String::from_utf8(v).ok())
        .filter(|p| !p.is_empty())
    {
        for line in &mut logs {
            *line = line.replace(&password, "[redacted]");
        }
    }
    for line in &mut logs {
        let lower = line.to_lowercase();
        if ["password", "rcon.pass", "api_key", "token=", "secret="]
            .iter()
            .any(|word| lower.contains(word))
        {
            *line = "[Sensitive console output redacted]".into();
        }
    }
    reauthorize(
        &pool,
        &key,
        &policy,
        (&auth, &session, &headers),
        Some(&id),
        false,
        &a,
    )
    .await?;
    Ok(Json(json!({"lines":logs})))
}
fn console_tls() -> ApiResult<std::sync::Arc<rustls::ClientConfig>> {
    let mut roots = rustls::RootCertStore::empty();
    for cert in rustls_native_certs::load_native_certs().certs {
        roots.add(cert).map_err(|_| upstream())?;
    }
    if roots.is_empty() {
        return Err(upstream());
    }
    let config = rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|_| upstream())?
    .with_root_certificates(roots)
    .with_no_client_auth();
    Ok(std::sync::Arc::new(config))
}
async fn read_console(a: &Access, policy: &PanelPolicy, value: &Value) -> ApiResult<Vec<String>> {
    tokio::time::timeout(Duration::from_secs(8), async {
        let data = &value["data"];
        let token = data["token"]
            .as_str()
            .filter(|s| s.len() < 16384)
            .ok_or_else(upstream)?;
        let url = reqwest::Url::parse(data["socket"].as_str().ok_or_else(upstream)?)
            .map_err(|_| upstream())?;
        let secure_socket = url.scheme() == "wss";
        #[cfg(test)]
        let secure_socket = secure_socket || (url.scheme() == "ws" && policy.test_origin.is_some());
        if !secure_socket
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(upstream());
        }
        let mut origin = url.clone();
        origin
            .set_scheme(if url.scheme() == "ws" {
                "http"
            } else {
                "https"
            })
            .map_err(|_| upstream())?;
        origin.set_path("/");
        validate_url(origin.as_str(), policy)?;
        let host = url.host_str().ok_or_else(upstream)?;
        let addresses: Vec<_> =
            tokio::net::lookup_host((host, url.port_or_known_default().ok_or_else(upstream)?))
                .await
                .map_err(|_| upstream())?
                .collect();
        if addresses.is_empty()
            || addresses
                .iter()
                .any(|address| !policy.allows(&origin, address.ip()))
        {
            return Err(upstream());
        }
        if url.path()
            != format!(
                "/api/servers/{}/ws",
                a.uuid.as_deref().ok_or_else(upstream)?
            )
        {
            return Err(upstream());
        }
        let mut stream = None;
        for address in addresses {
            if let Ok(socket) = tokio::net::TcpStream::connect(address).await {
                stream = Some(socket);
                break;
            }
        }
        let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
            .max_message_size(Some(256 * 1024))
            .max_frame_size(Some(256 * 1024));
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let mut request = url.as_str().into_client_request().map_err(|_| upstream())?;
        let panel_origin = a.url.origin().ascii_serialization();
        request
            .headers_mut()
            .insert("Origin", panel_origin.parse().map_err(|_| upstream())?);
        let (mut socket, _) = tokio_tungstenite::client_async_tls_with_config(
            request,
            stream.ok_or_else(upstream)?,
            Some(config),
            Some(tokio_tungstenite::Connector::Rustls(console_tls()?)),
        )
        .await
        .map_err(|_| upstream())?;
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({"event":"auth","args":[token]}).to_string().into(),
            ))
            .await
            .map_err(|_| upstream())?;
        let mut lines = Vec::new();
        let mut authenticated = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        while let Ok(Some(message)) = tokio::time::timeout_at(deadline, socket.next()).await {
            let message = message.map_err(|_| upstream())?;
            if let tokio_tungstenite::tungstenite::Message::Text(text) = message {
                let event: Value = serde_json::from_str(&text).map_err(|_| upstream())?;
                match event["event"].as_str() {
                    Some("auth success") => {
                        authenticated = true;
                        socket
                            .send(tokio_tungstenite::tungstenite::Message::Text(
                                json!({"event":"send logs","args":[null]})
                                    .to_string()
                                    .into(),
                            ))
                            .await
                            .map_err(|_| upstream())?;
                    }
                    Some("console output") => {
                        for arg in event["args"].as_array().into_iter().flatten() {
                            if let Some(text) = arg.as_str() {
                                let clean = text
                                    .replace(&a.secret, "[redacted]")
                                    .replace(token, "[redacted]");
                                lines.push(
                                    clean
                                        .chars()
                                        .filter(|c| *c == '\n' || *c == '\t' || !c.is_control())
                                        .take(4096)
                                        .collect::<String>(),
                                );
                                if lines.len() > 100 {
                                    lines.remove(0);
                                }
                            }
                        }
                    }
                    Some("jwt error" | "auth error") => return Err(upstream()),
                    _ => {}
                }
            }
        }
        let _ = socket.close(None).await;
        if !authenticated {
            return Err(upstream());
        }
        Ok(lines)
    })
    .await
    .map_err(|_| upstream())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn console_tls_uses_an_explicit_provider_with_native_roots() {
        assert!(console_tls().is_ok());
    }
    #[test]
    fn imports_only_rust_and_infers_only_complete_structured_connections() {
        assert!(rust_server(
            &json!({"invocation":"./RustDedicated +server.port 28015"})
        ));
        assert!(!rust_server(
            &json!({"invocation":"java -jar server.jar","name":"Rust community"})
        ));
        let mut server = json!({"relationships":{
            "variables":{"data":[
                {"attributes":{"env_variable":"RCON_PORT","server_value":"28016"}},
                {"attributes":{"env_variable":"QUERY_PORT","server_value":"28017"}},
                {"attributes":{"env_variable":"RCON_PASSWORD","server_value":"fixture-password"}}
            ]},
            "allocations":{"data":[{"attributes":{"is_default":true,"ip":"192.0.2.10"}}]}
        }});
        assert_eq!(
            infer_connections(&server),
            Some(("192.0.2.10".into(), 28016, 28017, "fixture-password".into()))
        );
        server["relationships"]["variables"]["data"][0]["attributes"]["server_value"] =
            json!("70000");
        assert!(infer_connections(&server).is_none());
        assert!(
            infer_connections(&json!({"invocation":"RustDedicated +rcon.password do-not-parse"}))
                .is_none()
        );
    }
}
