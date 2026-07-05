//! In-process PayNow stub for this crate's integration tests (feature `stub`).
//!
//! [`PayNowClient`](super::paynow::PayNowClient) takes an injectable base URL and joins
//! it with `/stores`, `/store`, `/store/products`, `/store/tags`, so tests need a real
//! socket serving those shapes rather than a fake transport. This binds an ephemeral
//! loopback port, serves the bare JSON arrays and objects the client's `as_array_payload`
//! and field extractors expect, and records every request so tests can assert auth and
//! the storefront header.
//!
//! Two knobs beyond static data: a FIFO of one-shot [`Fault`]s (each consumed by the next
//! request, ahead of normal handling and regardless of path) for exercising the client's
//! 401/403/429/5xx branches, and the request log. Fixtures are swappable at runtime
//! (`set_products`, `set_tags`, `set_stores`, `set_store_meta`) so a test can mutate the
//! catalog without restarting the stub.

use axum::extract::{OriginalUri, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tokio::task::JoinHandle;

/// A one-shot canned response, consumed by the next request before normal handling. The
/// body is returned verbatim so a test can hand the client whatever shape it needs (a
/// PayNow-style `{status,code,message}` error, a bad-JSON success body, and so on).
struct Fault {
    status: u16,
    body: String,
}

/// One recorded inbound request. `store_header` captures the storefront `x-paynow-store-id`
/// value when present, so tests can assert both the management (auth) and storefront paths.
#[derive(Clone, Debug)]
pub struct RecordedRequest {
    pub method: String,
    pub path: String,
    pub has_auth: bool,
    pub store_header: Option<String>,
}

/// Everything the stub serves plus its knobs, behind a single short-critical-section lock.
struct StubState {
    /// Requests to `GET /stores` must present `Authorization: apikey {expected}`; else 401.
    expected_api_key: String,
    /// Management store objects (`GET /stores`), served as a bare array.
    stores: Vec<Value>,
    /// The storefront store object (`GET /store`); its `id` gates the storefront endpoints.
    store_meta: Value,
    /// Storefront catalog (`GET /store/products`), served as a bare array.
    products: Vec<Value>,
    /// Storefront tags (`GET /store/tags`), served as a bare array.
    tags: Vec<Value>,
    /// One-shot faults, popped by the next request regardless of path.
    faults: VecDeque<Fault>,
    /// Every request seen so far, oldest first.
    recorded: Vec<RecordedRequest>,
}

/// A running stub server. Aborts its serve task on drop.
pub struct PayNowStub {
    base_url: String,
    handle: JoinHandle<()>,
    state: Arc<Mutex<StubState>>,
}

impl PayNowStub {
    /// Bind an ephemeral loopback port and start serving a sensible default fixture. Call
    /// from within a tokio runtime (a `#[tokio::test]`). `expected_api_key` is the key the
    /// management `GET /stores` endpoint requires.
    pub async fn spawn(expected_api_key: &str) -> PayNowStub {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind loopback ephemeral port");
        let addr = listener.local_addr().expect("resolve bound address");
        let base_url = format!("http://127.0.0.1:{}", addr.port());
        let state = Arc::new(Mutex::new(StubState {
            expected_api_key: expected_api_key.to_string(),
            stores: default_stores(),
            store_meta: default_store_meta(),
            products: default_products(),
            tags: default_tags(),
            faults: VecDeque::new(),
            recorded: Vec::new(),
        }));
        let app = Router::new()
            .route("/stores", get(get_stores))
            .route("/store", get(get_store))
            .route("/store/products", get(get_products))
            .route("/store/tags", get(get_tags))
            .with_state(state.clone());
        let handle = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("stub serve loop");
        });
        PayNowStub {
            base_url,
            handle,
            state,
        }
    }

    /// `http://127.0.0.1:{port}` -- feed this to `PayNowClient::new` as the base URL.
    pub fn base_url(&self) -> String {
        self.base_url.clone()
    }

    /// Replace the storefront product list (`GET /store/products`).
    pub fn set_products(&self, products: Vec<Value>) {
        self.lock().products = products;
    }

    /// Replace the storefront tag list (`GET /store/tags`).
    pub fn set_tags(&self, tags: Vec<Value>) {
        self.lock().tags = tags;
    }

    /// Replace the management store list (`GET /stores`).
    pub fn set_stores(&self, stores: Vec<Value>) {
        self.lock().stores = stores;
    }

    /// Replace the storefront store object (`GET /store`); its `id` gates the storefront
    /// endpoints, so update this in step with the `x-paynow-store-id` a test sends.
    pub fn set_store_meta(&self, store_meta: Value) {
        self.lock().store_meta = store_meta;
    }

    /// Queue a fault for the next request to consume (status + verbatim body).
    pub fn push_fault(&self, status: u16, body: &str) {
        self.lock().faults.push_back(Fault {
            status,
            body: body.to_string(),
        });
    }

    /// Every request seen so far, oldest first.
    pub fn requests(&self) -> Vec<RecordedRequest> {
        self.lock().recorded.clone()
    }

    /// Stop serving now (also done on drop).
    pub fn abort(&self) {
        self.handle.abort();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, StubState> {
        self.state.lock().expect("stub state lock")
    }
}

