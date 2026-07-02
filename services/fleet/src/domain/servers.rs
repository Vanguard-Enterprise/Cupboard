//! Server-connection data access. Request-scoped CRUD runs on the app pool inside a
//! tenant-bound transaction (RLS isolates rows); the Collector-facing config listing runs
//! on the owner pool (cross-tenant, RLS-exempt) and decrypts RCON credentials.

use crate::error::AppError;
use chrono::{DateTime, Utc};
use cupboard_crypto::Envelope;
use cupboard_domain::TenantId;
use sqlx::PgPool;
use uuid::Uuid;

/// A server connection as returned to the dashboard. Deliberately excludes the encrypted
/// RCON credential columns — secrets never leave the service on the API path.
#[derive(Debug, sqlx::FromRow, serde::Serialize)]
pub struct Server {
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub name: String,
    pub game: String,
    pub rcon_host: String,
    pub rcon_port: i32,
    pub query_port: Option<i32>,
    pub enabled: bool,
    pub connection_status: String,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    // A2S_INFO snapshot, heartbeated by the Collector; null until the first query lands.
    pub info_hostname: Option<String>,
    pub info_map: Option<String>,
    pub info_players: Option<i32>,
    pub info_max_players: Option<i32>,
    pub info_queued: Option<i32>,
    pub info_updated_at: Option<DateTime<Utc>>,
    /// Whether a push-ingest token is issued (the token itself is never re-shown).
    pub has_ingest_token: bool,
    pub ingest_token_created_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Non-secret columns of `servers`, reused across selects and `RETURNING`.
const COLS: &str = "id, tenant_id, name, game, rcon_host, rcon_port, query_port, enabled, \
     connection_status, last_seen_at, last_error, info_hostname, info_map, info_players, \
     info_max_players, info_queued, info_updated_at, \
     (ingest_token_hash IS NOT NULL) AS has_ingest_token, ingest_token_created_at, \
     created_at, updated_at";

/// Fields for creating a server. `rcon_password` is plaintext here and sealed before it
/// touches the database.
pub struct NewServer {
    pub name: String,
    pub game: String,
    pub rcon_host: String,
    pub rcon_port: i32,
    pub rcon_password: String,
    pub query_port: Option<i32>,
    pub enabled: bool,
}

/// Partial update. `None` leaves a column unchanged; `rcon_password = Some` rotates the
/// stored credential.
#[derive(Default)]
pub struct ServerUpdate {
    pub name: Option<String>,
    pub rcon_host: Option<String>,
    pub rcon_port: Option<i32>,
    pub query_port: Option<i32>,
    pub enabled: Option<bool>,
    pub rcon_password: Option<String>,
}

pub async fn create(
    app_pool: &PgPool,
    tenant: TenantId,
    master_key: &[u8; 32],
    input: NewServer,
) -> Result<Server, AppError> {
    let sealed = cupboard_crypto::seal(master_key, input.rcon_password.as_bytes())?;

    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let server = sqlx::query_as::<_, Server>(&format!(
        "INSERT INTO servers \
         (tenant_id, name, game, rcon_host, rcon_port, rcon_password_enc, rcon_password_dek, \
          query_port, enabled) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING {COLS}"
    ))
    .bind(tenant.0)
    .bind(&input.name)
    .bind(&input.game)
    .bind(&input.rcon_host)
    .bind(input.rcon_port)
    .bind(&sealed.ciphertext)
    .bind(&sealed.wrapped_dek)
    .bind(input.query_port)
    .bind(input.enabled)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(server)
}

pub async fn list(app_pool: &PgPool, tenant: TenantId) -> Result<Vec<Server>, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let rows = sqlx::query_as::<_, Server>(&format!("SELECT {COLS} FROM servers ORDER BY name"))
        .fetch_all(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(rows)
}

pub async fn get(
    app_pool: &PgPool,
    tenant: TenantId,
    id: Uuid,
) -> Result<Option<Server>, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let row = sqlx::query_as::<_, Server>(&format!("SELECT {COLS} FROM servers WHERE id = $1"))
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(row)
}

