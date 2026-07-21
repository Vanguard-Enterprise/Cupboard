//! /api/v1 middleware + facade tests: drive the real router (require_api_key ->
//! rate_limit -> typed handler) with tower::oneshot against stub auth/identity
//! services on ephemeral ports. Redis-backed limiter tests use the local throwaway
//! harness (`TEST_REDIS_URL`) and SKIP when it's absent; everything else needs no
//! external services.

use crate::api_v1;
use crate::AppState;
use axum::body::Body;
use axum::http::{header, HeaderMap, Request, StatusCode};
use axum::response::IntoResponse;
use axum::{Json, Router};
use cupboard_auth_core::{Claims, Keys};
use cupboard_domain::{OrgId, UserId};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tower::ServiceExt as _;
use uuid::Uuid;

// A throwaway Ed25519 keypair for tests only (the auth-core test pair; openssl
// genpkey -algorithm ed25519). Never used outside tests.
const TEST_PRIVATE_PEM: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIKfwTrhSm/f0QxY6e5mzQ+iTAvdyp3omCt4lyOjWItDm\n-----END PRIVATE KEY-----\n";
const TEST_PUBLIC_PEM: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAyKMiwFH0hHn4HiPl8DTEq+aPzW9XyzG5v1ELTEVNsbY=\n-----END PUBLIC KEY-----\n";

const INTERNAL_TOKEN: &str = "test-internal-token";
/// A port nothing listens on (chargen, never running locally).
const DEAD_URL: &str = "http://127.0.0.1:19";

/// Full signer+verifier: tests mint the "auth-side" JWT with the same key set the
/// gateway state verifies with.
fn keys() -> Arc<Keys> {
    Arc::new(Keys::from_ed_pem(TEST_PRIVATE_PEM, TEST_PUBLIC_PEM).expect("test keypair"))
}

/// A JWT shaped like the exchange mint (decision M): sub = sid = key id, org = key
/// org, perms = effective scopes, kind = api_key, plan absent (= Free tier).
fn mint_jwt(keys: &Keys, org: Uuid, perms: &[&str], ttl_secs: i64) -> String {
    let key_id = Uuid::new_v4();
    let mut claims = Claims::new(
        UserId(key_id),
        key_id,
        Some(OrgId(org)),
        perms.iter().map(|p| p.to_string()).collect(),
        ttl_secs,
    );
    claims.kind = Some("api_key".into());
    keys.encode(&claims).expect("sign test jwt")
}

/// How the stub auth service answers the exchange.
#[derive(Clone)]
enum ExchangeMode {
    /// Always 401 (unknown/revoked key).
    Reject,
    /// Always 200 with this minted JWT.
    Mint(String),
    /// The given failure status on the first call, then 200 with this JWT (auth or
    /// the internal channel recovering).
    FailThenMint(StatusCode, String),
}

/// Spawn a stub auth service; returns (base_url, exchange-call counter).
async fn stub_auth(mode: ExchangeMode) -> (String, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let app = Router::new().route(
        "/internal/api-keys/exchange",
        axum::routing::post(move |headers: HeaderMap, _body: Json<Value>| {
            let mode = mode.clone();
            let counter = counter.clone();
            async move {
                let n = counter.fetch_add(1, Ordering::SeqCst);
                if headers
                    .get("x-internal-token")
                    .and_then(|h| h.to_str().ok())
                    != Some(INTERNAL_TOKEN)
                {
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(json!({"error": "internal", "message": "bad internal token"})),
                    )
                        .into_response();
                }
                match mode {
                    ExchangeMode::Reject => (
                        StatusCode::UNAUTHORIZED,
                        Json(json!({"error": "unauthorized", "message": "invalid API key"})),
                    )
                        .into_response(),
                    ExchangeMode::Mint(jwt) => Json(json!({ "token": jwt })).into_response(),
                    ExchangeMode::FailThenMint(status, jwt) => {
                        if n == 0 {
                            (status, Json(json!({"error": "error", "message": "boom"})))
                                .into_response()
                        } else {
                            Json(json!({ "token": jwt })).into_response()
                        }
                    }
                }
            }
        }),
    );
    (serve(app).await, calls)
}

/// Spawn a stub identity service serving GET /bans; returns (base_url, the last
/// Authorization header it saw).
async fn stub_identity() -> (String, Arc<Mutex<Option<String>>>) {
    let seen_auth = Arc::new(Mutex::new(None::<String>));
    let seen = seen_auth.clone();
    let app = Router::new().route(
        "/bans",
        axum::routing::get(move |headers: HeaderMap| {
            let seen = seen.clone();
            async move {
                *seen.lock().unwrap() = headers
                    .get(header::AUTHORIZATION)
                    .and_then(|h| h.to_str().ok())
                    .map(str::to_owned);
                Json(json!([{
                    "id": "0198c0de-0000-7000-8000-000000000001",
                    "subject_type": "steam",
                    "subject_value": "76561198000000000",
                    "player_id": null,
                    "scope": "network",
                    "server_id": null,
                    "reason": "cheating",
                    "issued_by": "0198c0de-0000-7000-8000-000000000002",
                    "issued_at": "2026-07-14T00:00:00Z",
                    "expires_at": null,
                    "status": "active",
                    "revoked_at": null,
                    "revoke_reason": null,
                    "origin": "manual"
                }]))
            }
        }),
    );
    (serve(app).await, seen_auth)
}

