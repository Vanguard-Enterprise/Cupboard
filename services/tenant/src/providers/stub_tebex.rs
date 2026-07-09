//! In-process Tebex stub for this crate's integration tests (feature `stub`).
//!
//! [`TebexClient`](super::tebex::TebexClient) joins a Headless base with
//! `/api/accounts/{token}/...` and a plugin base with `/information` + `/payments`; in
//! tests both bases point at this one socket (the path spaces do not collide). It serves
//! the `{data: ...}`-wrapped catalog + basket flow the Headless client expects and the
//! `X-Tebex-Secret`-gated `/information` + `/payments` the plugin client expects, and
//! mints `validation.webhook`/`payment.*` signatures via [`sign_webhook`](TebexStub::sign_webhook)
//! so a test can drive the receiver end to end.

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::task::JoinHandle;

struct StubState {
    /// Plugin routes require `X-Tebex-Secret: {expected_secret}`.
    expected_secret: String,
    categories: Vec<Value>,
    payments: Vec<Value>,
    /// Whether `/payments` reports more pages (drives the reconcile cursor walk).
    payments_last_page: u64,
    webhook_secret: String,
    checkout_url: String,
    /// Packages added per basket ident, for assertions.
    packages: HashMap<String, Vec<Value>>,
    next_id: u64,
}

pub struct TebexStub {
    base_url: String,
    handle: JoinHandle<()>,
    state: Arc<Mutex<StubState>>,
}

impl TebexStub {
    pub async fn spawn(expected_secret: &str) -> TebexStub {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind loopback ephemeral port");
        let addr = listener.local_addr().expect("resolve bound address");
        let base_url = format!("http://127.0.0.1:{}", addr.port());
        let state = Arc::new(Mutex::new(StubState {
            expected_secret: expected_secret.to_string(),
            categories: default_categories(),
            payments: Vec::new(),
            payments_last_page: 1,
            webhook_secret: "tbx_whsec_test".to_string(),
            checkout_url: "https://checkout.tebex.io/test".to_string(),
            packages: HashMap::new(),
            next_id: 1,
        }));
        let app = Router::new()
            // Plugin (Game Server) surface.
            .route("/information", get(get_information))
            .route("/payments", get(get_payments))
            // Headless surface.
            .route("/api/accounts/{token}/categories", get(get_categories))
            .route("/api/accounts/{token}/baskets", post(post_basket))
            .route(
                "/api/accounts/{token}/baskets/{ident}/auth",
                get(get_basket_auth),
            )
            .route(
                "/api/accounts/{token}/baskets/{ident}/packages",
                post(post_basket_packages),
            )
            .route("/api/accounts/{token}/baskets/{ident}", get(get_basket))
            .with_state(state.clone());
        let handle = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("stub serve loop");
        });
        TebexStub {
            base_url,
            handle,
            state,
        }
    }

    /// Feed this to both `tebex_headless_base` and `tebex_plugin_base`.
    pub fn base_url(&self) -> String {
        self.base_url.clone()
    }

    pub fn set_categories(&self, categories: Vec<Value>) {
        self.lock().categories = categories;
    }

    /// Replace the `/payments` fixture; `last_page` drives the reconcile cursor walk.
    pub fn set_payments(&self, payments: Vec<Value>, last_page: u64) {
        let mut g = self.lock();
        g.payments = payments;
        g.payments_last_page = last_page;
    }

    pub fn set_webhook_secret(&self, secret: &str) {
        self.lock().webhook_secret = secret.to_string();
    }

    pub fn webhook_secret(&self) -> String {
        self.lock().webhook_secret.clone()
    }

    /// Packages added to a basket (via `POST .../packages`), for assertions.
    pub fn packages_for(&self, ident: &str) -> Vec<Value> {
        self.lock().packages.get(ident).cloned().unwrap_or_default()
    }

    /// Sign a webhook body exactly as Tebex would: hex `HMAC-SHA256(secret, sha256_hex(raw))`.
    pub fn sign_webhook(&self, raw_body: &str) -> String {
        let secret = self.webhook_secret();
        hmac_sha256_hex(
            secret.as_bytes(),
            sha256_hex(raw_body.as_bytes()).as_bytes(),
        )
    }

    pub fn abort(&self) {
        self.handle.abort();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, StubState> {
        self.state.lock().expect("stub state lock")
    }
}

