//! Commerce DB layer: store connections (operator-managed, envelope-encrypted
//! credentials), the runner lease (BM connection pattern), and the catalog cache tables
//! the public storefront renders from.
//!
//! Pool discipline: operator CRUD runs on the app pool inside `begin_tenant_tx` (RLS +
//! explicit tenant filters); the runner and public reads run on the owner pool with
//! explicit tenant/connection scoping. Catalog rows are runner-owned: the app role only
//! ever SELECTs them.

use crate::error::AppError;
use crate::providers::{category_content_hash, product_content_hash, CatalogSnapshot, StoreInfo};
use chrono::{DateTime, Utc};
use cupboard_domain::TenantId;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

/// Stale-claim takeover threshold (matches the BM runner).
pub const CLAIM_STALE_SECS: u64 = 120;
/// Catalog refresh cadence after a successful sync.
const SYNC_INTERVAL_SECS: i64 = 5 * 60;
/// Backoff after a transient sync failure / a rejected (4xx) sync failure.
const RETRY_TRANSIENT_SECS: i64 = 60;
const RETRY_REJECTED_SECS: i64 = 15 * 60;

const CONN_COLS: &str = "id, tenant_id, provider, status, api_key_enc, api_key_dek, \
     store_external_id, store_name, store_currency, store_live, \
     webhook_secret_enc, webhook_secret_dek, webhook_external_id, settings, last_error, \
     next_catalog_sync_at, catalog_synced_at, claimed_by, heartbeat_at, created_at, \
     updated_at";

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct StoreConnection {
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub provider: String,
    pub status: String,
    pub api_key_enc: Option<Vec<u8>>,
    pub api_key_dek: Option<Vec<u8>>,
    pub store_external_id: String,
    pub store_name: Option<String>,
    pub store_currency: Option<String>,
    pub store_live: Option<bool>,
    pub webhook_secret_enc: Option<Vec<u8>>,
    pub webhook_secret_dek: Option<Vec<u8>>,
    pub webhook_external_id: Option<String>,
    pub settings: serde_json::Value,
    pub last_error: Option<String>,
    pub next_catalog_sync_at: DateTime<Utc>,
    pub catalog_synced_at: Option<DateTime<Utc>>,
    pub claimed_by: Option<String>,
    pub heartbeat_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Operator-facing view: everything except secrets and lease internals.
#[derive(Debug, Serialize)]
pub struct ConnectionView {
    pub provider: String,
    pub status: String,
    pub store_external_id: String,
    pub store_name: Option<String>,
    pub store_currency: Option<String>,
    pub store_live: Option<bool>,
    pub last_error: Option<String>,
    pub catalog_synced_at: Option<DateTime<Utc>>,
    pub next_catalog_sync_at: DateTime<Utc>,
    pub product_count: i64,
    pub created_at: DateTime<Utc>,
}

/// What the public storefront needs to render store pages; also the Redis-cached value.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublicCatalog {
    pub store_name: Option<String>,
    pub currency: Option<String>,
    pub categories: Vec<PublicCategory>,
    pub products: Vec<PublicProduct>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct PublicCategory {
    pub external_id: String,
    pub slug: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub image_url: Option<String>,
    pub sort_order: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct PublicProduct {
    pub external_id: String,
    pub slug: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub image_url: Option<String>,
    pub price_minor: i64,
    pub price_final_minor: Option<i64>,
    pub currency: String,
    pub kind: String,
    pub interval_value: Option<i32>,
    pub interval_scale: Option<String>,
    pub category_ids: serde_json::Value,
    pub available: bool,
    pub sort_order: i32,
}

// ============================ Operator CRUD (app pool) ============================

pub async fn get_connection(
    app_pool: &PgPool,
    tenant: TenantId,
) -> Result<Option<StoreConnection>, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let conn = sqlx::query_as::<_, StoreConnection>(&format!(
        "SELECT {CONN_COLS} FROM store_connections WHERE tenant_id = $1"
    ))
    .bind(tenant.0)
    .fetch_optional(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(conn)
}

/// Admin view + product count in one round trip set.
pub async fn connection_view(
    app_pool: &PgPool,
    tenant: TenantId,
) -> Result<Option<ConnectionView>, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let row = sqlx::query_as::<_, StoreConnection>(&format!(
        "SELECT {CONN_COLS} FROM store_connections WHERE tenant_id = $1"
    ))
    .bind(tenant.0)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(conn) = row else {
        tx.commit().await?;
        return Ok(None);
    };
    let product_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM store_products \
         WHERE tenant_id = $1 AND connection_id = $2 AND deleted_at IS NULL",
    )
    .bind(tenant.0)
    .bind(conn.id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Some(ConnectionView {
        provider: conn.provider,
        status: conn.status,
        store_external_id: conn.store_external_id,
        store_name: conn.store_name,
        store_currency: conn.store_currency,
        store_live: conn.store_live,
        last_error: conn.last_error,
        catalog_synced_at: conn.catalog_synced_at,
        next_catalog_sync_at: conn.next_catalog_sync_at,
        product_count,
        created_at: conn.created_at,
    }))
}

