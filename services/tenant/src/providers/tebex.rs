//! Tebex adapter (Headless + Game-Server/plugin APIs; API facts researched 2026-07-05,
//! recorded in docs/phase5-plan.md and the phase plan appendix). No Tebex sandbox exists,
//! so the exact payload shapes are UNVERIFIED against a live store until PR8; parsing is
//! defensive (tolerates `{data: ...}` wrappers vs bare, numeric-vs-string ids, and
//! decimal-major vs minor prices), exactly like the PayNow adapter.
//!
//! Two credentials, two surfaces:
//!   * Headless (`{headless}/api/accounts/{publicToken}/...`, anonymous): catalog reads
//!     and the buyer checkout basket flow. The public token is the store identifier and is
//!     NOT secret (stored in `store_external_id`).
//!   * Plugin / Game Server (`{plugin}/...`, header `X-Tebex-Secret`): the secret key,
//!     used to validate credentials (`/information`) and to walk `/payments` on reconcile.
//!
//! Checkout is TWO legs (Tebex requires a buyer-auth roundtrip): `begin_checkout` creates
//! a basket and returns the Steam auth URL (`NeedsProviderAuth`); after the buyer
//! authenticates and returns to our continue leg, `continue_checkout` adds the package and
//! returns the hosted-checkout URL.

use super::{
    CatalogSnapshot, CheckoutBegin, CheckoutRequest, CheckoutStep, EntitlementRecord,
    EntitlementStatus, NormalizedWebhook, ProductKind, ProviderCategory, ProviderError,
    ProviderProduct, ReconcilePage, StoreInfo, StoreProvider, WebhookRegistration,
};
use cupboard_bmapi::RateLimiter;
use std::time::Duration;

pub const DEFAULT_HEADLESS_BASE: &str = "https://headless.tebex.io";
pub const DEFAULT_PLUGIN_BASE: &str = "https://plugin.tebex.io";

/// Game Server API budget is 500 req/5min per key; stay well under it (reconcile is one
/// page walk every 15 minutes). Headless is unpublished, so share the same conservative
/// limiter.
const PER_SEC: u32 = 5;
const PER_MIN: u32 = 90;

const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const CATALOG_TIMEOUT: Duration = Duration::from_secs(30);
const MGMT_TIMEOUT: Duration = Duration::from_secs(15);

/// Placeholder buyer IP for basket creation (Tebex requires `ip_address` server-side).
/// PR8 live-verify item: forward the real client IP from the web BFF if Tebex rejects a
/// placeholder; TEST-NET-3 (RFC 5737) documentation range, never a real host.
const PLACEHOLDER_IP: &str = "203.0.113.1";

pub struct TebexClient {
    http: reqwest::Client,
    headless_base: String,
    plugin_base: String,
    /// Game Server secret key (`X-Tebex-Secret`); the real credential.
    secret_key: String,
    /// Public/project token; the store identifier in Headless URLs (not secret).
    public_token: String,
    limiter: RateLimiter,
}

impl TebexClient {
    pub fn new(
        headless_base: impl Into<String>,
        plugin_base: impl Into<String>,
        secret_key: impl Into<String>,
        public_token: impl Into<String>,
    ) -> Self {
        Self {
            http: reqwest::Client::new(),
            headless_base: headless_base.into().trim_end_matches('/').to_string(),
            plugin_base: plugin_base.into().trim_end_matches('/').to_string(),
            secret_key: secret_key.into(),
            public_token: public_token.into(),
            limiter: RateLimiter::new(PER_SEC, PER_MIN),
        }
    }

    fn headless(&self, suffix: &str) -> String {
        format!(
            "{}/api/accounts/{}{}",
            self.headless_base, self.public_token, suffix
        )
    }

