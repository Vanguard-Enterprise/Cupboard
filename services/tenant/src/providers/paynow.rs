//! PayNow adapter (docs.paynow.gg; API facts researched 2026-07-05, recorded in
//! docs/phase5-plan.md and the phase plan appendix).
//!
//! Surfaces used:
//!   * Management `GET /v1/stores` (Authorization: `apikey <key>`): credential probe +
//!     store discovery. Doubles as the "insufficient role" detector.
//!   * Storefront `GET /v1/store`, `/v1/store/products`, `/v1/store/tags`
//!     (`x-paynow-store-id` header, anonymous): store metadata + the catalog with
//!     sale/regional pricing applied (`pricing.price_final`). The management product
//!     list is explicitly NOT for display.
//!
//! Wire discipline: flake ids are int64 ALWAYS serialized as strings; rate limits are
//! undocumented, so a conservative client-side limiter + 429/5xx retry applies; payload
//! envelopes are normalized defensively (bare array or `{data: [...]}`) because the
//! exact shells are unverified until a real store exists (PR2 live-verify item).

use super::{
    CatalogSnapshot, ProductKind, ProviderCategory, ProviderError, ProviderProduct, StoreInfo,
    StoreProvider,
};
use cupboard_bmapi::RateLimiter;
use std::time::Duration;

pub const DEFAULT_BASE: &str = "https://api.paynow.gg/v1";

/// Self-imposed budget; PayNow publishes none. Catalog sync is 2 requests per 5 minutes
/// per store, so this only matters for pathological loops.
const PER_SEC: u32 = 5;
const PER_MIN: u32 = 120;

/// Probe is on the operator connect path: single attempt, short timeout (phase-4
/// lesson: request paths never inherit background retry policy).
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const CATALOG_TIMEOUT: Duration = Duration::from_secs(30);
/// Catalog GET retry schedule on transient failures (the limiter spaces attempts too).
const RETRY_BACKOFF: &[Duration] = &[
    Duration::from_millis(500),
    Duration::from_secs(1),
    Duration::from_secs(2),
];

pub struct PayNowClient {
    http: reqwest::Client,
    base: String,
    api_key: String,
    /// Set after probe (or from the stored connection) for storefront calls.
    store_id: Option<String>,
    limiter: RateLimiter,
}

impl PayNowClient {
    pub fn new(
        base: impl Into<String>,
        api_key: impl Into<String>,
        store_id: Option<String>,
    ) -> Self {
        Self {
            http: reqwest::Client::new(),
            base: base.into().trim_end_matches('/').to_string(),
            api_key: api_key.into(),
            store_id,
            limiter: RateLimiter::new(PER_SEC, PER_MIN),
        }
    }

    fn store_id(&self) -> Result<&str, ProviderError> {
        self.store_id
            .as_deref()
            .ok_or_else(|| ProviderError::Rejected("no store id resolved".into()))
    }

    async fn get(
        &self,
        path: &str,
        auth: bool,
        store_header: bool,
        timeout: Duration,
    ) -> Result<serde_json::Value, ProviderError> {
        self.limiter.acquire().await;
        let mut req = self
            .http
            .get(format!("{}{}", self.base, path))
            .timeout(timeout)
            .header(reqwest::header::ACCEPT, "application/json");
        if auth {
            req = req.header(
                reqwest::header::AUTHORIZATION,
                format!("apikey {}", self.api_key),
            );
        }
        if store_header {
            req = req.header("x-paynow-store-id", self.store_id()?);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| ProviderError::Transient(format!("request failed: {e}")))?;
        let status = resp.status();
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            // Only a credentialed call proves anything about the API key. The anonymous
            // storefront endpoints can 401/403 for store-side reasons (restricted or
            // maintenance state); erroring the connection over those would send the
            // operator chasing a "bad key" that is fine.
            return if auth {
                Err(ProviderError::Auth(format!("paynow returned {status}")))
            } else {
                Err(ProviderError::Rejected(format!(
                    "paynow returned {status} on an anonymous storefront call"
                )))
            };
        }
        if status.as_u16() == 429 || status.is_server_error() {
            return Err(ProviderError::Transient(format!(
                "paynow returned {status}"
            )));
        }
        if !status.is_success() {
            // Body carries {status, code, message}; keep it short for the error column.
            let body = resp.text().await.unwrap_or_default();
            let brief: String = body.chars().take(200).collect();
            return Err(ProviderError::Rejected(format!("{status}: {brief}")));
        }
        resp.json::<serde_json::Value>()
            .await
            .map_err(|e| ProviderError::Transient(format!("invalid JSON: {e}")))
    }

    /// GET with retries for the catalog path (transient failures only).
    async fn get_retried(
        &self,
        path: &str,
        store_header: bool,
    ) -> Result<serde_json::Value, ProviderError> {
        let mut attempt = 0;
        loop {
            match self.get(path, false, store_header, CATALOG_TIMEOUT).await {
                Err(ProviderError::Transient(e)) if attempt < RETRY_BACKOFF.len() => {
                    tracing::debug!(path, attempt, error = %e, "paynow transient; retrying");
                    tokio::time::sleep(RETRY_BACKOFF[attempt]).await;
                    attempt += 1;
                }
                other => return other,
            }
        }
    }
}

