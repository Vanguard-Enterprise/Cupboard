use crate::{
    auth::{ApiError, ApiResult, AuthSession, account, forbidden, internal},
    team,
};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use std::collections::BTreeMap;
use tower_sessions::Session;

#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
struct Machine {
    id: String,
    name: String,
    address: String,
    provider: String,
    notes: String,
    revision: i64,
    enrolled: bool,
    enrolled_at: Option<i64>,
    enrollment_expires_at: Option<i64>,
    last_seen_at: Option<i64>,
    health: Option<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MachineInput {
    name: String,
    address: String,
    provider: String,
    notes: String,
    revision: Option<i64>,
}
impl MachineInput {
    fn validate(&mut self) -> Result<(), BTreeMap<&'static str, String>> {
        let mut fields = BTreeMap::new();
        for (key, value, limit, required) in [
            ("name", &mut self.name, 80, true),
            ("provider", &mut self.provider, 80, false),
            ("notes", &mut self.notes, 2000, false),
        ] {
            *value = value.trim().to_owned();
            if (required && value.is_empty())
                || value.chars().count() > limit
                || value
                    .chars()
                    .any(|c| c.is_control() && !(key == "notes" && matches!(c, '\n' | '\t' | '\r')))
            {
                fields.insert(
                    key,
                    format!(
                        "Enter {} of {} to {limit} characters.",
                        key,
                        if required { 1 } else { 0 }
                    ),
                );
            }
        }
        self.address = self.address.trim().to_owned();
        if self.address.parse::<std::net::IpAddr>().is_err() {
            fields.insert(
                "address",
                "Enter a valid IPv4 or IPv6 address without a scheme or port.".to_owned(),
            );
        }
        if fields.is_empty() {
            Ok(())
        } else {
            Err(fields)
        }
    }
}

// Hold the organization lock while checking membership and accessing its records.
// Role changes use the corresponding exclusive lock.
async fn access<'a>(
    pool: &'a PgPool,
    auth: &AuthSession,
    session: &Session,
    permission: &str,
) -> ApiResult<(Transaction<'a, Postgres>, String)> {
    let user = account(auth)?;
    let org = team::organization_id(session).await?;
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT id FROM organizations WHERE id=$1 FOR SHARE")
        .bind(&org)
        .execute(&mut *tx)
        .await?;
    let ctx = team::context_on(&mut tx, &user.id, &org).await?;
    if !ctx.permissions.iter().any(|p| p == permission) {
        return Err(forbidden());
    }
    Ok((tx, ctx.organization_id))
}