pub struct NewConnection {
    pub provider: String,
    pub api_key_enc: Vec<u8>,
    pub api_key_dek: Vec<u8>,
    pub info: StoreInfo,
}

/// Create or replace the org's store connection (one per org). A reconnect resets the
/// lease and schedules an immediate catalog sync; the old catalog rows converge on the
/// next sync (hash upsert + soft-delete of absentees).
pub async fn upsert_connection(
    app_pool: &PgPool,
    tenant: TenantId,
    actor: Option<Uuid>,
    new: NewConnection,
) -> Result<StoreConnection, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let conn = sqlx::query_as::<_, StoreConnection>(&format!(
        "INSERT INTO store_connections \
             (tenant_id, provider, status, api_key_enc, api_key_dek, store_external_id, \
              store_name, store_currency, store_live) \
         VALUES ($1, $2, 'connected', $3, $4, $5, $6, $7, $8) \
         ON CONFLICT (tenant_id) DO UPDATE SET \
             provider = EXCLUDED.provider, \
             status = 'connected', \
             api_key_enc = EXCLUDED.api_key_enc, \
             api_key_dek = EXCLUDED.api_key_dek, \
             store_external_id = EXCLUDED.store_external_id, \
             store_name = EXCLUDED.store_name, \
             store_currency = EXCLUDED.store_currency, \
             store_live = EXCLUDED.store_live, \
             last_error = NULL, \
             next_catalog_sync_at = now(), \
             claimed_by = NULL, \
             heartbeat_at = NULL, \
             webhook_secret_enc = NULL, \
             webhook_secret_dek = NULL, \
             webhook_external_id = NULL, \
             updated_at = now() \
         RETURNING {CONN_COLS}"
    ))
    .bind(tenant.0)
    .bind(&new.provider)
    .bind(&new.api_key_enc)
    .bind(&new.api_key_dek)
    .bind(&new.info.external_id)
    .bind(&new.info.name)
    .bind(&new.info.currency)
    .bind(new.info.live)
    .fetch_one(&mut *tx)
    .await?;

    crate::domain::audit::record_in_tx(
        &mut tx,
        tenant.0,
        actor,
        "store.connect",
        Some("store_connection"),
        Some(conn.id),
        Some(serde_json::json!({
            "provider": conn.provider,
            "store_external_id": conn.store_external_id,
            "store_name": conn.store_name,
        })),
    )
    .await?;
    tx.commit().await?;
    Ok(conn)
}

/// Disconnect: shred the credential, keep the row (catalog + future entitlement history
/// stay; public reads require status='connected' so the storefront hides immediately).
pub async fn disconnect(
    app_pool: &PgPool,
    tenant: TenantId,
    actor: Option<Uuid>,
) -> Result<bool, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let id: Option<Uuid> = sqlx::query_scalar(
        "UPDATE store_connections SET \
             status = 'disconnected', api_key_enc = NULL, api_key_dek = NULL, \
             webhook_secret_enc = NULL, webhook_secret_dek = NULL, \
             webhook_external_id = NULL, \
             last_error = NULL, updated_at = now() \
         WHERE tenant_id = $1 RETURNING id",
    )
    .bind(tenant.0)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(id) = id else {
        tx.rollback().await?;
        return Ok(false);
    };
    crate::domain::audit::record_in_tx(
        &mut tx,
        tenant.0,
        actor,
        "store.disconnect",
        Some("store_connection"),
        Some(id),
        None,
    )
    .await?;
    tx.commit().await?;
    Ok(true)
}

