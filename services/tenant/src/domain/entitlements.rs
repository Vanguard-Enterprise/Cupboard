//! The entitlement ledger + webhook dedupe + checkout sessions. Ownership flows in from
//! signed webhooks (fast) and a reconcile poll (authoritative backstop); both converge on
//! one row per `(connection_id, external_ref)` via a content-hash upsert. Provider-wins:
//! Cupboard stores only the provider's reported state.

use crate::error::AppError;
use crate::providers::{entitlement_content_hash, EntitlementRecord};
use chrono::{DateTime, Utc};
use cupboard_domain::TenantId;
use serde::Serialize;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

/// Apply one entitlement record within an existing transaction (webhook path). Upsert by
/// `(connection_id, external_ref)`, skipping the write when the content hash is unchanged.
pub async fn apply_record_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    connection_id: Uuid,
    provider: &str,
    source: &str,
    rec: &EntitlementRecord,
) -> Result<(), sqlx::Error> {
    let hash = entitlement_content_hash(rec);
    sqlx::query(
        "INSERT INTO entitlements \
             (tenant_id, connection_id, provider, external_ref, steam_id, \
              product_external_id, product_name, kind, status, granted_at, expires_at, \
              revoked_at, source, content_hash) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) \
         ON CONFLICT (connection_id, external_ref) DO UPDATE SET \
             steam_id = EXCLUDED.steam_id, \
             product_external_id = EXCLUDED.product_external_id, \
             product_name = COALESCE(EXCLUDED.product_name, entitlements.product_name), \
             kind = EXCLUDED.kind, \
             status = EXCLUDED.status, \
             granted_at = COALESCE(EXCLUDED.granted_at, entitlements.granted_at), \
             expires_at = EXCLUDED.expires_at, \
             revoked_at = EXCLUDED.revoked_at, \
             source = EXCLUDED.source, \
             content_hash = EXCLUDED.content_hash, \
             updated_at = now() \
         WHERE entitlements.content_hash IS DISTINCT FROM EXCLUDED.content_hash",
    )
    .bind(tenant_id)
    .bind(connection_id)
    .bind(provider)
    .bind(&rec.external_ref)
    .bind(&rec.steam_id)
    .bind(&rec.product_external_id)
    .bind(&rec.product_name)
    .bind(rec.kind.as_str())
    .bind(rec.status.as_str())
    .bind(rec.granted_at)
    .bind(rec.expires_at)
    .bind(revoked_at(rec))
    .bind(source)
    .bind(&hash)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn revoked_at(rec: &EntitlementRecord) -> Option<DateTime<Utc>> {
    use crate::providers::EntitlementStatus::*;
    match rec.status {
        Revoked | Refunded | Chargeback => Some(Utc::now()),
        _ => None,
    }
}

/// Record a webhook event and, if it is new (not a replay), apply its entitlement rows,
/// all in one transaction. Returns `true` if newly processed, `false` if a duplicate.
#[allow(clippy::too_many_arguments)]
pub async fn ingest_webhook(
    owner_pool: &PgPool,
    tenant_id: Uuid,
    connection_id: Uuid,
    provider: &str,
    event_id: &str,
    event_type: &str,
    payload: &serde_json::Value,
    entitlements: &[EntitlementRecord],
) -> Result<bool, AppError> {
    let mut tx = owner_pool.begin().await?;
    let inserted = sqlx::query(
        "INSERT INTO store_webhook_events \
             (tenant_id, connection_id, provider, event_id, event_type, payload) \
         VALUES ($1, $2, $3, $4, $5, $6) \
         ON CONFLICT (connection_id, event_id) DO NOTHING",
    )
    .bind(tenant_id)
    .bind(connection_id)
    .bind(provider)
    .bind(event_id)
    .bind(event_type)
    .bind(payload)
    .execute(&mut *tx)
    .await?
    .rows_affected();

    if inserted == 0 {
        // Replay: nothing to do.
        tx.rollback().await?;
        return Ok(false);
    }

    for rec in entitlements {
        apply_record_in_tx(&mut tx, tenant_id, connection_id, provider, "webhook", rec).await?;
    }
    sqlx::query("UPDATE store_webhook_events SET processed_at = now() WHERE connection_id = $1 AND event_id = $2")
        .bind(connection_id)
        .bind(event_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(true)
}

/// Apply a page of reconciled entitlements (owner pool). Each row is upserted with
/// source='reconcile'; unchanged rows are hash-skipped. Returns the number written.
pub async fn apply_reconcile_page(
    owner_pool: &PgPool,
    tenant_id: Uuid,
    connection_id: Uuid,
    provider: &str,
    records: &[EntitlementRecord],
) -> Result<u64, AppError> {
    if records.is_empty() {
        return Ok(0);
    }
    let mut tx = owner_pool.begin().await?;
    for rec in records {
        apply_record_in_tx(
            &mut tx,
            tenant_id,
            connection_id,
            provider,
            "reconcile",
            rec,
        )
        .await?;
    }
    tx.commit().await?;
    Ok(records.len() as u64)
}

// ============================ Checkout sessions ============================

pub struct NewCheckout {
    pub connection_id: Uuid,
    pub player_account_id: Option<Uuid>,
    pub steam_id: String,
    pub product_external_id: String,
    pub quantity: i32,
}

/// Record a started checkout (app pool, tenant-scoped). Returns the session id.
pub async fn create_checkout(
    app_pool: &PgPool,
    tenant: TenantId,
    new: NewCheckout,
    provider_ref: Option<&str>,
) -> Result<Uuid, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO checkout_sessions \
             (tenant_id, connection_id, player_account_id, steam_id, product_external_id, \
              quantity, provider_ref) \
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
    )
    .bind(tenant.0)
    .bind(new.connection_id)
    .bind(new.player_account_id)
    .bind(&new.steam_id)
    .bind(&new.product_external_id)
    .bind(new.quantity)
    .bind(provider_ref)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(id)
}