pub fn routes() -> Router<PgPool> {
    Router::new()
        .route("/app-api/machines", get(list).post(create))
        .route("/app-api/machines/{id}", post(update))
        .route("/app-api/machines/{id}/history", get(history))
        .route("/app-api/machines/{id}/enrollment", post(enrollment))
        .route("/app-api/machines/{id}/disconnect", post(disconnect))
        .route("/app-api/machines/{id}/remove", post(remove))
}
async fn list(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
) -> ApiResult<Json<Vec<Machine>>> {
    let (mut tx, org) = access(&pool, &auth, &session, "infrastructure.view").await?;
    let records = sqlx::query_as("SELECT id,name,address,provider,notes,revision,agent_hash IS NOT NULL AS enrolled,enrolled_at,enrollment_expires_at,last_seen_at,health FROM machines WHERE organization_id=$1 ORDER BY lower(name),id").bind(org).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(records))
}
async fn create(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    input: Result<Json<MachineInput>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Machine>, Response> {
    save(&pool, &auth, &session, None, input).await
}
async fn update(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    Path(id): Path<String>,
    input: Result<Json<MachineInput>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Machine>, Response> {
    save(&pool, &auth, &session, Some(id), input).await
}
async fn save(
    pool: &PgPool,
    auth: &AuthSession,
    session: &Session,
    id: Option<String>,
    input: Result<Json<MachineInput>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Machine>, Response> {
    let (mut tx, org) = access(pool, auth, session, "infrastructure.manage")
        .await
        .map_err(IntoResponse::into_response)?;
    let Json(mut input) = input.map_err(|_| {
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(serde_json::json!({"error":"Enter valid machine details."})),
        )
            .into_response()
    })?;
    input.validate().map_err(|fields| {
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(serde_json::json!({"error":"Check the highlighted fields.", "fields":fields})),
        )
            .into_response()
    })?;
    let record = if let Some(id) = id {
        let revision: Option<i64> = sqlx::query_scalar("SELECT revision FROM machines WHERE organization_id=$1 AND id=$2 FOR UPDATE").bind(&org).bind(&id).fetch_optional(&mut *tx).await.map_err(|_| internal().into_response())?;
        let revision = revision.ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Machine not found.").into_response())?;
        if input.revision != Some(revision) {
            return Err(ApiError(StatusCode::CONFLICT, "This machine changed while you were editing. Cancel and refresh before trying again.").into_response());
        }
        sqlx::query_as("UPDATE machines SET name=$3,address=$4,provider=$5,notes=$6,revision=revision+1 WHERE organization_id=$1 AND id=$2 RETURNING id,name,address,provider,notes,revision,agent_hash IS NOT NULL AS enrolled,enrolled_at,enrollment_expires_at,last_seen_at,health")
            .bind(&org).bind(id).bind(input.name).bind(input.address).bind(input.provider).bind(input.notes).fetch_one(&mut *tx).await
    } else {
        sqlx::query_as("INSERT INTO machines(organization_id,id,name,address,provider,notes) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,address,provider,notes,revision,agent_hash IS NOT NULL AS enrolled,enrolled_at,enrollment_expires_at,last_seen_at,health")
            .bind(&org).bind(uuid::Uuid::new_v4().to_string()).bind(input.name).bind(input.address).bind(input.provider).bind(input.notes).fetch_one(&mut *tx).await
    }.map_err(|_| internal().into_response())?;
    tx.commit().await.map_err(|_| internal().into_response())?;
    Ok(Json(record))
}

async fn enrollment(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    Path(id): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    let (mut tx, org) = access(&pool, &auth, &session, "infrastructure.manage").await?;
    let token = crate::auth::secret();
    let expires: Option<i64> = sqlx::query_scalar("UPDATE machines SET enrollment_hash=$3,enrollment_expires_at=(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint+600000 WHERE organization_id=$1 AND id=$2 RETURNING enrollment_expires_at")
        .bind(org).bind(id).bind(crate::auth::digest(&token)).fetch_optional(&mut *tx).await?;
    let expires = expires.ok_or(ApiError(StatusCode::NOT_FOUND, "Machine not found."))?;
    tx.commit().await?;
    Ok(Json(
        serde_json::json!({"token":token,"expiresAt":expires,"issuedAt":expires-600000}),
    ))
}
async fn disconnect(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    Path(id): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    let (mut tx, org) = access(&pool, &auth, &session, "infrastructure.manage").await?;
    let changed = sqlx::query("UPDATE machines SET enrollment_hash=NULL,enrollment_expires_at=NULL,agent_hash=NULL,enrolled_at=NULL,last_seen_at=NULL,health=NULL,metric_history='[]'::jsonb WHERE organization_id=$1 AND id=$2")
        .bind(org).bind(id).execute(&mut *tx).await?;
    if changed.rows_affected() == 0 {
        return Err(ApiError(StatusCode::NOT_FOUND, "Machine not found."));
    }
    tx.commit().await?;
    Ok(Json(serde_json::json!({"disconnected":true})))
}

async fn remove(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    Path(id): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    let (mut tx, org) = access(&pool, &auth, &session, "infrastructure.manage").await?;
    let enrolled: Option<bool> = sqlx::query_scalar(
        "SELECT agent_hash IS NOT NULL FROM machines WHERE organization_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(&org)
    .bind(&id)
    .fetch_optional(&mut *tx)
    .await?;
    match enrolled {
        None => return Err(ApiError(StatusCode::NOT_FOUND, "Machine not found.")),
        Some(true) => {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "Disconnect the agent before removing this machine.",
            ));
        }
        Some(false) => {}
    }
    sqlx::query("DELETE FROM machines WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(serde_json::json!({"removed":true})))
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetricSample {
    at: i64,
    cpu: Option<f64>,
    #[serde(default)]
    network_receive_bytes_per_second: Option<f64>,
    #[serde(default)]
    network_send_bytes_per_second: Option<f64>,
    memory_used: u64,
    memory_total: u64,
    storage_used: u64,
    storage_total: u64,
}
impl MetricSample {
    fn from_health(at: i64, health: &Health) -> Self {
        Self {
            at,
            cpu: health.cpu_usage_percent,
            network_receive_bytes_per_second: health.network_receive_bytes_per_second,
            network_send_bytes_per_second: health.network_send_bytes_per_second,
            memory_used: health.memory_total_bytes - health.memory_available_bytes,
            memory_total: health.memory_total_bytes,
            storage_used: health.disk_total_bytes - health.disk_available_bytes,
            storage_total: health.disk_total_bytes,
        }
    }
}
async fn history(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    Path(id): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    let (mut tx, org) = access(&pool, &auth, &session, "infrastructure.view").await?;
    let row: Option<serde_json::Value> = sqlx::query_scalar(
        "SELECT metric_history FROM machines WHERE organization_id=$1 AND id=$2",
    )
    .bind(org)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let row = row.ok_or(ApiError(StatusCode::NOT_FOUND, "Machine not found."))?;
    let now: i64 =
        sqlx::query_scalar("SELECT (EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint")
            .fetch_one(&mut *tx)
            .await?;
    let mut samples: Vec<MetricSample> = serde_json::from_value(row).map_err(|_| internal())?;
    samples.retain(|sample| sample.at > now - 3_600_000);
    tx.commit().await?;
    Ok(Json(serde_json::json!({"samples":samples,"windowEnd":now})))
}

// These endpoints authenticate only machine credentials, never browser sessions.
// They intentionally sit outside the browser's cookie and CSRF middleware.
pub fn agent_routes() -> Router<PgPool> {
    Router::new()
        .route("/node-api/enroll", post(enroll_agent))
        .route("/node-api/heartbeat", post(heartbeat))
        .layer(axum::extract::DefaultBodyLimit::max(8192))
        .layer(axum::middleware::from_fn(
            |request: axum::extract::Request, next: axum::middleware::Next| async move {
                let mut response = next.run(request).await;
                response.headers_mut().insert(
                    axum::http::header::CACHE_CONTROL,
                    "no-store".parse().unwrap(),
                );
                response
            },
        ))
}
fn bearer(headers: &axum::http::HeaderMap) -> ApiResult<String> {
    let token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "));
    match token {
        Some(token) if token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit()) => {
            Ok(crate::auth::digest(token))
        }
        _ => Err(agent_unauthorized()),
    }
}
fn agent_unauthorized() -> ApiError {
    ApiError(
        StatusCode::UNAUTHORIZED,
        "Machine credential is invalid or expired. Enroll the agent again.",
    )
}
async fn enroll_agent(
    State(pool): State<PgPool>,
    headers: axum::http::HeaderMap,
) -> ApiResult<Json<serde_json::Value>> {
    let hash = bearer(&headers)?;
    let credential = crate::auth::secret();
    // One atomic update consumes the enrollment token and revokes the former agent.
    let id: Option<String> = sqlx::query_scalar("UPDATE machines SET enrollment_hash=NULL,enrollment_expires_at=NULL,agent_hash=$2,enrolled_at=(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint,last_seen_at=NULL,health=NULL,metric_history='[]'::jsonb WHERE enrollment_hash=$1 AND enrollment_expires_at>(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint RETURNING id")
        .bind(hash).bind(crate::auth::digest(&credential)).fetch_optional(&pool).await?;
    let id = id.ok_or_else(agent_unauthorized)?;
    Ok(Json(
        serde_json::json!({"machineId":id,"credential":credential}),
    ))
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Health {
    hostname: String,
    os: String,
    agent_version: String,
    cpu_count: u32,
    load_one: f64,
    #[serde(default)]
    cpu_usage_percent: Option<f64>,
    #[serde(default)]
    network_receive_bytes_per_second: Option<f64>,
    #[serde(default)]
    network_send_bytes_per_second: Option<f64>,
    #[serde(default)]
    geolocation: Option<Geolocation>,
    memory_total_bytes: u64,
    memory_available_bytes: u64,
    disk_total_bytes: u64,
    disk_available_bytes: u64,
    uptime_seconds: u64,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Geolocation {
    public_ip: std::net::IpAddr,
    country_code: String,
}
impl Geolocation {
    fn valid(&self) -> bool {
        self.country_code.len() == 2
            && self.country_code.bytes().all(|b| b.is_ascii_uppercase())
            && match self.public_ip {
                std::net::IpAddr::V4(ip) => {
                    !ip.is_private()
                        && !ip.is_loopback()
                        && !ip.is_link_local()
                        && !ip.is_unspecified()
                        && !ip.is_multicast()
                        && !ip.is_documentation()
                        && !ip.is_broadcast()
                        && ip.octets()[0] != 0
                        && ip.octets()[0] < 240
                        && !(ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1]))
                }
                std::net::IpAddr::V6(ip) => {
                    !ip.is_loopback()
                        && !ip.is_unspecified()
                        && !ip.is_multicast()
                        && !ip.is_unique_local()
                        && !ip.is_unicast_link_local()
                        && ip.to_ipv4_mapped().is_none()
                }
            }
    }
}
impl Health {
    fn valid(&self) -> bool {
        [&self.hostname, &self.os, &self.agent_version]
            .iter()
            .all(|s| !s.is_empty() && s.len() <= 200 && !s.chars().any(char::is_control))
            && (1..=65536).contains(&self.cpu_count)
            && self
                .cpu_usage_percent
                .is_none_or(|n| n.is_finite() && (0.0..=100.0).contains(&n))
            && [
                self.network_receive_bytes_per_second,
                self.network_send_bytes_per_second,
            ]
            .iter()
            .all(|rate| {
                rate.is_none_or(|n| n.is_finite() && (0.0..=9007199254740991.0).contains(&n))
            })
            && self.geolocation.as_ref().is_none_or(Geolocation::valid)
            && self.load_one.is_finite()
            && (0.0..=1000000.0).contains(&self.load_one)
            && self.memory_total_bytes > 0
            && self.memory_total_bytes <= 9007199254740991
            && self.memory_available_bytes <= self.memory_total_bytes
            && self.disk_total_bytes > 0
            && self.disk_total_bytes <= 9007199254740991
            && self.disk_available_bytes <= self.disk_total_bytes
            && self.uptime_seconds <= 9007199254740991
    }
}
async fn heartbeat(
    State(pool): State<PgPool>,
    headers: axum::http::HeaderMap,
    input: Result<Json<Health>, axum::extract::rejection::JsonRejection>,
) -> ApiResult<Json<serde_json::Value>> {
    let hash = bearer(&headers)?;
    let Json(health) = input.map_err(|_| {
        ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Enter valid machine health readings.",
        )
    })?;
    if !health.valid() {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Enter valid machine health readings.",
        ));
    }
    let mut tx = pool.begin().await?;
    let row: Option<(String, serde_json::Value)> =
        sqlx::query_as("SELECT id,metric_history FROM machines WHERE agent_hash=$1 FOR UPDATE")
            .bind(&hash)
            .fetch_optional(&mut *tx)
            .await?;
    let (id, history) = row.ok_or_else(agent_unauthorized)?;
    let now: i64 =
        sqlx::query_scalar("SELECT (EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint")
            .fetch_one(&mut *tx)
            .await?;
    let mut samples: Vec<MetricSample> = serde_json::from_value(history).map_err(|_| internal())?;
    samples.retain(|sample| sample.at > now - 3_600_000 && sample.at / 30_000 != now / 30_000);
    samples.push(MetricSample::from_health(now, &health));
    if samples.len() > 120 {
        samples.drain(..samples.len() - 120);
    }
    sqlx::query("UPDATE machines SET health=$2,last_seen_at=$3,metric_history=$4 WHERE id=$1")
        .bind(id)
        .bind(serde_json::to_value(health).map_err(|_| internal())?)
        .bind(now)
        .bind(serde_json::to_value(samples).map_err(|_| internal())?)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(serde_json::json!({"accepted":true})))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn machine_addresses_accept_only_ipv4_and_ipv6() {
        for address in [
            "192.0.2.1",
            "10.1.1.30",
            "2001:db8::1",
            "::1",
            "::ffff:192.0.2.1",
        ] {
            let mut input: MachineInput = serde_json::from_value(
                serde_json::json!({"name":"Host","address":address,"provider":"","notes":""}),
            )
            .unwrap();
            assert!(input.validate().is_ok(), "{address}");
        }
        for address in [
            "10.1.1.30.50",
            "256.1.2.3",
            "1.2.3",
            "01.2.3.4",
            "host.example.com",
            "https://10.1.1.1",
            "10.1.1.1:80",
            "[::1]",
            "2001:::1",
            "fe80::1%eth0",
            "",
        ] {
            let mut input: MachineInput = serde_json::from_value(
                serde_json::json!({"name":"Host","address":address,"provider":"","notes":""}),
            )
            .unwrap();
            assert!(
                input.validate().unwrap_err().contains_key("address"),
                "{address}"
            );
        }
    }
    #[test]
    fn optional_readings_validate_and_accept_older_agents() {
        let base = serde_json::json!({"hostname":"host","os":"Linux","agentVersion":"1","cpuCount":4,"loadOne":1.0,"memoryTotalBytes":8,"memoryAvailableBytes":4,"diskTotalBytes":100,"diskAvailableBytes":50,"uptimeSeconds":10});
        assert!(
            serde_json::from_value::<Health>(base.clone())
                .unwrap()
                .valid()
        );
        for invalid in [-1.0, 100.1] {
            let mut value = base.clone();
            value["cpuUsagePercent"] = serde_json::json!(invalid);
            assert!(!serde_json::from_value::<Health>(value).unwrap().valid());
        }
        for field in ["networkReceiveBytesPerSecond", "networkSendBytesPerSecond"] {
            for invalid in [-1.0, 9007199254740992.0] {
                let mut value = base.clone();
                value[field] = serde_json::json!(invalid);
                assert!(!serde_json::from_value::<Health>(value).unwrap().valid());
            }
        }
        for ip in ["127.0.0.1", "10.0.0.1", "100.64.0.1", "::1", "fe80::1"] {
            assert!(
                !Geolocation {
                    public_ip: ip.parse().unwrap(),
                    country_code: "US".into()
                }
                .valid()
            );
        }
        assert!(
            !Geolocation {
                public_ip: "8.8.8.8".parse().unwrap(),
                country_code: "<script>".into()
            }
            .valid()
        );
    }
}
