//! Push-ingestion integration tests: drive the real router (auth → limits → translate →
//! Redis) with tower::oneshot. Redis-backed tests use the local throwaway harness
//! (`TEST_REDIS_URL`) and skip when it's absent; auth/limit tests need no Redis.
//!
//! This is the synthetic pusher standing in for the plugin — it proves the #1 Phase 3
//! risk (push backpressure: 401/413/429 + stream caps) before the plugin exists.

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use cupboard_bus::Bus;
use cupboard_collector::fleet_client::ServerConfig;
use cupboard_collector::identity_client::IdentityClient;
use cupboard_collector::ingest::{router, IngestState, RateLimiter};
use cupboard_collector::registry::TokenRegistry;
use http_body_util::BodyExt as _;
use tower::ServiceExt as _;
use uuid::Uuid;

const TOKEN: &str = "cus_integration-test-token";

/// An identity client pointing nowhere: enforcement lookups fail, which the handler
/// degrades to "no commands" — right for tests not about enforcement.
fn dead_identity() -> IdentityClient {
    IdentityClient::new(
        reqwest::Client::new(),
        "http://127.0.0.1:9".into(),
        "unused".into(),
    )
}

/// Spawn a stub identity service whose /internal/enforce reports `banned_steam_id` as
/// banned; returns its base URL.
async fn stub_identity(banned_steam_id: &'static str) -> String {
    let app = axum::Router::new().route(
        "/internal/enforce",
        axum::routing::post(move |body: axum::Json<serde_json::Value>| async move {
            let hits: Vec<serde_json::Value> = body["steam_ids"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|id| id.as_str() == Some(banned_steam_id))
                .map(|id| serde_json::json!({ "steam_id": id, "reason": "test ban" }))
                .collect();
            axum::Json(serde_json::Value::Array(hits))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

fn registry_with(server_id: Uuid, tenant_id: Uuid) -> TokenRegistry {
    let registry = TokenRegistry::default();
    registry.update(&[ServerConfig {
        id: server_id,
        tenant_id,
        name: "test".into(),
        rcon_host: "h".into(),
        rcon_port: 28016,
        rcon_password: "p".into(),
        query_port: None,
        ingest_token_hash: Some(hex::encode(cupboard_crypto::sha256(TOKEN.as_bytes()))),
    }]);
    registry
}

async fn state(rate_per_min: u32) -> Option<(IngestState, Uuid, String)> {
    let url = std::env::var("TEST_REDIS_URL").ok()?;
    let server_id = Uuid::new_v4();
    let bus = Bus::connect(&url).await.expect("connect test redis");
    Some((
        IngestState {
            registry: registry_with(server_id, Uuid::new_v4()),
            bus,
            limiter: RateLimiter::new(rate_per_min),
            stream_maxlen: 1000,
            identity: dead_identity(),
        },
        server_id,
        url,
    ))
}

fn post(body: &str, token: Option<&str>) -> Request<Body> {
    let mut req = Request::builder()
        .method("POST")
        .uri("/ingest/v1/events")
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(t) = token {
        req = req.header(header::AUTHORIZATION, format!("Bearer {t}"));
    }
    req.body(Body::from(body.to_string())).unwrap()
}

fn batch(events: &[serde_json::Value]) -> String {
    serde_json::json!({ "schema": 1, "events": events }).to_string()
}

#[tokio::test]
async fn rejects_missing_and_invalid_tokens() {
    // No Redis needed: auth fails before any publish.
    let state = IngestState {
        registry: registry_with(Uuid::new_v4(), Uuid::new_v4()),
        bus: match std::env::var("TEST_REDIS_URL") {
            Ok(url) => Bus::connect(&url).await.expect("redis"),
            Err(_) => {
                eprintln!("SKIP rejects_missing_and_invalid_tokens: TEST_REDIS_URL unset");
                return;
            }
        },
        limiter: RateLimiter::new(100),
        stream_maxlen: 1000,
        identity: dead_identity(),
    };
    let app = router(state);

    let res = app.clone().oneshot(post(&batch(&[]), None)).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

    let res = app
        .oneshot(post(&batch(&[]), Some("cus_wrong")))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn accepts_events_onto_capped_streams_and_reports_counts() {
    let Some((state, server_id, url)) = state(100).await else {
        eprintln!(
            "SKIP accepts_events_onto_capped_streams_and_reports_counts: TEST_REDIS_URL unset"
        );
        return;
    };
    let app = router(state);

    let body = batch(&[
        serde_json::json!({"type":"heartbeat","at":"2026-07-01T12:00:00Z"}),
        serde_json::json!({"type":"player_connected","at":"2026-07-01T12:00:00Z",
            "steam_id":"76561198000000042","name":"Pusher","ip":"203.0.113.5",
            "owner_steam_id":"76561198000000001"}),
        serde_json::json!({"type":"chat","at":"2026-07-01T12:00:01Z","channel":0,
            "steam_id":"76561198000000042","name":"Pusher","message":"via push"}),
        serde_json::json!({"type":"from_the_future","at":"2026-07-01T12:00:02Z","x":1}),
    ]);
    let res = app.oneshot(post(&body, Some(TOKEN))).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let resp: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(resp["accepted"], 3, "heartbeat + session + chat");
    assert_eq!(
        resp["dropped_unknown"], 1,
        "unknown type dropped, not fatal"
    );
    assert_eq!(resp["commands"], serde_json::json!([]));

    // The session event actually landed on the stream, attributed to OUR server (the
    // token decides identity — the body can't spoof another tenant).
    let client = redis::Client::open(url).unwrap();
    let mut conn = client.get_multiplexed_async_connection().await.unwrap();
    let entries: Vec<(String, Vec<(String, String)>)> = redis::cmd("XRANGE")
        .arg("cupboard:sessions")
        .arg("-")
        .arg("+")
        .query_async(&mut conn)
        .await
        .unwrap();
    let found = entries.iter().any(|(_, fields)| {
        fields
            .iter()
            .any(|(_, v)| v.contains(&server_id.to_string()) && v.contains("76561198000000042"))
    });
    assert!(
        found,
        "pushed session event must be on cupboard:sessions for the token's server"
    );
}

#[tokio::test]
async fn roster_publishes_and_banned_player_yields_kick_command() {
    let Some((mut state, server_id, url)) = state(100).await else {
        eprintln!(
            "SKIP roster_publishes_and_banned_player_yields_kick_command: TEST_REDIS_URL unset"
        );
        return;
    };
    // Identity says 76561198000000666 is banned; the roster below contains them.
    let identity_url = stub_identity("76561198000000666").await;
    state.identity = IdentityClient::new(reqwest::Client::new(), identity_url, "unused".into());
    let app = router(state);

    let body = batch(&[serde_json::json!({
        "type":"roster","at":"2026-07-02T09:00:00Z",
        "players":[
            {"steam_id":"76561198000000666","name":"Banned","ip":"203.0.113.66","connected_seconds":12},
            {"steam_id":"76561198000000042","name":"Fine","ip":"203.0.113.42",
             "owner_steam_id":"76561198000000042","connected_seconds":40}
        ]
    })]);
    let res = app.oneshot(post(&body, Some(TOKEN))).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let resp: serde_json::Value = serde_json::from_slice(&bytes).unwrap();

    // Exactly one command: kick the banned player, with the ban reason.
    let commands = resp["commands"].as_array().unwrap();
    assert_eq!(commands.len(), 1, "one banned player → one command");
    assert_eq!(commands[0]["action"], "kick");
    assert_eq!(commands[0]["steam_id"], "76561198000000666");
    assert_eq!(commands[0]["reason"], "test ban");
    assert!(commands[0]["id"].as_str().is_some_and(|s| !s.is_empty()));

    // The roster snapshot landed on the roster stream, and owner==self was dropped.
    let client = redis::Client::open(url).unwrap();
    let mut conn = client.get_multiplexed_async_connection().await.unwrap();
    let entries: Vec<(String, Vec<(String, String)>)> = redis::cmd("XRANGE")
        .arg("cupboard:roster")
        .arg("-")
        .arg("+")
        .query_async(&mut conn)
        .await
        .unwrap();
    let ours: Vec<&String> = entries
        .iter()
        .flat_map(|(_, fields)| fields.iter().map(|(_, v)| v))
        .filter(|v| v.contains(&server_id.to_string()))
        .collect();
    assert_eq!(ours.len(), 1, "one roster event for our server");
    assert!(ours[0].contains("76561198000000042"));
    assert!(
        !ours[0].contains("\"owner_steam_id\":\"76561198000000042\""),
        "owner == self must be normalized to null, got: {}",
        ours[0]
    );
}

#[tokio::test]
async fn enforces_batch_size_schema_and_rate_limits() {
    // Budget of 4: the two malformed requests below count too (limiting happens before
    // parsing, so malformed spam can't bypass it), then two OK, then 429.
    let Some((state, _server_id, _url)) = state(4).await else {
        eprintln!("SKIP enforces_batch_size_schema_and_rate_limits: TEST_REDIS_URL unset");
        return;
    };
    let app = router(state);

    // Wrong schema major → 400.
    let res = app
        .clone()
        .oneshot(post(r#"{"schema":99,"events":[]}"#, Some(TOKEN)))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);

    // Over the per-batch event cap → 413.
    let heartbeat = serde_json::json!({"type":"heartbeat","at":"2026-07-01T12:00:00Z"});
    let oversize: Vec<_> = std::iter::repeat_n(heartbeat.clone(), 501).collect();
    let res = app
        .clone()
        .oneshot(post(&batch(&oversize), Some(TOKEN)))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);

    // Rate limit: window of 2 → third request 429 with Retry-After.
    for _ in 0..2 {
        let res = app
            .clone()
            .oneshot(post(&batch(std::slice::from_ref(&heartbeat)), Some(TOKEN)))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }
    let res = app
        .oneshot(post(&batch(&[heartbeat]), Some(TOKEN)))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(res.headers().contains_key(header::RETRY_AFTER));
}