// ============================ Reads ============================

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct EntitlementView {
    pub product_external_id: Option<String>,
    pub product_name: Option<String>,
    pub kind: String,
    pub status: String,
    pub granted_at: Option<DateTime<Utc>>,
    pub expires_at: Option<DateTime<Utc>>,
}

/// A player's active entitlements for a tenant, by Steam id (owner pool; the public
/// player path has no tenant transaction, and this is scoped explicitly by tenant_id).
pub async fn list_active_for_steam(
    owner_pool: &PgPool,
    tenant_id: Uuid,
    steam_id: &str,
) -> Result<Vec<EntitlementView>, AppError> {
    Ok(sqlx::query_as::<_, EntitlementView>(
        "SELECT product_external_id, product_name, kind, status, granted_at, expires_at \
         FROM entitlements \
         WHERE tenant_id = $1 AND steam_id = $2 AND status = 'active' \
         ORDER BY granted_at DESC NULLS LAST",
    )
    .bind(tenant_id)
    .bind(steam_id)
    .fetch_all(owner_pool)
    .await?)
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct AdminEntitlementView {
    pub steam_id: Option<String>,
    pub product_name: Option<String>,
    pub kind: String,
    pub status: String,
    pub granted_at: Option<DateTime<Utc>>,
    pub expires_at: Option<DateTime<Utc>>,
    pub source: String,
    pub updated_at: DateTime<Utc>,
}

/// The tenant's recent entitlements for the admin dashboard (app pool, RLS + explicit
/// tenant filter). Capped; newest first.
pub async fn list_admin(
    app_pool: &PgPool,
    tenant: TenantId,
    limit: i64,
) -> Result<Vec<AdminEntitlementView>, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let rows = sqlx::query_as::<_, AdminEntitlementView>(
        "SELECT steam_id, product_name, kind, status, granted_at, expires_at, source, \
                updated_at \
         FROM entitlements WHERE tenant_id = $1 \
         ORDER BY updated_at DESC LIMIT $2",
    )
    .bind(tenant.0)
    .bind(limit)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(rows)
}