/// "Sync now": pull the next catalog sync forward; the runner (or a fresh claim) picks
/// it up within a supervisor tick.
pub async fn request_sync(app_pool: &PgPool, tenant: TenantId) -> Result<bool, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let res = sqlx::query(
        "UPDATE store_connections SET next_catalog_sync_at = now(), updated_at = now() \
         WHERE tenant_id = $1 AND status = 'connected'",
    )
    .bind(tenant.0)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(res.rows_affected() == 1)
}

/// Admin catalog table (app pool; SELECT-only grant).
pub async fn list_products_admin(
    app_pool: &PgPool,
    tenant: TenantId,
) -> Result<Vec<PublicProduct>, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let rows = sqlx::query_as::<_, PublicProduct>(
        "SELECT external_id, slug, name, description, image_url, price_minor, \
                price_final_minor, currency, kind, interval_value, interval_scale, \
                category_ids, available, sort_order \
         FROM store_products \
         WHERE tenant_id = $1 AND deleted_at IS NULL \
         ORDER BY sort_order, name",
    )
    .bind(tenant.0)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(rows)
}

// ============================ Runner lease (owner pool) ============================

/// Claim connections with runnable work (BM `claim_ready` shape): connected rows that
/// are unclaimed, ours already, or stale. The runner idles between syncs, so status is
/// the only work condition.
pub async fn claim_ready(
    owner_pool: &PgPool,
    claimer: &str,
    limit: i64,
) -> Result<Vec<StoreConnection>, AppError> {
    let rows = sqlx::query_as::<_, StoreConnection>(&format!(
        "UPDATE store_connections SET claimed_by = $1, heartbeat_at = now() \
         WHERE id IN ( \
             SELECT c.id FROM store_connections c \
             WHERE c.status = 'connected' \
               AND (c.claimed_by IS NULL OR c.claimed_by = $1 \
                    OR c.heartbeat_at < now() - make_interval(secs => $3)) \
             ORDER BY c.heartbeat_at ASC NULLS FIRST \
             LIMIT $2 \
             FOR UPDATE SKIP LOCKED \
         ) \
         RETURNING {CONN_COLS}"
    ))
    .bind(claimer)
    .bind(limit)
    .bind(CLAIM_STALE_SECS as f64)
    .fetch_all(owner_pool)
    .await?;
    Ok(rows)
}

pub async fn heartbeat(
    owner_pool: &PgPool,
    connection_id: Uuid,
    claimer: &str,
) -> Result<bool, AppError> {
    let res = sqlx::query(
        "UPDATE store_connections SET heartbeat_at = now() WHERE id = $1 AND claimed_by = $2",
    )
    .bind(connection_id)
    .bind(claimer)
    .execute(owner_pool)
    .await?;
    Ok(res.rows_affected() == 1)
}

pub async fn release_claim(
    owner_pool: &PgPool,
    connection_id: Uuid,
    claimer: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE store_connections SET claimed_by = NULL, heartbeat_at = NULL \
         WHERE id = $1 AND claimed_by = $2",
    )
    .bind(connection_id)
    .bind(claimer)
    .execute(owner_pool)
    .await?;
    Ok(())
}

/// Fresh row each runner tick so operator changes (disconnect, reconnect, Sync now)
/// apply within seconds. Also used by the webhook receiver to load the connection (and
/// its webhook secret) by id, since webhooks arrive without a tenant context.
pub async fn load_fresh(
    owner_pool: &PgPool,
    connection_id: Uuid,
) -> Result<Option<StoreConnection>, AppError> {
    Ok(sqlx::query_as::<_, StoreConnection>(&format!(
        "SELECT {CONN_COLS} FROM store_connections WHERE id = $1"
    ))
    .bind(connection_id)
    .fetch_optional(owner_pool)
    .await?)
}

