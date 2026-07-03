//! F7-report read path (dashboard reports page + player-profile reports). Request-scoped
//! reads on the app pool inside a tenant-bound transaction (RLS isolates rows); writes
//! happen in `ingest`.

use crate::error::AppError;
use chrono::{DateTime, Utc};
use cupboard_domain::TenantId;
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, sqlx::FromRow, serde::Serialize)]
pub struct ReportRow {
    pub id: Uuid,
    pub server_id: Uuid,
    pub reporter_player_id: Option<Uuid>,
    pub target_player_id: Option<Uuid>,
    pub reporter_name: Option<String>,
    pub target_name: Option<String>,
    pub subject: Option<String>,
    pub message: Option<String>,
    pub report_type: Option<String>,
    pub reported_at: DateTime<Utc>,
}

/// Filters for a reports query; all optional, newest-first.
#[derive(Default)]
pub struct ReportQuery {
    pub server_id: Option<Uuid>,
    /// Reports *against* this player.
    pub target_player_id: Option<Uuid>,
    /// Only reports strictly older than this (keyset pagination on `reported_at`).
    pub before: Option<DateTime<Utc>>,
    pub limit: i64,
}

pub async fn list(
    app_pool: &PgPool,
    tenant: TenantId,
    q: &ReportQuery,
) -> Result<Vec<ReportRow>, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let rows = sqlx::query_as::<_, ReportRow>(
        "SELECT id, server_id, reporter_player_id, target_player_id, reporter_name, \
                target_name, subject, message, report_type, reported_at \
         FROM player_reports \
         WHERE ($1::uuid IS NULL OR server_id = $1) \
           AND ($2::uuid IS NULL OR target_player_id = $2) \
           AND ($3::timestamptz IS NULL OR reported_at < $3) \
         ORDER BY reported_at DESC \
         LIMIT $4",
    )
    .bind(q.server_id)
    .bind(q.target_player_id)
    .bind(q.before)
    .bind(q.limit.clamp(1, 200))
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(rows)
}