    /// Classify an HTTP response status the same way across surfaces. `secret` marks a
    /// credentialed (plugin) call, whose 401/403 means a bad key (`Auth`); an anonymous
    /// Headless 401/403 is a per-request `Rejected` (store-side reasons), never a "bad
    /// key" that would error the whole connection.
    fn classify_status(status: reqwest::StatusCode, secret: bool) -> Option<ProviderError> {
        if status.is_success() {
            return None;
        }
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Some(if secret {
                ProviderError::Auth(format!("tebex returned {status}"))
            } else {
                ProviderError::Rejected(format!("tebex returned {status} on an anonymous call"))
            });
        }
        if status.as_u16() == 429 || status.is_server_error() {
            return Some(ProviderError::Transient(format!("tebex returned {status}")));
        }
        Some(ProviderError::Rejected(format!("tebex returned {status}")))
    }

    async fn send_json(
        &self,
        req: reqwest::RequestBuilder,
        secret: bool,
    ) -> Result<serde_json::Value, ProviderError> {
        self.limiter.acquire().await;
        let mut req = req.header(reqwest::header::ACCEPT, "application/json");
        if secret {
            req = req.header("X-Tebex-Secret", &self.secret_key);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| ProviderError::Transient(format!("request failed: {e}")))?;
        let status = resp.status();
        if let Some(err) = Self::classify_status(status, secret) {
            // Keep a short body snippet for the diagnosable-error column on 4xx.
            if matches!(err, ProviderError::Rejected(_)) {
                let body = resp.text().await.unwrap_or_default();
                let brief: String = body.chars().take(200).collect();
                return Err(ProviderError::Rejected(format!("{status}: {brief}")));
            }
            return Err(err);
        }
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

    async fn get(
        &self,
        url: String,
        secret: bool,
        timeout: Duration,
    ) -> Result<serde_json::Value, ProviderError> {
        self.send_json(self.http.get(url).timeout(timeout), secret)
            .await
    }

    async fn post(
        &self,
        url: String,
        body: serde_json::Value,
        secret: bool,
    ) -> Result<serde_json::Value, ProviderError> {
        self.send_json(
            self.http.post(url).timeout(MGMT_TIMEOUT).json(&body),
            secret,
        )
        .await
    }
}

impl StoreProvider for TebexClient {
    /// Validate the secret key against the plugin `/information` endpoint (its 200 proves
    /// the key), and adopt the store name/currency it reports. The store id stays the
    /// operator-supplied public token.
    async fn probe(&mut self) -> Result<StoreInfo, ProviderError> {
        let info = self
            .get(
                format!("{}/information", self.plugin_base),
                true,
                PROBE_TIMEOUT,
            )
            .await?;
        let account = info.get("account");
        let name = account.and_then(|a| str_field(a, "name"));
        let currency = account
            .and_then(|a| a.get("currency"))
            .and_then(|c| str_field(c, "iso_4217"))
            .or_else(|| account.and_then(|a| str_field(a, "currency")));
        Ok(StoreInfo {
            external_id: self.public_token.clone(),
            name,
            currency,
            // Tebex has no test/live flag on the account; leave informational-none.
            live: None,
        })
    }

    async fn fetch_catalog(&self) -> Result<CatalogSnapshot, ProviderError> {
        let body = self
            .get(
                self.headless("/categories?includePackages=1"),
                false,
                CATALOG_TIMEOUT,
            )
            .await?;
        let cats = require_array(&body, "categories")?;
        let mut categories = Vec::new();
        let mut products = Vec::new();
        for c in &cats {
            let Some(cat) = map_category(c) else { continue };
            // Headless nests each category's packages; flatten them with a back-reference.
            if let Some(pkgs) = c.get("packages").and_then(|p| p.as_array()) {
                for p in pkgs {
                    if let Some(prod) = map_package(p, &cat.external_id) {
                        products.push(prod);
                    }
                }
            }
            categories.push(cat);
        }
        Ok(CatalogSnapshot {
            products,
            categories,
        })
    }

    async fn register_webhook(
        &self,
        _endpoint_url: &str,
    ) -> Result<Option<WebhookRegistration>, ProviderError> {
        // Tebex has no programmatic webhook registration: the operator adds our URL in the
        // creator panel and pastes back the secret (the wizard's manual branch). The
        // reconcile poll is the authoritative backstop meanwhile.
        Ok(None)
    }

