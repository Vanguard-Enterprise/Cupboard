//! Thin hand-rolled Stripe REST client + webhook signature verification + the plan
//! mirror push (Phase 6 decisions H, I, K). Deliberately NOT a store provider: Stripe is
//! single-merchant platform billing (Cupboard's own revenue), so there is no envelope
//! crypto, no per-tenant connection, and no `StoreProvider` impl; the client mirrors the
//! Tebex adapter's shape (reqwest client + base + secret, send helper, status
//! classification, per-call timeouts) with an injectable API base for the test stub.
//!
//! The secret key is write-only: it rides the Authorization header and is never logged
//! and never appears in any response body Stripe returns, so error snippets are safe.

use crate::providers::ProviderError;
use cupboard_domain::Plan;
use std::time::Duration;
use uuid::Uuid;

pub const DEFAULT_API_BASE: &str = "https://api.stripe.com";

/// Request-path calls (checkout/portal session creation, retrieve).
const MGMT_TIMEOUT: Duration = Duration::from_secs(15);
/// Reconcile listing pages.
const LIST_TIMEOUT: Duration = Duration::from_secs(30);
/// Max clock skew accepted on the `t` element of a Stripe-Signature (replay window).
const WEBHOOK_MAX_SKEW: chrono::Duration = chrono::Duration::minutes(5);
/// Stripe's max page size; fewer round trips on the reconcile walk.
const LIST_PAGE_LIMIT: &str = "100";

#[derive(Clone)]
pub struct StripeClient {
    http: reqwest::Client,
    base: String,
    secret_key: String,
}

/// One page of a `GET /v1/subscriptions` walk.
pub struct SubscriptionPage {
    pub data: Vec<serde_json::Value>,
    pub has_more: bool,
}

impl StripeClient {
    pub fn new(
        http: reqwest::Client,
        base: impl Into<String>,
        secret_key: impl Into<String>,
    ) -> Self {
        Self {
            http,
            base: base.into().trim_end_matches('/').to_string(),
            secret_key: secret_key.into(),
        }
    }

    /// Build a client from config, or `None` when billing is not configured.
    pub fn from_config(http: &reqwest::Client, config: &crate::config::Config) -> Option<Self> {
        config
            .stripe_secret_key
            .as_ref()
            .map(|key| Self::new(http.clone(), &config.stripe_api_base, key))
    }