/// Store the webhook registration (envelope-encrypted secret + provider id), fenced on
/// the lease + credential like the sync bookkeeping so a stale runner cannot clobber it.
pub async fn save_webhook_registration(
    owner_pool: &PgPool,
    connection_id: Uuid,
    claimer: &str,
    key_fence: &[u8],
    secret_enc: &[u8],
    secret_dek: &[u8],
    external_id: &str,
) -> Result<bool, AppError> {
    let res = sqlx::query(
        "UPDATE store_connections SET \
             webhook_secret_enc = $4, webhook_secret_dek = $5, webhook_external_id = $6, \
             updated_at = now() \
         WHERE id = $1 AND claimed_by = $2 AND api_key_enc = $3",
    )
    .bind(connection_id)
    .bind(claimer)
    .bind(key_fence)
    .bind(secret_enc)
    .bind(secret_dek)
    .bind(external_id)
    .execute(owner_pool)
    .await?;
    Ok(res.rows_affected() == 1)
}

/// Mark the connection errored, fenced on both the lease and the exact credential bytes
/// the runner decrypted (a runner holding a rotated key must not error a reconnected
/// connection; BM token-fence discipline).
pub async fn mark_error_fenced(
    owner_pool: &PgPool,
    connection_id: Uuid,
    claimer: &str,
    key_fence: &[u8],
    message: &str,
) -> Result<bool, AppError> {
    let res = sqlx::query(
        "UPDATE store_connections SET status = 'error', last_error = $4, updated_at = now() \
         WHERE id = $1 AND claimed_by = $2 AND api_key_enc = $3",
    )
    .bind(connection_id)
    .bind(claimer)
    .bind(key_fence)
    .bind(message)
    .execute(owner_pool)
    .await?;
    Ok(res.rows_affected() == 1)
}

/// Record a sync failure without erroring the connection (transient/rejected): surface
/// `last_error` and push the next attempt out. Same double fence as `mark_error_fenced`.
pub async fn defer_sync_fenced(
    owner_pool: &PgPool,
    connection_id: Uuid,
    claimer: &str,
    key_fence: &[u8],
    message: &str,
    transient: bool,
) -> Result<bool, AppError> {
    let secs = if transient {
        RETRY_TRANSIENT_SECS
    } else {
        RETRY_REJECTED_SECS
    };
    let res = sqlx::query(
        "UPDATE store_connections SET \
             last_error = $4, \
             next_catalog_sync_at = now() + make_interval(secs => $5), \
             updated_at = now() \
         WHERE id = $1 AND claimed_by = $2 AND api_key_enc = $3",
    )
    .bind(connection_id)
    .bind(claimer)
    .bind(key_fence)
    .bind(message)
    .bind(secs as f64)
    .execute(owner_pool)
    .await?;
    Ok(res.rows_affected() == 1)
}

