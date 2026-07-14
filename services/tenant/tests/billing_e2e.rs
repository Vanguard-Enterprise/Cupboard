//! End-to-end for Phase 6 PR2 slice 1 (Stripe subscriptions): the operator billing
//! surface, the signed/deduped webhook receiver, the plan mirror push to auth, the
//! reconcile walk + absent-sweep, and the per-plan custom-domain cap. Drives the real
//! router against an in-process Stripe stub (injectable `stripe_api_base`) and an
//! in-process auth stub capturing `PUT /internal/orgs/{id}/plan`.
//!
//! Requires TEST_DATABASE_URL(_APP); skips (passes) when unset.

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, Request, StatusCode};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use cupboard_auth_core::{Claims, Keys};
use cupboard_domain::{OrgId, UserId};
use cupboard_tenant::cache::SiteCache;
use cupboard_tenant::config::Config;
use cupboard_tenant::http;
use cupboard_tenant::state::AppState;
use cupboard_tenant::stripe::StripeClient;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use tokio::sync::OnceCell;
use tower::util::ServiceExt;
use uuid::Uuid;

// Test-only Ed25519 keypair (same throwaway pair as crates/auth-core's unit tests).
const OP_PRIV: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIKfwTrhSm/f0QxY6e5mzQ+iTAvdyp3omCt4lyOjWItDm\n-----END PRIVATE KEY-----\n";
const OP_PUB: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAyKMiwFH0hHn4HiPl8DTEq+aPzW9XyzG5v1ELTEVNsbY=\n-----END PUBLIC KEY-----\n";

const STRIPE_SECRET: &str = "sk_test_pr2_slice1";
const WEBHOOK_SECRET: &str = "whsec_pr2_slice1";
const PLAN_WRITE_TOKEN: &str = "pwt_pr2_distinct";
const PRICE_TEAM: &str = "price_team_test";
const PRICE_ENTERPRISE: &str = "price_ent_test";
const PRICE_CUSTOM: &str = "price_custom_test";

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
static MIGRATED: OnceCell<()> = OnceCell::const_new();
/// Serializes the tests that read or write `org_subscriptions`: the reconcile
/// absent-sweep is GLOBAL by design (single merchant), so a concurrently-seeded active
/// row in another test would be swept mid-assertion.
static SUBS_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn setup() -> Option<(PgPool, PgPool)> {
    let owner_url = std::env::var("TEST_DATABASE_URL").ok()?;
    let app_url = std::env::var("TEST_DATABASE_URL_APP").unwrap_or_else(|_| owner_url.clone());
    let owner = cupboard_db::connect_scoped(&owner_url, 5, "tenant,public")
        .await
        .expect("owner");
    let app = cupboard_db::connect_scoped(&app_url, 5, "tenant,public")
        .await
        .expect("app");
    MIGRATED
        .get_or_init(|| async {
            sqlx::query("CREATE SCHEMA IF NOT EXISTS tenant")
                .execute(&owner)
                .await
                .expect("schema");
            MIGRATOR.run(&owner).await.expect("migrate");
        })
        .await;
    Some((owner, app))
}

// ============================ In-process Stripe stub ============================

#[derive(Default)]
struct StripeStubState {
    /// Recorded form bodies of `POST /v1/checkout/sessions`.
    checkout_forms: Vec<HashMap<String, String>>,
    /// Recorded form bodies of `POST /v1/billing_portal/sessions`.
    portal_forms: Vec<HashMap<String, String>>,
    /// Session ids expired via `POST /v1/checkout/sessions/{id}/expire`.
    expired_sessions: Vec<String>,
    /// FIFO of canned expire responses; exhausted => 200 expired-ok.
    expire_responses: VecDeque<(u16, Value)>,
    /// Monotonic counter minting unique checkout-session ids.
    next_session: u64,
    /// `GET /v1/subscriptions/{id}` fixtures.
    subscriptions: HashMap<String, Value>,
    /// `GET /v1/prices/{id}` fixtures. Missing ids default to a price matching the
    /// custom_design catalog entry so tests not about the sanity check just proceed.
    prices: HashMap<String, Value>,
    /// FIFO of canned `GET /v1/subscriptions` responses; exhausted => 500 (so a test
    /// controls exactly how far a reconcile walk gets).
    list_responses: VecDeque<(u16, Value)>,
    /// FIFO of canned `GET /v1/checkout/sessions` LIST responses (the purchases
    /// backstop); exhausted => 500.
    session_list_responses: VecDeque<(u16, Value)>,
}

struct StripeStub {
    base_url: String,
    state: Arc<Mutex<StripeStubState>>,
    handle: tokio::task::JoinHandle<()>,
}

impl Drop for StripeStub {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

impl StripeStub {
    async fn spawn() -> Self {
        let state = Arc::new(Mutex::new(StripeStubState::default()));
        let router = Router::new()
            .route(
                "/v1/checkout/sessions",
                post(
                    |State(s): State<Arc<Mutex<StripeStubState>>>,
                     axum::extract::Form(form): axum::extract::Form<HashMap<String, String>>| async move {
                        let mut st = s.lock().unwrap();
                        st.checkout_forms.push(form);
                        st.next_session += 1;
                        let id = format!("cs_test_{}", st.next_session);
                        Json(json!({
                            "id": id,
                            "url": format!("https://checkout.stripe.com/c/pay/{id}")
                        }))
                    },
                )
                .get(|State(s): State<Arc<Mutex<StripeStubState>>>| async move {
                    let popped = s.lock().unwrap().session_list_responses.pop_front();
                    match popped {
                        Some((code, body)) => (StatusCode::from_u16(code).unwrap(), Json(body)),
                        None => (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            Json(json!({"error": {"message": "stub: no canned session list"}})),
                        ),
                    }
                }),
            )
            .route(
                "/v1/checkout/sessions/{id}/expire",
                post(
                    |State(s): State<Arc<Mutex<StripeStubState>>>,
                     Path(id): Path<String>| async move {
                        let mut st = s.lock().unwrap();
                        st.expired_sessions.push(id.clone());
                        match st.expire_responses.pop_front() {
                            Some((code, body)) => (StatusCode::from_u16(code).unwrap(), Json(body)),
                            None => (StatusCode::OK, Json(json!({"id": id, "status": "expired"}))),
                        }
                    },
                ),
            )
            .route(
                "/v1/billing_portal/sessions",
                post(
                    |State(s): State<Arc<Mutex<StripeStubState>>>,
                     axum::extract::Form(form): axum::extract::Form<HashMap<String, String>>| async move {
                        s.lock().unwrap().portal_forms.push(form);
                        Json(json!({
                            "id": "bps_test_1",
                            "url": "https://billing.stripe.com/p/session/bps_test_1"
                        }))
                    },
                ),
            )
            .route(
                "/v1/subscriptions",
                get(|State(s): State<Arc<Mutex<StripeStubState>>>| async move {
                    let popped = s.lock().unwrap().list_responses.pop_front();
                    match popped {
                        Some((code, body)) => (
                            StatusCode::from_u16(code).unwrap(),
                            Json(body),
                        ),
                        None => (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            Json(json!({"error": {"message": "stub: no canned list response"}})),
                        ),
                    }
                }),
            )
            .route(
                "/v1/subscriptions/{id}",
                get(
                    |State(s): State<Arc<Mutex<StripeStubState>>>, Path(id): Path<String>| async move {
                        let sub = s.lock().unwrap().subscriptions.get(&id).cloned();
                        match sub {
                            Some(v) => (StatusCode::OK, Json(v)),
                            None => (
                                StatusCode::NOT_FOUND,
                                Json(json!({"error": {"message": "no such subscription"}})),
                            ),
                        }
                    },
                ),
            )
            .route(
                "/v1/prices/{id}",
                get(
                    |State(s): State<Arc<Mutex<StripeStubState>>>, Path(id): Path<String>| async move {
                        let price = s.lock().unwrap().prices.get(&id).cloned();
                        Json(price.unwrap_or_else(|| {
                            json!({"id": id, "unit_amount": 25000, "currency": "usd",
                                   "type": "one_time"})
                        }))
                    },
                ),
            )
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        StripeStub {
            base_url,
            state,
            handle,
        }
    }

    fn set_subscription(&self, id: &str, sub: Value) {
        self.state
            .lock()
            .unwrap()
            .subscriptions
            .insert(id.to_string(), sub);
    }