    async fn begin_checkout(&self, req: &CheckoutRequest) -> Result<CheckoutBegin, ProviderError> {
        // Leg 1: create the basket (ip_address is required server-side).
        let basket = self
            .post(
                self.headless("/baskets"),
                serde_json::json!({
                    "complete_url": req.return_url,
                    "cancel_url": req.cancel_url,
                    "complete_auto_redirect": true,
                    "ip_address": PLACEHOLDER_IP,
                }),
                false,
            )
            .await?;
        let ident = unwrap_data(&basket)
            .and_then(|d| str_field(d, "ident"))
            .ok_or_else(|| ProviderError::Transient("basket create returned no ident".into()))?;

        // Leg 1b: fetch the buyer-auth links and pick the Steam provider (or the first).
        let auth = self
            .get(
                self.headless(&format!(
                    "/baskets/{}/auth?returnUrl={}",
                    urlencoding_light(&ident),
                    urlencoding_light(&req.continue_url)
                )),
                false,
                MGMT_TIMEOUT,
            )
            .await?;
        let links = as_array(&auth)
            .ok_or_else(|| ProviderError::Transient("auth returned an unexpected shape".into()))?;
        let auth_url = links
            .iter()
            .find(|l| {
                str_field(l, "name")
                    .map(|n| n.to_ascii_lowercase().contains("steam"))
                    .unwrap_or(false)
            })
            .or_else(|| links.first())
            .and_then(|l| http_url_field(l, "url"))
            .ok_or_else(|| ProviderError::Rejected("no buyer-auth URL offered".into()))?;

        Ok(CheckoutBegin {
            redirect_url: auth_url,
            provider_ref: Some(ident),
            step: CheckoutStep::NeedsProviderAuth,
        })
    }

    async fn continue_checkout(
        &self,
        provider_ref: &str,
        req: &CheckoutRequest,
    ) -> Result<CheckoutBegin, ProviderError> {
        // Leg 2: add the package to the (now buyer-authed) basket, then read its checkout
        // link. `package_id` is numeric in Tebex; send a number when it parses, else the
        // string (defensive against id-shape drift).
        let package_id = req
            .product_external_id
            .parse::<i64>()
            .map(serde_json::Value::from)
            .unwrap_or_else(|_| serde_json::Value::from(req.product_external_id.clone()));
        self.post(
            self.headless(&format!(
                "/baskets/{}/packages",
                urlencoding_light(provider_ref)
            )),
            serde_json::json!({ "package_id": package_id, "quantity": req.quantity }),
            false,
        )
        .await?;

        let basket = self
            .get(
                self.headless(&format!("/baskets/{}", urlencoding_light(provider_ref))),
                false,
                MGMT_TIMEOUT,
            )
            .await?;
        let checkout = unwrap_data(&basket)
            .and_then(|d| d.get("links"))
            .and_then(|l| http_url_field(l, "checkout"))
            .ok_or_else(|| ProviderError::Transient("basket has no checkout link".into()))?;
        Ok(CheckoutBegin {
            redirect_url: checkout,
            provider_ref: Some(provider_ref.to_string()),
            step: CheckoutStep::Final,
        })
    }

    async fn reconcile(&self, cursor: Option<&str>) -> Result<ReconcilePage, ProviderError> {
        let page: u32 = cursor.and_then(|c| c.parse().ok()).unwrap_or(1);
        let body = self
            .get(
                format!("{}/payments?paged={page}", self.plugin_base),
                true,
                MGMT_TIMEOUT,
            )
            .await?;
        let (items, more) = payments_page(&body, page);
        let entitlements = items.iter().flat_map(map_payment).collect();
        Ok(ReconcilePage {
            entitlements,
            next_cursor: more.then(|| (page + 1).to_string()),
        })
    }
}

// ============================ JSON helpers (defensive) ============================