/// Accept both a bare JSON array and an object wrapping one (`{"data": [...]}` or any
/// single unambiguous array-valued field): the exact envelope is unverified against a
/// live store. `None` means "shape not recognized", which callers MUST treat as an
/// error, never as an empty list: a misread envelope that returned `[]` would make the
/// sync sweep soft-delete the tenant's entire catalog as a "successful" run.
fn as_array_payload(v: &serde_json::Value) -> Option<Vec<serde_json::Value>> {
    if let Some(arr) = v.as_array() {
        return Some(arr.clone());
    }
    if let Some(obj) = v.as_object() {
        if let Some(arr) = obj.get("data").and_then(|d| d.as_array()) {
            return Some(arr.clone());
        }
        let arrays: Vec<&Vec<serde_json::Value>> =
            obj.values().filter_map(|x| x.as_array()).collect();
        if arrays.len() == 1 {
            return Some(arrays[0].clone());
        }
    }
    None
}

/// Unwrap a list payload or fail the sync with a diagnosable error.
fn require_array(
    v: &serde_json::Value,
    what: &str,
) -> Result<Vec<serde_json::Value>, ProviderError> {
    as_array_payload(v).ok_or_else(|| {
        let brief: String = v.to_string().chars().take(120).collect();
        ProviderError::Rejected(format!(
            "unrecognized {what} payload shape (update the PayNow adapter): {brief}"
        ))
    })
}