pub async fn update(
    app_pool: &PgPool,
    tenant: TenantId,
    master_key: &[u8; 32],
    id: Uuid,
    patch: ServerUpdate,
) -> Result<Option<Server>, AppError> {
    // Seal a rotated password up front, if one was supplied.
    let sealed = match &patch.rcon_password {
        Some(pw) => Some(cupboard_crypto::seal(master_key, pw.as_bytes())?),
        None => None,
    };
    let (enc, dek) = match sealed {
        Some(s) => (Some(s.ciphertext), Some(s.wrapped_dek)),
        None => (None, None),
    };

    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let row = sqlx::query_as::<_, Server>(&format!(
        "UPDATE servers SET \
         name = COALESCE($2, name), \
         rcon_host = COALESCE($3, rcon_host), \
         rcon_port = COALESCE($4, rcon_port), \
         query_port = COALESCE($5, query_port), \
         enabled = COALESCE($6, enabled), \
         rcon_password_enc = COALESCE($7, rcon_password_enc), \
         rcon_password_dek = COALESCE($8, rcon_password_dek), \
         updated_at = now() \
         WHERE id = $1 RETURNING {COLS}"
    ))
    .bind(id)
    .bind(patch.name)
    .bind(patch.rcon_host)
    .bind(patch.rcon_port)
    .bind(patch.query_port)
    .bind(patch.enabled)
    .bind(enc)
    .bind(dek)
    .fetch_optional(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(row)
}

pub async fn delete(app_pool: &PgPool, tenant: TenantId, id: Uuid) -> Result<bool, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let res = sqlx::query("DELETE FROM servers WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(res.rows_affected() > 0)
}

/// Statuses the Collector may report for a connection (mirrors the CHECK constraint).
pub const VALID_STATUSES: [&str; 4] = ["unknown", "connected", "degraded", "down"];

/// Update a server's liveness from a Collector heartbeat. Cross-tenant (owner pool);
/// `mark_seen` bumps `last_seen_at` on a successful poll.
pub async fn update_status(
    owner_pool: &PgPool,
    id: Uuid,
    status: &str,
    error: Option<&str>,
    mark_seen: bool,
) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE servers SET \
         connection_status = $2, \
         last_error = $3, \
         last_seen_at = CASE WHEN $4 THEN now() ELSE last_seen_at END, \
         updated_at = now() \
         WHERE id = $1",
    )
    .bind(id)
    .bind(status)
    .bind(error)
    .bind(mark_seen)
    .execute(owner_pool)
    .await?;
    Ok(())
}

/// Issue (or rotate) the push-ingest token for a server the tenant owns. Returns the
/// plaintext token exactly once; only its SHA-256 is stored. Returns `None` when the
/// server isn't visible to this tenant.
pub async fn issue_ingest_token(
    app_pool: &PgPool,
    tenant: TenantId,
    id: Uuid,
) -> Result<Option<String>, AppError> {
    let token = format!("cus_{}", cupboard_crypto::random_token());
    let hash = cupboard_crypto::sha256(token.as_bytes()).to_vec();

    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let updated = sqlx::query(
        "UPDATE servers SET ingest_token_hash = $2, ingest_token_created_at = now(), \
         updated_at = now() WHERE id = $1",
    )
    .bind(id)
    .bind(&hash)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok((updated.rows_affected() > 0).then_some(token))
}

/// Revoke a server's push-ingest token. Returns whether a row was touched.
pub async fn revoke_ingest_token(
    app_pool: &PgPool,
    tenant: TenantId,
    id: Uuid,
) -> Result<bool, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let res = sqlx::query(
        "UPDATE servers SET ingest_token_hash = NULL, ingest_token_created_at = NULL, \
         updated_at = now() WHERE id = $1",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(res.rows_affected() > 0)
}