    fn set_price(&self, id: &str, price: Value) {
        self.state
            .lock()
            .unwrap()
            .prices
            .insert(id.to_string(), price);
    }

    fn push_list_response(&self, code: u16, body: Value) {
        self.state
            .lock()
            .unwrap()
            .list_responses
            .push_back((code, body));
    }

    fn push_session_list_response(&self, code: u16, body: Value) {
        self.state
            .lock()
            .unwrap()
            .session_list_responses
            .push_back((code, body));
    }

    fn checkout_forms(&self) -> Vec<HashMap<String, String>> {
        self.state.lock().unwrap().checkout_forms.clone()
    }

    fn expired_sessions(&self) -> Vec<String> {
        self.state.lock().unwrap().expired_sessions.clone()
    }

    fn push_expire_response(&self, code: u16, body: Value) {
        self.state
            .lock()
            .unwrap()
            .expire_responses
            .push_back((code, body));
    }
}

/// Clear every subscription row (under `SUBS_LOCK`) so the reconcile tests' sweep
/// fraction guard sees deterministic counts, not leftovers from earlier tests/runs.
async fn clear_subscriptions(owner: &PgPool) {
    sqlx::query("DELETE FROM org_subscriptions")
        .execute(owner)
        .await
        .unwrap();
}

// ============================ In-process auth (mirror) stub ============================

#[derive(Clone, Debug)]
struct MirrorPush {
    org: String,
    token: Option<String>,
    body: Value,
}

struct AuthStub {
    base_url: String,
    pushes: Arc<Mutex<Vec<MirrorPush>>>,
    handle: tokio::task::JoinHandle<()>,
}

impl Drop for AuthStub {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

impl AuthStub {
    async fn spawn() -> Self {
        let pushes: Arc<Mutex<Vec<MirrorPush>>> = Arc::new(Mutex::new(Vec::new()));
        let router = Router::new()
            .route(
                "/internal/orgs/{org}/plan",
                put(
                    |State(p): State<Arc<Mutex<Vec<MirrorPush>>>>,
                     Path(org): Path<String>,
                     headers: axum::http::HeaderMap,
                     Json(body): Json<Value>| async move {
                        p.lock().unwrap().push(MirrorPush {
                            org,
                            token: headers
                                .get("x-internal-token")
                                .and_then(|h| h.to_str().ok())
                                .map(str::to_string),
                            body,
                        });
                        StatusCode::NO_CONTENT
                    },
                ),
            )
            .with_state(pushes.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        AuthStub {
            base_url,
            pushes,
            handle,
        }
    }

    fn pushes(&self) -> Vec<MirrorPush> {
        self.pushes.lock().unwrap().clone()
    }

    fn pushes_for(&self, org: Uuid) -> Vec<MirrorPush> {
        self.pushes()
            .into_iter()
            .filter(|p| p.org == org.to_string())
            .collect()
    }
}

// ============================ Harness ============================

fn state(owner: PgPool, app: PgPool, stripe_base: &str, auth_base: &str) -> AppState {
    let config = Config {
        bind_addr: "127.0.0.1:0".into(),
        database_url: String::new(),
        database_url_app: String::new(),
        db_max_connections: 5,
        environment: "test".into(),
        otel_endpoint: None,
        jwt_public_key_pem: OP_PUB.into(),
        redis_url: None,
        sites_suffix: "sites.test".into(),
        tenant_master_key: None,
        consumer_name: "pr2s1".into(),
        paynow_api_base: "http://paynow.test".into(),
        tebex_headless_base: "http://tebex.test".into(),
        tebex_plugin_base: "http://tebex.test".into(),
        internal_api_token: None,
        player_jwt_public_key_pem: None,
        public_webhook_base: None,
        edge_hostname: None,
        cert_namespace: "cupboard-web".into(),
        cert_issuer: "letsencrypt-http01".into(),
        web_service_name: "cupboard-web".into(),
        web_service_port: 3000,
        ingress_class: "traefik-external".into(),
        stripe_secret_key: Some(STRIPE_SECRET.into()),
        stripe_webhook_secret: Some(WEBHOOK_SECRET.into()),
        stripe_price_team: Some(PRICE_TEAM.into()),
        stripe_price_enterprise: Some(PRICE_ENTERPRISE.into()),
        stripe_price_custom_design: Some(PRICE_CUSTOM.into()),
        stripe_api_base: stripe_base.to_string(),
        auth_internal_url: auth_base.to_string(),
        plan_write_token: Some(PLAN_WRITE_TOKEN.into()),
    };
    AppState {
        owner_pool: owner,
        app_pool: app,
        keys: Arc::new(Keys::verifier_from_ed_pem(OP_PUB).unwrap()),
        player_keys: None,
        cache: SiteCache::disabled(),
        site_miss_budget: Arc::new(Default::default()),
        catalog_miss_budget: Arc::new(Default::default()),
        http: reqwest::Client::new(),
        verified_prices: Arc::new(Default::default()),
        config: Arc::new(config),
    }
}

fn bearer(tenant: Uuid, plan: Option<&str>) -> String {
    let signer = Keys::from_ed_pem(OP_PRIV, OP_PUB).unwrap();
    let mut claims = Claims::new(
        UserId(Uuid::new_v4()),
        Uuid::new_v4(),
        Some(OrgId(tenant)),
        vec!["billing.manage".into(), "sites.edit".into()],
        300,
    );
    claims.plan = plan.map(str::to_string);
    format!("Bearer {}", signer.encode(&claims).unwrap())
}

async fn send(
    st: &AppState,
    method: &str,
    path: &str,
    auth: Option<&str>,
    headers: &[(&str, &str)],
    body: Option<String>,
) -> (StatusCode, Value) {
    let mut req = Request::builder().method(method).uri(path);
    if let Some(a) = auth {
        req = req.header(header::AUTHORIZATION, a);
    }
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let req = match body {
        Some(b) => req
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(b))
            .unwrap(),
        None => req.body(Body::empty()).unwrap(),
    };
    let resp = http::router(st.clone()).oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let val = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, val)
}

/// A valid `Stripe-Signature` header for `body`, minted `skew_secs` in the past.
fn stripe_sig(body: &str, skew_secs: i64) -> String {
    use hmac::{Hmac, Mac};
    let t = (chrono::Utc::now().timestamp() - skew_secs).to_string();
    let mut mac = Hmac::<sha2::Sha256>::new_from_slice(WEBHOOK_SECRET.as_bytes()).unwrap();
    mac.update(format!("{t}.{body}").as_bytes());
    format!("t={t},v1={}", hex::encode(mac.finalize().into_bytes()))
}

async fn deliver_webhook(st: &AppState, body: &str, sig: &str) -> StatusCode {
    let (status, _) = send(
        st,
        "POST",
        "/webhooks/stripe",
        None,
        &[("stripe-signature", sig)],
        Some(body.to_string()),
    )
    .await;
    status
}

fn evt_id() -> String {
    format!("evt_{}", Uuid::new_v4().simple())
}

fn sub_object(id: &str, org: Uuid, status: &str, price: &str, period_end: i64) -> Value {
    json!({
        "id": id,
        "object": "subscription",
        "customer": format!("cus_for_{id}"),
        "status": status,
        "metadata": {"org_id": org.to_string()},
        "items": {"data": [{"price": {"id": price}, "current_period_end": period_end}]}
    })
}

async fn sub_row(owner: &PgPool, tenant: Uuid) -> Option<(String, String)> {
    sqlx::query_as("SELECT plan, status FROM org_subscriptions WHERE tenant_id = $1")
        .bind(tenant)
        .fetch_optional(owner)
        .await
        .unwrap()
}

// ============================ Tests ============================

#[tokio::test]
async fn webhook_rejects_bad_signature_stale_timestamp_and_dedupes_replays() {
    let _subs_guard = SUBS_LOCK.lock().await;
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP webhook_rejects...: TEST_DATABASE_URL unset");
        return;
    };
    let stripe = StripeStub::spawn().await;
    let auth = AuthStub::spawn().await;
    let st = state(owner.clone(), app, &stripe.base_url, &auth.base_url);

    let event = evt_id();
    let body = json!({"id": event, "type": "customer.created", "data": {"object": {}}}).to_string();

