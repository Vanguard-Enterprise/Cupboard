//! Store-provider adapters (ARCHITECTURE decision #23, phase plan decision B).
//!
//! Each provider (PayNow now, Tebex in PR6) implements [`StoreProvider`] over its own
//! HTTP client with an injectable base URL (tests run against an in-process stub). The
//! trait grows with the phase: PR2 needs probe + catalog; checkout, webhooks, and
//! reconciliation methods land with the PRs that consume them, so there is no dead
//! surface to maintain in the meantime.
//!
//! Provider credentials never leave this service: sealed with
//! `cupboard_crypto::envelope` under TENANT_MASTER_KEY at rest, decrypted only inside
//! the store runner and the probe path.

pub mod paynow;
#[cfg(feature = "stub")]
pub mod stub;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Provider identifiers as stored in `store_connections.provider`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    PayNow,
    Tebex,
}

impl ProviderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderKind::PayNow => "paynow",
            ProviderKind::Tebex => "tebex",
        }
    }
}

impl std::str::FromStr for ProviderKind {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "paynow" => Ok(ProviderKind::PayNow),
            "tebex" => Ok(ProviderKind::Tebex),
            _ => Err(()),
        }
    }
}

/// Errors classified by what the caller should do about them, mirroring the fleet
/// client's discipline: `Auth` marks the connection errored (bad/rotated key), `Rejected`
/// is a permanent per-request failure (skip, do not retry), `Transient` retries.
#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("provider rejected credentials: {0}")]
    Auth(String),
    #[error("provider rejected request: {0}")]
    Rejected(String),
    #[error("transient provider error: {0}")]
    Transient(String),
}

/// What a successful credential probe learns about the store.
#[derive(Debug, Clone)]
pub struct StoreInfo {
    pub external_id: String,
    pub name: Option<String>,
    pub currency: Option<String>,
    /// Provider-side live/test state (PayNow `live_mode`), informational.
    pub live: Option<bool>,
}

/// One product as the provider reports it, already normalized to the columns of
/// `store_products`. `raw` keeps the provider payload for debugging/forward-compat.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderProduct {
    pub external_id: String,
    pub slug: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub image_url: Option<String>,
    /// Base price in minor units (integer cents).
    pub price_minor: i64,
    /// Display price after provider-side sales/regional pricing, when reported.
    pub price_final_minor: Option<i64>,
    pub currency: String,
    /// `single` or `subscription` (store_products.kind CHECK).
    pub kind: ProductKind,
    pub interval_value: Option<i32>,
    pub interval_scale: Option<String>,
    /// External ids of the categories this product belongs to.
    pub category_ids: Vec<String>,
    pub available: bool,
    pub sort_order: i32,
    pub raw: serde_json::Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProductKind {
    Single,
    Subscription,
}

impl ProductKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ProductKind::Single => "single",
            ProductKind::Subscription => "subscription",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderCategory {
    pub external_id: String,
    pub slug: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub image_url: Option<String>,
    pub sort_order: i32,
}

/// A full catalog snapshot. Neither provider paginates catalog reads, so a snapshot is
/// always complete; the sync applies it as a hash diff + soft-delete of absentees.
#[derive(Debug, Clone, Default)]
pub struct CatalogSnapshot {
    pub products: Vec<ProviderProduct>,
    pub categories: Vec<ProviderCategory>,
}

/// Entitlement status as normalized across providers (the `entitlements.status` CHECK).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntitlementStatus {
    Active,
    Expired,
    Revoked,
    Refunded,
    Chargeback,
}

impl EntitlementStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            EntitlementStatus::Active => "active",
            EntitlementStatus::Expired => "expired",
            EntitlementStatus::Revoked => "revoked",
            EntitlementStatus::Refunded => "refunded",
            EntitlementStatus::Chargeback => "chargeback",
        }
    }
}

/// One entitlement's reported state, from either a webhook or a reconcile poll. Keyed by
/// `external_ref` (the provider "delivery item" id) so both sources converge on one row.
#[derive(Debug, Clone)]
pub struct EntitlementRecord {
    pub external_ref: String,
    pub steam_id: Option<String>,
    pub product_external_id: Option<String>,
    pub product_name: Option<String>,
    pub kind: ProductKind,
    pub status: EntitlementStatus,
    pub granted_at: Option<chrono::DateTime<chrono::Utc>>,
    pub expires_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// Canonical content hash for an entitlement row (change detection on the hot path, like
/// the catalog).
pub fn entitlement_content_hash(e: &EntitlementRecord) -> String {
    let canonical = serde_json::json!({
        "external_ref": e.external_ref,
        "steam_id": e.steam_id,
        "product_external_id": e.product_external_id,
        "product_name": e.product_name,
        "kind": e.kind.as_str(),
        "status": e.status.as_str(),
        "granted_at": e.granted_at.map(|t| t.timestamp()),
        "expires_at": e.expires_at.map(|t| t.timestamp()),
    });
    sha256_hex(canonical.to_string().as_bytes())
}

/// A verified, parsed webhook: its dedupe id, type, and any entitlement rows it reports.
#[derive(Debug, Clone)]
pub struct NormalizedWebhook {
    pub event_id: String,
    pub event_type: String,
    pub entitlements: Vec<EntitlementRecord>,
}

/// Outcome of registering a webhook with the provider (PayNow returns a signing secret).
#[derive(Debug, Clone)]
pub struct WebhookRegistration {
    pub external_id: String,
    pub signing_secret: String,
}

/// What the checkout endpoint needs to start a purchase.
#[derive(Debug, Clone)]
pub struct CheckoutRequest {
    pub steam_id: String,
    pub product_external_id: String,
    pub quantity: i32,
    pub return_url: String,
    pub cancel_url: String,
}

/// The step the storefront must take next after `begin_checkout`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckoutStep {
    /// Redirect the buyer straight to the provider's hosted checkout (PayNow).
    Final,
    /// Provider requires a buyer-auth roundtrip first (Tebex basket auth; PR6).
    NeedsProviderAuth,
}

