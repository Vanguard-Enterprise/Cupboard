//! Chat-message read path (dashboard chat logs + player-profile chat). Request-scoped
//! reads on the app pool inside a tenant-bound transaction (RLS isolates rows); writes
//! happen in `ingest`.

use crate::error::AppError;
use chrono::{DateTime, Utc};
use cupboard_domain::TenantId;
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, sqlx::FromRow, serde::Serialize)]
pub struct ChatRow {
    pub id: Uuid,
    pub server_id: Uuid,
    pub player_id: Option<Uuid>,
    pub channel: i32,
    pub name: Option<String>,
    pub message: String,
    pub sent_at: DateTime<Utc>,
}

/// Filters for a chat-log query; all optional, newest-first.
#[derive(Default)]
pub struct ChatQuery {
    pub server_id: Option<Uuid>,
    pub player_id: Option<Uuid>,
    /// Only messages strictly older than this (keyset pagination on `sent_at`).
    pub before: Option<DateTime<Utc>>,
    pub limit: i64,
}

pub async fn list(
    app_pool: &PgPool,
    tenant: TenantId,
    q: &ChatQuery,
) -> Result<Vec<ChatRow>, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let rows = sqlx::query_as::<_, ChatRow>(
        "SELECT id, server_id, player_id, channel, name, message, sent_at \
         FROM chat_messages \
         WHERE ($1::uuid IS NULL OR server_id = $1) \
           AND ($2::uuid IS NULL OR player_id = $2) \
           AND ($3::timestamptz IS NULL OR sent_at < $3) \
         ORDER BY sent_at DESC \
         LIMIT $4",
    )
    .bind(q.server_id)
    .bind(q.player_id)
    .bind(q.before)
    .bind(q.limit.clamp(1, 200))
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(rows)
}