    // Bad v1 => 400, nothing recorded.
    let bad = format!("t={},v1=deadbeef", chrono::Utc::now().timestamp());
    assert_eq!(
        deliver_webhook(&st, &body, &bad).await,
        StatusCode::BAD_REQUEST
    );
    // Stale t (validly signed, 6 minutes old) => 400.
    let stale = stripe_sig(&body, 6 * 60);
    assert_eq!(
        deliver_webhook(&st, &body, &stale).await,
        StatusCode::BAD_REQUEST
    );
    let rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM billing_webhook_events WHERE event_id = $1")
            .bind(&event)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(rows, 0, "rejected webhooks must not be recorded");

    // Valid (unhandled type) => 200 and dedupe-recorded; a replay stays 200 and single.
    let sig = stripe_sig(&body, 0);
    assert_eq!(deliver_webhook(&st, &body, &sig).await, StatusCode::OK);
    assert_eq!(deliver_webhook(&st, &body, &sig).await, StatusCode::OK);
    let rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM billing_webhook_events WHERE event_id = $1")
            .bind(&event)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(rows, 1, "a replayed event.id must be a single no-op row");
}

#[tokio::test]
async fn checkout_flow_upserts_subscription_and_pushes_mirror() {
    let _subs_guard = SUBS_LOCK.lock().await;
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP checkout_flow...: TEST_DATABASE_URL unset");
        return;
    };
    let stripe = StripeStub::spawn().await;
    let auth = AuthStub::spawn().await;
    let st = state(owner.clone(), app, &stripe.base_url, &auth.base_url);
    let tenant = Uuid::new_v4();
    let token = bearer(tenant, None);

    // No subscription yet: the read reports the free tier.
    let (status, body) = send(&st, "GET", "/billing/subscription", Some(&token), &[], None).await;
    assert_eq!(status, StatusCode::OK, "read failed: {body}");
    assert_eq!(body["plan"], "free");
    assert_eq!(body["status"], "none");
    assert_eq!(body["effective_plan"], "free");

    // Portal without a customer is a 409 conflict envelope.
    let (status, body) = send(
        &st,
        "POST",
        "/billing/portal",
        Some(&token),
        &[],
        Some(json!({"return_url": "https://app.test/billing"}).to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"], "conflict");

    // Checkout handoff: session created at the stub with the right form fields.
    let (status, body) = send(
        &st,
        "POST",
        "/billing/checkout",
        Some(&token),
        &[],
        Some(json!({"plan": "team", "return_url": "https://app.test/billing"}).to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "checkout failed: {body}");
    assert!(body["redirect_url"]
        .as_str()
        .unwrap()
        .contains("checkout.stripe.com"));
    let forms = stripe.checkout_forms();
    assert_eq!(forms.len(), 1);
    let form = &forms[0];
    assert_eq!(form.get("mode").map(String::as_str), Some("subscription"));
    assert_eq!(
        form.get("line_items[0][price]").map(String::as_str),
        Some(PRICE_TEAM)
    );
    assert_eq!(form.get("client_reference_id"), Some(&tenant.to_string()));
    assert_eq!(
        form.get("success_url").map(String::as_str),
        Some("https://app.test/billing?flag=checkout_success")
    );
    assert_eq!(
        form.get("cancel_url").map(String::as_str),
        Some("https://app.test/billing?flag=checkout_cancel")
    );

    // An invalid plan is rejected up front.
    let (status, _) = send(
        &st,
        "POST",
        "/billing/checkout",
        Some(&token),
        &[],
        Some(json!({"plan": "free", "return_url": "https://app.test/billing"}).to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Double-charge guard: a second checkout while the first session is still pending
    // (24h lifetime) EXPIRES the first session at Stripe before minting a new one, so
    // both can never complete.
    let (status, _) = send(
        &st,
        "POST",
        "/billing/checkout",
        Some(&token),
        &[],
        Some(json!({"plan": "team", "return_url": "https://app.test/billing"}).to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        stripe.expired_sessions(),
        vec!["cs_test_1".to_string()],
        "the previous pending session must be expired first"
    );
    let pending: Option<String> = sqlx::query_scalar(
        "SELECT stripe_checkout_session_id FROM billing_pending_checkouts WHERE tenant_id = $1",
    )
    .bind(tenant)
    .fetch_optional(&owner)
    .await
    .unwrap();
    assert_eq!(pending.as_deref(), Some("cs_test_2"));

    // Stripe completes: checkout.session.completed -> retrieve -> upsert + mirror push.
    let sub_id = format!("sub_{}", Uuid::new_v4().simple());
    let period_end = chrono::Utc::now().timestamp() + 30 * 24 * 3600;
    stripe.set_subscription(
        &sub_id,
        sub_object(&sub_id, tenant, "active", PRICE_TEAM, period_end),
    );
    let event = json!({
        "id": evt_id(),
        "type": "checkout.session.completed",
        "data": {"object": {
            "id": "cs_test_2",
            "mode": "subscription",
            "client_reference_id": tenant.to_string(),
            "customer": format!("cus_for_{sub_id}"),
            "subscription": sub_id
        }}
    })
    .to_string();
    let sig = stripe_sig(&event, 0);
    assert_eq!(deliver_webhook(&st, &event, &sig).await, StatusCode::OK);

    assert_eq!(
        sub_row(&owner, tenant).await,
        Some(("team".into(), "active".into()))
    );
    // Completion clears the pending-session record.
    let pending: Option<String> = sqlx::query_scalar(
        "SELECT stripe_checkout_session_id FROM billing_pending_checkouts WHERE tenant_id = $1",
    )
    .bind(tenant)
    .fetch_optional(&owner)
    .await
    .unwrap();
    assert_eq!(pending, None, "completion must clear the pending session");
    let pushes = auth.pushes_for(tenant);
    assert_eq!(pushes.len(), 1, "one mirror push after the commit");
    assert_eq!(pushes[0].token.as_deref(), Some(PLAN_WRITE_TOKEN));
    assert_eq!(pushes[0].body, json!({"plan": "team", "status": "active"}));

    // The read now reports the paid plan, effective included.
    let (status, body) = send(&st, "GET", "/billing/subscription", Some(&token), &[], None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["plan"], "team");
    assert_eq!(body["status"], "active");
    assert_eq!(body["effective_plan"], "team");
    assert!(body["current_period_end"].is_string());

    // A second checkout while subscribed is a conflict (Portal is for changes).
    let (status, _) = send(
        &st,
        "POST",
        "/billing/checkout",
        Some(&token),
        &[],
        Some(json!({"plan": "enterprise", "return_url": "https://app.test/billing"}).to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    // Portal now works off the stored customer id.
    let (status, body) = send(
        &st,
        "POST",
        "/billing/portal",
        Some(&token),
        &[],
        Some(json!({"return_url": "https://app.test/billing"}).to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["redirect_url"]
        .as_str()
        .unwrap()
        .contains("billing.stripe.com"));

    // billing.manage is enforced: a token without it is 403.
    let signer = Keys::from_ed_pem(OP_PRIV, OP_PUB).unwrap();
    let weak = Claims::new(
        UserId(Uuid::new_v4()),
        Uuid::new_v4(),
        Some(OrgId(tenant)),
        vec!["sites.edit".into()],
        300,
    );
    let weak = format!("Bearer {}", signer.encode(&weak).unwrap());
    let (status, _) = send(&st, "GET", "/billing/subscription", Some(&weak), &[], None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Audit rows exist for both handoffs and the applied change.
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE tenant_id = $1 \
         AND action IN ('billing.checkout_created', 'billing.subscription_updated')",
    )
    .bind(tenant)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(audits, 3, "two checkout handoffs + one applied change");
}

#[tokio::test]
async fn subscription_deleted_downgrades_to_free_and_pushes_free() {
    let _subs_guard = SUBS_LOCK.lock().await;
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP subscription_deleted...: TEST_DATABASE_URL unset");
        return;
    };
    let stripe = StripeStub::spawn().await;
    let auth = AuthStub::spawn().await;
    let st = state(owner.clone(), app, &stripe.base_url, &auth.base_url);
    let tenant = Uuid::new_v4();
    let sub_id = format!("sub_{}", Uuid::new_v4().simple());

    // Seed an active paid subscription (as the checkout webhook would have).
    sqlx::query(
        "INSERT INTO org_subscriptions \
             (tenant_id, stripe_customer_id, stripe_subscription_id, plan, status) \
         VALUES ($1, 'cus_del', $2, 'team', 'active')",
    )
    .bind(tenant)
    .bind(&sub_id)
    .execute(&owner)
    .await
    .unwrap();

    // customer.subscription.deleted (no metadata: resolution falls back to the local
    // row keyed by the subscription id).
    let deleted = json!({
        "id": evt_id(),
        "type": "customer.subscription.deleted",
        "data": {"object": {
            "id": sub_id,
            "object": "subscription",
            "customer": "cus_del",
            "status": "canceled",
            "items": {"data": [{"price": {"id": PRICE_TEAM}}]}
        }}
    })
    .to_string();
    let sig = stripe_sig(&deleted, 0);
    assert_eq!(deliver_webhook(&st, &deleted, &sig).await, StatusCode::OK);

    assert_eq!(
        sub_row(&owner, tenant).await,
        Some(("team".into(), "canceled".into())),
        "the stored plan is provider truth; gating resolves canceled to free"
    );
    let pushes = auth.pushes_for(tenant);
    assert_eq!(pushes.len(), 1);
    assert_eq!(
        pushes[0].body,
        json!({"plan": "free", "status": "canceled"}),
        "the RESOLVED gating plan (free) is pushed, not the stored paid plan"
    );
}

#[tokio::test]
async fn invoice_payment_failed_marks_past_due_but_keeps_paid_gating_in_grace() {
    let _subs_guard = SUBS_LOCK.lock().await;
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP invoice_payment_failed...: TEST_DATABASE_URL unset");
        return;
    };
    let stripe = StripeStub::spawn().await;
    let auth = AuthStub::spawn().await;
    let st = state(owner.clone(), app, &stripe.base_url, &auth.base_url);
    let tenant = Uuid::new_v4();
    let sub_id = format!("sub_{}", Uuid::new_v4().simple());

    // The REAL renewal-failure shape: Stripe has already advanced current_period_end a
    // month into the NEW period before the invoice fails.
    sqlx::query(
        "INSERT INTO org_subscriptions \
             (tenant_id, stripe_customer_id, stripe_subscription_id, plan, status, \
              current_period_end) \
         VALUES ($1, 'cus_pd', $2, 'enterprise', 'active', now() + interval '27 days')",
    )
    .bind(tenant)
    .bind(&sub_id)
    .execute(&owner)
    .await
    .unwrap();

    let failed = json!({
        "id": evt_id(),
        "type": "invoice.payment_failed",
        "data": {"object": {"id": "in_1", "subscription": sub_id}}
    })
    .to_string();
    let sig = stripe_sig(&failed, 0);
    assert_eq!(deliver_webhook(&st, &failed, &sig).await, StatusCode::OK);

    assert_eq!(
        sub_row(&owner, tenant).await,
        Some(("enterprise".into(), "past_due".into()))
    );
    // The transition stamped the grace anchor.
    let since: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT past_due_since FROM org_subscriptions WHERE tenant_id = $1")
            .bind(tenant)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert!(
        since.is_some(),
        "entering past_due must stamp past_due_since"
    );
    // Freshly past_due: within grace, the mirror still carries the paid plan.
    let pushes = auth.pushes_for(tenant);
    assert_eq!(pushes.len(), 1);
    assert_eq!(
        pushes[0].body,
        json!({"plan": "enterprise", "status": "past_due"})
    );

    // 7 days after the TRANSITION the paid gating ends, even though
    // current_period_end + 7d is still weeks away (the anchor is past_due_since, not
    // the already-advanced period end).
    sqlx::query(
        "UPDATE org_subscriptions SET past_due_since = now() - interval '8 days' \
         WHERE tenant_id = $1",
    )
    .bind(tenant)
    .execute(&owner)
    .await
    .unwrap();
    let token = bearer(tenant, None);
    let (status, body) = send(&st, "GET", "/billing/subscription", Some(&token), &[], None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "past_due");
    assert_eq!(
        body["effective_plan"], "free",
        "grace must expire 7 days after entering past_due, not after period end + 7d"
    );
}

#[tokio::test]
async fn reconcile_sweeps_lost_cancellation_only_after_a_complete_walk() {
    let _subs_guard = SUBS_LOCK.lock().await;
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP reconcile_sweeps...: TEST_DATABASE_URL unset");
        return;
    };
    let stripe = StripeStub::spawn().await;
    let auth = AuthStub::spawn().await;
    let st = state(owner.clone(), app, &stripe.base_url, &auth.base_url);
    let client = StripeClient::new(st.http.clone(), &stripe.base_url, STRIPE_SECRET);
    clear_subscriptions(&owner).await;

    // Org A: locally active, but its subscription no longer exists at Stripe (the
    // deleted webhook was lost). Org B: live at Stripe with org metadata.
    let (org_a, org_b) = (Uuid::new_v4(), Uuid::new_v4());
    let (sub_a, sub_b) = (
        format!("sub_{}", Uuid::new_v4().simple()),
        format!("sub_{}", Uuid::new_v4().simple()),
    );
    sqlx::query(
        "INSERT INTO org_subscriptions \
             (tenant_id, stripe_customer_id, stripe_subscription_id, plan, status) \
         VALUES ($1, 'cus_a', $2, 'team', 'active')",
    )
    .bind(org_a)
    .bind(&sub_a)
    .execute(&owner)
    .await
    .unwrap();
    let period_end = chrono::Utc::now().timestamp() + 20 * 24 * 3600;
    let sub_b_obj = sub_object(&sub_b, org_b, "active", PRICE_TEAM, period_end);

    // INCOMPLETE walk first: page 1 says has_more, page 2 errors (stub queue empty
    // => 500). The sweep must NOT run: org A stays active.
    stripe.push_list_response(200, json!({"data": [sub_b_obj], "has_more": true}));
    cupboard_tenant::billing_loop::reconcile_once(&owner, &client, &st.http, &st.config).await;
    assert_eq!(
        sub_row(&owner, org_a).await,
        Some(("team".into(), "active".into())),
        "an incomplete walk must not sweep"
    );

    // COMPLETE walk: Stripe reports only sub_b. Org A is swept to canceled/free and its
    // mirror re-push carries free (lost-webhook convergence); org B stays team/active.
    let sub_b_obj = sub_object(&sub_b, org_b, "active", PRICE_TEAM, period_end);
    stripe.push_list_response(200, json!({"data": [sub_b_obj], "has_more": false}));
    cupboard_tenant::billing_loop::reconcile_once(&owner, &client, &st.http, &st.config).await;

    assert_eq!(
        sub_row(&owner, org_a).await,
        Some(("free".into(), "canceled".into()))
    );
    assert_eq!(
        sub_row(&owner, org_b).await,
        Some(("team".into(), "active".into()))
    );
    let a_pushes = auth.pushes_for(org_a);
    assert!(
        !a_pushes.is_empty(),
        "the re-push must include downgrades to free"
    );
    assert_eq!(
        a_pushes.last().unwrap().body,
        json!({"plan": "free", "status": "canceled"})
    );
    let b_pushes = auth.pushes_for(org_b);
    assert_eq!(
        b_pushes.last().unwrap().body,
        json!({"plan": "team", "status": "active"})
    );
}

#[tokio::test]
async fn domain_cap_follows_the_plan_claim() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP domain_cap_follows_the_plan_claim: TEST_DATABASE_URL unset");
        return;
    };
    let stripe = StripeStub::spawn().await;
    let auth = AuthStub::spawn().await;
    let st = state(owner.clone(), app, &stripe.base_url, &auth.base_url);
    let tenant = Uuid::new_v4();
    let slug = format!("bc{}", &Uuid::new_v4().simple().to_string()[..8]);
    sqlx::query("INSERT INTO sites (tenant_id, slug) VALUES ($1, $2)")
        .bind(tenant)
        .bind(&slug)
        .execute(&owner)
        .await
        .unwrap();

    let add = |token: String, n: u32| {
        let st = st.clone();
        async move {
            let domain = format!(
                "d{n}-{}.example.gg",
                &Uuid::new_v4().simple().to_string()[..6]
            );
            let (status, body) = send(
                &st,
                "POST",
                "/sites/domains",
                Some(&token),
                &[],
                Some(json!({"domain": domain}).to_string()),
            )
            .await;
            (status, body)
        }
    };

    // Free tier (no plan claim): first domain ok, second rejected.
    let free = bearer(tenant, None);
    let (status, body) = add(free.clone(), 0).await;
    assert_eq!(status, StatusCode::CREATED, "free 1st domain: {body}");
    let (status, body) = add(free, 1).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "free 2nd domain: {body}");
    assert!(body["message"]
        .as_str()
        .unwrap()
        .contains("1 custom domain"));

    // Team plan claim: up to 3 total (2 more), then rejected.
    let team = bearer(tenant, Some("team"));
    for n in 1..3 {
        let (status, body) = add(team.clone(), n).await;
        assert_eq!(status, StatusCode::CREATED, "team domain {n}: {body}");
    }
    let (status, _) = add(team, 3).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "team cap is 3");

    // An unknown plan string gates as free (safe floor), so it is also rejected.
    let bogus = bearer(tenant, Some("platinum"));
    let (status, _) = add(bogus, 4).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn stale_cancellation_never_clobbers_a_live_resubscription() {
    let _subs_guard = SUBS_LOCK.lock().await;
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP stale_cancellation...: TEST_DATABASE_URL unset");
        return;
    };
    let stripe = StripeStub::spawn().await;
    let auth = AuthStub::spawn().await;
    let st = state(owner.clone(), app, &stripe.base_url, &auth.base_url);
    let client = StripeClient::new(st.http.clone(), &stripe.base_url, STRIPE_SECRET);
    clear_subscriptions(&owner).await;

    // Cancel-then-resubscribe: the org's OLD subscription is canceled at Stripe (and
    // listed forever, still carrying this org's metadata); the NEW one is live and is
    // what the local row holds.
    let org = Uuid::new_v4();
    let sub_old = format!("sub_{}", Uuid::new_v4().simple());
    let sub_new = format!("sub_{}", Uuid::new_v4().simple());
    sqlx::query(
        "INSERT INTO org_subscriptions \
             (tenant_id, stripe_customer_id, stripe_subscription_id, plan, status) \
         VALUES ($1, 'cus_rs', $2, 'team', 'active')",
    )
    .bind(org)
    .bind(&sub_new)
    .execute(&owner)
    .await
    .unwrap();

    // (a) Webhook path: a LATE customer.subscription.deleted for the old subscription
    // must not clobber the live row (it would push free for a paying org).
    let late_deleted = json!({
        "id": evt_id(),
        "type": "customer.subscription.deleted",
        "data": {"object": {
            "id": sub_old,
            "object": "subscription",
            "customer": "cus_rs",
            "status": "canceled",
            "metadata": {"org_id": org.to_string()},
            "items": {"data": [{"price": {"id": PRICE_TEAM}}]}
        }}
    })
    .to_string();
    let sig = stripe_sig(&late_deleted, 0);
    assert_eq!(
        deliver_webhook(&st, &late_deleted, &sig).await,
        StatusCode::OK
    );
    assert_eq!(
        sub_row(&owner, org).await,
        Some(("team".into(), "active".into())),
        "a stale terminal event for a superseded subscription must not downgrade"
    );
    let pushes = auth.pushes_for(org);
    assert_eq!(
        pushes.last().unwrap().body,
        json!({"plan": "team", "status": "active"}),
        "any mirror push after the stale event must still carry the live plan"
    );

    // (b) Reconcile path: Stripe lists the old canceled subscription FIRST (its listing
    // is newest-cancellation-first in the bug scenario); per-org aggregation must pick
    // the live subscription, not last-writer-wins the canceled one.
    let period_end = chrono::Utc::now().timestamp() + 20 * 24 * 3600;
    let mut old_obj = sub_object(&sub_old, org, "canceled", PRICE_TEAM, period_end);
    old_obj["created"] = json!(1_000);
    let mut new_obj = sub_object(&sub_new, org, "active", PRICE_TEAM, period_end);
    new_obj["created"] = json!(2_000);
    stripe.push_list_response(200, json!({"data": [old_obj, new_obj], "has_more": false}));
    cupboard_tenant::billing_loop::reconcile_once(&owner, &client, &st.http, &st.config).await;

    let (plan_status, stored_sub): ((String, String), Option<String>) = (
        sub_row(&owner, org).await.unwrap(),
        sqlx::query_scalar(
            "SELECT stripe_subscription_id FROM org_subscriptions WHERE tenant_id = $1",
        )
        .bind(org)
        .fetch_one(&owner)
        .await
        .unwrap(),
    );
    assert_eq!(plan_status, ("team".into(), "active".into()));
    assert_eq!(
        stored_sub.as_deref(),
        Some(sub_new.as_str()),
        "the live subscription wins the per-org aggregation"
    );
    assert_eq!(
        auth.pushes_for(org).last().unwrap().body,
        json!({"plan": "team", "status": "active"})
    );
}

#[tokio::test]
async fn empty_complete_walk_refuses_to_sweep_live_rows() {
    let _subs_guard = SUBS_LOCK.lock().await;
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP empty_complete_walk...: TEST_DATABASE_URL unset");
        return;
    };
    let stripe = StripeStub::spawn().await;
    let auth = AuthStub::spawn().await;
    let st = state(owner.clone(), app, &stripe.base_url, &auth.base_url);
    let client = StripeClient::new(st.http.clone(), &stripe.base_url, STRIPE_SECRET);
    clear_subscriptions(&owner).await;

    // A paying org on file...
    let org = Uuid::new_v4();
    let sub = format!("sub_{}", Uuid::new_v4().simple());
    sqlx::query(
        "INSERT INTO org_subscriptions \
             (tenant_id, stripe_customer_id, stripe_subscription_id, plan, status) \
         VALUES ($1, 'cus_ew', $2, 'enterprise', 'active')",
    )
    .bind(org)
    .bind(&sub)
    .execute(&owner)
    .await
    .unwrap();

    // ...and a COMPLETED walk that saw zero subscriptions (a wrong-account or
    // wrong-mode STRIPE_SECRET_KEY returns an empty 200 listing). The sweep must be
    // refused, or every org would be freed in one tick.
    stripe.push_list_response(200, json!({"data": [], "has_more": false}));
    cupboard_tenant::billing_loop::reconcile_once(&owner, &client, &st.http, &st.config).await;

    assert_eq!(
        sub_row(&owner, org).await,
        Some(("enterprise".into(), "active".into())),
        "an empty complete walk must never sweep live rows"
    );
    // The mirror re-push still ran off the intact row.
    assert_eq!(
        auth.pushes_for(org).last().unwrap().body,
        json!({"plan": "enterprise", "status": "active"})
    );
}

