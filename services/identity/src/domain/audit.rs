//! Audit logging for moderation + player-data actions (Identity owns this — Decision 16).
//! Records are written inside the same transaction as the action they describe, so an
//! action and its audit entry commit together.

use sqlx::{Postgres, Transaction};
use uuid::Uuid;

/// Append an audit entry within an existing transaction. `tenant` is `None` for
/// system/global actions (e.g. a merge on the owner pool).
#[allow(clippy::too_many_arguments)]
pub async fn record_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Option<Uuid>,
    actor: Option<Uuid>,
    action: &str,
    target_type: Option<&str>,
    target_id: Option<Uuid>,
    metadata: Option<serde_json::Value>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id, metadata) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(tenant)
    .bind(actor)
    .bind(action)
    .bind(target_type)
    .bind(target_id)
    .bind(metadata)
    .execute(&mut **tx)
    .await?;
    Ok(())
}