fn str_field(v: &serde_json::Value, key: &str) -> Option<String> {
    match v.get(key) {
        Some(serde_json::Value::String(s)) if !s.is_empty() => Some(s.clone()),
        Some(serde_json::Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

/// Provider-supplied URLs that public pages render into `src`: http(s) only (stored-XSS
/// posture, same as the site-config + PayNow adapters).
fn http_url_field(v: &serde_json::Value, key: &str) -> Option<String> {
    str_field(v, key).filter(|s| {
        let lower = s.trim().to_ascii_lowercase();
        lower.starts_with("https://") || lower.starts_with("http://")
    })
}

/// Unwrap a `{data: X}` envelope (Tebex wraps most objects) or fall back to the value
/// itself when it is already the object.
fn unwrap_data(v: &serde_json::Value) -> Option<&serde_json::Value> {
    match v.get("data") {
        Some(d) => Some(d),
        None if v.is_object() => Some(v),
        None => None,
    }
}

/// A bare array or a `{data: [...]}` array.
fn as_array(v: &serde_json::Value) -> Option<Vec<serde_json::Value>> {
    if let Some(a) = v.as_array() {
        return Some(a.clone());
    }
    v.get("data").and_then(|d| d.as_array()).cloned()
}

fn require_array(
    v: &serde_json::Value,
    what: &str,
) -> Result<Vec<serde_json::Value>, ProviderError> {
    as_array(v).ok_or_else(|| {
        let brief: String = v.to_string().chars().take(120).collect();
        ProviderError::Rejected(format!(
            "unrecognized {what} payload shape (update the Tebex adapter): {brief}"
        ))
    })
}

/// Tebex Headless prices are decimal MAJOR units (e.g. `5.00` or `"5.00"`); the ledger
/// stores integer minor units.
fn price_minor(v: &serde_json::Value, key: &str) -> Option<i64> {
    match v.get(key) {
        Some(serde_json::Value::Number(n)) => n.as_f64().map(|f| (f * 100.0).round() as i64),
        Some(serde_json::Value::String(s)) => {
            s.parse::<f64>().ok().map(|f| (f * 100.0).round() as i64)
        }
        _ => None,
    }
}

fn map_category(v: &serde_json::Value) -> Option<ProviderCategory> {
    Some(ProviderCategory {
        external_id: str_field(v, "id")?,
        slug: str_field(v, "slug"),
        name: str_field(v, "name")?,
        description: str_field(v, "description"),
        image_url: http_url_field(v, "image_url").or_else(|| http_url_field(v, "image")),
        sort_order: v
            .get("order")
            .or_else(|| v.get("sort_order"))
            .and_then(|x| x.as_i64())
            .unwrap_or(0) as i32,
    })
}

fn map_package(v: &serde_json::Value, category_id: &str) -> Option<ProviderProduct> {
    let external_id = str_field(v, "id")?;
    let name = str_field(v, "name")?;
    let kind = match v.get("type").and_then(|t| t.as_str()) {
        Some("subscription") => ProductKind::Subscription,
        _ => ProductKind::Single,
    };
    let base = price_minor(v, "base_price").unwrap_or(0);
    let total = price_minor(v, "total_price");
    let currency = str_field(v, "currency").unwrap_or_else(|| "USD".into());
    // Tebex packages have exactly one category; keep any provider-supplied one too.
    let mut category_ids = vec![category_id.to_string()];
    if let Some(cid) = v.get("category").and_then(|c| str_field(c, "id")) {
        if cid != category_id {
            category_ids.push(cid);
        }
    }
    Some(ProviderProduct {
        external_id,
        slug: str_field(v, "slug"),
        name,
        description: str_field(v, "description"),
        image_url: http_url_field(v, "image"),
        price_minor: base,
        price_final_minor: total,
        currency,
        kind,
        interval_value: v
            .get("expiration_length")
            .and_then(|x| x.as_i64())
            .map(|x| x as i32),
        interval_scale: str_field(v, "expiration_period"),
        category_ids,
        available: v
            .get("disabled")
            .and_then(|d| d.as_bool())
            .map(|d| !d)
            .unwrap_or(true),
        sort_order: v.get("order").and_then(|x| x.as_i64()).unwrap_or(0) as i32,
        raw: v.clone(),
    })
}

/// Extract the payments list and whether more pages remain. Prefer the provider's
/// `last_page`/`current_page` when present; otherwise a bare array is treated as complete
/// (never guess "more" from a full page, which risks an unbounded walk).
fn payments_page(v: &serde_json::Value, page: u32) -> (Vec<serde_json::Value>, bool) {
    let items = as_array(v).unwrap_or_default();
    let last_page = v.get("last_page").and_then(|x| x.as_u64());
    let current_page = v
        .get("current_page")
        .and_then(|x| x.as_u64())
        .unwrap_or(page as u64);
    let more = last_page.map(|last| current_page < last).unwrap_or(false);
    (items, more)
}

/// One Tebex payment -> one entitlement per package (keyed `{txn}:{package_id}` so a
/// multi-package payment yields distinct rows). Reconcile carries no expiry timestamps;
/// webhooks fill `expires_at`.
fn map_payment(v: &serde_json::Value) -> Vec<EntitlementRecord> {
    let txn = str_field(v, "txn_id")
        .or_else(|| str_field(v, "id"))
        .unwrap_or_default();
    if txn.is_empty() {
        return Vec::new();
    }
    let status = map_status(v.get("status").and_then(|s| s.as_str()).unwrap_or(""));
    let steam_id = v
        .get("player")
        .and_then(|p| str_field(p, "uuid").or_else(|| str_field(p, "id")));
    let granted_at = parse_ts_field(v, "date").or_else(|| parse_ts_field(v, "time"));
    let packages = v.get("packages").and_then(|p| p.as_array());
    match packages {
        Some(pkgs) if !pkgs.is_empty() => pkgs
            .iter()
            .filter_map(|pkg| {
                let pid = str_field(pkg, "id")?;
                Some(EntitlementRecord {
                    external_ref: format!("{txn}:{pid}"),
                    steam_id: steam_id.clone(),
                    product_external_id: Some(pid),
                    product_name: str_field(pkg, "name"),
                    kind: ProductKind::Single,
                    status,
                    granted_at,
                    expires_at: None,
                })
            })
            .collect(),
        // A payment with no itemized packages still records the transaction outcome.
        _ => vec![EntitlementRecord {
            external_ref: txn,
            steam_id,
            product_external_id: None,
            product_name: None,
            kind: ProductKind::Single,
            status,
            granted_at,
            expires_at: None,
        }],
    }
}

fn map_status(s: &str) -> EntitlementStatus {
    match s.to_ascii_lowercase().as_str() {
        "complete" | "completed" => EntitlementStatus::Active,
        "refund" | "refunded" => EntitlementStatus::Refunded,
        "chargeback" => EntitlementStatus::Chargeback,
        other => {
            // Money is involved: an unrecognized status must never keep granting access.
            tracing::warn!(
                status = other,
                "unknown tebex payment status; treating as expired"
            );
            EntitlementStatus::Expired
        }
    }
}

fn parse_ts_field(v: &serde_json::Value, key: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    let raw = v.get(key)?;
    if let Some(s) = raw.as_str() {
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
            return Some(dt.with_timezone(&chrono::Utc));
        }
        // Tebex plugin timestamps are often "YYYY-MM-DD HH:MM:SS" (UTC, no tz).
        if let Ok(ndt) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S") {
            return Some(ndt.and_utc());
        }
    }
    // Or a unix epoch integer (seconds, or millis for large values ~past year 2286).
    raw.as_i64().and_then(|v| {
        if v > 10_000_000_000 {
            chrono::DateTime::from_timestamp_millis(v)
        } else {
            chrono::DateTime::from_timestamp(v, 0)
        }
    })
}

// ============================ Webhook verify + parse ============================

/// Verify a Tebex webhook and parse it into a normalized event. Pure/sync (unit-testable).
/// `X-Signature` is hex `HMAC-SHA256(secret, sha256_hex(raw_body))`. The `validation.webhook`
/// type carries no entitlements; the receiver must echo its id back to Tebex.
pub fn verify_and_parse_webhook(
    secret: &str,
    signature_hex: &str,
    raw_body: &[u8],
) -> Result<NormalizedWebhook, WebhookError> {
    let expected = hmac_sha256_hex(secret.as_bytes(), sha256_hex(raw_body).as_bytes());
    if !cupboard_crypto::constant_time_eq(
        expected.as_bytes(),
        signature_hex.trim().to_ascii_lowercase().as_bytes(),
    ) {
        return Err(WebhookError::BadSignature);
    }
    let doc: serde_json::Value =
        serde_json::from_slice(raw_body).map_err(|_| WebhookError::Malformed("bad JSON"))?;
    let event_id = str_field(&doc, "id").ok_or(WebhookError::Malformed("no id"))?;
    let event_type = str_field(&doc, "type").unwrap_or_default();
    let entitlements = if event_type == "validation.webhook" {
        Vec::new()
    } else {
        parse_webhook_entitlements(&doc, &event_type)
    };
    Ok(NormalizedWebhook {
        event_id,
        event_type,
        entitlements,
    })
}

/// True for the endpoint-validation handshake, whose id the receiver must echo.
pub fn is_validation(event_type: &str) -> bool {
    event_type == "validation.webhook"
}

fn parse_webhook_entitlements(doc: &serde_json::Value, event_type: &str) -> Vec<EntitlementRecord> {
    let status = match event_type {
        t if t.starts_with("payment.completed") || t.starts_with("recurring-payment") => {
            EntitlementStatus::Active
        }
        "payment.refunded" => EntitlementStatus::Refunded,
        t if t.contains("chargeback") || t.contains("dispute") => EntitlementStatus::Chargeback,
        "payment.declined" => EntitlementStatus::Expired,
        _ => return Vec::new(),
    };
    let subject = doc.get("subject").unwrap_or(doc);
    let txn = str_field(subject, "transaction_id")
        .or_else(|| str_field(subject, "txn_id"))
        .or_else(|| str_field(subject, "id"))
        .unwrap_or_default();
    if txn.is_empty() {
        return Vec::new();
    }
    let steam_id = subject
        .get("player")
        .and_then(|p| str_field(p, "uuid").or_else(|| str_field(p, "id")))
        .or_else(|| str_field(subject, "steam_id"));
    let granted_at = parse_ts_field(subject, "date").or_else(|| parse_ts_field(subject, "time"));
    let products = subject.get("products").and_then(|p| p.as_array());
    match products {
        Some(items) if !items.is_empty() => items
            .iter()
            .filter_map(|p| {
                let pid = str_field(p, "id")?;
                Some(EntitlementRecord {
                    external_ref: format!("{txn}:{pid}"),
                    steam_id: steam_id.clone(),
                    product_external_id: Some(pid),
                    product_name: str_field(p, "name"),
                    kind: ProductKind::Single,
                    status,
                    granted_at,
                    expires_at: parse_ts_field(p, "expires_at"),
                })
            })
            .collect(),
        _ => vec![EntitlementRecord {
            external_ref: txn,
            steam_id,
            product_external_id: None,
            product_name: None,
            kind: ProductKind::Single,
            status,
            granted_at,
            expires_at: None,
        }],
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum WebhookError {
    #[error("bad signature")]
    BadSignature,
    #[error("malformed webhook: {0}")]
    Malformed(&'static str),
}

fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(data);
    hex::encode(h.finalize())
}

fn hmac_sha256_hex(key: &[u8], data: &[u8]) -> String {
    use hmac::{Hmac, Mac};
    let mut mac = Hmac::<sha2::Sha256>::new_from_slice(key).expect("hmac accepts any key length");
    mac.update(data);
    hex::encode(mac.finalize().into_bytes())
}

/// Minimal percent-encoding for path/query values (basket idents, return URLs).
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
    fn package_maps_price_to_minor_and_kind() {
        let p = map_package(
            &json!({
                "id": 12345, "name": "VIP", "type": "subscription",
                "base_price": 9.99, "total_price": 7.99, "currency": "USD",
                "image": "https://cdn.tebex.io/vip.png", "order": 2,
                "expiration_length": 1, "expiration_period": "month"
            }),
            "cat-1",
        )
        .unwrap();
        assert_eq!(p.external_id, "12345");
        assert_eq!(p.kind, ProductKind::Subscription);
        assert_eq!(p.price_minor, 999);
        assert_eq!(p.price_final_minor, Some(799));
        assert_eq!(p.currency, "USD");
        assert_eq!(p.category_ids, vec!["cat-1".to_string()]);
        assert!(p.available);

        // String price + disabled flag + unsafe image.
        let q = map_package(
            &json!({"id": "7", "name": "Kit", "base_price": "5.00", "disabled": true,
                    "image": "javascript:alert(1)"}),
            "cat-2",
        )
        .unwrap();
        assert_eq!(q.price_minor, 500);
        assert_eq!(q.kind, ProductKind::Single);
        assert!(!q.available);
        assert!(q.image_url.is_none());
    }

    #[test]
    fn payment_maps_per_package_with_status() {
        let recs = map_payment(&json!({
            "txn_id": "tbx-1",
            "status": "Complete",
            "player": {"uuid": "76561198000000000", "name": "p"},
            "date": "2026-07-05 12:00:00",
            "packages": [{"id": 10, "name": "VIP"}, {"id": 11, "name": "Kit"}]
        }));
        assert_eq!(recs.len(), 2);
        assert_eq!(recs[0].external_ref, "tbx-1:10");
        assert_eq!(recs[0].steam_id.as_deref(), Some("76561198000000000"));
        assert_eq!(recs[0].status, EntitlementStatus::Active);
        assert!(recs[0].granted_at.is_some());

        let refunded = map_payment(&json!({"id": "t2", "status": "Refund"}));
        assert_eq!(refunded.len(), 1);
        assert_eq!(refunded[0].status, EntitlementStatus::Refunded);
        assert_eq!(refunded[0].external_ref, "t2");
    }

    #[test]
    fn webhook_verify_and_validation_handshake() {
        let secret = "wh_secret";
        let body = json!({
            "id": "wh-1", "type": "payment.completed",
            "subject": {
                "transaction_id": "tbx-9",
                "player": {"uuid": "76561198000000000"},
                "products": [{"id": 5, "name": "VIP", "expires_at": "2026-08-01T00:00:00Z"}]
            }
        })
        .to_string();
        let sig = hmac_sha256_hex(secret.as_bytes(), sha256_hex(body.as_bytes()).as_bytes());
        let parsed = verify_and_parse_webhook(secret, &sig, body.as_bytes()).unwrap();
        assert_eq!(parsed.event_id, "wh-1");
        assert_eq!(parsed.entitlements.len(), 1);
        assert_eq!(parsed.entitlements[0].external_ref, "tbx-9:5");
        assert_eq!(parsed.entitlements[0].status, EntitlementStatus::Active);
        assert!(parsed.entitlements[0].expires_at.is_some());

        // Uppercase hex signature is accepted (case-insensitive compare).
        let parsed_upper =
            verify_and_parse_webhook(secret, &sig.to_ascii_uppercase(), body.as_bytes()).unwrap();
        assert_eq!(parsed_upper.event_id, "wh-1");

        // Validation handshake: verified, no entitlements, flagged for echo.
        let vbody = json!({"id": "val-1", "type": "validation.webhook"}).to_string();
        let vsig = hmac_sha256_hex(secret.as_bytes(), sha256_hex(vbody.as_bytes()).as_bytes());
        let v = verify_and_parse_webhook(secret, &vsig, vbody.as_bytes()).unwrap();
        assert!(is_validation(&v.event_type));
        assert!(v.entitlements.is_empty());

        // Bad signature rejected.
        assert!(matches!(
            verify_and_parse_webhook(secret, "deadbeef", body.as_bytes()),
            Err(WebhookError::BadSignature)
        ));
    }
}