#[tokio::test]
async fn all_terminal_candidates_converge_via_the_stored_subscription() {
    let _subs_guard = SUBS_LOCK.lock().await;
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP all_terminal_candidates...: TEST_DATABASE_URL unset");
        return;
    };
    let stripe = StripeStub::spawn().await;
    let auth = AuthStub::spawn().await;
    let st = state(owner.clone(), app, &stripe.base_url, &auth.base_url);
    let client = StripeClient::new(st.http.clone(), &stripe.base_url, STRIPE_SECRET);
    clear_subscriptions(&owner).await;

    // Lost deleted-webhook: the local row still holds sub_B live, but at Stripe BOTH of
    // the org's subscriptions are canceled: sub_B (older) and a newer canceled sub_C.
    // A created-only tie-break would pick sub_C, the stale-terminal guard would refuse
    // it every tick, and the org would keep paid gating forever. The stored-id
    // preference picks sub_B, whose same-id cancellation is allowed to write.
    let org = Uuid::new_v4();
    let sub_b = format!("sub_{}", Uuid::new_v4().simple());
    let sub_c = format!("sub_{}", Uuid::new_v4().simple());
    sqlx::query(
        "INSERT INTO org_subscriptions \
             (tenant_id, stripe_customer_id, stripe_subscription_id, plan, status) \
         VALUES ($1, 'cus_tc', $2, 'team', 'active')",
    )
    .bind(org)
    .bind(&sub_b)
    .execute(&owner)
    .await
    .unwrap();

    let period_end = chrono::Utc::now().timestamp() + 5 * 24 * 3600;
    let mut b_obj = sub_object(&sub_b, org, "canceled", PRICE_TEAM, period_end);
    b_obj["created"] = json!(1_000);
    let mut c_obj = sub_object(&sub_c, org, "canceled", PRICE_TEAM, period_end);
    c_obj["created"] = json!(2_000);
    stripe.push_list_response(200, json!({"data": [c_obj, b_obj], "has_more": false}));
    cupboard_tenant::billing_loop::reconcile_once(&owner, &client, &st.http, &st.config).await;

    let (status, stored_sub): (String, Option<String>) = sqlx::query_as(
        "SELECT status, stripe_subscription_id FROM org_subscriptions WHERE tenant_id = $1",
    )
    .bind(org)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(
        status, "canceled",
        "the stored subscription's cancellation must converge the row"
    );
    assert_eq!(stored_sub.as_deref(), Some(sub_b.as_str()));
    assert_eq!(
        auth.pushes_for(org).last().unwrap().body,
        json!({"plan": "free", "status": "canceled"}),
        "the org must converge to free, not keep paid gating forever"
    );
}