    /// Classify a Stripe HTTP status. Every call here is credentialed, so 401/403 means
    /// a bad/rotated key (`Auth`); 429 and 5xx are retryable (`Transient`); other 4xx are
    /// per-request rejections.
    fn classify_status(status: reqwest::StatusCode) -> Option<ProviderError> {
        if status.is_success() {
            return None;
        }
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Some(ProviderError::Auth(format!("stripe returned {status}")));
        }
        if status.as_u16() == 429 || status.is_server_error() {
            return Some(ProviderError::Transient(format!(
                "stripe returned {status}"
            )));
        }
        Some(ProviderError::Rejected(format!("stripe returned {status}")))
    }

    /// Send with bearer auth and parse the JSON body. On a rejected 4xx a short body
    /// snippet is kept for diagnosability (Stripe error bodies describe the request and
    /// never echo the secret key).
    async fn send(&self, req: reqwest::RequestBuilder) -> Result<serde_json::Value, ProviderError> {
        let resp = req
            .bearer_auth(&self.secret_key)
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(|e| ProviderError::Transient(format!("request failed: {e}")))?;
        let status = resp.status();
        if let Some(err) = Self::classify_status(status) {
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
        serde_json::from_str(&text)
            .map_err(|e| ProviderError::Transient(format!("invalid JSON: {e}")))
    }

    /// POST a form-encoded body (Stripe's request encoding) and parse the response.
    async fn post_form(
        &self,
        path: &str,
        pairs: &[(&str, &str)],
    ) -> Result<serde_json::Value, ProviderError> {
        self.send(
            self.http
                .post(format!("{}{}", self.base, path))
                .timeout(MGMT_TIMEOUT)
                .form(pairs),
        )
        .await
    }

    /// Create a Checkout Session (subscription mode, slice 1). `customer` reuses the
    /// org's existing Stripe customer; absent, Checkout creates one. `client_reference_id`
    /// AND `subscription_data.metadata.org_id` both carry the org id so the webhook (the
    /// former) and the reconcile walk (the latter) can each attribute the subscription
    /// without depending on the other having run.
    #[allow(clippy::too_many_arguments)]
    pub async fn create_subscription_checkout(
        &self,
        price_id: &str,
        org_id: Uuid,
        success_url: &str,
        cancel_url: &str,
        customer: Option<&str>,
    ) -> Result<serde_json::Value, ProviderError> {
        let org = org_id.to_string();
        let mut pairs: Vec<(&str, &str)> = vec![
            ("mode", "subscription"),
            ("line_items[0][price]", price_id),
            ("line_items[0][quantity]", "1"),
            ("success_url", success_url),
            ("cancel_url", cancel_url),
            ("client_reference_id", &org),
            ("subscription_data[metadata][org_id]", &org),
        ];
        if let Some(c) = customer {
            pairs.push(("customer", c));
        }
        self.post_form("/v1/checkout/sessions", &pairs).await
    }

    /// Expire an in-flight Checkout Session. Sessions live 24h; the checkout handler
    /// expires the org's previous pending session before minting a new one so two
    /// concurrent/abandoned sessions can never BOTH complete (a double charge).
    pub async fn expire_checkout_session(
        &self,
        session_id: &str,
    ) -> Result<serde_json::Value, ProviderError> {
        self.post_form(&format!("/v1/checkout/sessions/{session_id}/expire"), &[])
            .await
    }

    /// Create a Billing Portal session for an existing customer (manage/cancel/payment
    /// method, decision J).
    pub async fn create_portal_session(
        &self,
        customer: &str,
        return_url: &str,
    ) -> Result<serde_json::Value, ProviderError> {
        self.post_form(
            "/v1/billing_portal/sessions",
            &[("customer", customer), ("return_url", return_url)],
        )
        .await
    }

    /// One page of ALL subscriptions (`status=all`: Stripe's default listing excludes
    /// canceled subscriptions, which would make the reconcile walk unable to converge a
    /// lost `customer.subscription.deleted`, decision H).
    pub async fn list_subscriptions(
        &self,
        starting_after: Option<&str>,
    ) -> Result<SubscriptionPage, ProviderError> {
        let mut query: Vec<(&str, &str)> = vec![("status", "all"), ("limit", LIST_PAGE_LIMIT)];
        if let Some(cursor) = starting_after {
            query.push(("starting_after", cursor));
        }
        let body = self
            .send(
                self.http
                    .get(format!("{}/v1/subscriptions", self.base))
                    .timeout(LIST_TIMEOUT)
                    .query(&query),
            )
            .await?;
        let data = body
            .get("data")
            .and_then(|d| d.as_array())
            .cloned()
            .ok_or_else(|| {
                ProviderError::Transient("subscription list has no data array".into())
            })?;
        let has_more = body
            .get("has_more")
            .and_then(|h| h.as_bool())
            .unwrap_or(false);
        Ok(SubscriptionPage { data, has_more })
    }

    /// Retrieve one subscription by id (the `checkout.session.completed` handler needs
    /// the full object; the session only carries the id).
    pub async fn retrieve_subscription(
        &self,
        id: &str,
    ) -> Result<serde_json::Value, ProviderError> {
        self.send(
            self.http
                .get(format!("{}/v1/subscriptions/{id}", self.base))
                .timeout(MGMT_TIMEOUT),
        )
        .await
    }
}

