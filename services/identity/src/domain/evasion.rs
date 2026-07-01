//! Read/triage for ban-evasion alerts (per-tenant, RLS). Alerts are *written* by the
//! ingestion path (owner pool); staff list and dismiss/action them on the app pool.

use crate::error::AppError;
use chrono::{DateTime, Utc};
use cupboard_domain::TenantId;
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, sqlx::FromRow, serde::Serialize)]
pub struct EvasionAlert {
    pub id: Uuid,
    pub status: String,
    pub via_kind: Option<String>,
    pub detected_at: DateTime<Utc>,
    pub suspect_player: Uuid,
    pub suspect_display_id: i64,
    pub ban_id: Uuid,
    pub ban_subject: Option<String>,
    pub ban_reason: Option<String>,
}

pub async fn list(app_pool: &PgPool, tenant: TenantId) -> Result<Vec<EvasionAlert>, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    // RLS scopes both the alerts and the joined bans to the tenant; players is global.
    let alerts = sqlx::query_as::<_, EvasionAlert>(
        "SELECT a.id, a.status, a.via_kind, a.detected_at, \
                a.suspect_player, p.display_id AS suspect_display_id, \
                a.ban_id, b.subject_value AS ban_subject, b.reason AS ban_reason \
         FROM ban_evasion_alerts a \
         JOIN players p ON p.id = a.suspect_player \
         JOIN bans b ON b.id = a.ban_id \
         ORDER BY (a.status = 'open') DESC, a.detected_at DESC LIMIT 200",
    )
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(alerts)
}

/// Set an alert's status (`dismissed` or `actioned`). Returns false if it doesn't exist.
pub async fn set_status(
    app_pool: &PgPool,
    tenant: TenantId,
    actor: Uuid,
    id: Uuid,
    status: &str,
) -> Result<bool, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let res = sqlx::query("UPDATE ban_evasion_alerts SET status = $2 WHERE id = $1")
        .bind(id)
        .bind(status)
        .execute(&mut *tx)
        .await?;
    let changed = res.rows_affected() > 0;
    if changed {
        crate::domain::audit::record_in_tx(
            &mut tx,
            Some(tenant.0),
            Some(actor),
            &format!("evasion.{status}"),
            Some("evasion_alert"),
            Some(id),
            None,
        )
        .await?;
    }
    tx.commit().await?;
    Ok(changed)
}