#[tokio::test]
async fn unknown_price_id_preserves_prior_plan_and_floors_without_knowledge() {
    let _subs_guard = SUBS_LOCK.lock().await;
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP unknown_price_id...: TEST_DATABASE_URL unset");
        return;
    };
    let stripe = StripeStub::spawn().await;
    let auth = AuthStub::spawn().await;
    let st = state(owner.clone(), app, &stripe.base_url, &auth.base_url);

    // Known paid subscription: an update carrying an unmappable price id (configmap
    // typo, or a price introduced Stripe-side first) must PRESERVE the stored plan and
    // keep pushing paid, not mass-downgrade.
    let org_known = Uuid::new_v4();
    let sub_x = format!("sub_{}", Uuid::new_v4().simple());
    sqlx::query(
        "INSERT INTO org_subscriptions \
             (tenant_id, stripe_customer_id, stripe_subscription_id, plan, status) \
         VALUES ($1, 'cus_up', $2, 'team', 'active')",
    )
    .bind(org_known)
    .bind(&sub_x)
    .execute(&owner)
    .await
    .unwrap();
    let period_end = chrono::Utc::now().timestamp() + 20 * 24 * 3600;
    let updated = json!({
        "id": evt_id(),
        "type": "customer.subscription.updated",
        "data": {"object": sub_object(&sub_x, org_known, "active", "price_bogus", period_end)}
    })
    .to_string();
    let sig = stripe_sig(&updated, 0);
    assert_eq!(deliver_webhook(&st, &updated, &sig).await, StatusCode::OK);
    assert_eq!(
        sub_row(&owner, org_known).await,
        Some(("team".into(), "active".into())),
        "unmappable price on a known paid subscription must preserve the stored plan"
    );
    assert_eq!(
        auth.pushes_for(org_known).last().unwrap().body,
        json!({"plan": "team", "status": "active"})
    );

    // No prior knowledge for the subscription: the same unmappable price floors to
    // free (the safe floor, never a guessed entitlement).
    let org_new = Uuid::new_v4();
    let sub_y = format!("sub_{}", Uuid::new_v4().simple());
    let fresh = json!({
        "id": evt_id(),
        "type": "customer.subscription.updated",
        "data": {"object": sub_object(&sub_y, org_new, "active", "price_bogus", period_end)}
    })
    .to_string();
    let sig = stripe_sig(&fresh, 0);
    assert_eq!(deliver_webhook(&st, &fresh, &sig).await, StatusCode::OK);
    assert_eq!(
        sub_row(&owner, org_new).await,
        Some(("free".into(), "active".into())),
        "with no prior plan knowledge an unmappable price gates as free"
    );
}