impl Drop for PayNowStub {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

/// Record the request, then short-circuit on a queued fault. `None` means the caller
/// should proceed with normal handling. Kept in one place so every endpoint records and
/// consumes faults identically.
fn record_and_fault(
    state: &Arc<Mutex<StubState>>,
    method: &Method,
    path: &str,
    headers: &HeaderMap,
) -> Option<Response> {
    let mut guard = state.lock().expect("stub state lock");
    let has_auth = headers.contains_key(header::AUTHORIZATION);
    let store_header = headers
        .get("x-paynow-store-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    guard.recorded.push(RecordedRequest {
        method: method.as_str().to_string(),
        path: path.to_string(),
        has_auth,
        store_header,
    });
    guard.faults.pop_front().map(|fault| {
        let status =
            StatusCode::from_u16(fault.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        (status, fault.body).into_response()
    })
}

async fn get_stores(
    State(state): State<Arc<Mutex<StubState>>>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Response {
    if let Some(short) = record_and_fault(&state, &method, uri.path(), &headers) {
        return short;
    }
    let guard = state.lock().expect("stub state lock");
    let expected = format!("apikey {}", guard.expected_api_key);
    let provided = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    if provided != Some(expected.as_str()) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "status": 401,
                "code": "Unauthorized",
                "message": "invalid api key"
            })),
        )
            .into_response();
    }
    Json(guard.stores.clone()).into_response()
}

async fn get_store(
    State(state): State<Arc<Mutex<StubState>>>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Response {
    if let Some(short) = record_and_fault(&state, &method, uri.path(), &headers) {
        return short;
    }
    let guard = state.lock().expect("stub state lock");
    if let Some(bad) = require_store(&guard, &headers) {
        return bad;
    }
    Json(guard.store_meta.clone()).into_response()
}

async fn get_products(
    State(state): State<Arc<Mutex<StubState>>>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Response {
    if let Some(short) = record_and_fault(&state, &method, uri.path(), &headers) {
        return short;
    }
    let guard = state.lock().expect("stub state lock");
    if let Some(bad) = require_store(&guard, &headers) {
        return bad;
    }
    Json(guard.products.clone()).into_response()
}

async fn get_tags(
    State(state): State<Arc<Mutex<StubState>>>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Response {
    if let Some(short) = record_and_fault(&state, &method, uri.path(), &headers) {
        return short;
    }
    let guard = state.lock().expect("stub state lock");
    if let Some(bad) = require_store(&guard, &headers) {
        return bad;
    }
    Json(guard.tags.clone()).into_response()
}

/// Storefront gate: the `x-paynow-store-id` header must equal `store_meta["id"]`. Returns
/// a 400 JSON error response when it is missing or wrong, `None` when it is valid.
fn require_store(state: &StubState, headers: &HeaderMap) -> Option<Response> {
    let want = state.store_meta.get("id").and_then(Value::as_str);
    let got = headers
        .get("x-paynow-store-id")
        .and_then(|v| v.to_str().ok());
    if got.is_some() && got == want {
        return None;
    }
    Some(
        (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "status": 400,
                "code": "BadRequest",
                "message": "missing or invalid store id"
            })),
        )
            .into_response(),
    )
}

/// Default management store list: a single store the key can reach (so `probe` adopts it
/// without an explicit id).
fn default_stores() -> Vec<Value> {
    vec![json!({
        "id": "459276186938060800",
        "name": "ACME Store",
        "currency": "USD",
        "live_mode": false
    })]
}

/// Default storefront store object; its `id` matches the management store above.
fn default_store_meta() -> Value {
    json!({
        "id": "459276186938060800",
        "name": "ACME Store",
        "currency": "USD",
        "live_mode": false,
        "slug": "acme-store"
    })
}

/// Default catalog: a subscription-only rank (with a sale `price_final` below `price`), an
/// out-of-stock one-time kit, and an in-stock one-time coin pack spanning both tags.
fn default_products() -> Vec<Value> {
    vec![
        json!({
            "id": "500000000000000001",
            "slug": "vip",
            "name": "VIP Rank",
            "description": "Priority queue and perks",
            "image_url": "https://cdn.example.test/vip.png",
            "price": 999,
            "currency": "USD",
            "allow_one_time_purchase": false,
            "allow_subscription": true,
            "subscription_interval_value": 1,
            "subscription_interval_scale": "month",
            "pricing": { "price_original": 999, "price_final": 799 },
            "tags": [{ "id": "700000000000000001", "slug": "ranks" }],
            "stock": { "available_to_purchase": true },
            "sort_order": 0
        }),
        json!({
            "id": "500000000000000002",
            "slug": "starter-kit",
            "name": "Starter Kit",
            "description": "One-time boost",
            "price": 500,
            "currency": "USD",
            "allow_one_time_purchase": true,
            "allow_subscription": false,
            "pricing": { "price_original": 500, "price_final": 500 },
            "tags": [{ "id": "700000000000000002", "slug": "currency" }],
            "stock": { "available_to_purchase": false },
            "sort_order": 1
        }),
        json!({
            "id": "500000000000000003",
            "slug": "1000-coins",
            "name": "1000 Coins",
            "description": "In-game currency",
            "price": 250,
            "currency": "USD",
            "allow_one_time_purchase": true,
            "allow_subscription": false,
            "pricing": { "price_original": 250, "price_final": 250 },
            "tags": [
                { "id": "700000000000000001", "slug": "ranks" },
                { "id": "700000000000000002", "slug": "currency" }
            ],
            "stock": { "available_to_purchase": true },
            "sort_order": 2
        }),
    ]
}

/// Default tags, referenced by the default products above.
fn default_tags() -> Vec<Value> {
    vec![
        json!({
            "id": "700000000000000001",
            "slug": "ranks",
            "name": "Ranks",
            "description": "Membership ranks",
            "order": 0
        }),
        json!({
            "id": "700000000000000002",
            "slug": "currency",
            "name": "Currency",
            "description": "In-game currency",
            "order": 1
        }),
    ]
}
