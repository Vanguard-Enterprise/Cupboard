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
//! request log. Reads and mutations (`POST`/`PATCH`/`DELETE /bans`) go through the same
//! `intercept`/`record` machinery, so a queued fault or a bad token short-circuits
//! either kind of request identically.

use axum::extract::{OriginalUri, Path, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch};
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
    /// Echoed back as `attributes.orgWide` on GET and mutation responses alike.
    pub org_wide: bool,
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
            org_wide: false,
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

    pub fn org_wide(mut self, org_wide: bool) -> Self {
        self.org_wide = org_wide;
        self
    }

    /// Included identifier resources this ban's numeric refs point at.
    pub fn included(mut self, included: Vec<(String, String, String)>) -> Self {
        self.included_identifiers = included;
        self
    }
}

/// A server as the stub should serve it. Attributes map to [`crate::types::ServerAttrs`].
#[derive(Clone, Debug)]
pub struct StubServer {
    pub id: String,
    pub name: String,
    pub ip: Option<String>,
    pub port: Option<i64>,
    pub port_query: Option<i64>,
}

impl StubServer {
    pub fn new(id: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            ip: None,
            port: None,
            port_query: None,
        }
    }

    pub fn ip(mut self, ip: impl Into<String>) -> Self {
        self.ip = Some(ip.into());
        self
    }

    pub fn port(mut self, port: i64) -> Self {
        self.port = Some(port);
        self
    }

    pub fn port_query(mut self, port_query: i64) -> Self {
        self.port_query = Some(port_query);
        self
    }
}

/// A player as the stub should serve it. `identifiers` is a list of `(kind, value)`
/// pairs emitted as `included` resources of JSON:API type `identifier` and referenced by
/// the player's `identifiers` relationship (only when `include=identifiers` is requested).
#[derive(Clone, Debug)]
pub struct StubPlayer {
    pub id: String,
    pub name: String,
    pub created_at: Option<String>,
    pub identifiers: Vec<(String, String)>,
}

impl StubPlayer {
    pub fn new(id: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            created_at: None,
            identifiers: Vec::new(),
        }
    }

    pub fn created_at(mut self, created_at: impl Into<String>) -> Self {
        self.created_at = Some(created_at.into());
        self
    }

    /// Push one `(kind, value)` identifier, e.g. `("steamID", "7656...")` or `("ip", ...)`.
    pub fn identifier(mut self, kind: impl Into<String>, value: impl Into<String>) -> Self {
        self.identifiers.push((kind.into(), value.into()));
        self
    }
}

/// A player note as the stub should serve it. Attributes map to [`crate::types::NoteAttrs`].
#[derive(Clone, Debug)]
pub struct StubNote {
    pub id: String,
    pub note: String,
    pub created_at: String,
}

impl StubNote {
    pub fn new(
        id: impl Into<String>,
        note: impl Into<String>,
        created_at: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            note: note.into(),
            created_at: created_at.into(),
        }
    }
}

/// Everything the stub serves, plus the required bearer token.
#[derive(Clone, Debug, Default)]
pub struct StubData {
    /// Requests must present `Authorization: Bearer {token}`; anything else is 401.
    pub token: String,
    pub ban_lists: Vec<StubBanList>,
    pub bans: Vec<StubBan>,
    pub servers: Vec<StubServer>,
    pub players: Vec<StubPlayer>,
    /// Notes keyed by BM player id, served from `/players/{id}/relationships/notes`.
    pub notes_by_player: HashMap<String, Vec<StubNote>>,
}