#[tokio::test]
async fn past_due_since_survives_repeats_and_clears_on_recovery() {
    let _subs_guard = SUBS_LOCK.lock().await;
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP past_due_since_survives...: TEST_DATABASE_URL unset");
        return;
    };
    let stripe = StripeStub::spawn().await;
    let auth = AuthStub::spawn().await;
    let st = state(owner.clone(), app, &stripe.base_url, &auth.base_url);
    let org = Uuid::new_v4();
    let sub = format!("sub_{}", Uuid::new_v4().simple());
    sqlx::query(
        "INSERT INTO org_subscriptions \
             (tenant_id, stripe_customer_id, stripe_subscription_id, plan, status, \
              current_period_end) \
         VALUES ($1, 'cus_ps', $2, 'team', 'active', now() + interval '27 days')",
    )
    .bind(org)
    .bind(&sub)
    .execute(&owner)
    .await
    .unwrap();
    let since = |owner: &PgPool| {
        let owner = owner.clone();
        async move {
            sqlx::query_scalar::<_, Option<chrono::DateTime<chrono::Utc>>>(
                "SELECT past_due_since FROM org_subscriptions WHERE tenant_id = $1",
            )
            .bind(org)
            .fetch_one(&owner)
            .await
            .unwrap()
        }
    };

    // Enter past_due: the anchor is stamped once.
    let failed = json!({
        "id": evt_id(),
        "type": "invoice.payment_failed",
        "data": {"object": {"id": "in_ps", "subscription": sub}}
    })
    .to_string();
    let sig = stripe_sig(&failed, 0);
    assert_eq!(deliver_webhook(&st, &failed, &sig).await, StatusCode::OK);
    let first = since(&owner).await.expect("anchor stamped on transition");

    // A REPEATED past_due write (the matching subscription.updated) must not slide the
    // window: the original anchor survives via the COALESCE.
    let period_end = chrono::Utc::now().timestamp() + 27 * 24 * 3600;
    let still_past_due = json!({
        "id": evt_id(),
        "type": "customer.subscription.updated",
        "data": {"object": sub_object(&sub, org, "past_due", PRICE_TEAM, period_end)}
    })
    .to_string();
    let sig = stripe_sig(&still_past_due, 0);
    assert_eq!(
        deliver_webhook(&st, &still_past_due, &sig).await,
        StatusCode::OK
    );
    assert_eq!(
        since(&owner).await,
        Some(first),
        "a repeated past_due write must preserve the original past_due_since"
    );

    // Recovery to active clears the anchor entirely.
    let recovered = json!({
        "id": evt_id(),
        "type": "customer.subscription.updated",
        "data": {"object": sub_object(&sub, org, "active", PRICE_TEAM, period_end)}
    })
    .to_string();
    let sig = stripe_sig(&recovered, 0);
    assert_eq!(deliver_webhook(&st, &recovered, &sig).await, StatusCode::OK);
    assert_eq!(
        sub_row(&owner, org).await,
        Some(("team".into(), "active".into()))
    );
    assert_eq!(
        since(&owner).await,
        None,
        "recovery to active must clear past_due_since"
    );
}

#[tokio::test]
async fn checkout_conflicts_when_previous_session_already_completed() {
    let _subs_guard = SUBS_LOCK.lock().await;
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP checkout_conflicts...: TEST_DATABASE_URL unset");
        return;
    };
    let stripe = StripeStub::spawn().await;
    let auth = AuthStub::spawn().await;
    let st = state(owner.clone(), app, &stripe.base_url, &auth.base_url);
    let tenant = Uuid::new_v4();
    let token = bearer(tenant, None);

    // A pending session is on record, and Stripe reports it cannot be expired because
    // it already COMPLETED (the completion webhook just has not landed yet): the new
    // checkout must abort with a conflict, not mint a second subscription.
    sqlx::query(
        "INSERT INTO billing_pending_checkouts (tenant_id, stripe_checkout_session_id) \
         VALUES ($1, 'cs_done')",
    )
    .bind(tenant)
    .execute(&owner)
    .await
    .unwrap();
    stripe.push_expire_response(
        400,
        json!({"error": {"message":
            "This Checkout Session cannot be expired because it is already in the 'complete' state."}}),
    );
    let (status, body) = send(
        &st,
        "POST",
        "/billing/checkout",
        Some(&token),
        &[],
        Some(json!({"plan": "team", "return_url": "https://app.test/billing"}).to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "body: {body}");
    assert_eq!(body["error"], "conflict");
    assert!(
        stripe.checkout_forms().is_empty(),
        "no new session may be created after a completed-session conflict"
    );
}

/// A paid payment-mode Checkout Session object as Stripe reports it.
fn payment_session(session_id: &str, org: Uuid, service_key: &str, pi: &str) -> Value {
    json!({
        "id": session_id,
        "object": "checkout.session",
        "mode": "payment",
        "payment_status": "paid",
        "status": "complete",
        "client_reference_id": org.to_string(),
        "metadata": {"org_id": org.to_string(), "service_key": service_key},
        "payment_intent": pi,
        "amount_total": 25000,
        "currency": "usd"
    })
}

