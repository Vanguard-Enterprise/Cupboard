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
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Non-secret columns of `servers`, reused across selects and `RETURNING`.
const COLS: &str = "id, tenant_id, name, game, rcon_host, rcon_port, query_port, enabled, \
     connection_status, last_seen_at, last_error, created_at, updated_at";

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
}

/// Every enabled server across all tenants, with RCON credentials decrypted — the
/// Collector's source of truth for what to dial. Runs on the owner pool (RLS-exempt).
pub async fn list_enabled_configs(
    owner_pool: &PgPool,
    master_key: &[u8; 32],
) -> Result<Vec<ServerConfig>, AppError> {
    let rows = sqlx::query_as::<_, EncRow>(
        "SELECT id, tenant_id, name, rcon_host, rcon_port, rcon_password_enc, \
         rcon_password_dek, query_port FROM servers WHERE enabled",
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
        });
    }
    Ok(configs)
}
