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
    assert!(
        body["paths"]["/api/v1/bans"].is_object(),
        "openapi must document /api/v1/bans: {body}"
    );

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