// ============================ Webhook signature ============================

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum WebhookError {
    #[error("bad signature")]
    BadSignature,
    #[error("stale timestamp")]
    StaleTimestamp,
    #[error("malformed webhook: {0}")]
    Malformed(&'static str),
}

/// Verify a `Stripe-Signature` header over the raw body. The header is
/// `t=<unix>,v1=<hex>[,v1=<hex>...]`; the signed payload is `"{t}.{raw_body}"`,
/// HMAC-SHA256 with the endpoint's signing secret, hex-encoded. `t` must be within the
/// skew window (replay protection); any one matching `v1` accepts (Stripe sends several
/// during secret rolls). Pure/sync (unit-testable), the paynow precedent.
pub fn verify_signature(
    secret: &str,
    header: &str,
    raw_body: &[u8],
    now: chrono::DateTime<chrono::Utc>,
) -> Result<(), WebhookError> {
    let mut t: Option<&str> = None;
    let mut v1s: Vec<&str> = Vec::new();
    for part in header.split(',') {
        match part.trim().split_once('=') {
            Some(("t", val)) => t = Some(val),
            Some(("v1", val)) => v1s.push(val),
            _ => {} // ignore v0 and unknown elements, per Stripe's spec
        }
    }
    let t = t.ok_or(WebhookError::Malformed("no t element"))?;
    if v1s.is_empty() {
        return Err(WebhookError::Malformed("no v1 element"));
    }
    let ts: i64 = t
        .parse()
        .map_err(|_| WebhookError::Malformed("bad timestamp"))?;
    let sent = chrono::DateTime::from_timestamp(ts, 0)
        .ok_or(WebhookError::Malformed("timestamp out of range"))?;
    if (now - sent).abs() > WEBHOOK_MAX_SKEW {
        return Err(WebhookError::StaleTimestamp);
    }

    let mut signed = Vec::with_capacity(t.len() + 1 + raw_body.len());
    signed.extend_from_slice(t.as_bytes());
    signed.push(b'.');
    signed.extend_from_slice(raw_body);
    let expected = hmac_sha256_hex(secret.as_bytes(), &signed);
    // Check EVERY candidate (no early exit) so timing does not reveal which v1 matched.
    let mut ok = false;
    for candidate in v1s {
        if cupboard_crypto::constant_time_eq(
            expected.as_bytes(),
            candidate.trim().to_ascii_lowercase().as_bytes(),
        ) {
            ok = true;
        }
    }
    if ok {
        Ok(())
    } else {
        Err(WebhookError::BadSignature)
    }
}

pub(crate) fn hmac_sha256_hex(key: &[u8], data: &[u8]) -> String {
    use hmac::{Hmac, Mac};
    let mut mac = Hmac::<sha2::Sha256>::new_from_slice(key).expect("hmac accepts any key length");
    mac.update(data);
    hex::encode(mac.finalize().into_bytes())
}

// ============================ Subscription parsing ============================

/// The facts the billing tables need out of a Stripe subscription object, parsed
/// defensively (expandable fields arrive as ids or objects; `current_period_end` moved
/// from the subscription to its items in 2025 API versions, so both spots are read).
#[derive(Debug)]
pub struct SubscriptionFacts {
    pub id: String,
    pub customer: Option<String>,
    pub status: String,
    pub price_id: Option<String>,
    pub current_period_end: Option<chrono::DateTime<chrono::Utc>>,
    /// `metadata.org_id`, stamped at checkout creation; the reconcile walk's attribution.
    pub org_hint: Option<Uuid>,
    /// Creation epoch, the tie-breaker when several subscriptions map to one org
    /// (cancel-then-resubscribe): the newest wins within a status rank.
    pub created: Option<i64>,
}

pub fn subscription_facts(v: &serde_json::Value) -> Option<SubscriptionFacts> {
    let id = str_or_id(v.get("id")?)?;
    let status = v.get("status").and_then(|s| s.as_str())?.to_string();
    let customer = v.get("customer").and_then(str_or_id);
    let first_item = v
        .get("items")
        .and_then(|i| i.get("data"))
        .and_then(|d| d.as_array())
        .and_then(|a| a.first());
    let price_id = first_item
        .and_then(|item| item.get("price"))
        .and_then(str_or_id)
        // Legacy shape: the item (or subscription) carries `plan` instead of `price`.
        .or_else(|| {
            first_item
                .and_then(|item| item.get("plan"))
                .and_then(str_or_id)
        })
        .or_else(|| v.get("plan").and_then(str_or_id));
    let current_period_end = epoch_field(v, "current_period_end")
        .or_else(|| first_item.and_then(|item| epoch_field(item, "current_period_end")));
    let org_hint = v
        .get("metadata")
        .and_then(|m| m.get("org_id"))
        .and_then(|o| o.as_str())
        .and_then(|s| s.parse::<Uuid>().ok());
    Some(SubscriptionFacts {
        id,
        customer,
        status,
        price_id,
        current_period_end,
        org_hint,
        created: v.get("created").and_then(|c| c.as_i64()),
    })
}

/// An expandable reference: either the bare id string or an object with an `id`.
fn str_or_id(v: &serde_json::Value) -> Option<String> {
    if let Some(s) = v.as_str() {
        return Some(s.to_string());
    }
    v.get("id").and_then(|i| i.as_str()).map(str::to_string)
}

fn epoch_field(v: &serde_json::Value, key: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    v.get(key)
        .and_then(|x| x.as_i64())
        .and_then(|secs| chrono::DateTime::from_timestamp(secs, 0))
}

/// Map a Stripe price id to a plan via config (decision I: `STRIPE_PRICE_TEAM` /
/// `STRIPE_PRICE_ENTERPRISE`). `None` for an unknown price id: the caller logs it and
/// gates as free (the safe floor, never an escalation).
pub fn plan_for_price(config: &crate::config::Config, price_id: &str) -> Option<Plan> {
    if config.stripe_price_team.as_deref() == Some(price_id) {
        return Some(Plan::Team);
    }
    if config.stripe_price_enterprise.as_deref() == Some(price_id) {
        return Some(Plan::Enterprise);
    }
    None
}

// ============================ Plan mirror push ============================

/// Push the RESOLVED gating plan to auth (decision K): `PUT /internal/orgs/{id}/plan`,
/// guarded by the distinct `PLAN_WRITE_TOKEN` (never the shared `INTERNAL_API_TOKEN`;
/// a plan write is a privilege-escalation primitive). Best-effort, retry-nothing: a
/// failure is logged and the 15-minute reconcile re-push heals it. Auth stores and mints
/// the pushed plan verbatim, so grace logic is applied BEFORE calling this.
pub async fn push_plan_mirror(
    http: &reqwest::Client,
    config: &crate::config::Config,
    org_id: Uuid,
    plan: Plan,
    status: &str,
) {
    let Some(token) = config.plan_write_token.as_deref() else {
        tracing::warn!(org = %org_id, "PLAN_WRITE_TOKEN unset; skipping plan mirror push");
        return;
    };
    let url = format!("{}/internal/orgs/{org_id}/plan", config.auth_internal_url);
    let result = http
        .put(&url)
        .timeout(Duration::from_secs(10))
        .header("x-internal-token", token)
        .json(&serde_json::json!({ "plan": plan.as_str(), "status": status }))
        .send()
        .await;
    match result {
        Ok(resp) if resp.status().is_success() => {
            tracing::info!(org = %org_id, plan = %plan, status, "plan mirror pushed");
        }
        Ok(resp) => {
            tracing::warn!(org = %org_id, status_code = %resp.status(), "plan mirror push rejected");
        }
        Err(e) => {
            tracing::warn!(org = %org_id, error = %e, "plan mirror push failed");
        }
    }
}

/// Resolve an org's effective plan from its stored row (grace applied) and push the
/// mirror. The one call every writer (webhook, reconcile) makes after a commit.
pub async fn resolve_and_push_mirror(
    owner_pool: &sqlx::PgPool,
    http: &reqwest::Client,
    config: &crate::config::Config,
    org_id: Uuid,
) {
    match crate::domain::billing::get_subscription_owner(owner_pool, org_id).await {
        Ok(row) => {
            let plan = crate::domain::billing::effective_plan(row.as_ref(), chrono::Utc::now());
            let status = crate::domain::billing::mirror_status(row.as_ref()).to_string();
            push_plan_mirror(http, config, org_id, plan, &status).await;
        }
        Err(e) => {
            tracing::warn!(org = %org_id, error = ?e, "could not load subscription for mirror push");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sig_header(secret: &str, body: &str, at: chrono::DateTime<chrono::Utc>) -> String {
        let t = at.timestamp().to_string();
        let mut signed = t.clone().into_bytes();
        signed.push(b'.');
        signed.extend_from_slice(body.as_bytes());
        format!("t={t},v1={}", hmac_sha256_hex(secret.as_bytes(), &signed))
    }

    #[test]
    fn signature_verifies_and_rejects() {
        let secret = "whsec_test";
        let body = r#"{"id":"evt_1"}"#;
        let now = chrono::Utc::now();
        let header = sig_header(secret, body, now);
        assert_eq!(
            verify_signature(secret, &header, body.as_bytes(), now),
            Ok(())
        );

        // A second v1 (secret roll) still accepts when one matches.
        let rolled = format!("{header},v1=deadbeef");
        assert_eq!(
            verify_signature(secret, &rolled, body.as_bytes(), now),
            Ok(())
        );

        // Tampered body.
        assert_eq!(
            verify_signature(secret, &header, b"{}", now),
            Err(WebhookError::BadSignature)
        );
        // Wrong secret.
        assert_eq!(
            verify_signature("whsec_other", &header, body.as_bytes(), now),
            Err(WebhookError::BadSignature)
        );
        // Stale timestamp (outside the 5-minute window).
        let stale = sig_header(secret, body, now - chrono::Duration::minutes(6));
        assert_eq!(
            verify_signature(secret, &stale, body.as_bytes(), now),
            Err(WebhookError::StaleTimestamp)
        );
        // Malformed headers.
        assert!(matches!(
            verify_signature(secret, "v1=abc", body.as_bytes(), now),
            Err(WebhookError::Malformed(_))
        ));
        assert!(matches!(
            verify_signature(secret, "t=123", body.as_bytes(), now),
            Err(WebhookError::Malformed(_))
        ));
    }

    #[test]
    fn subscription_facts_parse_both_shapes() {
        // Modern shape: period end on the item, price as an object, metadata org.
        let org = Uuid::new_v4();
        let sub = json!({
            "id": "sub_1",
            "customer": "cus_1",
            "status": "active",
            "metadata": {"org_id": org.to_string()},
            "items": {"data": [{
                "price": {"id": "price_team"},
                "current_period_end": 1789000000
            }]}
        });
        let f = subscription_facts(&sub).unwrap();
        assert_eq!(f.id, "sub_1");
        assert_eq!(f.customer.as_deref(), Some("cus_1"));
        assert_eq!(f.status, "active");
        assert_eq!(f.price_id.as_deref(), Some("price_team"));
        assert_eq!(f.org_hint, Some(org));
        assert!(f.current_period_end.is_some());

        // Legacy shape: top-level current_period_end, expanded customer, plan not price.
        let sub = json!({
            "id": "sub_2",
            "customer": {"id": "cus_2"},
            "status": "past_due",
            "current_period_end": 1789000000,
            "items": {"data": [{"plan": {"id": "price_ent"}}]}
        });
        let f = subscription_facts(&sub).unwrap();
        assert_eq!(f.customer.as_deref(), Some("cus_2"));
        assert_eq!(f.price_id.as_deref(), Some("price_ent"));
        assert!(f.current_period_end.is_some());
        assert_eq!(f.org_hint, None);
    }
}
