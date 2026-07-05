//! Audit logging for site/store administration. Records are written inside the same
//! transaction as the action they describe, so an action and its audit entry commit
//! together (identity's `domain/audit.rs` pattern; each service owns its own
//! schema-local `audit_log`).

use sqlx::{Postgres, Transaction};
use uuid::Uuid;

/// Append an audit entry within an existing transaction.
pub async fn record_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
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
