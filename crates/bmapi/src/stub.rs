//! In-process BattleMetrics stub for integration tests (feature `stub`).
//!
//! `BmClient` fetches absolute URLs, so pagination cannot be tested against a fake
//! transport: the stub must run a real socket and emit `links.next` URLs that point
//! back at itself, which the client then GETs verbatim. It binds an ephemeral loopback
//! port, serves the JSON:API shapes `ListDoc<BanAttrs>` / `ListDoc<BanListAttrs>`
//! decode, and records every request so tests can assert retry counts and auth.
//!
//! Two knobs beyond static data: a FIFO of one-shot `Fault`s (each consumed by the next
//! request, ahead of normal handling) for exercising the retry/backoff paths, and the
//! request log. Only reads are wired now; the recorder already keys on method so the
//! later mutation PR (POST/PATCH/DELETE with `needs_verify`) can register verbs against
//! the same `intercept`/`record` machinery.

use axum::extract::{OriginalUri, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use tokio::task::JoinHandle;

/// A ban list as the stub should serve it. Attributes map to [`crate::types::BanListAttrs`].
#[derive(Clone, Debug)]
pub struct StubBanList {
    pub id: String,
    pub name: String,
    pub action: String,
    pub perm_manage: bool,
    pub perm_create: bool,
    pub perm_update: bool,
    pub perm_delete: bool,
}

impl StubBanList {
    /// A list with sensible permission defaults; override the fields as needed.
    pub fn new(id: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            action: "kick".into(),
            perm_manage: false,
            perm_create: true,
            perm_update: true,
            perm_delete: true,
        }
    }
}

/// A ban as the stub should serve it. `identifiers` is a raw JSON array so tests can mix
/// numeric refs (resolved via `included_identifiers`) with inline manual entries; the
/// value is echoed into the ban's `attributes.identifiers` untouched.
#[derive(Clone, Debug)]
pub struct StubBan {
    pub ban_list_id: String,
    pub id: String,
    pub uid: String,
    /// RFC3339. Bans are served newest-first (`sort=-timestamp`) regardless of insertion order.
    pub timestamp: String,
    pub reason: String,
    pub note: String,
    /// `None` = permanent.
    pub expires: Option<String>,
    pub identifiers: Value,
    /// Player-identifier resources emitted under `included` when `include=playerIdentifiers`
    /// is requested: `(resource id, type, identifier value)`.
    pub included_identifiers: Vec<(String, String, String)>,
}

impl StubBan {
    pub fn new(
        ban_list_id: impl Into<String>,
        id: impl Into<String>,
        uid: impl Into<String>,
        timestamp: impl Into<String>,
        reason: impl Into<String>,
    ) -> Self {
        Self {
            ban_list_id: ban_list_id.into(),
            id: id.into(),
            uid: uid.into(),
            timestamp: timestamp.into(),
            reason: reason.into(),
            note: String::new(),
            expires: None,
            identifiers: json!([]),
            included_identifiers: Vec::new(),
        }
    }

    pub fn note(mut self, note: impl Into<String>) -> Self {
        self.note = note.into();
        self
    }

    pub fn expires(mut self, expires: impl Into<String>) -> Self {
        self.expires = Some(expires.into());
        self
    }

    /// Raw `identifiers` array (numeric refs, manual `{type,identifier}` objects, or both).
    pub fn identifiers(mut self, identifiers: Value) -> Self {
        self.identifiers = identifiers;
        self
    }

    /// Included identifier resources this ban's numeric refs point at.
    pub fn included(mut self, included: Vec<(String, String, String)>) -> Self {
        self.included_identifiers = included;
        self
    }
}

/// Everything the stub serves, plus the required bearer token.
#[derive(Clone, Debug, Default)]
pub struct StubData {
    /// Requests must present `Authorization: Bearer {token}`; anything else is 401.
    pub token: String,
    pub ban_lists: Vec<StubBanList>,
    pub bans: Vec<StubBan>,
}

impl StubData {
    pub fn new(token: impl Into<String>) -> Self {
        Self {
            token: token.into(),
            ban_lists: Vec::new(),
            bans: Vec::new(),
        }
    }

    pub fn with_ban_list(mut self, list: StubBanList) -> Self {
        self.ban_lists.push(list);
        self
    }

    pub fn with_ban_lists(mut self, lists: Vec<StubBanList>) -> Self {
        self.ban_lists.extend(lists);
        self
    }

    pub fn with_bans(mut self, bans: Vec<StubBan>) -> Self {
        self.bans.extend(bans);
        self
    }
}