/// Spawn a stub identity service for the ban WRITE paths: POST /bans captures the
/// forwarded (facade-resolved) body and answers 201; POST /bans/{id}/revoke answers
/// identity's 404 envelope (no active ban).
async fn stub_identity_ban_writes() -> (String, Arc<Mutex<Option<Value>>>) {
    let seen_body = Arc::new(Mutex::new(None::<Value>));
    let seen = seen_body.clone();
    let app = Router::new()
        .route(
            "/bans",
            axum::routing::post(move |Json(body): Json<Value>| {
                let seen = seen.clone();
                async move {
                    *seen.lock().unwrap() = Some(body.clone());
                    (
                        StatusCode::CREATED,
                        Json(json!({
                            "id": "0198c0de-0000-7000-8000-000000000001",
                            "subject_type": body["subject_type"],
                            "subject_value": body["subject_value"],
                            "player_id": null,
                            "scope": body["scope"],
                            "server_id": null,
                            "reason": body["reason"],
                            "issued_by": "0198c0de-0000-7000-8000-000000000002",
                            "issued_at": "2026-07-14T00:00:00Z",
                            "expires_at": null,
                            "status": "active",
                            "revoked_at": null,
                            "revoke_reason": null,
                            "origin": "manual"
                        })),
                    )
                }
            }),
        )
        .route(
            "/bans/{id}/revoke",
            axum::routing::post(|| async {
                (
                    StatusCode::NOT_FOUND,
                    Json(json!({"error": "not_found", "message": "active ban not found"})),
                )
            }),
        );
    (serve(app).await, seen_body)
}

/// Spawn a stub identity service serving the player read paths WITH PII present
/// everywhere. Real identity nulls the list `ip` AND the profile session ips itself
/// without `players.view_pii` (only `identifiers[].value` is identity-ungated);
/// returning them all populated is adversarial, proving each facade gate nulls its
/// field by itself: load-bearing for identifier values, redundant depth for ips.
async fn stub_identity_players() -> String {
    let app = Router::new()
        .route(
            "/players",
            axum::routing::get(|| async {
                Json(json!([{
                    "player_id": "0198c0de-0000-7000-8000-0000000000aa",
                    "display_id": 1234,
                    "name": "Rusty",
                    "ip": "203.0.113.9",
                    "online": true,
                    "server_id": "0198c0de-0000-7000-8000-0000000000bb",
                    "connected_at": "2026-07-14T00:00:00Z",
                    "last_seen_at": "2026-07-14T01:00:00Z"
                }]))
            }),
        )
        .route(
            "/players/{id}",
            axum::routing::get(|| async {
                Json(json!({
                    "player": {
                        "id": "0198c0de-0000-7000-8000-0000000000aa",
                        "display_id": 1234,
                        "status": "active",
                        "first_seen_at": "2026-07-01T00:00:00Z",
                        "last_seen_at": "2026-07-14T01:00:00Z"
                    },
                    "identifiers": [
                        {"type": "steam", "value": "76561198000000000",
                         "last_seen_at": "2026-07-14T01:00:00Z"}
                    ],
                    "names": [{"name": "Rusty", "last_seen_at": "2026-07-14T01:00:00Z"}],
                    "recent_sessions": [{
                        "server_id": "0198c0de-0000-7000-8000-0000000000bb",
                        "name": "Rusty",
                        "ip": "203.0.113.9",
                        "connected_at": "2026-07-14T00:00:00Z",
                        "disconnected_at": null
                    }],
                    "links": [{
                        "other_player_id": "0198c0de-0000-7000-8000-0000000000cc",
                        "other_display_id": 77,
                        "confidence": 0.9,
                        "signals": "{\"shared_ip\":true}"
                    }],
                    "playtime": [{
                        "server_id": "0198c0de-0000-7000-8000-0000000000bb",
                        "total_secs": 3600,
                        "sessions": 2
                    }],
                    "reports_against": [{
                        "id": "0198c0de-0000-7000-8000-0000000000dd",
                        "server_id": "0198c0de-0000-7000-8000-0000000000bb",
                        "reporter_player_id": null,
                        "target_player_id": "0198c0de-0000-7000-8000-0000000000aa",
                        "reporter_name": "Watcher",
                        "target_name": "Rusty",
                        "subject": "cheating",
                        "message": "aimbot",
                        "report_type": "cheat",
                        "reported_at": "2026-07-13T00:00:00Z"
                    }]
                }))
            }),
        );
    serve(app).await
}