/// Apply a full catalog snapshot in one transaction: hash-diff upserts (unchanged rows
/// untouched, no WAL churn on quiet catalogs), soft-delete of absentees, then the
/// fenced sync bookkeeping on the connection. Returns (written, soft_deleted).
pub async fn apply_catalog(
    owner_pool: &PgPool,
    conn: &StoreConnection,
    claimer: &str,
    key_fence: &[u8],
    snapshot: &CatalogSnapshot,
) -> Result<(u64, u64), AppError> {
    let mut tx = owner_pool.begin().await?;

    // Batched set-based upserts (one statement per table regardless of catalog size);
    // the conditional DO UPDATE leaves unchanged rows untouched (no WAL churn).
    let mut written: u64 = 0;
    if !snapshot.categories.is_empty() {
        let mut ext = Vec::new();
        let mut slug: Vec<Option<String>> = Vec::new();
        let mut name = Vec::new();
        let mut desc: Vec<Option<String>> = Vec::new();
        let mut img: Vec<Option<String>> = Vec::new();
        let mut sort = Vec::new();
        let mut hash = Vec::new();
        for c in &snapshot.categories {
            ext.push(c.external_id.clone());
            slug.push(c.slug.clone());
            name.push(c.name.clone());
            desc.push(c.description.clone());
            img.push(c.image_url.clone());
            sort.push(c.sort_order);
            hash.push(category_content_hash(c));
        }
        let res = sqlx::query(
            "INSERT INTO store_categories \
                 (tenant_id, connection_id, external_id, slug, name, description, \
                  image_url, sort_order, content_hash) \
             SELECT $1, $2, u.* FROM UNNEST( \
                 $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], \
                 $8::int[], $9::text[]) \
               AS u(external_id, slug, name, description, image_url, sort_order, \
                    content_hash) \
             ON CONFLICT (connection_id, external_id) DO UPDATE SET \
                 slug = EXCLUDED.slug, name = EXCLUDED.name, \
                 description = EXCLUDED.description, image_url = EXCLUDED.image_url, \
                 sort_order = EXCLUDED.sort_order, content_hash = EXCLUDED.content_hash, \
                 deleted_at = NULL \
             WHERE store_categories.content_hash IS DISTINCT FROM EXCLUDED.content_hash \
                OR store_categories.deleted_at IS NOT NULL",
        )
        .bind(conn.tenant_id)
        .bind(conn.id)
        .bind(&ext)
        .bind(&slug)
        .bind(&name)
        .bind(&desc)
        .bind(&img)
        .bind(&sort)
        .bind(&hash)
        .execute(&mut *tx)
        .await?;
        written += res.rows_affected();
    }

    if !snapshot.products.is_empty() {
        let n = snapshot.products.len();
        let mut ext = Vec::with_capacity(n);
        let mut slug: Vec<Option<String>> = Vec::with_capacity(n);
        let mut name = Vec::with_capacity(n);
        let mut desc: Vec<Option<String>> = Vec::with_capacity(n);
        let mut img: Vec<Option<String>> = Vec::with_capacity(n);
        let mut price = Vec::with_capacity(n);
        let mut price_final: Vec<Option<i64>> = Vec::with_capacity(n);
        let mut currency = Vec::with_capacity(n);
        let mut kind = Vec::with_capacity(n);
        let mut ivl_value: Vec<Option<i32>> = Vec::with_capacity(n);
        let mut ivl_scale: Vec<Option<String>> = Vec::with_capacity(n);
        let mut cats: Vec<serde_json::Value> = Vec::with_capacity(n);
        let mut avail = Vec::with_capacity(n);
        let mut sort = Vec::with_capacity(n);
        let mut raw: Vec<serde_json::Value> = Vec::with_capacity(n);
        let mut hash = Vec::with_capacity(n);
        for p in &snapshot.products {
            ext.push(p.external_id.clone());
            slug.push(p.slug.clone());
            name.push(p.name.clone());
            desc.push(p.description.clone());
            img.push(p.image_url.clone());
            price.push(p.price_minor);
            price_final.push(p.price_final_minor);
            currency.push(p.currency.clone());
            kind.push(p.kind.as_str().to_string());
            ivl_value.push(p.interval_value);
            ivl_scale.push(p.interval_scale.clone());
            cats.push(serde_json::json!(p.category_ids));
            avail.push(p.available);
            sort.push(p.sort_order);
            raw.push(p.raw.clone());
            hash.push(product_content_hash(p));
        }
        let res = sqlx::query(
            "INSERT INTO store_products \
                 (tenant_id, connection_id, external_id, slug, name, description, \
                  image_url, price_minor, price_final_minor, currency, kind, \
                  interval_value, interval_scale, category_ids, available, sort_order, \
                  raw, content_hash) \
             SELECT $1, $2, u.* FROM UNNEST( \
                 $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], \
                 $8::bigint[], $9::bigint[], $10::text[], $11::text[], $12::int[], \
                 $13::text[], $14::jsonb[], $15::bool[], $16::int[], $17::jsonb[], \
                 $18::text[]) \
               AS u(external_id, slug, name, description, image_url, price_minor, \
                    price_final_minor, currency, kind, interval_value, interval_scale, \
                    category_ids, available, sort_order, raw, content_hash) \
             ON CONFLICT (connection_id, external_id) DO UPDATE SET \
                 slug = EXCLUDED.slug, name = EXCLUDED.name, \
                 description = EXCLUDED.description, image_url = EXCLUDED.image_url, \
                 price_minor = EXCLUDED.price_minor, \
                 price_final_minor = EXCLUDED.price_final_minor, \
                 currency = EXCLUDED.currency, kind = EXCLUDED.kind, \
                 interval_value = EXCLUDED.interval_value, \
                 interval_scale = EXCLUDED.interval_scale, \
                 category_ids = EXCLUDED.category_ids, \
                 available = EXCLUDED.available, sort_order = EXCLUDED.sort_order, \
                 raw = EXCLUDED.raw, content_hash = EXCLUDED.content_hash, \
                 last_seen_at = now(), deleted_at = NULL \
             WHERE store_products.content_hash IS DISTINCT FROM EXCLUDED.content_hash \
                OR store_products.deleted_at IS NOT NULL",
        )
        .bind(conn.tenant_id)
        .bind(conn.id)
        .bind(&ext)
        .bind(&slug)
        .bind(&name)
        .bind(&desc)
        .bind(&img)
        .bind(&price)
        .bind(&price_final)
        .bind(&currency)
        .bind(&kind)
        .bind(&ivl_value)
        .bind(&ivl_scale)
        .bind(&cats)
        .bind(&avail)
        .bind(&sort)
        .bind(&raw)
        .bind(&hash)
        .execute(&mut *tx)
        .await?;
        written += res.rows_affected();
    }

    // Soft-delete anything the (always complete) snapshot no longer contains.
    let product_ids: Vec<String> = snapshot
        .products
        .iter()
        .map(|p| p.external_id.clone())
        .collect();
    let category_ids: Vec<String> = snapshot
        .categories
        .iter()
        .map(|c| c.external_id.clone())
        .collect();
    let mut deleted: u64 = 0;
    deleted += sqlx::query(
        "UPDATE store_products SET deleted_at = now() \
         WHERE connection_id = $1 AND deleted_at IS NULL AND external_id <> ALL($2)",
    )
    .bind(conn.id)
    .bind(&product_ids)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    deleted += sqlx::query(
        "UPDATE store_categories SET deleted_at = now() \
         WHERE connection_id = $1 AND deleted_at IS NULL AND external_id <> ALL($2)",
    )
    .bind(conn.id)
    .bind(&category_ids)
    .execute(&mut *tx)
    .await?
    .rows_affected();

    // Fenced bookkeeping: if the lease or credential changed mid-sync, the whole
    // snapshot application must not land (LostClaim discipline).
    let fenced = sqlx::query(
        "UPDATE store_connections SET \
             catalog_synced_at = now(), \
             next_catalog_sync_at = now() + make_interval(secs => $4), \
             last_error = NULL, updated_at = now() \
         WHERE id = $1 AND claimed_by = $2 AND api_key_enc = $3",
    )
    .bind(conn.id)
    .bind(claimer)
    .bind(key_fence)
    .bind(SYNC_INTERVAL_SECS as f64)
    .execute(&mut *tx)
    .await?;
    if fenced.rows_affected() != 1 {
        tx.rollback().await?;
        return Err(AppError::Conflict(
            "sync lease lost; discarding snapshot".into(),
        ));
    }

    tx.commit().await?;
    Ok((written, deleted))
}

