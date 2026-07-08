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
    CatalogSnapshot, CheckoutBegin, CheckoutRequest, CheckoutStep, EntitlementRecord,
    EntitlementStatus, NormalizedWebhook, ProductKind, ProviderCategory, ProviderError,
    ProviderProduct, ReconcilePage, StoreInfo, StoreProvider, WebhookRegistration,
};
use base64::Engine as _;
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
/// Checkout/customer/webhook/reconcile management calls.
const MGMT_TIMEOUT: Duration = Duration::from_secs(15);
/// Max clock skew accepted on a PayNow webhook timestamp.
const WEBHOOK_MAX_SKEW: chrono::Duration = chrono::Duration::minutes(5);
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

    /// Store-scoped management path helper: `/stores/{storeId}{suffix}`.
    fn store_path(&self, suffix: &str) -> Result<String, ProviderError> {
        Ok(format!("/stores/{}{}", self.store_id()?, suffix))
    }

    /// Management GET (apikey auth, no store header — the store is in the path).
    async fn management_get(&self, path: &str) -> Result<serde_json::Value, ProviderError> {
        self.get(path, true, false, MGMT_TIMEOUT).await
    }

    /// Management POST (apikey auth). Returns the parsed JSON body.
    async fn management_post(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value, ProviderError> {
        self.limiter.acquire().await;
        let resp = self
            .http
            .post(format!("{}{}", self.base, path))
            .timeout(MGMT_TIMEOUT)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(
                reqwest::header::AUTHORIZATION,
                format!("apikey {}", self.api_key),
            )
            .json(body)
            .send()
            .await
            .map_err(|e| ProviderError::Transient(format!("request failed: {e}")))?;
        let status = resp.status();
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err(ProviderError::Auth(format!("paynow returned {status}")));
        }
        if status.as_u16() == 429 || status.is_server_error() {
            return Err(ProviderError::Transient(format!(
                "paynow returned {status}"
            )));
        }
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            let brief: String = body.chars().take(200).collect();
            return Err(ProviderError::Rejected(format!("{status}: {brief}")));
        }
        // Some POSTs (e.g. a 204) may have an empty body; tolerate it.
        let text = resp
            .text()
            .await
            .map_err(|e| ProviderError::Transient(format!("read body: {e}")))?;
        if text.trim().is_empty() {
            return Ok(serde_json::Value::Null);
        }
        serde_json::from_str(&text)
            .map_err(|e| ProviderError::Transient(format!("invalid JSON: {e}")))
    }

    /// Resolve (or create) the PayNow customer id for a Steam id.
    async fn upsert_customer(&self, steam_id: &str) -> Result<String, ProviderError> {
        let lookup = self.store_path(&format!(
            "/customers/lookup?steam_id={}",
            urlencoding_light(steam_id)
        ))?;
        if let Ok(found) = self.management_get(&lookup).await {
            if let Some(id) = str_field(&found, "id") {
                return Ok(id);
            }
        }
        // Not found (or lookup 404'd): create.
        let created = self
            .management_post(
                &self.store_path("/customers")?,
                &serde_json::json!({ "steam_id": steam_id }),
            )
            .await?;
        str_field(&created, "id")
            .ok_or_else(|| ProviderError::Transient("customer create returned no id".into()))
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

    async fn register_webhook(
        &self,
        endpoint_url: &str,
    ) -> Result<Option<WebhookRegistration>, ProviderError> {
        // One webhook for the entitlement-grant event; the 15-minute reconcile poll is the
        // authoritative backstop for renewals/revokes/refunds, so we do not depend on
        // registering every event (PayNow registers one event per webhook, each with its
        // own secret). See docs/phase5-plan.md decision E.
        let created = self
            .management_post(
                &self.store_path("/webhooks")?,
                &serde_json::json!({
                    "url": endpoint_url,
                    "subscribed_to": "OnDeliveryItemAdded",
                    "type": "json_v1",
                }),
            )
            .await?;
        match (str_field(&created, "id"), str_field(&created, "secret")) {
            (Some(external_id), Some(signing_secret)) => Ok(Some(WebhookRegistration {
                external_id,
                signing_secret,
            })),
            _ => Err(ProviderError::Transient(
                "webhook registration returned no id/secret".into(),
            )),
        }
    }

    async fn begin_checkout(&self, req: &CheckoutRequest) -> Result<CheckoutBegin, ProviderError> {
        let customer_id = self.upsert_customer(&req.steam_id).await?;
        let created = self
            .management_post(
                &self.store_path("/checkouts")?,
                &serde_json::json!({
                    "customer_id": customer_id,
                    "lines": [{
                        "product_id": req.product_external_id,
                        "quantity": req.quantity,
                    }],
                    "return_url": req.return_url,
                    "cancel_url": req.cancel_url,
                    "auto_redirect": true,
                }),
            )
            .await?;
        let url = str_field(&created, "url")
            .ok_or_else(|| ProviderError::Transient("checkout create returned no url".into()))?;
        Ok(CheckoutBegin {
            redirect_url: url,
            provider_ref: str_field(&created, "id"),
            step: CheckoutStep::Final,
        })
    }

    async fn continue_checkout(
        &self,
        _provider_ref: &str,
        _req: &CheckoutRequest,
    ) -> Result<CheckoutBegin, ProviderError> {
        // PayNow checkout is single-step (begin_checkout returns Final), so this is never
        // reached on the happy path; fail loudly if some caller invokes it anyway.
        Err(ProviderError::Rejected(
            "PayNow checkout completes in one step".into(),
        ))
    }

    async fn reconcile(&self, cursor: Option<&str>) -> Result<ReconcilePage, ProviderError> {
        let mut path = self.store_path("/delivery/items?limit=100")?;
        if let Some(c) = cursor {
            path.push_str(&format!("&after={}", urlencoding_light(c)));
        }
        let body = self.management_get(&path).await?;
        let items = require_array(&body, "delivery items")?;
        // The cursor for the next page, if PayNow signals more.
        let next_cursor = body
            .get("cursor")
            .or_else(|| body.get("next"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        Ok(ReconcilePage {
            entitlements: items.iter().filter_map(map_delivery_item).collect(),
            next_cursor,
        })
    }
}

/// Parse a PayNow "delivery item" object into a normalized entitlement record.
fn map_delivery_item(v: &serde_json::Value) -> Option<EntitlementRecord> {
    let external_ref = str_field(v, "id")?;
    let product = v.get("product");
    let product_external_id = product.and_then(|p| str_field(p, "id"));
    let product_name = product.and_then(|p| str_field(p, "name"));
    // Customer's Steam id may be nested under customer.steam_id / steam.id.
    let steam_id = v
        .get("customer")
        .and_then(|c| {
            str_field(c, "steam_id").or_else(|| c.get("steam").and_then(|s| str_field(s, "id")))
        })
        .or_else(|| str_field(v, "steam_id"));
    let status = match v.get("state").and_then(|s| s.as_str()).unwrap_or("active") {
        "usable" | "active" | "used" | "renewed" => EntitlementStatus::Active,
        "revoked" => EntitlementStatus::Revoked,
        "expired" => EntitlementStatus::Expired,
        "refunded" => EntitlementStatus::Refunded,
        "chargeback" => EntitlementStatus::Chargeback,
        other => {
            // Unknown states are treated conservatively as expired, NOT active: money is
            // involved, so a state we do not recognize must never keep granting access.
            tracing::warn!(
                state = other,
                "unknown delivery-item state; treating as expired (no access)"
            );
            EntitlementStatus::Expired
        }
    };
    let kind = if v
        .get("subscription_id")
        .map(|x| !x.is_null())
        .unwrap_or(false)
    {
        ProductKind::Subscription
    } else {
        ProductKind::Single
    };
    Some(EntitlementRecord {
        external_ref,
        steam_id,
        product_external_id,
        product_name,
        kind,
        status,
        granted_at: parse_ts(v, "active_at").or_else(|| parse_ts(v, "added_at")),
        expires_at: parse_ts(v, "expires_at"),
    })
}

fn parse_ts(v: &serde_json::Value, key: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    v.get(key)
        .and_then(|x| x.as_str())
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&chrono::Utc))
}