/// A one-shot canned response, consumed by the next request before normal handling.
#[derive(Clone, Debug)]
pub enum Fault {
    /// Reply with this HTTP status and a JSON:API error body.
    Status(u16),
    /// Reply 429, optionally with a `Retry-After` header (seconds).
    RateLimited { retry_after: Option<u64> },
    /// Reply 200 with a body that is not valid JSON (drives the client's decode path).
    Malformed,
}

/// One recorded inbound request. Keyed on method so mutation verbs record uniformly later.
#[derive(Clone, Debug)]
pub struct RecordedRequest {
    pub method: String,
    pub path_and_query: String,
    pub bearer_ok: bool,
}

struct StubState {
    token: String,
    base_url: String,
    ban_lists: Vec<StubBanList>,
    bans: Vec<StubBan>,
    faults: Mutex<VecDeque<Fault>>,
    requests: Mutex<Vec<RecordedRequest>>,
}

impl StubState {
    fn record(&self, method: &str, path_and_query: &str, bearer_ok: bool) {
        self.requests
            .lock()
            .expect("requests lock")
            .push(RecordedRequest {
                method: method.to_string(),
                path_and_query: path_and_query.to_string(),
                bearer_ok,
            });
    }

    fn take_fault(&self) -> Option<Fault> {
        self.faults.lock().expect("faults lock").pop_front()
    }
}

/// A running stub server. Aborts its serve task on drop.
pub struct StubBm {
    base_url: String,
    handle: JoinHandle<()>,
    state: Arc<StubState>,
}

impl StubBm {
    /// Bind an ephemeral loopback port and start serving `data`. Call from within a
    /// tokio runtime (a `#[tokio::test]`).
    pub async fn start(data: StubData) -> StubBm {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind loopback ephemeral port");
        let addr = listener.local_addr().expect("resolve bound address");
        let base_url = format!("http://{addr}");
        let state = Arc::new(StubState {
            token: data.token,
            base_url: base_url.clone(),
            ban_lists: data.ban_lists,
            bans: data.bans,
            faults: Mutex::new(VecDeque::new()),
            requests: Mutex::new(Vec::new()),
        });
        let app = Router::new()
            .route("/ban-lists", get(ban_lists))
            .route("/bans", get(bans))
            .with_state(state.clone());
        let handle = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("stub serve loop");
        });
        StubBm {
            base_url,
            handle,
            state,
        }
    }

    /// `http://127.0.0.1:{port}` — feed this to `BmClient::new`.
    pub fn base_url(&self) -> String {
        self.base_url.clone()
    }

    /// Queue a fault for the next request to consume.
    pub fn push_fault(&self, fault: Fault) {
        self.state
            .faults
            .lock()
            .expect("faults lock")
            .push_back(fault);
    }

    /// Every request seen so far, oldest first.
    pub fn requests(&self) -> Vec<RecordedRequest> {
        self.state.requests.lock().expect("requests lock").clone()
    }

    /// Stop serving now (also done on drop).
    pub fn abort(&self) {
        self.handle.abort();
    }
}