// ============================ Public reads (owner pool) ============================

/// The catalog the storefront renders. `None` when the tenant has no *connected* store
/// (disconnected/errored stores hide their pages rather than serving stale commerce).
pub async fn public_catalog(
    owner_pool: &PgPool,
    tenant_id: Uuid,
) -> Result<Option<PublicCatalog>, AppError> {
    let conn = sqlx::query_as::<_, StoreConnection>(&format!(
        "SELECT {CONN_COLS} FROM store_connections \
         WHERE tenant_id = $1 AND status = 'connected'"
    ))
    .bind(tenant_id)
    .fetch_optional(owner_pool)
    .await?;
    let Some(conn) = conn else { return Ok(None) };

    let categories = sqlx::query_as::<_, PublicCategory>(
        "SELECT external_id, slug, name, description, image_url, sort_order \
         FROM store_categories \
         WHERE tenant_id = $1 AND connection_id = $2 AND deleted_at IS NULL \
         ORDER BY sort_order, name",
    )
    .bind(tenant_id)
    .bind(conn.id)
    .fetch_all(owner_pool)
    .await?;

    let products = sqlx::query_as::<_, PublicProduct>(
        "SELECT external_id, slug, name, description, image_url, price_minor, \
                price_final_minor, currency, kind, interval_value, interval_scale, \
                category_ids, available, sort_order \
         FROM store_products \
         WHERE tenant_id = $1 AND connection_id = $2 AND deleted_at IS NULL \
         ORDER BY sort_order, name",
    )
    .bind(tenant_id)
    .bind(conn.id)
    .fetch_all(owner_pool)
    .await?;

    Ok(Some(PublicCatalog {
        store_name: conn.store_name,
        currency: conn.store_currency,
        categories,
        products,
    }))
}