impl StubData {
    pub fn new(token: impl Into<String>) -> Self {
        Self {
            token: token.into(),
            ..Default::default()
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

    pub fn with_servers(mut self, servers: Vec<StubServer>) -> Self {
        self.servers.extend(servers);
        self
    }

    pub fn with_players(mut self, players: Vec<StubPlayer>) -> Self {
        self.players.extend(players);
        self
    }

    pub fn with_notes(mut self, player_id: impl Into<String>, notes: Vec<StubNote>) -> Self {
        self.notes_by_player.insert(player_id.into(), notes);
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

/// One recorded inbound request. Keyed on method so mutation verbs record uniformly.
#[derive(Clone, Debug)]
pub struct RecordedRequest {
    pub method: String,
    pub path_and_query: String,
    pub bearer_ok: bool,
    /// The parsed JSON:API request body for mutation verbs. `None` for GET/DELETE.
    pub body: Option<Value>,
}

struct StubState {
    token: String,
    base_url: String,
    ban_lists: Vec<StubBanList>,
    servers: Vec<StubServer>,
    players: Vec<StubPlayer>,
    notes_by_player: HashMap<String, Vec<StubNote>>,
    bans: Mutex<Vec<StubBan>>,
    /// Source of server-generated ban ids ("srv-ban-<n>"), monotonic for the stub's
    /// whole lifetime regardless of deletions.
    next_ban_id: Mutex<u64>,
    faults: Mutex<VecDeque<Fault>>,
    requests: Mutex<Vec<RecordedRequest>>,
}

impl StubState {
    fn record(&self, method: &str, path_and_query: &str, bearer_ok: bool, body: Option<Value>) {
        self.requests
            .lock()
            .expect("requests lock")
            .push(RecordedRequest {
                method: method.to_string(),
                path_and_query: path_and_query.to_string(),
                bearer_ok,
                body,
            });
    }

    fn take_fault(&self) -> Option<Fault> {
        self.faults.lock().expect("faults lock").pop_front()
    }

    /// Next server-generated ban id/uid suffix, monotonically increasing.
    fn next_ban_seq(&self) -> u64 {
        let mut seq = self.next_ban_id.lock().expect("seq lock");
        let n = *seq;
        *seq += 1;
        n
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
            servers: data.servers,
            players: data.players,
            notes_by_player: data.notes_by_player,
            bans: Mutex::new(data.bans),
            next_ban_id: Mutex::new(1),
            faults: Mutex::new(VecDeque::new()),
            requests: Mutex::new(Vec::new()),
        });
        let app = Router::new()
            .route("/ban-lists", get(ban_lists))
            .route("/bans", get(bans).post(create_ban))
            .route("/bans/{id}", patch(patch_ban).delete(delete_ban))
            .route("/servers", get(servers))
            .route("/players", get(players))
            .route("/players/{id}/relationships/notes", get(player_notes))
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

    /// Replace the whole ban dataset wholesale, e.g. to simulate a BM-side change
    /// without restarting the stub.
    pub fn set_bans(&self, bans: Vec<StubBan>) {
        *self.state.bans.lock().expect("bans lock") = bans;
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
    body: Option<&Value>,
) -> Option<Response> {
    let path_and_query = uri
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_default();
    let bearer_ok = check_bearer(headers, &state.token);
    state.record(method.as_str(), &path_and_query, bearer_ok, body.cloned());
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
    if let Some(short) = intercept(&state, &method, &uri, &headers, None) {
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
    if let Some(short) = intercept(&state, &method, &uri, &headers, None) {
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

    let stored = state.bans.lock().expect("bans lock");
    let mut selected: Vec<&StubBan> = stored
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

async fn servers(
    State(state): State<Arc<StubState>>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Response {
    if let Some(short) = intercept(&state, &method, &uri, &headers, None) {
        return short;
    }
    // filter[organizations] is ignored: the stub serves one org's worth of data.
    let query = parse_query(uri.query());
    let size = page_size(&query);
    let offset = page_offset(&query);
    let total = state.servers.len();
    let end = (offset + size).min(total);
    let slice: &[StubServer] = if offset < total {
        &state.servers[offset..end]
    } else {
        &[]
    };
    let data: Vec<Value> = slice.iter().map(server_resource).collect();

    let mut doc = json!({ "data": data });
    if end < total {
        let next = format!(
            "{}/servers?page[size]={size}&page[key]={end}",
            state.base_url
        );
        doc["links"] = json!({ "next": next });
    }
    Json(doc).into_response()
}

async fn players(
    State(state): State<Arc<StubState>>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Response {
    if let Some(short) = intercept(&state, &method, &uri, &headers, None) {
        return short;
    }
    let query = parse_query(uri.query());
    let size = page_size(&query);
    let offset = page_offset(&query);
    let include_ids = query
        .get("include")
        .is_some_and(|v| v.split(',').any(|p| p == "identifiers"));

    let total = state.players.len();
    let end = (offset + size).min(total);
    let page: &[StubPlayer] = if offset < total {
        &state.players[offset..end]
    } else {
        &[]
    };

    // Identifier resources get response-unique ids the player's relationship references.
    let mut seq = 1u64;
    let mut included: Vec<Value> = Vec::new();
    let data: Vec<Value> = page
        .iter()
        .map(|p| {
            let mut refs: Vec<Value> = Vec::new();
            for (kind, value) in &p.identifiers {
                let rid = seq.to_string();
                seq += 1;
                refs.push(json!({ "type": "identifier", "id": rid }));
                if include_ids {
                    included.push(json!({
                        "type": "identifier",
                        "id": rid,
                        "attributes": { "type": kind, "identifier": value },
                    }));
                }
            }
            player_resource(p, refs)
        })
        .collect();

    let mut doc = json!({ "data": data, "included": included });
    if end < total {
        let mut q = format!("page[size]={size}");
        if include_ids {
            q.push_str("&include=identifiers");
        }
        q.push_str(&format!("&page[key]={end}"));
        doc["links"] = json!({ "next": format!("{}/players?{q}", state.base_url) });
    }
    Json(doc).into_response()
}

async fn player_notes(
    State(state): State<Arc<StubState>>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Some(short) = intercept(&state, &method, &uri, &headers, None) {
        return short;
    }
    let query = parse_query(uri.query());
    let size = page_size(&query);
    let offset = page_offset(&query);
    let empty = Vec::new();
    let notes = state.notes_by_player.get(&id).unwrap_or(&empty);
    let total = notes.len();
    let end = (offset + size).min(total);
    let slice: &[StubNote] = if offset < total {
        &notes[offset..end]
    } else {
        &[]
    };
    let data: Vec<Value> = slice.iter().map(note_resource).collect();

    let mut doc = json!({ "data": data });
    if end < total {
        let next = format!(
            "{}/players/{id}/relationships/notes?page[size]={size}&page[key]={end}",
            state.base_url
        );
        doc["links"] = json!({ "next": next });
    }
    Json(doc).into_response()
}

async fn create_ban(
    State(state): State<Arc<StubState>>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Some(short) = intercept(&state, &method, &uri, &headers, Some(&body)) {
        return short;
    }
    let attrs = &body["data"]["attributes"];
    let ban_list_id = body["data"]["relationships"]["banList"]["data"]["id"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let reason = attrs
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let note = attrs
        .get("note")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let expires = attrs
        .get("expires")
        .and_then(Value::as_str)
        .map(str::to_string);
    let identifiers = attrs
        .get("identifiers")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let org_wide = attrs
        .get("orgWide")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let seq = state.next_ban_seq();
    let mut ban = StubBan::new(
        ban_list_id,
        format!("srv-ban-{seq}"),
        format!("srv-uid-{seq}"),
        synthetic_created_ts(seq),
        reason,
    )
    .note(note)
    .identifiers(identifiers)
    .org_wide(org_wide);
    if let Some(expires) = expires {
        ban = ban.expires(expires);
    }

    let resource = ban_resource(&ban);
    state.bans.lock().expect("bans lock").push(ban);

    (StatusCode::CREATED, Json(json!({ "data": resource }))).into_response()
}

async fn delete_ban(
    State(state): State<Arc<StubState>>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Some(short) = intercept(&state, &method, &uri, &headers, None) {
        return short;
    }
    let mut stored = state.bans.lock().expect("bans lock");
    let before = stored.len();
    stored.retain(|b| b.id != id);
    if stored.len() < before {
        StatusCode::NO_CONTENT.into_response()
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(error_body(404, "ban not found")),
        )
            .into_response()
    }
}

async fn patch_ban(
    State(state): State<Arc<StubState>>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    if let Some(short) = intercept(&state, &method, &uri, &headers, Some(&body)) {
        return short;
    }
    let attrs = &body["data"]["attributes"];
    let mut stored = state.bans.lock().expect("bans lock");
    let Some(ban) = stored.iter_mut().find(|b| b.id == id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(error_body(404, "ban not found")),
        )
            .into_response();
    };
    if let Some(v) = attrs.get("expires") {
        ban.expires = v.as_str().map(str::to_string);
    }
    if let Some(v) = attrs.get("reason").and_then(Value::as_str) {
        ban.reason = v.to_string();
    }
    if let Some(v) = attrs.get("note").and_then(Value::as_str) {
        ban.note = v.to_string();
    }
    if let Some(v) = attrs.get("orgWide").and_then(Value::as_bool) {
        ban.org_wide = v;
    }
    if let Some(v) = attrs.get("identifiers") {
        ban.identifiers = v.clone();
    }
    let resource = ban_resource(ban);
    Json(json!({ "data": resource })).into_response()
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
        "orgWide": ban.org_wide,
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

fn server_resource(s: &StubServer) -> Value {
    json!({
        "type": "server",
        "id": s.id,
        "attributes": {
            "name": s.name,
            "ip": s.ip,
            "port": s.port,
            "portQuery": s.port_query,
        },
    })
}

fn player_resource(p: &StubPlayer, identifier_refs: Vec<Value>) -> Value {
    json!({
        "type": "player",
        "id": p.id,
        "attributes": {
            "name": p.name,
            "createdAt": p.created_at,
        },
        "relationships": {
            "identifiers": { "data": identifier_refs },
        },
    })
}

fn note_resource(n: &StubNote) -> Value {
    json!({
        "type": "playerNote",
        "id": n.id,
        "attributes": {
            "note": n.note,
            "createdAt": n.created_at,
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

/// A fixed-but-increasing synthetic timestamp for server-generated bans (well past any
/// fixture data), so creation order stays deterministic across test runs.
fn synthetic_created_ts(seq: u64) -> String {
    let base = chrono::DateTime::parse_from_rfc3339("2030-01-01T00:00:00Z").expect("valid literal");
    (base + chrono::Duration::seconds(seq as i64))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