/// Spawn a stub fleet service serving GET /fleet/servers with the FULL internal
/// `Server` shape, rcon and ingest fields included: proves the facade trims them.
async fn stub_fleet() -> String {
    let app = Router::new().route(
        "/fleet/servers",
        axum::routing::get(|| async {
            Json(json!([{
                "id": "0198c0de-0000-7000-8000-0000000000ee",
                "tenant_id": "0198c0de-0000-7000-8000-0000000000ff",
                "name": "Main",
                "game": "rust",
                "rcon_host": "10.0.0.5",
                "rcon_port": 28016,
                "query_port": 28017,
                "enabled": true,
                "connection_status": "connected",
                "last_seen_at": "2026-07-14T01:00:00Z",
                "last_error": "boom",
                "info_hostname": "My Rust Server",
                "info_map": "Procedural Map",
                "info_players": 42,
                "info_max_players": 100,
                "info_queued": 0,
                "info_updated_at": "2026-07-14T01:00:00Z",
                "has_ingest_token": true,
                "ingest_token_created_at": "2026-07-01T00:00:00Z",
                "created_at": "2026-06-01T00:00:00Z",
                "updated_at": "2026-07-14T01:00:00Z"
            }]))
        }),
    );
    serve(app).await
}

/// Spawn a stub tenant service serving GET /store/entitlements in tenant's wrapped
/// `{"entitlements": [...]}` shape; returns (base_url, the last query string it saw).
async fn stub_tenant() -> (String, Arc<Mutex<Option<String>>>) {
    let seen_query = Arc::new(Mutex::new(None::<String>));
    let seen = seen_query.clone();
    let app = Router::new().route(
        "/store/entitlements",
        axum::routing::get(move |axum::extract::RawQuery(q): axum::extract::RawQuery| {
            let seen = seen.clone();
            async move {
                *seen.lock().unwrap() = q;
                Json(json!({
                    "entitlements": [{
                        "steam_id": "76561198000000000",
                        "product_name": "VIP",
                        "kind": "subscription",
                        "status": "active",
                        "granted_at": "2026-07-01T00:00:00Z",
                        "expires_at": null,
                        "source": "webhook",
                        "updated_at": "2026-07-14T00:00:00Z"
                    }]
                }))
            }
        }),
    );
    (serve(app).await, seen_query)
}

async fn serve(app: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

fn test_state(auth_url: &str, identity_url: &str, redis_url: Option<&str>) -> AppState {
    AppState {
        // Lazy pool: never connected: these tests exercise no DB path.
        pool: sqlx::PgPool::connect_lazy("postgres://unused:unused@127.0.0.1:1/unused").unwrap(),
        environment: "test".into(),
        keys: Some(keys()),
        http: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap(),
        auth_service_url: auth_url.into(),
        fleet_service_url: DEAD_URL.into(),
        identity_service_url: identity_url.into(),
        collector_service_url: DEAD_URL.into(),
        metrics_service_url: DEAD_URL.into(),
        tenant_service_url: DEAD_URL.into(),
        internal_api_token: Some(INTERNAL_TOKEN.into()),
        key_cache: Arc::new(api_v1::key_auth::KeyCache::default()),
        limiter: match redis_url {
            Some(url) => api_v1::rate_limit::Limiter::new(url).unwrap(),
            None => api_v1::rate_limit::Limiter::disabled(),
        },
    }
}

fn app(state: AppState) -> Router {
    api_v1::router(state.clone()).with_state(state)
}

fn get_bans(bearer: Option<&str>) -> Request<Body> {
    let mut req = Request::builder().uri("/api/v1/bans").method("GET");
    if let Some(b) = bearer {
        req = req.header(header::AUTHORIZATION, format!("Bearer {b}"));
    }
    req.body(Body::empty()).unwrap()
}

fn api_req(method: &str, uri: &str, bearer: &str, body: Option<Value>) -> Request<Body> {
    let mut req = Request::builder()
        .uri(uri)
        .method(method)
        .header(header::AUTHORIZATION, format!("Bearer {bearer}"));
    let body = match body {
        Some(v) => {
            req = req.header(header::CONTENT_TYPE, "application/json");
            Body::from(serde_json::to_vec(&v).unwrap())
        }
        None => Body::empty(),
    };
    req.body(body).unwrap()
}

async fn call(app: &Router, req: Request<Body>) -> (StatusCode, HeaderMap, Value) {
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let headers = resp.headers().clone();
    let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20)
        .await
        .unwrap();
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, headers, body)
}