/// An A2S_INFO snapshot as reported by the Collector.
pub struct InfoUpdate {
    pub hostname: String,
    pub map: String,
    pub players: i32,
    pub max_players: i32,
    pub queued: Option<i32>,
}

/// Store a server's latest A2S snapshot. Cross-tenant (owner pool), same trust boundary
/// as `update_status`. Strings are length-bounded here — A2S hostnames are
/// server-operator-controlled input.
pub async fn update_info(owner_pool: &PgPool, id: Uuid, info: &InfoUpdate) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE servers SET \
         info_hostname = left($2, 256), \
         info_map = left($3, 128), \
         info_players = $4, \
         info_max_players = $5, \
         info_queued = $6, \
         info_updated_at = now(), \
         updated_at = now() \
         WHERE id = $1",
    )
    .bind(id)
    .bind(&info.hostname)
    .bind(&info.map)
    .bind(info.players.max(0))
    .bind(info.max_players.max(0))
    .bind(info.queued.map(|q| q.max(0)))
    .execute(owner_pool)
    .await?;
    Ok(())
}

/// A decrypted connection config for the Collector. Carries the plaintext RCON password —
/// only ever served over the cluster-internal, token-guarded `/internal` endpoint.
#[derive(Debug, serde::Serialize)]
pub struct ServerConfig {
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub name: String,
    pub rcon_host: String,
    pub rcon_port: i32,
    pub rcon_password: String,
    pub query_port: Option<i32>,
    /// SHA-256 of the server's push-ingest token, hex-encoded; the Collector matches
    /// presented bearer tokens against it. `None` = push disabled for this server.
    pub ingest_token_hash: Option<String>,
}

#[derive(sqlx::FromRow)]
struct EncRow {
    id: Uuid,
    tenant_id: Uuid,
    name: String,
    rcon_host: String,
    rcon_port: i32,
    rcon_password_enc: Vec<u8>,
    rcon_password_dek: Vec<u8>,
    query_port: Option<i32>,
    ingest_token_hash: Option<Vec<u8>>,
}

/// Every enabled server across all tenants, with RCON credentials decrypted — the
/// Collector's source of truth for what to dial. Runs on the owner pool (RLS-exempt).
pub async fn list_enabled_configs(
    owner_pool: &PgPool,
    master_key: &[u8; 32],
) -> Result<Vec<ServerConfig>, AppError> {
    let rows = sqlx::query_as::<_, EncRow>(
        "SELECT id, tenant_id, name, rcon_host, rcon_port, rcon_password_enc, \
         rcon_password_dek, query_port, ingest_token_hash FROM servers WHERE enabled",
    )
    .fetch_all(owner_pool)
    .await?;

    let mut configs = Vec::with_capacity(rows.len());
    for r in rows {
        // A single undecryptable row (corruption, or a master-key mismatch after rotation)
        // must not blind the Collector to every other server — skip it, loudly.
        let plaintext = match cupboard_crypto::open(
            master_key,
            &Envelope {
                wrapped_dek: r.rcon_password_dek,
                ciphertext: r.rcon_password_enc,
            },
        ) {
            Ok(pt) => pt,
            Err(e) => {
                tracing::error!(server_id = %r.id, error = %e, "skipping server: RCON credential failed to decrypt");
                continue;
            }
        };
        let rcon_password = match String::from_utf8(plaintext) {
            Ok(pw) => pw,
            Err(_) => {
                tracing::error!(server_id = %r.id, "skipping server: decrypted RCON password not UTF-8");
                continue;
            }
        };
        configs.push(ServerConfig {
            id: r.id,
            tenant_id: r.tenant_id,
            name: r.name,
            rcon_host: r.rcon_host,
            rcon_port: r.rcon_port,
            rcon_password,
            query_port: r.query_port,
            ingest_token_hash: r.ingest_token_hash.map(hex::encode),
        });
    }
    Ok(configs)
}