async fn purchase_rows(owner: &PgPool, tenant: Uuid) -> Vec<(String, String, Option<i64>)> {
    sqlx::query_as(
        "SELECT service_key, status, amount FROM billing_purchases \
         WHERE tenant_id = $1 ORDER BY purchased_at",
    )
    .bind(tenant)
    .fetch_all(owner)
    .await
    .unwrap()
}

#[tokio::test]
async fn service_checkout_and_purchase_lifecycle() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP service_checkout_and_purchase_lifecycle: TEST_DATABASE_URL unset");
        return;
    };
    let stripe = StripeStub::spawn().await;
    let auth = AuthStub::spawn().await;
    let st = state(owner.clone(), app, &stripe.base_url, &auth.base_url);
    let tenant = Uuid::new_v4();
    let token = bearer(tenant, None);

    // Catalog read: code-defined services, no purchases yet.
    let (status, body) = send(&st, "GET", "/billing/services", Some(&token), &[], None).await;
    assert_eq!(status, StatusCode::OK, "services read: {body}");
    let services = body["services"].as_array().unwrap();
    assert_eq!(services.len(), 1);
    assert_eq!(services[0]["key"], "custom_design");
    assert_eq!(services[0]["name"], "Custom Design");
    assert_eq!(services[0]["price_amount"], 25000);
    assert_eq!(services[0]["currency"], "usd");
    assert!(body["purchases"].as_array().unwrap().is_empty());

    // Unknown service keys are rejected up front.
    let (status, _) = send(
        &st,
        "POST",
        "/billing/services/checkout",
        Some(&token),
        &[],
        Some(
            json!({"service": "gold_plating", "return_url": "https://app.test/billing"})
                .to_string(),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Payment-mode handoff with the right form fields and flags.
    let (status, body) = send(
        &st,
        "POST",
        "/billing/services/checkout",
        Some(&token),
        &[],
        Some(
            json!({"service": "custom_design", "return_url": "https://app.test/billing"})
                .to_string(),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "service checkout: {body}");
    assert!(body["redirect_url"]
        .as_str()
        .unwrap()
        .contains("checkout.stripe.com"));
    let forms = stripe.checkout_forms();
    assert_eq!(forms.len(), 1);
    let form = &forms[0];
    assert_eq!(form.get("mode").map(String::as_str), Some("payment"));
    assert_eq!(
        form.get("payment_method_types[0]").map(String::as_str),
        Some("card"),
        "payment checkout must be card-only until async methods are deliberately supported"
    );
    assert_eq!(
        form.get("line_items[0][price]").map(String::as_str),
        Some(PRICE_CUSTOM)
    );
    assert_eq!(form.get("client_reference_id"), Some(&tenant.to_string()));
    assert_eq!(form.get("metadata[org_id]"), Some(&tenant.to_string()));
    assert_eq!(
        form.get("metadata[service_key]").map(String::as_str),
        Some("custom_design")
    );
    assert_eq!(
        form.get("success_url").map(String::as_str),
        Some("https://app.test/billing?flag=service_success")
    );
    assert_eq!(
        form.get("cancel_url").map(String::as_str),
        Some("https://app.test/billing?flag=service_cancel")
    );

    // Completion webhook lands the ledger row exactly once.
    let session = payment_session("cs_test_1", tenant, "custom_design", "pi_life_1");
    let event = json!({
        "id": evt_id(),
        "type": "checkout.session.completed",
        "data": {"object": session}
    })
    .to_string();
    let sig = stripe_sig(&event, 0);
    assert_eq!(deliver_webhook(&st, &event, &sig).await, StatusCode::OK);
    assert_eq!(
        purchase_rows(&owner, tenant).await,
        vec![("custom_design".into(), "paid".into(), Some(25000))]
    );

    // Replay (same event id) and a DIFFERENT event for the same session are both no-ops.
    assert_eq!(deliver_webhook(&st, &event, &sig).await, StatusCode::OK);
    let dup_session = payment_session("cs_test_1", tenant, "custom_design", "pi_life_1");
    let dup_event = json!({
        "id": evt_id(),
        "type": "checkout.session.completed",
        "data": {"object": dup_session}
    })
    .to_string();
    let dup_sig = stripe_sig(&dup_event, 0);
    assert_eq!(
        deliver_webhook(&st, &dup_event, &dup_sig).await,
        StatusCode::OK
    );
    assert_eq!(
        purchase_rows(&owner, tenant).await.len(),
        1,
        "the session-id unique key must keep the ledger at one row"
    );

    // The history now shows the purchase.
    let (_s, body) = send(&st, "GET", "/billing/services", Some(&token), &[], None).await;
    let purchases = body["purchases"].as_array().unwrap();
    assert_eq!(purchases.len(), 1);
    assert_eq!(purchases[0]["service_key"], "custom_design");
    assert_eq!(purchases[0]["status"], "paid");
    assert_eq!(purchases[0]["amount"], 25000);
    assert_eq!(purchases[0]["currency"], "usd");

    // An UNMATCHED refund is dedupe-recorded and changes nothing.
    let stray = json!({
        "id": evt_id(),
        "type": "charge.refunded",
        "data": {"object": {"id": "ch_stray", "payment_intent": "pi_nothing", "refunded": true}}
    })
    .to_string();
    let sig = stripe_sig(&stray, 0);
    assert_eq!(deliver_webhook(&st, &stray, &sig).await, StatusCode::OK);
    assert_eq!(
        purchase_rows(&owner, tenant).await,
        vec![("custom_design".into(), "paid".into(), Some(25000))]
    );

    // The real refund flips the row (webhook-only per decision H).
    let refund = json!({
        "id": evt_id(),
        "type": "charge.refunded",
        "data": {"object": {"id": "ch_life_1", "payment_intent": "pi_life_1",
                            "refunded": true, "amount_refunded": 25000}}
    })
    .to_string();
    let sig = stripe_sig(&refund, 0);
    assert_eq!(deliver_webhook(&st, &refund, &sig).await, StatusCode::OK);
    assert_eq!(
        purchase_rows(&owner, tenant).await,
        vec![("custom_design".into(), "refunded".into(), Some(25000))]
    );

    // Audit trail: handoff + purchase + refund.
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE tenant_id = $1 AND action IN \
             ('billing.service_checkout_created', 'billing.service_purchased', \
              'billing.purchase_refunded')",
    )
    .bind(tenant)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(audits, 3);
}

#[tokio::test]
async fn purchases_backstop_lands_sessions_the_webhook_missed() {
    let _subs_guard = SUBS_LOCK.lock().await;
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP purchases_backstop...: TEST_DATABASE_URL unset");
        return;
    };
    let stripe = StripeStub::spawn().await;
    let auth = AuthStub::spawn().await;
    let st = state(owner.clone(), app, &stripe.base_url, &auth.base_url);
    let client = StripeClient::new(st.http.clone(), &stripe.base_url, STRIPE_SECRET);
    clear_subscriptions(&owner).await;

    let org = Uuid::new_v4();
    let missed = format!("cs_missed_{}", Uuid::new_v4().simple());
    // The listing carries a paid payment session the webhook never delivered, plus two
    // rows the backstop must skip: an unpaid (abandoned/processing) session and a
    // subscription-mode session.
    let mut unpaid = payment_session("cs_unpaid_x", org, "custom_design", "pi_unpaid");
    unpaid["payment_status"] = json!("unpaid");
    let session_page = json!({
        "data": [
            payment_session(&missed, org, "custom_design", "pi_missed_1"),
            unpaid,
            {"id": "cs_sub_x", "object": "checkout.session", "mode": "subscription",
             "payment_status": "paid", "client_reference_id": org.to_string()}
        ],
        "has_more": false
    });

    // Tick 1: empty (complete) subscription walk + the session listing above.
    stripe.push_list_response(200, json!({"data": [], "has_more": false}));
    stripe.push_session_list_response(200, session_page.clone());
    cupboard_tenant::billing_loop::reconcile_once(&owner, &client, &st.http, &st.config).await;
    assert_eq!(
        purchase_rows(&owner, org).await,
        vec![("custom_design".into(), "paid".into(), Some(25000))],
        "the backstop lands exactly the paid payment-mode session"
    );

    // Tick 2 re-sees the same listing: idempotent, still one row.
    stripe.push_list_response(200, json!({"data": [], "has_more": false}));
    stripe.push_session_list_response(200, session_page);
    cupboard_tenant::billing_loop::reconcile_once(&owner, &client, &st.http, &st.config).await;
    assert_eq!(purchase_rows(&owner, org).await.len(), 1);
}