impl Drop for TebexStub {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

fn require_secret(state: &StubState, headers: &HeaderMap) -> Option<Response> {
    let got = headers.get("x-tebex-secret").and_then(|v| v.to_str().ok());
    if got == Some(state.expected_secret.as_str()) {
        return None;
    }
    Some(
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "bad secret" })),
        )
            .into_response(),
    )
}

async fn get_information(
    State(state): State<Arc<Mutex<StubState>>>,
    headers: HeaderMap,
) -> Response {
    let guard = state.lock().expect("stub state lock");
    if let Some(bad) = require_secret(&guard, &headers) {
        return bad;
    }
    Json(json!({
        "account": {
            "id": 1234,
            "name": "ACME Rust",
            "domain": "acme.tebex.io",
            "currency": { "iso_4217": "USD", "symbol": "$" }
        },
        "server": { "id": 1, "name": "Main" }
    }))
    .into_response()
}

async fn get_payments(
    State(state): State<Arc<Mutex<StubState>>>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let guard = state.lock().expect("stub state lock");
    if let Some(bad) = require_secret(&guard, &headers) {
        return bad;
    }
    let page: u64 = params
        .get("paged")
        .and_then(|p| p.parse().ok())
        .unwrap_or(1);
    // Serve the fixture only on page 1; later pages are empty (the walk stops at last_page).
    let data = if page == 1 {
        guard.payments.clone()
    } else {
        Vec::new()
    };
    Json(json!({
        "data": data,
        "current_page": page,
        "last_page": guard.payments_last_page
    }))
    .into_response()
}

async fn get_categories(
    State(state): State<Arc<Mutex<StubState>>>,
    Path(_token): Path<String>,
) -> Response {
    let guard = state.lock().expect("stub state lock");
    Json(json!({ "data": guard.categories.clone() })).into_response()
}

async fn post_basket(
    State(state): State<Arc<Mutex<StubState>>>,
    Path(_token): Path<String>,
    Json(_body): Json<Value>,
) -> Response {
    let mut guard = state.lock().expect("stub state lock");
    let ident = format!("bskt-{}", mint(&mut guard));
    guard.packages.insert(ident.clone(), Vec::new());
    (
        StatusCode::CREATED,
        Json(json!({ "data": { "ident": ident } })),
    )
        .into_response()
}

async fn get_basket_auth(
    State(_state): State<Arc<Mutex<StubState>>>,
    Path((_token, ident)): Path<(String, String)>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    // Bare array of auth providers; the `returnUrl` is echoed into the Steam link so a
    // test can confirm the continue URL flowed through.
    let return_url = params.get("returnUrl").cloned().unwrap_or_default();
    Json(json!([
        {
            "name": "Steam",
            "url": format!("https://auth.tebex.io/{ident}?return={return_url}")
        }
    ]))
    .into_response()
}

async fn post_basket_packages(
    State(state): State<Arc<Mutex<StubState>>>,
    Path((_token, ident)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> Response {
    let mut guard = state.lock().expect("stub state lock");
    guard.packages.entry(ident).or_default().push(body);
    Json(json!({ "data": { "packages": [] } })).into_response()
}

async fn get_basket(
    State(state): State<Arc<Mutex<StubState>>>,
    Path((_token, ident)): Path<(String, String)>,
) -> Response {
    let guard = state.lock().expect("stub state lock");
    Json(json!({
        "data": {
            "ident": ident,
            "links": { "checkout": guard.checkout_url.clone() }
        }
    }))
    .into_response()
}

fn mint(state: &mut StubState) -> u64 {
    let id = state.next_id;
    state.next_id += 1;
    id
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

/// Default catalog: one category with a subscription rank (sale price) and a one-time kit.
fn default_categories() -> Vec<Value> {
    vec![json!({
        "id": 10,
        "name": "Ranks",
        "description": "Membership ranks",
        "order": 0,
        "packages": [
            {
                "id": 100,
                "name": "VIP",
                "description": "Priority queue",
                "image": "https://cdn.tebex.io/vip.png",
                "type": "subscription",
                "base_price": 9.99,
                "total_price": 7.99,
                "currency": "USD",
                "expiration_length": 1,
                "expiration_period": "month",
                "order": 0
            },
            {
                "id": 101,
                "name": "Starter Kit",
                "description": "One-time boost",
                "image": "https://cdn.tebex.io/kit.png",
                "type": "single",
                "base_price": 5.00,
                "total_price": 5.00,
                "currency": "USD",
                "order": 1
            }
        ]
    })]
}