#[derive(Debug, Clone)]
pub struct CheckoutBegin {
    pub redirect_url: String,
    pub provider_ref: Option<String>,
    pub step: CheckoutStep,
}

/// A page of reconciled entitlements plus the cursor for the next page (`None` = done).
#[derive(Debug, Clone, Default)]
pub struct ReconcilePage {
    pub entitlements: Vec<EntitlementRecord>,
    pub next_cursor: Option<String>,
}

/// The provider adapter. One instance per connection runner (which also makes each
/// client's process-local rate limiter globally correct per credential).
pub trait StoreProvider: Send + Sync {
    /// Validate credentials and discover/confirm the store (`&mut self`: a successful
    /// probe may resolve and adopt the store id for subsequent calls). Single attempt
    /// with a short timeout (probe runs on the connect request path; phase-4 lesson:
    /// never inherit minutes of retry policy there).
    fn probe(
        &mut self,
    ) -> impl std::future::Future<Output = Result<StoreInfo, ProviderError>> + Send;

    /// Fetch the complete catalog (products + categories).
    fn fetch_catalog(
        &self,
    ) -> impl std::future::Future<Output = Result<CatalogSnapshot, ProviderError>> + Send;

    /// Register a webhook endpoint with the provider, returning the signing secret to
    /// store (envelope-encrypted). `Ok(None)` = the provider does not support programmatic
    /// registration (Tebex; the wizard shows manual instructions in PR6).
    fn register_webhook(
        &self,
        endpoint_url: &str,
    ) -> impl std::future::Future<Output = Result<Option<WebhookRegistration>, ProviderError>> + Send;

    /// Begin a checkout: for PayNow, upsert the customer by Steam id and create a hosted
    /// checkout session, returning its redirect URL.
    fn begin_checkout(
        &self,
        req: &CheckoutRequest,
    ) -> impl std::future::Future<Output = Result<CheckoutBegin, ProviderError>> + Send;

    /// Pull one page of the provider's entitlement truth (the reconcile backstop).
    fn reconcile(
        &self,
        cursor: Option<&str>,
    ) -> impl std::future::Future<Output = Result<ReconcilePage, ProviderError>> + Send;
}

/// Canonical content hash for change detection (the bmapi `ban_content_hash` recipe):
/// stable field order via serde struct serialization of the normalized value, so
/// provider-side reordering or `raw` noise does not churn rows.
pub fn product_content_hash(p: &ProviderProduct) -> String {
    // Hash the normalized fields, NOT `raw`: raw exists for debugging and may carry
    // volatile provider noise (timestamps etc.) that must not register as change.
    let mut sorted_categories = p.category_ids.clone();
    sorted_categories.sort();
    let canonical = serde_json::json!({
        "external_id": p.external_id,
        "slug": p.slug,
        "name": p.name,
        "description": p.description,
        "image_url": p.image_url,
        "price_minor": p.price_minor,
        "price_final_minor": p.price_final_minor,
        "currency": p.currency,
        "kind": p.kind.as_str(),
        "interval_value": p.interval_value,
        "interval_scale": p.interval_scale,
        "category_ids": sorted_categories,
        "available": p.available,
        "sort_order": p.sort_order,
    });
    sha256_hex(canonical.to_string().as_bytes())
}

pub fn category_content_hash(c: &ProviderCategory) -> String {
    let canonical = serde_json::json!({
        "external_id": c.external_id,
        "slug": c.slug,
        "name": c.name,
        "description": c.description,
        "image_url": c.image_url,
        "sort_order": c.sort_order,
    });
    sha256_hex(canonical.to_string().as_bytes())
}

fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_product() -> ProviderProduct {
        ProviderProduct {
            external_id: "123456789012345678".into(),
            slug: Some("vip".into()),
            name: "VIP Rank".into(),
            description: Some("Priority queue".into()),
            image_url: None,
            price_minor: 999,
            price_final_minor: Some(799),
            currency: "USD".into(),
            kind: ProductKind::Subscription,
            interval_value: Some(1),
            interval_scale: Some("month".into()),
            category_ids: vec!["b".into(), "a".into()],
            available: true,
            sort_order: 1,
            raw: serde_json::json!({"noise": "changes every fetch"}),
        }
    }

    #[test]
    fn hash_ignores_raw_noise_and_category_order() {
        let a = sample_product();
        let mut b = sample_product();
        b.raw = serde_json::json!({"noise": "different"});
        b.category_ids = vec!["a".into(), "b".into()];
        assert_eq!(product_content_hash(&a), product_content_hash(&b));
    }

    #[test]
    fn hash_detects_field_changes() {
        let a = sample_product();
        let mut b = sample_product();
        b.price_final_minor = Some(899);
        assert_ne!(product_content_hash(&a), product_content_hash(&b));
        let mut c = sample_product();
        c.available = false;
        assert_ne!(product_content_hash(&a), product_content_hash(&c));
    }
}