impl Drop for StubBm {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

/// Record the request, then short-circuit on a queued fault or bad token. `None` means
/// the caller should proceed with normal handling.
fn intercept(
    state: &StubState,
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
) -> Option<Response> {
    let path_and_query = uri
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_default();
    let bearer_ok = check_bearer(headers, &state.token);
    state.record(method.as_str(), &path_and_query, bearer_ok);
    if let Some(fault) = state.take_fault() {
        return Some(fault_response(fault));
    }
    if !bearer_ok {
        return Some(unauthorized());
    }
    None
}

async fn ban_lists(
    State(state): State<Arc<StubState>>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Response {
    if let Some(short) = intercept(&state, &method, &uri, &headers) {
        return short;
    }
    let query = parse_query(uri.query());
    let size = page_size(&query);
    let offset = page_offset(&query);
    let total = state.ban_lists.len();
    let end = (offset + size).min(total);
    let slice: &[StubBanList] = if offset < total {
        &state.ban_lists[offset..end]
    } else {
        &[]
    };
    let data: Vec<Value> = slice.iter().map(ban_list_resource).collect();

    let mut doc = json!({ "data": data });
    if end < total {
        let next = format!(
            "{}/ban-lists?page[size]={size}&page[key]={end}",
            state.base_url
        );
        doc["links"] = json!({ "next": next });
    }
    Json(doc).into_response()
}

async fn bans(
    State(state): State<Arc<StubState>>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Response {
    if let Some(short) = intercept(&state, &method, &uri, &headers) {
        return short;
    }
    let query = parse_query(uri.query());
    let size = page_size(&query);
    let offset = page_offset(&query);
    let filter = query.get("filter[banList]").cloned();
    let sort = query.get("sort").cloned();
    let include_ids = query
        .get("include")
        .is_some_and(|v| v.split(',').any(|p| p == "playerIdentifiers"));

    let mut selected: Vec<&StubBan> = state
        .bans
        .iter()
        .filter(|b| filter.as_deref().is_none_or(|f| b.ban_list_id == f))
        .collect();
    // Newest first, matching the client's `sort=-timestamp` iterator order.
    selected.sort_by_key(|b| std::cmp::Reverse(ban_ts(b)));

    let total = selected.len();
    let end = (offset + size).min(total);
    let page: &[&StubBan] = if offset < total {
        &selected[offset..end]
    } else {
        &[]
    };
    let data: Vec<Value> = page.iter().map(|b| ban_resource(b)).collect();

    let mut included: Vec<Value> = Vec::new();
    if include_ids {
        let mut seen = HashSet::new();
        for b in page {
            for (id, kind, value) in &b.included_identifiers {
                if seen.insert(id.clone()) {
                    included.push(json!({
                        "type": "identifier",
                        "id": id,
                        "attributes": { "type": kind, "identifier": value },
                    }));
                }
            }
        }
    }

    let mut doc = json!({ "data": data, "included": included });
    if end < total {
        // Preserve filter/include/sort so following pages keep the same shape.
        let mut q = format!("page[size]={size}");
        if let Some(f) = &filter {
            q.push_str(&format!("&filter[banList]={f}"));
        }
        if include_ids {
            q.push_str("&include=playerIdentifiers");
        }
        if let Some(s) = &sort {
            q.push_str(&format!("&sort={s}"));
        }
        q.push_str(&format!("&page[key]={end}"));
        doc["links"] = json!({ "next": format!("{}/bans?{q}", state.base_url) });
    }
    Json(doc).into_response()
}

fn ban_list_resource(list: &StubBanList) -> Value {
    json!({
        "type": "banList",
        "id": list.id,
        "attributes": {
            "name": list.name,
            "action": list.action,
            "permManage": list.perm_manage,
            "permCreate": list.perm_create,
            "permUpdate": list.perm_update,
            "permDelete": list.perm_delete,
        },
    })
}

fn ban_resource(ban: &StubBan) -> Value {
    let mut attributes = json!({
        "uid": ban.uid,
        "timestamp": ban.timestamp,
        "reason": ban.reason,
        "note": ban.note,
        "expires": ban.expires,
        "orgWide": false,
    });
    attributes["identifiers"] = ban.identifiers.clone();
    json!({
        "type": "ban",
        "id": ban.id,
        "attributes": attributes,
        "relationships": {
            "banList": { "data": { "type": "banList", "id": ban.ban_list_id } },
        },
    })
}

fn fault_response(fault: Fault) -> Response {
    match fault {
        Fault::Status(code) => {
            let status = StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            (status, Json(error_body(code, "stub fault"))).into_response()
        }
        Fault::RateLimited { retry_after } => {
            let mut resp = (
                StatusCode::TOO_MANY_REQUESTS,
                Json(error_body(429, "rate limited")),
            )
                .into_response();
            if let Some(secs) = retry_after {
                resp.headers_mut().insert(
                    header::RETRY_AFTER,
                    HeaderValue::from_str(&secs.to_string())
                        .expect("digits are a valid header value"),
                );
            }
            resp
        }
        // 200 with a non-JSON body: the client succeeds on status, then fails to decode.
        Fault::Malformed => (StatusCode::OK, "this is not json").into_response(),
    }
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(error_body(401, "Unauthorized")),
    )
        .into_response()
}

fn error_body(status: u16, title: &str) -> Value {
    json!({ "errors": [{ "status": status.to_string(), "title": title }] })
}

fn check_bearer(headers: &HeaderMap, token: &str) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v == format!("Bearer {token}"))
}

/// Parse a raw query string into last-value-wins pairs. Inputs are the client's own
/// unescaped URLs (bracketed keys like `page[size]`, no percent-encoding), so no decode.
fn parse_query(query: Option<&str>) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Some(query) = query else {
        return map;
    };
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        map.insert(key.to_string(), value.to_string());
    }
    map
}

fn page_size(query: &HashMap<String, String>) -> usize {
    query
        .get("page[size]")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(100)
        .max(1)
}

fn page_offset(query: &HashMap<String, String>) -> usize {
    query
        .get("page[key]")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(0)
}

/// Parse a ban's RFC3339 timestamp for sorting; unparseable values sort oldest.
fn ban_ts(ban: &StubBan) -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339(&ban.timestamp)
        .map(|t| t.with_timezone(&chrono::Utc))
        .unwrap_or(chrono::DateTime::<chrono::Utc>::MIN_UTC)
}
