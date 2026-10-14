use crate::{
    auth::{ApiError, ApiResult, AuthSession, account, forbidden, internal, invalid},
    secrets::SecretKey,
    team,
};
use axum::{
    Extension, Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use std::{
    collections::HashSet,
    net::{IpAddr, SocketAddr},
    time::Duration,
};
use tower_sessions::Session;

const MAX_SERVERS: usize = 1000;
const MAX_BODY: usize = 2 * 1024 * 1024;
static CHECKS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

/// Only deployment operators can allow private panel origins. Never accept this from a request.
#[derive(Clone, Default)]
pub struct PanelPolicy {
    private_origins: HashSet<String>,
    #[cfg(test)]
    pub(crate) test_origin: Option<String>,
}
impl PanelPolicy {
    pub fn from_env() -> Result<Self, &'static str> {
        let mut policy = Self::default();
        for origin in std::env::var("CUPBOARD_PELICAN_PRIVATE_ORIGINS")
            .unwrap_or_default()
            .split(',')
            .filter(|s| !s.trim().is_empty())
        {
            let url = panel_url(origin.trim())
                .map_err(|_| "CUPBOARD_PELICAN_PRIVATE_ORIGINS must contain HTTPS panel origins")?;
            policy.private_origins.insert(url.to_string());
        }
        Ok(policy)
    }
    pub(crate) fn allows(&self, url: &Url, ip: IpAddr) -> bool {
        #[cfg(test)]
        if self.test_origin.as_deref() == Some(url.as_str()) {
            return true;
        }
        if matches!(ip, IpAddr::V4(address) if address.octets() == [100, 100, 100, 200]) {
            return false;
        }
        public_ip(ip) || (self.private_origins.contains(url.as_str()) && private_ip(ip))
    }
}
fn private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_private() || (ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1]))
        }
        IpAddr::V6(ip) => ip.is_unique_local(),
    }
}
fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !ip.is_private()
                && !ip.is_loopback()
                && !ip.is_link_local()
                && !ip.is_broadcast()
                && !ip.is_documentation()
                && a != 0
                && a < 224
                && !(a == 100 && (64..=127).contains(&b))
                && !(a == 198 && (b == 18 || b == 19))
                && !(a == 192 && b == 0 && c == 0)
                && !(a == 192 && b == 88 && c == 99)
        }
        IpAddr::V6(ip) => {
            let segments = ip.segments();
            segments[0] & 0xe000 == 0x2000
                && !(segments[0] == 0x2001 && segments[1] < 0x200)
                && !(segments[0] == 0x2001 && segments[1] == 0xdb8)
                && segments[0] != 0x2002
                && !(segments[0] == 0x3fff && segments[1] < 0x1000)
        }
    }
}
fn panel_url(value: &str) -> Result<Url, &'static str> {
    let url = Url::parse(value).map_err(|_| "Enter a complete HTTPS panel URL.")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
        || value.len() > 2048
    {
        return Err(
            "Use the HTTPS panel origin without a path, login details, query, or fragment.",
        );
    }
    Ok(url)
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PanelServer {
    uuid: String,
    identifier: String,
    name: String,
    node: String,
    suspended: bool,
    installing: bool,
    transferring: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Connection {
    id: String,
    revision: i64,
    panel_url: String,
    checked_at: i64,
    last_success_at: Option<i64>,
    error: Option<String>,
    servers: Vec<PanelServer>,
}
#[derive(FromRow)]
struct Stored {
    id: String,
    revision: i64,
    panel_url: String,
    api_key_encrypted: Vec<u8>,
    checked_at: i64,
    last_success_at: Option<i64>,
    error: Option<String>,
    servers: serde_json::Value,
}
impl Stored {
    fn response(self) -> ApiResult<Connection> {
        Ok(Connection {
            id: self.id,
            revision: self.revision,
            panel_url: self.panel_url,
            checked_at: self.checked_at,
            last_success_at: self.last_success_at,
            error: self.error,
            servers: serde_json::from_value(self.servers).map_err(|_| internal())?,
        })
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Save {
    panel_url: String,
    api_key: Option<String>,
    id: Option<String>,
    revision: Option<i64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Revision {
    id: String,
    revision: i64,
}

pub fn routes() -> Router<PgPool> {
    Router::new()
        .route("/app-api/integrations/pelican", get(list).post(save))
        .route("/app-api/integrations/pelican/check", post(check))
        .route("/app-api/integrations/pelican/remove", post(remove))
}
async fn authorized<'a>(
    pool: &'a PgPool,
    auth: &AuthSession,
    session: &Session,
    headers: &HeaderMap,
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
            "The active organization changed. Refresh the page before accessing integrations.",
        ));
    }
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE")
        .bind(&org)
        .execute(&mut *tx)
        .await?;
    let ctx = team::context_on(&mut tx, &user.id, &org).await?;
    if !ctx.permissions.iter().any(|p| p == "integrations.manage") {
        return Err(forbidden());
    }
    Ok((tx, ctx.organization_id))
}
async fn stored(tx: &mut Transaction<'_, Postgres>, org: &str) -> ApiResult<Option<Stored>> {
    Ok(sqlx::query_as("SELECT id,revision,panel_url,api_key_encrypted,checked_at,last_success_at,error,servers FROM pelican_connections WHERE organization_id=$1")
        .bind(org).fetch_optional(&mut **tx).await?)
}
fn conflict() -> ApiError {
    ApiError(
        StatusCode::CONFLICT,
        "This connection changed. Reload connections before trying again.",
    )
}
fn permit() -> ApiResult<tokio::sync::SemaphorePermit<'static>> {
    CHECKS.try_acquire().map_err(|_| {
        ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Connection checks are busy. Try again shortly.",
        )
    })
}
async fn list(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    headers: HeaderMap,
) -> ApiResult<Json<Option<Connection>>> {
    let (mut tx, org) = authorized(&pool, &auth, &session, &headers).await?;
    let connection = stored(&mut tx, &org)
        .await?
        .map(Stored::response)
        .transpose()?;
    tx.commit().await?;
    Ok(Json(connection))
}
async fn save(
    State(pool): State<PgPool>,
    Extension(key): Extension<SecretKey>,
    policy: Option<Extension<PanelPolicy>>,
    auth: AuthSession,
    session: Session,
    headers: HeaderMap,
    input: Result<Json<Save>, axum::extract::rejection::JsonRejection>,
) -> ApiResult<Json<Connection>> {
    let (mut tx, org) = authorized(&pool, &auth, &session, &headers).await?;
    let Json(input) = input.map_err(|_| invalid("Enter valid Pelican connection details."))?;
    let previous = stored(&mut tx, &org).await?;
    if previous.as_ref().map(|v| (&v.id, v.revision)) != input.id.as_ref().zip(input.revision) {
        return Err(conflict());
    }
    let policy = policy.map(|p| p.0).unwrap_or_default();
    let url = validate_url(&input.panel_url, &policy)?;
    let id = previous
        .as_ref()
        .map(|v| v.id.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let secret = match input.api_key.filter(|v| !v.is_empty()) {
        Some(secret) => {
            if secret.len() > 512
                || secret.len() < 16
                || !secret.bytes().all(|b| b.is_ascii_graphic())
            {
                return Err(invalid(
                    "Enter a Client API key of 16 to 512 characters without spaces.",
                ));
            }
            secret
        }
        None => {
            let previous = previous
                .as_ref()
                .ok_or_else(|| invalid("Enter a Pelican Client API key."))?;
            if previous.panel_url != url.as_str() {
                return Err(invalid(
                    "Enter a new Client API key when changing the panel URL.",
                ));
            }
            String::from_utf8(
                key.decrypt(&previous.api_key_encrypted, &org, &id, "pelican")
                    .map_err(|_| internal())?,
            )
            .map_err(|_| internal())?
        }
    };
    tx.commit().await?;
    let _permit = permit()?;
    let result = probe(&url, &secret, &policy).await;
    let encrypted = key.encrypt(&secret, &org, &id, "pelican")?;
    let (mut tx, current_org) = authorized(&pool, &auth, &session, &headers).await?;
    if current_org != org {
        return Err(conflict());
    }
    let current = stored(&mut tx, &org).await?;
    if current.as_ref().map(|v| (&v.id, v.revision))
        != previous.as_ref().map(|v| (&v.id, v.revision))
    {
        return Err(conflict());
    }
    let (servers, error) = match result {
        Ok(servers) => (servers, None),
        Err(error) => (Vec::new(), Some(error)),
    };
    let now = now();
    sqlx::query("INSERT INTO pelican_connections(organization_id,id,revision,panel_url,api_key_encrypted,checked_at,last_success_at,error,servers) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(organization_id) DO UPDATE SET revision=EXCLUDED.revision,panel_url=EXCLUDED.panel_url,api_key_encrypted=EXCLUDED.api_key_encrypted,checked_at=EXCLUDED.checked_at,last_success_at=EXCLUDED.last_success_at,error=EXCLUDED.error,servers=EXCLUDED.servers")
        .bind(&org).bind(&id).bind(input.revision.unwrap_or(0)+1).bind(url.as_str()).bind(encrypted).bind(now).bind(error.is_none().then_some(now)).bind(error).bind(serde_json::to_value(servers).map_err(|_|internal())?).execute(&mut *tx).await?;
    let response = stored(&mut tx, &org)
        .await?
        .ok_or_else(internal)?
        .response()?;
    tx.commit().await?;
    Ok(Json(response))
}
async fn check(
    State(pool): State<PgPool>,
    Extension(key): Extension<SecretKey>,
    policy: Option<Extension<PanelPolicy>>,
    auth: AuthSession,
    session: Session,
    headers: HeaderMap,
    input: Result<Json<Revision>, axum::extract::rejection::JsonRejection>,
) -> ApiResult<Json<Connection>> {
    let (mut tx, org) = authorized(&pool, &auth, &session, &headers).await?;
    let Json(input) = input.map_err(|_| invalid("Enter a valid connection ID and revision."))?;
    let previous = stored(&mut tx, &org).await?.ok_or_else(conflict)?;
    if previous.id != input.id || previous.revision != input.revision {
        return Err(conflict());
    }
    let secret = String::from_utf8(
        key.decrypt(&previous.api_key_encrypted, &org, &previous.id, "pelican")
            .map_err(|_| internal())?,
    )
    .map_err(|_| internal())?;
    tx.commit().await?;
    let policy = policy.map(|p| p.0).unwrap_or_default();
    let url = validate_url(&previous.panel_url, &policy)?;
    let _permit = permit()?;
    let result = probe(&url, &secret, &policy).await;
    let (mut tx, current_org) = authorized(&pool, &auth, &session, &headers).await?;
    if current_org != org {
        return Err(conflict());
    }
    let current = stored(&mut tx, &org).await?.ok_or_else(conflict)?;
    if current.id != previous.id || current.revision != previous.revision {
        return Err(conflict());
    }
    let now = now();
    let (servers, error, success) = match result {
        Ok(servers) => (
            serde_json::to_value(servers).map_err(|_| internal())?,
            None,
            Some(now),
        ),
        Err(error) => (current.servers, Some(error), current.last_success_at),
    };
    sqlx::query("UPDATE pelican_connections SET revision=revision+1,checked_at=$2,last_success_at=$3,error=$4,servers=$5 WHERE organization_id=$1")
        .bind(&org).bind(now).bind(success).bind(error).bind(servers).execute(&mut *tx).await?;
    let response = stored(&mut tx, &org)
        .await?
        .ok_or_else(internal)?
        .response()?;
    tx.commit().await?;
    Ok(Json(response))
}
/// Refresh saved connections independently of browser sessions. A persisted lease
/// prevents replicas from selecting the same connection during network I/O.
pub async fn monitor(pool: PgPool, key: SecretKey, policy: PanelPolicy) {
    loop {
        if poll_due(&pool, &key, &policy).await.is_err() {
            eprintln!("Pelican inventory refresh failed; retrying shortly.");
        }
        tokio::time::sleep(Duration::from_secs(15)).await;
    }
}
pub(crate) async fn poll_due(
    pool: &PgPool,
    key: &SecretKey,
    policy: &PanelPolicy,
) -> ApiResult<()> {
    let Ok(_permit) = CHECKS.try_acquire() else {
        return Ok(());
    };
    let claimed: Option<(String, String, i64, String, Vec<u8>, i64)> = sqlx::query_as(
        "UPDATE pelican_connections SET next_check_at=$1+300000 WHERE organization_id=(SELECT organization_id FROM pelican_connections WHERE next_check_at <= $1 AND checked_at <= $1-300000 ORDER BY next_check_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING organization_id,id,revision,panel_url,api_key_encrypted,checked_at"
    ).bind(now()).fetch_optional(pool).await?;
    let Some((org, id, revision, panel_url, encrypted, previous_check)) = claimed else {
        return Ok(());
    };
    let result = match key
        .decrypt(&encrypted, &org, &id, "pelican")
        .ok()
        .and_then(|v| String::from_utf8(v).ok())
    {
        Some(secret) => match validate_url(&panel_url, policy) {
            Ok(url) => probe(&url, &secret, policy).await,
            Err(_) => Err("The saved panel address is not allowed."),
        },
        None => Err("The saved credential could not be read."),
    };
    let checked = now();
    let (servers, error) = match result {
        Ok(servers) => (
            Some(serde_json::to_value(servers).map_err(|_| internal())?),
            None,
        ),
        Err(error) => (None, Some(error)),
    };
    // Organization, connection identity, revision, and timestamp all must still
    // match. A manual check, edit, or disconnect wins over the scheduled result.
    sqlx::query("UPDATE pelican_connections SET checked_at=$4,next_check_at=$4+300000,last_success_at=CASE WHEN $5::jsonb IS NOT NULL THEN $4 ELSE last_success_at END,servers=COALESCE($5,servers),error=$6 WHERE organization_id=$1 AND id=$2 AND revision=$3 AND checked_at=$7")
        .bind(org).bind(id).bind(revision).bind(checked).bind(servers).bind(error).bind(previous_check).execute(pool).await?;
    Ok(())
}
async fn remove(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    headers: HeaderMap,
    input: Result<Json<Revision>, axum::extract::rejection::JsonRejection>,
) -> ApiResult<Json<serde_json::Value>> {
    let (mut tx, org) = authorized(&pool, &auth, &session, &headers).await?;
    let Json(input) = input.map_err(|_| invalid("Enter a valid connection ID and revision."))?;
    let current = stored(&mut tx, &org).await?.ok_or_else(conflict)?;
    if current.id != input.id || current.revision != input.revision {
        return Err(conflict());
    }
    sqlx::query("DELETE FROM pelican_connections WHERE organization_id=$1")
        .bind(&org)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(serde_json::json!({"removed":true})))
}
fn now() -> i64 {
    time::OffsetDateTime::now_utc()
        .unix_timestamp_nanos()
        .div_euclid(1_000_000) as i64
}
pub(crate) fn validate_url(value: &str, policy: &PanelPolicy) -> ApiResult<Url> {
    #[cfg(test)]
    if policy.test_origin.as_deref() == Some(value) {
        return Url::parse(value).map_err(|_| invalid("Invalid test URL."));
    }
    let url = panel_url(value.trim()).map_err(invalid)?;
    if url.port_or_known_default() != Some(443) && !policy.private_origins.contains(url.as_str()) {
        return Err(invalid(
            "This panel port needs an operator-approved Pelican origin.",
        ));
    }
    Ok(url)
}
async fn probe(
    url: &Url,
    secret: &str,
    policy: &PanelPolicy,
) -> Result<Vec<PanelServer>, &'static str> {
    tokio::time::timeout(Duration::from_secs(15), inventory(url, secret, policy))
        .await
        .unwrap_or(Err("Pelican did not respond within 15 seconds. Try again."))
}
pub(crate) async fn panel_client(
    url: &Url,
    policy: &PanelPolicy,
) -> Result<reqwest::Client, &'static str> {
    let host = url
        .host_str()
        .ok_or("The panel URL is invalid.")?
        .trim_matches(['[', ']']);
    let addresses: Vec<SocketAddr> = tokio::net::lookup_host((
        host,
        url.port_or_known_default()
            .ok_or("The panel port is invalid.")?,
    ))
    .await
    .map_err(|_| "Could not resolve the Pelican panel hostname.")?
    .collect();
    if addresses.is_empty() || addresses.iter().any(|a| !policy.allows(url, a.ip())) {
        return Err(
            "This panel resolves to a restricted address. Ask the Cupboard operator to approve its private origin.",
        );
    }
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(host, &addresses)
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| "Could not initialize the Pelican connection.")
}
async fn inventory(
    url: &Url,
    secret: &str,
    policy: &PanelPolicy,
) -> Result<Vec<PanelServer>, &'static str> {
    let client = panel_client(url, policy).await?;
    let mut servers = Vec::new();
    let mut seen = HashSet::new();
    for page in 1..=10 {
        let mut endpoint = url
            .join("api/client")
            .map_err(|_| "The panel URL is invalid.")?;
        endpoint
            .query_pairs_mut()
            .append_pair("per_page", "100")
            .append_pair("page", &page.to_string());
        let mut response = client.get(endpoint).bearer_auth(secret).header("Accept", "application/json").send().await.map_err(|_| "Could not reach Pelican securely. Check the URL, certificate, and network access.")?;
        match response.status().as_u16() {
            200 => {}
            401 => return Err("Pelican rejected the Client API key. Replace it and try again."),
            403 => {
                return Err(
                    "The Pelican account does not have access. Check its server assignments and permissions.",
                );
            }
            429 => return Err("Pelican is rate limiting requests. Wait before checking again."),
            300..=399 => {
                return Err("Pelican redirected the request. Use the final HTTPS panel URL.");
            }
            _ => {
                return Err(
                    "Pelican could not return server inventory. Check the panel URL and try again.",
                );
            }
        }
        if response
            .content_length()
            .is_some_and(|n| n > MAX_BODY as u64)
        {
            return Err("Pelican returned an oversized response.");
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Pelican returned an incomplete response.")?
        {
            if bytes.len() + chunk.len() > MAX_BODY {
                return Err("Pelican returned an oversized response.");
            }
            bytes.extend_from_slice(&chunk);
        }
        let page_data: Page = serde_json::from_slice(&bytes)
            .map_err(|_| "Pelican returned an unsupported inventory response.")?;
        let pagination = page_data.meta.pagination;
        if pagination.current_page != page
            || pagination.total_pages > 10
            || pagination.total_pages == 0
            || page_data.data.len() > 100
            || servers.len() + page_data.data.len() > MAX_SERVERS
        {
            return Err(
                "Pelican inventory exceeds the supported limit or returned invalid pagination. Use an account assigned to at most 1,000 servers.",
            );
        }
        for entry in page_data.data {
            let s = entry.attributes;
            if uuid::Uuid::parse_str(&s.uuid).is_err()
                || !seen.insert(s.uuid.clone())
                || s.identifier.is_empty()
                || s.identifier.len() > 64
                || s.name.len() > 320
                || s.node.len() > 320
                || s.name.chars().any(char::is_control)
                || s.node.chars().any(char::is_control)
            {
                return Err("Pelican returned an unsupported server record.");
            }
            servers.push(PanelServer {
                uuid: s.uuid,
                identifier: s.identifier,
                name: s.name,
                node: s.node,
                suspended: s.is_suspended,
                installing: s.is_installing,
                transferring: s.is_transferring,
            });
        }
        if page >= pagination.total_pages {
            return Ok(servers);
        }
    }
    Err("Pelican inventory exceeds the supported limit.")
}
#[derive(Deserialize)]
struct Page {
    data: Vec<Entry>,
    meta: Meta,
}
#[derive(Deserialize)]
struct Meta {
    pagination: Pagination,
}
#[derive(Deserialize)]
struct Pagination {
    current_page: u32,
    total_pages: u32,
}
#[derive(Deserialize)]
struct Entry {
    attributes: Attributes,
}
#[derive(Deserialize)]
struct Attributes {
    uuid: String,
    identifier: String,
    name: String,
    node: String,
    is_suspended: bool,
    is_installing: bool,
    #[serde(default)]
    is_transferring: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn url_and_network_policy_block_unsafe_targets() {
        for value in [
            "http://panel.example.com",
            "https://user:key@panel.example.com",
            "https://panel.example.com/path",
            "https://panel.example.com/?key=secret",
            "https://panel.example.com/#fragment",
        ] {
            assert!(panel_url(value).is_err());
        }
        let url = panel_url("https://panel.example.com").unwrap();
        let mut policy = PanelPolicy::default();
        for ip in [
            "127.0.0.1",
            "169.254.169.254",
            "10.0.0.1",
            "100.107.41.153",
            "192.0.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "fc00::1",
            "fe80::1",
            "2002:7f00:1::",
        ] {
            assert!(!policy.allows(&url, ip.parse().unwrap()), "{ip}");
        }
        policy.private_origins.insert(url.to_string());
        assert!(policy.allows(&url, "10.0.0.1".parse().unwrap()));
        assert!(policy.allows(&url, "100.107.41.153".parse().unwrap()));
        for ip in ["127.0.0.1", "169.254.169.254", "::1", "fe80::1"] {
            assert!(!policy.allows(&url, ip.parse().unwrap()));
        }
        assert!(policy.allows(&url, "1.1.1.1".parse().unwrap()));
        assert!(policy.allows(&url, "2606:4700:4700::1111".parse().unwrap()));
        assert!(!policy.allows(
            &panel_url("https://other.example.com").unwrap(),
            "10.0.0.1".parse().unwrap()
        ));
    }
}