fn assert_envelope(body: &Value, code: &str) {
    assert_eq!(body["error"].as_str(), Some(code), "envelope: {body}");
    assert!(
        body["message"].as_str().is_some_and(|m| !m.is_empty()),
        "envelope message: {body}"
    );
}

#[tokio::test]
async fn non_api_key_bearers_are_401_in_the_envelope() {
    // Auth is a dead port: these must be rejected before any exchange is attempted.
    let app = app(test_state(DEAD_URL, DEAD_URL, None));

    for bearer in [None, Some("nope"), Some("eyJhbGciOiJFZERTQSJ9.e30.sig")] {
        let (status, _, body) = call(&app, get_bans(bearer)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "bearer {bearer:?}");
        assert_envelope(&body, "unauthorized");
    }
}

#[tokio::test]
async fn auth_rejections_are_negative_cached_by_token_hash() {
    let (auth_url, calls) = stub_auth(ExchangeMode::Reject).await;
    let app = app(test_state(&auth_url, DEAD_URL, None));

    // Same garbage key twice: one exchange, both 401.
    for _ in 0..2 {
        let (status, _, body) = call(&app, get_bans(Some("cb_bogus"))).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_envelope(&body, "unauthorized");
    }
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "second 401 must come from cache"
    );

    // A different key is a different hash: it gets its own (single) exchange.
    let (status, _, _) = call(&app, get_bans(Some("cb_other"))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn cached_jwt_is_reused_and_bans_reshape_through_the_facade() {
    let org = Uuid::new_v4();
    let jwt = mint_jwt(&keys(), org, &["bans.view"], 300);
    let (auth_url, calls) = stub_auth(ExchangeMode::Mint(jwt.clone())).await;
    let (identity_url, seen_auth) = stub_identity().await;
    let app = app(test_state(&auth_url, &identity_url, None));

    for _ in 0..2 {
        let (status, _, body) = call(&app, get_bans(Some("cb_valid_key"))).await;
        assert_eq!(status, StatusCode::OK);
        let bans = body.as_array().expect("json array");
        assert_eq!(bans.len(), 1);
        assert_eq!(bans[0]["subject_type"].as_str(), Some("steam"));
        assert_eq!(bans[0]["status"].as_str(), Some("active"));
        // Nullable fields survive the DTO round trip as explicit nulls.
        assert!(bans[0]["expires_at"].is_null());
        assert_eq!(bans[0]["origin"].as_str(), Some("manual"));
    }
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "second request must hit the cache"
    );

    // Identity received the MINTED JWT as its bearer, not the raw cb_ key.
    let forwarded = seen_auth
        .lock()
        .unwrap()
        .clone()
        .expect("identity saw auth header");
    assert_eq!(forwarded, format!("Bearer {jwt}"));
}