#[tokio::test]
async fn async_payment_succeeded_lands_purchase_once() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP async_payment_succeeded...: TEST_DATABASE_URL unset");
        return;
    };
    let stripe = StripeStub::spawn().await;
    let auth = AuthStub::spawn().await;
    let st = state(owner.clone(), app, &stripe.base_url, &auth.base_url);
    let org = Uuid::new_v4();
    let session_id = format!("cs_async_{}", Uuid::new_v4().simple());

    // An async payment method settles days later: the paid signal is
    // checkout.session.async_payment_succeeded, not completed (whose payment_status was
    // still unpaid), and the settlement can outlive the backstop's 24h window.
    let session = payment_session(&session_id, org, "custom_design", "pi_async_1");
    let event = json!({
        "id": evt_id(),
        "type": "checkout.session.async_payment_succeeded",
        "data": {"object": session}
    })
    .to_string();
    let sig = stripe_sig(&event, 0);
    assert_eq!(deliver_webhook(&st, &event, &sig).await, StatusCode::OK);
    assert_eq!(
        purchase_rows(&owner, org).await,
        vec![("custom_design".into(), "paid".into(), Some(25000))]
    );

    // Replay + a duplicate `completed` for the same session: still exactly one row.
    assert_eq!(deliver_webhook(&st, &event, &sig).await, StatusCode::OK);
    let dup = json!({
        "id": evt_id(),
        "type": "checkout.session.completed",
        "data": {"object": payment_session(&session_id, org, "custom_design", "pi_async_1")}
    })
    .to_string();
    let dup_sig = stripe_sig(&dup, 0);
    assert_eq!(deliver_webhook(&st, &dup, &dup_sig).await, StatusCode::OK);
    assert_eq!(purchase_rows(&owner, org).await.len(), 1);
}

#[tokio::test]
async fn refund_recorded_before_purchase_lands_row_as_refunded() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP refund_recorded_before_purchase...: TEST_DATABASE_URL unset");
        return;
    };
    let stripe = StripeStub::spawn().await;
    let auth = AuthStub::spawn().await;
    let st = state(owner.clone(), app, &stripe.base_url, &auth.base_url);
    let org = Uuid::new_v4();
    let pi = format!("pi_race_{}", Uuid::new_v4().simple());
    let session_id = format!("cs_race_{}", Uuid::new_v4().simple());

    // The FULL refund arrives first (receiver was down when the purchase completed;
    // staff refunded fast): unmatched, so it is dedupe-recorded only.
    let refund = json!({
        "id": evt_id(),
        "type": "charge.refunded",
        "data": {"object": {"id": "ch_race", "payment_intent": pi,
                            "refunded": true, "amount_refunded": 25000}}
    })
    .to_string();
    let sig = stripe_sig(&refund, 0);
    assert_eq!(deliver_webhook(&st, &refund, &sig).await, StatusCode::OK);
    assert!(purchase_rows(&owner, org).await.is_empty());

    // The purchase row lands later (late webhook or the backstop; same shared insert):
    // it must be born REFUNDED, or a permanently paid row would drive manual
    // fulfillment of refunded money.
    let completed = json!({
        "id": evt_id(),
        "type": "checkout.session.completed",
        "data": {"object": payment_session(&session_id, org, "custom_design", &pi)}
    })
    .to_string();
    let sig = stripe_sig(&completed, 0);
    assert_eq!(deliver_webhook(&st, &completed, &sig).await, StatusCode::OK);
    assert_eq!(
        purchase_rows(&owner, org).await,
        vec![("custom_design".into(), "refunded".into(), Some(25000))],
        "a pre-recorded full refund must land the late purchase row as refunded"
    );
}

#[tokio::test]
async fn partial_refund_keeps_paid_and_audits_the_amount() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP partial_refund...: TEST_DATABASE_URL unset");
        return;
    };
    let stripe = StripeStub::spawn().await;
    let auth = AuthStub::spawn().await;
    let st = state(owner.clone(), app, &stripe.base_url, &auth.base_url);
    let org = Uuid::new_v4();
    let pi = format!("pi_part_{}", Uuid::new_v4().simple());
    let session_id = format!("cs_part_{}", Uuid::new_v4().simple());

    // A paid purchase on record.
    let completed = json!({
        "id": evt_id(),
        "type": "checkout.session.completed",
        "data": {"object": payment_session(&session_id, org, "custom_design", &pi)}
    })
    .to_string();
    let sig = stripe_sig(&completed, 0);
    assert_eq!(deliver_webhook(&st, &completed, &sig).await, StatusCode::OK);

    // A PARTIAL refund (refunded == false) must not halt fulfillment: status stays
    // paid, the amount lands in the audit trail.
    let partial = json!({
        "id": evt_id(),
        "type": "charge.refunded",
        "data": {"object": {"id": "ch_part", "payment_intent": pi,
                            "refunded": false, "amount_refunded": 5000}}
    })
    .to_string();
    let sig = stripe_sig(&partial, 0);
    assert_eq!(deliver_webhook(&st, &partial, &sig).await, StatusCode::OK);
    assert_eq!(
        purchase_rows(&owner, org).await,
        vec![("custom_design".into(), "paid".into(), Some(25000))],
        "a partial refund must keep the purchase paid"
    );
    let audited_amount: Option<i64> = sqlx::query_scalar(
        "SELECT (metadata->>'amount_refunded')::bigint FROM audit_log \
         WHERE tenant_id = $1 AND action = 'billing.purchase_refund_partial'",
    )
    .bind(org)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(audited_amount, Some(5000));

    // The subsequent FULL refund flips the row.
    let full = json!({
        "id": evt_id(),
        "type": "charge.refunded",
        "data": {"object": {"id": "ch_part_full", "payment_intent": pi,
                            "refunded": true, "amount_refunded": 25000}}
    })
    .to_string();
    let sig = stripe_sig(&full, 0);
    assert_eq!(deliver_webhook(&st, &full, &sig).await, StatusCode::OK);
    assert_eq!(
        purchase_rows(&owner, org).await,
        vec![("custom_design".into(), "refunded".into(), Some(25000))]
    );
}

#[tokio::test]
async fn service_price_mismatch_refuses_checkout_and_match_is_cached() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP service_price_mismatch...: TEST_DATABASE_URL unset");
        return;
    };
    let stripe = StripeStub::spawn().await;
    let auth = AuthStub::spawn().await;
    let st = state(owner.clone(), app, &stripe.base_url, &auth.base_url);
    let tenant = Uuid::new_v4();
    let token = bearer(tenant, None);
    let body =
        json!({"service": "custom_design", "return_url": "https://app.test/billing"}).to_string();

    // The configured price charges something other than the catalog advertises:
    // refuse the checkout (503) and create no session.
    stripe.set_price(
        PRICE_CUSTOM,
        json!({"id": PRICE_CUSTOM, "unit_amount": 9900, "currency": "usd", "type": "one_time"}),
    );
    let (status, resp) = send(
        &st,
        "POST",
        "/billing/services/checkout",
        Some(&token),
        &[],
        Some(body.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "resp: {resp}");
    assert!(
        stripe.checkout_forms().is_empty(),
        "no session may be created on a price mismatch"
    );

    // Fixed price: the checkout proceeds and the verification is cached...
    stripe.set_price(
        PRICE_CUSTOM,
        json!({"id": PRICE_CUSTOM, "unit_amount": 25000, "currency": "usd", "type": "one_time"}),
    );
    let (status, _) = send(
        &st,
        "POST",
        "/billing/services/checkout",
        Some(&token),
        &[],
        Some(body.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // ...so a later divergence in the stub is not re-fetched this process.
    stripe.set_price(
        PRICE_CUSTOM,
        json!({"id": PRICE_CUSTOM, "unit_amount": 1, "currency": "usd", "type": "one_time"}),
    );
    let (status, _) = send(
        &st,
        "POST",
        "/billing/services/checkout",
        Some(&token),
        &[],
        Some(body),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "a verified price is cached per process"
    );
    assert_eq!(stripe.checkout_forms().len(), 2);
}