fn str_field(v: &serde_json::Value, key: &str) -> Option<String> {
    match v.get(key) {
        // Flake ids must be strings, but tolerate a numeric id defensively.
        Some(serde_json::Value::String(s)) if !s.is_empty() => Some(s.clone()),
        Some(serde_json::Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

fn i64_field(v: &serde_json::Value, key: &str) -> Option<i64> {
    v.get(key).and_then(|x| x.as_i64())
}

/// Provider-supplied URLs that public pages render into src attributes: http(s) only
/// (same stored-XSS posture as site-config URLs; the web render layer guards again).
fn http_url_field(v: &serde_json::Value, key: &str) -> Option<String> {
    str_field(v, key).filter(|s| {
        let lower = s.trim().to_ascii_lowercase();
        lower.starts_with("https://") || lower.starts_with("http://")
    })
}

fn map_product(v: &serde_json::Value) -> Option<ProviderProduct> {
    let external_id = str_field(v, "id")?;
    let name = str_field(v, "name")?;

    let allow_one_time = v
        .get("allow_one_time_purchase")
        .and_then(|x| x.as_bool())
        .unwrap_or(true);
    let allow_subscription = v
        .get("allow_subscription")
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    // Subscription-only products render subscription terms; anything one-time
    // purchasable is a `single` (the allow flags survive in `raw`).
    let kind = if allow_subscription && !allow_one_time {
        ProductKind::Subscription
    } else {
        ProductKind::Single
    };

    let pricing = v.get("pricing");
    let price_minor = i64_field(v, "price").unwrap_or(0);
    let price_final_minor = pricing
        .and_then(|p| p.get("price_final"))
        .and_then(|x| x.as_i64());

    let category_ids = v
        .get("tags")
        .and_then(|t| t.as_array())
        .map(|tags| tags.iter().filter_map(|t| str_field(t, "id")).collect())
        .unwrap_or_default();

    let available = v
        .get("stock")
        .and_then(|s| s.get("available_to_purchase"))
        .and_then(|x| x.as_bool())
        .unwrap_or(true);

    Some(ProviderProduct {
        external_id,
        slug: str_field(v, "slug"),
        name,
        description: str_field(v, "description"),
        image_url: http_url_field(v, "image_url"),
        price_minor,
        price_final_minor,
        currency: str_field(v, "currency").unwrap_or_else(|| "USD".into()),
        kind,
        interval_value: i64_field(v, "subscription_interval_value").map(|x| x as i32),
        interval_scale: str_field(v, "subscription_interval_scale"),
        category_ids,
        available,
        sort_order: i64_field(v, "sort_order")
            .or_else(|| i64_field(v, "order"))
            .unwrap_or(0) as i32,
        raw: v.clone(),
    })
}

fn map_category(v: &serde_json::Value) -> Option<ProviderCategory> {
    Some(ProviderCategory {
        external_id: str_field(v, "id")?,
        slug: str_field(v, "slug"),
        name: str_field(v, "name")?,
        description: str_field(v, "description"),
        image_url: http_url_field(v, "image_url"),
        sort_order: i64_field(v, "order")
            .or_else(|| i64_field(v, "sort_order"))
            .unwrap_or(0) as i32,
    })
}

impl StoreProvider for PayNowClient {
    /// Validate the key against `GET /stores` and resolve the store: an explicitly
    /// configured id must be among the key's stores; otherwise adopt the single store
    /// the key can reach (multiple stores without an explicit id is an operator error).
    /// Metadata (name/currency/live) is enriched from the storefront `GET /store`.
    async fn probe(&mut self) -> Result<StoreInfo, ProviderError> {
        let stores_raw = self.get("/stores", true, false, PROBE_TIMEOUT).await?;
        let stores = require_array(&stores_raw, "stores")?;

        let matched = match self.store_id.as_deref() {
            Some(want) => stores
                .iter()
                .find(|s| str_field(s, "id").as_deref() == Some(want))
                .ok_or_else(|| {
                    ProviderError::Rejected(format!(
                        "store {want} is not accessible with this API key"
                    ))
                })?,
            None => match stores.len() {
                0 => {
                    return Err(ProviderError::Rejected(
                        "this API key can reach no stores".into(),
                    ))
                }
                1 => &stores[0],
                n => {
                    return Err(ProviderError::Rejected(format!(
                        "this API key can reach {n} stores; specify the store id"
                    )))
                }
            },
        };

        let external_id = str_field(matched, "id")
            .ok_or_else(|| ProviderError::Transient("store object missing id".into()))?;
        self.store_id = Some(external_id.clone());

        let mut info = StoreInfo {
            external_id,
            name: str_field(matched, "name"),
            currency: str_field(matched, "currency"),
            live: matched.get("live_mode").and_then(|x| x.as_bool()),
        };

        // Storefront metadata is the customer-facing truth (name/currency/live_mode);
        // tolerate failure, the management row already identified the store.
        if let Ok(store) = self.get("/store", false, true, PROBE_TIMEOUT).await {
            info.name = str_field(&store, "name").or(info.name);
            info.currency = str_field(&store, "currency").or(info.currency);
            info.live = store
                .get("live_mode")
                .and_then(|x| x.as_bool())
                .or(info.live);
        }
        Ok(info)
    }

    async fn fetch_catalog(&self) -> Result<CatalogSnapshot, ProviderError> {
        let tags = self.get_retried("/store/tags", true).await?;
        let products = self.get_retried("/store/products", true).await?;
        Ok(CatalogSnapshot {
            categories: require_array(&tags, "tags")?
                .iter()
                .filter_map(map_category)
                .collect(),
            products: require_array(&products, "products")?
                .iter()
                .filter_map(map_product)
                .collect(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn array_payload_accepts_bare_and_wrapped_and_rejects_ambiguity() {
        assert_eq!(as_array_payload(&json!([1, 2])).unwrap().len(), 2);
        assert_eq!(as_array_payload(&json!({"data": [1]})).unwrap().len(), 1);
        assert_eq!(
            as_array_payload(&json!({"stores": [1, 2, 3]}))
                .unwrap()
                .len(),
            3
        );
        // Empty lists are valid (a store with no products), but unrecognized shapes
        // must be None: treating them as empty would wipe catalogs via the sweep.
        assert_eq!(as_array_payload(&json!([])).unwrap().len(), 0);
        assert!(as_array_payload(&json!({"a": [1], "b": [2]})).is_none());
        assert!(as_array_payload(&json!({"data": {"items": []}})).is_none());
        assert!(as_array_payload(&json!("nope")).is_none());
        assert!(require_array(&json!({"weird": 1}), "products").is_err());
    }

    #[test]
    fn product_mapping_covers_pricing_kind_and_tags() {
        let p = map_product(&json!({
            "id": "459276186938060800",
            "slug": "vip",
            "name": "VIP",
            "price": 999,
            "currency": "USD",
            "allow_one_time_purchase": false,
            "allow_subscription": true,
            "subscription_interval_value": 1,
            "subscription_interval_scale": "month",
            "pricing": {"price_original": 999, "price_final": 799},
            "tags": [{"id": "459", "slug": "ranks"}],
            "stock": {"available_to_purchase": false}
        }))
        .unwrap();
        assert_eq!(p.external_id, "459276186938060800");
        assert_eq!(p.kind, ProductKind::Subscription);
        assert_eq!(p.price_minor, 999);
        assert_eq!(p.price_final_minor, Some(799));
        assert_eq!(p.category_ids, vec!["459".to_string()]);
        assert!(!p.available);

        // Numeric id tolerated, defaults applied.
        let q = map_product(&json!({"id": 42, "name": "Kit", "price": 500})).unwrap();
        assert_eq!(q.external_id, "42");
        assert_eq!(q.kind, ProductKind::Single);
        assert!(q.available);
    }

    #[test]
    fn product_mapping_drops_unsafe_image_urls() {
        let p = map_product(&json!({
            "id": "1", "name": "Kit", "price": 1,
            "image_url": "javascript:alert(1)"
        }))
        .unwrap();
        assert!(p.image_url.is_none());
        let q = map_product(&json!({
            "id": "1", "name": "Kit", "price": 1,
            "image_url": "https://cdn.paynow.gg/x.png"
        }))
        .unwrap();
        assert!(q.image_url.is_some());
    }

    #[test]
    fn product_mapping_rejects_incomplete_rows() {
        assert!(map_product(&json!({"name": "no id"})).is_none());
        assert!(map_product(&json!({"id": "1"})).is_none());
    }
}