#[tokio::test]
async fn missing_scope_is_403_in_the_envelope() {
    let jwt = mint_jwt(&keys(), Uuid::new_v4(), &["players.view"], 300);
    let (auth_url, _) = stub_auth(ExchangeMode::Mint(jwt)).await;
    let app = app(test_state(&auth_url, DEAD_URL, None));

    let (status, _, body) = call(&app, get_bans(Some("cb_scoped_key"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_envelope(&body, "forbidden");
}

#[tokio::test]
async fn exchange_failures_are_503_and_never_negative_cached() {
    // Auth entirely unreachable: 503, not 401.
    let app_dead = app(test_state(DEAD_URL, DEAD_URL, None));
    let (status, _, body) = call(&app_dead, get_bans(Some("cb_key"))).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_envelope(&body, "unavailable");

    // Auth fails once, then recovers: the failure must not have been cached as a
    // 401, so the SAME key succeeds on the very next request. 500 = auth erroring;
    // 403 = auth rejecting the gateway's own x-internal-token (a broken internal
    // channel, not a key verdict): both map to 503 with NO cache entry.
    for failure in [StatusCode::INTERNAL_SERVER_ERROR, StatusCode::FORBIDDEN] {
        let jwt = mint_jwt(&keys(), Uuid::new_v4(), &["bans.view"], 300);
        let (auth_url, calls) = stub_auth(ExchangeMode::FailThenMint(failure, jwt)).await;
        let (identity_url, _) = stub_identity().await;
        let app = app(test_state(&auth_url, &identity_url, None));

        let (status, _, body) = call(&app, get_bans(Some("cb_flaky"))).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "auth {failure}");
        assert_envelope(&body, "unavailable");

        let (status, _, _) = call(&app, get_bans(Some("cb_flaky"))).await;
        assert_eq!(status, StatusCode::OK, "auth {failure} must not be cached");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}

#[tokio::test]
async fn docs_routes_are_served_without_an_api_key() {
    let app = app(test_state(DEAD_URL, DEAD_URL, None));

    let (status, _, body) = call(
        &app,
        Request::get("/api/v1/openapi.json")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // Every v1 operation must be documented: 7 operations across 6 paths.
    for (path, ops) in [
        ("/api/v1/bans", &["get", "post"][..]),
        ("/api/v1/bans/{id}/revoke", &["post"]),
        ("/api/v1/players", &["get"]),
        ("/api/v1/players/{id}", &["get"]),
        ("/api/v1/servers", &["get"]),
        ("/api/v1/entitlements", &["get"]),
    ] {
        for op in ops {
            assert!(
                body["paths"][path][op].is_object(),
                "openapi must document {op} {path}"
            );
        }
    }
    // ... along with the schemas the operations reference.
    for schema in [
        "BanDto",
        "CreateBanRequestDto",
        "RevokeBanRequestDto",
        "PlayerDto",
        "PlayerProfileDto",
        "ServerDto",
        "EntitlementDto",
        "ErrorBody",
    ] {
        assert!(
            body["components"]["schemas"][schema].is_object(),
            "openapi must define the {schema} schema"
        );
    }

    let resp = app
        .clone()
        .oneshot(Request::get("/api/v1/docs").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn limiter_fails_open_when_redis_is_unreachable() {
    let jwt = mint_jwt(&keys(), Uuid::new_v4(), &["bans.view"], 300);
    let (auth_url, _) = stub_auth(ExchangeMode::Mint(jwt)).await;
    let (identity_url, _) = stub_identity().await;
    // A dead Redis port: the limiter must fail OPEN, not 5xx.
    let app = app(test_state(
        &auth_url,
        &identity_url,
        Some("redis://127.0.0.1:19"),
    ));

    let (status, headers, _) = call(&app, get_bans(Some("cb_key"))).await;
    assert_eq!(status, StatusCode::OK);
    // No X-RateLimit-* headers when nothing was actually counted.
    assert!(headers.get("x-ratelimit-limit").is_none());
}

#[tokio::test]
async fn free_tier_limit_enforced_exactly_at_the_boundary() {
    let Ok(redis_url) = std::env::var("TEST_REDIS_URL") else {
        eprintln!("SKIP free_tier_limit_enforced_exactly_at_the_boundary: TEST_REDIS_URL unset");
        return;
    };

    let org = Uuid::new_v4(); // fresh org = fresh rate-limit keys
    let jwt = mint_jwt(&keys(), org, &["bans.view"], 300); // plan absent = Free (60/min)
    let (auth_url, _) = stub_auth(ExchangeMode::Mint(jwt)).await;
    let (identity_url, _) = stub_identity().await;
    let app = app(test_state(&auth_url, &identity_url, Some(&redis_url)));

    // Fixed windows: if the minute boundary is imminent, wait it out so all 61 calls
    // land in one window.
    let into_window = chrono::Utc::now().timestamp() % 60;
    if into_window > 54 {
        tokio::time::sleep(std::time::Duration::from_secs(
            (60 - into_window + 1) as u64,
        ))
        .await;
    }

    for i in 1..=60_i64 {
        let (status, headers, _) = call(&app, get_bans(Some("cb_key"))).await;
        assert_eq!(status, StatusCode::OK, "call {i} must be under the limit");
        assert_eq!(
            headers.get("x-ratelimit-limit").unwrap().to_str().unwrap(),
            "60"
        );
        assert_eq!(
            headers
                .get("x-ratelimit-remaining")
                .unwrap()
                .to_str()
                .unwrap(),
            (60 - i).to_string(),
            "remaining after call {i}"
        );
    }

    // The 61st call in the window: 429 with Retry-After + X-RateLimit-* headers.
    let before = chrono::Utc::now().timestamp();
    let (status, headers, body) = call(&app, get_bans(Some("cb_key"))).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_envelope(&body, "too_many_requests");

    let retry_after: i64 = headers
        .get("retry-after")
        .unwrap()
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!((1..=60).contains(&retry_after), "retry-after {retry_after}");
    assert_eq!(
        headers.get("x-ratelimit-limit").unwrap().to_str().unwrap(),
        "60"
    );
    assert_eq!(
        headers
            .get("x-ratelimit-remaining")
            .unwrap()
            .to_str()
            .unwrap(),
        "0"
    );
    let reset: i64 = headers
        .get("x-ratelimit-reset")
        .unwrap()
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!(
        reset > before && reset <= before + 60,
        "reset {reset} must be the end of the current window (now {before})"
    );
    // Retry-After is exactly the seconds until the reset instant (modulo the test's
    // own elapsed time).
    let now = chrono::Utc::now().timestamp();
    assert!((reset - now - retry_after).abs() <= 2);
}

#[tokio::test]
async fn every_endpoint_gates_its_scope_with_the_403_envelope() {
    // A key with NO scopes: each endpoint must refuse at the facade, in the envelope,
    // without touching its downstream (identity/fleet/tenant are dead ports).
    let jwt = mint_jwt(&keys(), Uuid::new_v4(), &[], 300);
    let (auth_url, _) = stub_auth(ExchangeMode::Mint(jwt)).await;
    let app = app(test_state(&auth_url, DEAD_URL, None));

    let ban_id = "0198c0de-0000-7000-8000-000000000001";
    for (method, uri) in [
        ("GET", "/api/v1/bans".to_string()),
        ("POST", "/api/v1/bans".to_string()),
        ("POST", format!("/api/v1/bans/{ban_id}/revoke")),
        ("GET", "/api/v1/players".to_string()),
        ("GET", format!("/api/v1/players/{ban_id}")),
        ("GET", "/api/v1/servers".to_string()),
        ("GET", "/api/v1/entitlements".to_string()),
    ] {
        let (status, _, body) = call(&app, api_req(method, &uri, "cb_unscoped", None)).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}");
        assert_envelope(&body, "forbidden");
    }
}

#[tokio::test]
async fn create_ban_forwards_resolved_defaults_and_returns_201() {
    let jwt = mint_jwt(&keys(), Uuid::new_v4(), &["bans.create"], 300);
    let (auth_url, _) = stub_auth(ExchangeMode::Mint(jwt)).await;
    let (identity_url, seen_body) = stub_identity_ban_writes().await;
    let app = app(test_state(&auth_url, &identity_url, None));

    // Minimal body: the facade must resolve and forward the documented defaults.
    let (status, _, body) = call(
        &app,
        api_req(
            "POST",
            "/api/v1/bans",
            "cb_key",
            Some(json!({"subject_value": "76561198000000000"})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["subject_type"].as_str(), Some("steam"));
    assert_eq!(body["scope"].as_str(), Some("network"));
    assert_eq!(body["status"].as_str(), Some("active"));

    let forwarded = seen_body
        .lock()
        .unwrap()
        .clone()
        .expect("identity saw body");
    assert_eq!(forwarded["subject_type"].as_str(), Some("steam"));
    assert_eq!(forwarded["scope"].as_str(), Some("network"));
    assert_eq!(
        forwarded["subject_value"].as_str(),
        Some("76561198000000000")
    );

    // A malformed body is refused at the facade, in the envelope (not axum's
    // plain-text rejection).
    let (status, _, body) = call(
        &app,
        api_req("POST", "/api/v1/bans", "cb_key", Some(json!({"scope": 7}))),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_envelope(&body, "bad_request");
}

#[tokio::test]
async fn revoke_ban_passes_identitys_404_through() {
    let jwt = mint_jwt(&keys(), Uuid::new_v4(), &["bans.revoke"], 300);
    let (auth_url, _) = stub_auth(ExchangeMode::Mint(jwt)).await;
    let (identity_url, _) = stub_identity_ban_writes().await;
    let app = app(test_state(&auth_url, &identity_url, None));

    // No request body at all: the body is optional on both sides.
    let (status, _, body) = call(
        &app,
        api_req(
            "POST",
            "/api/v1/bans/0198c0de-0000-7000-8000-000000000009/revoke",
            "cb_key",
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // Identity's envelope, verbatim.
    assert_envelope(&body, "not_found");
    assert_eq!(body["message"].as_str(), Some("active ban not found"));
}

#[tokio::test]
async fn player_list_ip_is_nulled_without_view_pii() {
    let identity_url = stub_identity_players().await;

    // Without players.view_pii: the facade nulls ip even though the stub sent one.
    let jwt = mint_jwt(&keys(), Uuid::new_v4(), &["players.view"], 300);
    let (auth_url, _) = stub_auth(ExchangeMode::Mint(jwt)).await;
    let app_nopii = app(test_state(&auth_url, &identity_url, None));
    let (status, _, body) = call(&app_nopii, api_req("GET", "/api/v1/players", "cb_a", None)).await;
    assert_eq!(status, StatusCode::OK);
    let players = body.as_array().expect("json array");
    assert_eq!(players.len(), 1);
    assert!(players[0]["ip"].is_null(), "ip must be nulled: {body}");
    assert_eq!(players[0]["name"].as_str(), Some("Rusty"));

    // With players.view_pii: ip passes through.
    let jwt = mint_jwt(
        &keys(),
        Uuid::new_v4(),
        &["players.view", "players.view_pii"],
        300,
    );
    let (auth_url, _) = stub_auth(ExchangeMode::Mint(jwt)).await;
    let app_pii = app(test_state(&auth_url, &identity_url, None));
    let (status, _, body) = call(&app_pii, api_req("GET", "/api/v1/players", "cb_b", None)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body[0]["ip"].as_str(), Some("203.0.113.9"));
}

#[tokio::test]
async fn player_profile_pii_is_gated_at_the_facade() {
    let identity_url = stub_identity_players().await;
    let uri = "/api/v1/players/0198c0de-0000-7000-8000-0000000000aa";

    // Without players.view_pii: session ips AND raw identifier values are nulled at
    // the facade. The identifier nulling is the load-bearing gate (identity does not
    // gate `identifiers[].value`); the session-ip nulling is redundant depth.
    let jwt = mint_jwt(&keys(), Uuid::new_v4(), &["players.view"], 300);
    let (auth_url, _) = stub_auth(ExchangeMode::Mint(jwt)).await;
    let app_nopii = app(test_state(&auth_url, &identity_url, None));
    let (status, _, body) = call(&app_nopii, api_req("GET", uri, "cb_a", None)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(
        body["recent_sessions"][0]["ip"].is_null(),
        "session ip must be nulled: {body}"
    );
    assert!(
        body["identifiers"][0]["value"].is_null(),
        "identifier value must be nulled: {body}"
    );
    // The non-PII surface survives untouched.
    assert_eq!(body["identifiers"][0]["type"].as_str(), Some("steam"));
    assert_eq!(body["names"][0]["name"].as_str(), Some("Rusty"));
    assert_eq!(body["links"][0]["other_display_id"].as_i64(), Some(77));
    assert_eq!(body["playtime"][0]["total_secs"].as_i64(), Some(3600));
    assert_eq!(
        body["reports_against"][0]["report_type"].as_str(),
        Some("cheat")
    );

    // With players.view_pii: both pass through.
    let jwt = mint_jwt(
        &keys(),
        Uuid::new_v4(),
        &["players.view", "players.view_pii"],
        300,
    );
    let (auth_url, _) = stub_auth(ExchangeMode::Mint(jwt)).await;
    let app_pii = app(test_state(&auth_url, &identity_url, None));
    let (status, _, body) = call(&app_pii, api_req("GET", uri, "cb_b", None)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["recent_sessions"][0]["ip"].as_str(),
        Some("203.0.113.9")
    );
    assert_eq!(
        body["identifiers"][0]["value"].as_str(),
        Some("76561198000000000")
    );
}

#[tokio::test]
async fn servers_response_is_trimmed_to_the_public_shape() {
    let jwt = mint_jwt(&keys(), Uuid::new_v4(), &["servers.view"], 300);
    let (auth_url, _) = stub_auth(ExchangeMode::Mint(jwt)).await;
    let fleet_url = stub_fleet().await;
    let mut state = test_state(&auth_url, DEAD_URL, None);
    state.fleet_service_url = fleet_url;
    let app = app(state);

    let (status, _, body) = call(&app, api_req("GET", "/api/v1/servers", "cb_key", None)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let servers = body.as_array().expect("json array");
    assert_eq!(servers.len(), 1);
    let server = servers[0].as_object().expect("json object");

    // The public fields survive.
    assert_eq!(server["name"].as_str().unwrap(), "Main");
    assert_eq!(server["connection_status"].as_str().unwrap(), "connected");
    assert_eq!(server["info_players"].as_i64(), Some(42));

    // The operational internals are gone from the JSON entirely (not just nulled).
    for excluded in [
        "tenant_id",
        "rcon_host",
        "rcon_port",
        "query_port",
        "last_error",
        "has_ingest_token",
        "ingest_token_created_at",
    ] {
        assert!(
            !server.contains_key(excluded),
            "{excluded} must not be in the public server shape: {body}"
        );
    }
}

#[tokio::test]
async fn entitlements_are_unwrapped_and_steam_id_is_forwarded() {
    let jwt = mint_jwt(&keys(), Uuid::new_v4(), &["store.manage"], 300);
    let (auth_url, _) = stub_auth(ExchangeMode::Mint(jwt)).await;
    let (tenant_url, seen_query) = stub_tenant().await;
    let mut state = test_state(&auth_url, DEAD_URL, None);
    state.tenant_service_url = tenant_url;
    let app = app(state);

    // Tenant wraps as {"entitlements": [...]}; v1 lists are bare arrays.
    let (status, _, body) =
        call(&app, api_req("GET", "/api/v1/entitlements", "cb_key", None)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let list = body.as_array().expect("bare array, not the tenant wrapper");
    assert_eq!(list[0]["product_name"].as_str(), Some("VIP"));
    assert_eq!(list[0]["kind"].as_str(), Some("subscription"));
    assert!(seen_query.lock().unwrap().is_none(), "no filter sent");

    // The steam_id filter is forwarded downstream.
    let (status, _, _) = call(
        &app,
        api_req(
            "GET",
            "/api/v1/entitlements?steam_id=76561198000000000",
            "cb_key",
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        seen_query.lock().unwrap().as_deref(),
        Some("steam_id=76561198000000000")
    );
}

#[tokio::test]
async fn extractor_rejections_get_the_400_envelope_after_the_scope_gate() {
    // A key with every scope these endpoints need; every downstream is a dead port,
    // proving the 400 verdicts are facade-originated.
    let jwt = mint_jwt(
        &keys(),
        Uuid::new_v4(),
        &["bans.revoke", "players.view", "store.manage"],
        300,
    );
    let (auth_url, _) = stub_auth(ExchangeMode::Mint(jwt)).await;
    let app = app(test_state(&auth_url, DEAD_URL, None));

    // Malformed revoke body (reason must be a string).
    let (status, _, body) = call(
        &app,
        api_req(
            "POST",
            "/api/v1/bans/0198c0de-0000-7000-8000-000000000001/revoke",
            "cb_key",
            Some(json!({"reason": 7})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "malformed revoke body");
    assert_envelope(&body, "bad_request");

    // A non-JSON content type on a present revoke body.
    let req = Request::builder()
        .uri("/api/v1/bans/0198c0de-0000-7000-8000-000000000001/revoke")
        .method("POST")
        .header(header::AUTHORIZATION, "Bearer cb_key")
        .header(header::CONTENT_TYPE, "text/plain")
        .body(Body::from("free the ban"))
        .unwrap();
    let (status, _, body) = call(&app, req).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "text/plain revoke body");
    assert_envelope(&body, "bad_request");

    // Non-uuid path segments.
    for uri in [
        "/api/v1/bans/not-a-uuid/revoke",
        "/api/v1/players/not-a-uuid",
    ] {
        let method = if uri.contains("revoke") {
            "POST"
        } else {
            "GET"
        };
        let (status, _, body) = call(&app, api_req(method, uri, "cb_key", None)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}");
        assert_envelope(&body, "bad_request");
    }

    // A duplicate steam_id query parameter.
    let (status, _, body) = call(
        &app,
        api_req(
            "GET",
            "/api/v1/entitlements?steam_id=1&steam_id=2",
            "cb_key",
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "duplicate steam_id");
    assert_envelope(&body, "bad_request");
}

#[tokio::test]
async fn scope_gate_outranks_extractor_rejections() {
    // A malformed revoke request from a key WITHOUT bans.revoke must be told 403,
    // not 400: the scope verdict comes first, and a scopeless key learns nothing
    // about the endpoint's parsing.
    let jwt = mint_jwt(&keys(), Uuid::new_v4(), &[], 300);
    let (auth_url, _) = stub_auth(ExchangeMode::Mint(jwt)).await;
    let app = app(test_state(&auth_url, DEAD_URL, None));

    let (status, _, body) = call(
        &app,
        api_req(
            "POST",
            "/api/v1/bans/not-a-uuid/revoke",
            "cb_unscoped",
            Some(json!({"reason": 7})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_envelope(&body, "forbidden");
}

#[tokio::test]
async fn openapi_documents_the_pii_boundary_and_optional_revoke_body() {
    let app = app(test_state(DEAD_URL, DEAD_URL, None));
    let (status, _, body) = call(
        &app,
        Request::get("/api/v1/openapi.json")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // The revoke body is optional on the wire and must be documented as such. With
    // `content = Option<...>` utoipa omits `required` (absent = false per the OAS
    // default) and emits a nullable oneOf schema; assert both, and above all that
    // the body is NOT marked required.
    let request_body = &body["paths"]["/api/v1/bans/{id}/revoke"]["post"]["requestBody"];
    assert!(request_body.is_object(), "revoke requestBody documented");
    assert_ne!(
        request_body["required"].as_bool(),
        Some(true),
        "revoke body must be documented optional: {request_body}"
    );
    let schema = &request_body["content"]["application/json"]["schema"];
    assert!(
        schema["oneOf"]
            .as_array()
            .is_some_and(|alts| alts.iter().any(|a| a["type"].as_str() == Some("null"))),
        "revoke body schema must admit null: {schema}"
    );

    // The PII-bearing scopes are stated on their tags (decision: document, not null;
    // BM-parity ban management operates on raw steam ids).
    let tags = body["tags"].as_array().expect("tags array");
    let tag_desc = |name: &str| {
        tags.iter()
            .find(|t| t["name"].as_str() == Some(name))
            .and_then(|t| t["description"].as_str())
            .unwrap_or_default()
            .to_owned()
    };
    assert!(
        tag_desc("bans").contains("PII-bearing"),
        "bans tag must state it is PII-bearing"
    );
    assert!(
        tag_desc("bans").contains("raw identifiers"),
        "bans tag must mention raw identifiers"
    );
    assert!(
        tag_desc("entitlements").contains("steam_id"),
        "entitlements tag must mention steam_id exposure"
    );
    assert!(
        tag_desc("players").contains("players.view_pii"),
        "players tag must state the PII scope"
    );
}