/// Verify a PayNow webhook signature and parse it into a normalized event. Pure/sync so
/// it is unit-testable without a server. `PayNow-Signature` is base64 HMAC-SHA256 over
/// `"{timestamp}.{raw_body}"` with the store's signing secret; `PayNow-Timestamp` is unix
/// millis and must be within the skew window (replay protection).
pub fn verify_and_parse_webhook(
    secret: &str,
    signature_b64: &str,
    timestamp_ms: &str,
    raw_body: &[u8],
    now: chrono::DateTime<chrono::Utc>,
) -> Result<NormalizedWebhook, WebhookError> {
    // Timestamp freshness.
    let ts: i64 = timestamp_ms
        .trim()
        .parse()
        .map_err(|_| WebhookError::Malformed("bad timestamp"))?;
    let sent = chrono::DateTime::from_timestamp_millis(ts)
        .ok_or(WebhookError::Malformed("timestamp out of range"))?;
    if (now - sent).abs() > WEBHOOK_MAX_SKEW {
        return Err(WebhookError::StaleTimestamp);
    }

    // Signature.
    let mut signed = Vec::with_capacity(timestamp_ms.len() + 1 + raw_body.len());
    signed.extend_from_slice(timestamp_ms.trim().as_bytes());
    signed.push(b'.');
    signed.extend_from_slice(raw_body);
    let expected = hmac_sha256_b64(secret.as_bytes(), &signed);
    let presented = signature_b64.trim();
    if !constant_time_str_eq(&expected, presented) {
        return Err(WebhookError::BadSignature);
    }

    // Parse envelope {event_type, event_id, body}.
    let doc: serde_json::Value =
        serde_json::from_slice(raw_body).map_err(|_| WebhookError::Malformed("bad JSON"))?;
    let event_id = str_field(&doc, "event_id").ok_or(WebhookError::Malformed("no event_id"))?;
    let event_type = str_field(&doc, "event_type").unwrap_or_default();
    // Delivery-item events carry the item as `body`; other events (orders/subs) are
    // recorded for dedupe but leave entitlement convergence to the reconcile poll.
    let entitlements = doc
        .get("body")
        .and_then(map_delivery_item)
        .into_iter()
        .collect();
    Ok(NormalizedWebhook {
        event_id,
        event_type,
        entitlements,
    })
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum WebhookError {
    #[error("bad signature")]
    BadSignature,
    #[error("stale timestamp")]
    StaleTimestamp,
    #[error("malformed webhook: {0}")]
    Malformed(&'static str),
}

fn hmac_sha256_b64(key: &[u8], data: &[u8]) -> String {
    use hmac::{Hmac, Mac};
    let mut mac = Hmac::<sha2::Sha256>::new_from_slice(key).expect("hmac accepts any key length");
    mac.update(data);
    base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes())
}

/// Constant-time string comparison (length-independent short-circuit only on mismatch of
/// the byte content, not length; both are attacker-influenced but not secret-length).
fn constant_time_str_eq(a: &str, b: &str) -> bool {
    cupboard_crypto::constant_time_eq(a.as_bytes(), b.as_bytes())
}

/// Minimal percent-encoding for query values already known to be simple (steam ids,
/// cursors); escapes anything unexpected defensively.
fn urlencoding_light(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '~') {
                c.to_string()
            } else {
                format!("%{:02X}", c as u32)
            }
        })
        .collect()
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

    fn signed_webhook(secret: &str, ts: &str, body: &str) -> String {
        let mut signed = ts.as_bytes().to_vec();
        signed.push(b'.');
        signed.extend_from_slice(body.as_bytes());
        hmac_sha256_b64(secret.as_bytes(), &signed)
    }

    #[test]
    fn webhook_verify_accepts_valid_and_extracts_entitlement() {
        let secret = "whsec_test";
        let now = chrono::Utc::now();
        let ts = now.timestamp_millis().to_string();
        let body = json!({
            "event_type": "ON_DELIVERY_ITEM_ADDED",
            "event_id": "459276186938060800",
            "body": {
                "id": "di_1",
                "state": "active",
                "product": {"id": "p_1", "name": "VIP"},
                "customer": {"steam_id": "76561198000000000"},
                "active_at": "2026-07-05T00:00:00Z"
            }
        })
        .to_string();
        let sig = signed_webhook(secret, &ts, &body);
        let parsed = verify_and_parse_webhook(secret, &sig, &ts, body.as_bytes(), now).unwrap();
        assert_eq!(parsed.event_id, "459276186938060800");
        assert_eq!(parsed.entitlements.len(), 1);
        let e = &parsed.entitlements[0];
        assert_eq!(e.external_ref, "di_1");
        assert_eq!(e.steam_id.as_deref(), Some("76561198000000000"));
        assert_eq!(e.status, EntitlementStatus::Active);
    }

    #[test]
    fn webhook_verify_rejects_bad_signature_and_stale_ts() {
        let secret = "whsec_test";
        let now = chrono::Utc::now();
        let ts = now.timestamp_millis().to_string();
        let body = json!({"event_id": "1", "event_type": "X", "body": {}}).to_string();
        // Wrong signature.
        assert!(matches!(
            verify_and_parse_webhook(secret, "not-a-sig", &ts, body.as_bytes(), now),
            Err(WebhookError::BadSignature)
        ));
        // Correct signature but a timestamp 10 minutes old.
        let stale = (now - chrono::Duration::minutes(10))
            .timestamp_millis()
            .to_string();
        let sig = signed_webhook(secret, &stale, &body);
        assert!(matches!(
            verify_and_parse_webhook(secret, &sig, &stale, body.as_bytes(), now),
            Err(WebhookError::StaleTimestamp)
        ));
    }

    #[test]
    fn delivery_item_states_map_to_statuses() {
        let mk = |state: &str| {
            map_delivery_item(&json!({"id": "x", "state": state}))
                .unwrap()
                .status
        };
        assert_eq!(mk("active"), EntitlementStatus::Active);
        assert_eq!(mk("renewed"), EntitlementStatus::Active);
        assert_eq!(mk("revoked"), EntitlementStatus::Revoked);
        assert_eq!(mk("expired"), EntitlementStatus::Expired);
    }
}
