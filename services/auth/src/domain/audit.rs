//! Central audit log of staff/admin actions. Written on the owner pool (it may record
//! either a tenant-scoped or a system-global action). Best-effort: an audit write
//! failure is logged but never fails the underlying action.

use sqlx::PgPool;
use uuid::Uuid;

/// Record an audit entry. `organization_id`/`actor_id` are `None` for system actions.
pub async fn record(
    pool: &PgPool,
    organization_id: Option<Uuid>,
    actor_id: Option<Uuid>,
    action: &str,
    target_type: Option<&str>,
    target_id: Option<Uuid>,
    metadata: Option<serde_json::Value>,
) {
    let result = sqlx::query(
        "INSERT INTO audit_log \
         (organization_id, actor_id, action, target_type, target_id, metadata) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(organization_id)
    .bind(actor_id)
    .bind(action)
    .bind(target_type)
    .bind(target_id)
    .bind(metadata)
    .execute(pool)
    .await;
    if let Err(e) = result {
        tracing::warn!(error = %e, action, "failed to write audit entry");
    }
}
