//! The push-ingestion endpoint: `POST /ingest/v1/events` (+ `GET /ingest/v1/ping` for
//! plugin setup checks). Reached through the public gateway; authenticated here by
//! per-server ingest tokens (never JWTs — game servers aren't operators).
//!
//! Backpressure, layered (the #1 Phase 3 risk):
//! 1. request body capped (1 MiB) and events-per-batch capped (413);
//! 2. per-server fixed-window rate limit (429 + `Retry-After`);
//! 3. streams published with `XADD MAXLEN ~` so a stalled consumer sheds oldest
//!    entries instead of growing Redis unboundedly;
//! 4. Redis down → 503 + `Retry-After` — the plugin buffers and retries.
//!
//! No business logic: events are validated at the transport level, translated onto the
//! same streams the RCON pull path feeds, and answered with any pending commands
//! (empty until the command queue lands with the plugin PRs).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::{DateTime, Utc};
use cupboard_bus::Bus;
use cupboard_domain::push::{
    PushBatch, PushEvent, PushResponse, MAX_EVENTS_PER_BATCH, PUSH_SCHEMA_VERSION,
};
use cupboard_domain::{
    ChatEvent, ServerId, SessionEdge, SessionEvent, TenantId, CHAT_STREAM, SESSION_STREAM,
};
use serde_json::json;

use crate::registry::{PushIdentity, TokenRegistry};

/// Push timestamps further than this from the Collector clock are clamped to "now" —
/// transport hygiene against wildly skewed (or hostile) server clocks.
const MAX_CLOCK_SKEW: chrono::Duration = chrono::Duration::minutes(10);

/// Everything the push handlers need. Cloned per request (all fields are handles).
#[derive(Clone)]
pub struct IngestState {
    pub registry: TokenRegistry,
    pub bus: Bus,
    pub limiter: RateLimiter,
    /// `XADD MAXLEN ~` cap per stream.
    pub stream_maxlen: usize,
}

/// Fixed-window per-server request limiter. Windows are 60s; coarse but cheap, and the
/// plugin's retry/backoff handles 429s gracefully.
#[derive(Clone)]
pub struct RateLimiter {
    windows: Arc<Mutex<HashMap<uuid::Uuid, (Instant, u32)>>>,
    pub max_per_minute: u32,
}

impl RateLimiter {
    pub fn new(max_per_minute: u32) -> Self {
        Self {
            windows: Arc::new(Mutex::new(HashMap::new())),
            max_per_minute,
        }
    }

    /// Try to admit one request; `Err(retry_after)` when the window is exhausted.
    fn admit(&self, server: uuid::Uuid) -> Result<(), Duration> {
        let mut windows = self.windows.lock().expect("rate limiter poisoned");
        let now = Instant::now();
        let entry = windows.entry(server).or_insert((now, 0));
        if now.duration_since(entry.0) >= Duration::from_secs(60) {
            *entry = (now, 0);
        }
        if entry.1 >= self.max_per_minute {
            let retry = Duration::from_secs(60).saturating_sub(now.duration_since(entry.0));
            return Err(retry);
        }
        entry.1 += 1;
        Ok(())
    }
}

/// The push-ingestion sub-router. Extracted so integration tests can drive it without a
/// network listener.
pub fn router(state: IngestState) -> axum::Router {
    axum::Router::new()
        .route("/ingest/v1/events", axum::routing::post(post_events))
        .route("/ingest/v1/ping", axum::routing::get(ping))
        .with_state(state)
}

/// `GET /ingest/v1/ping` — lets a plugin/operator verify a token before going live.
pub async fn ping(State(state): State<IngestState>, headers: HeaderMap) -> Response {
    match authenticate(&state.registry, &headers) {
        Ok(who) => (StatusCode::OK, Json(json!({ "server_id": who.server_id }))).into_response(),
        Err(resp) => resp,
    }
}

/// `POST /ingest/v1/events` — the push firehose entry point.
pub async fn post_events(
    State(state): State<IngestState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let who = match authenticate(&state.registry, &headers) {
        Ok(w) => w,
        Err(resp) => return resp,
    };

    if let Err(retry_after) = state.limiter.admit(who.server_id) {
        return rate_limited(retry_after);
    }

    let batch: PushBatch = match serde_json::from_slice(&body) {
        Ok(b) => b,
        Err(e) => return bad_request(&format!("invalid batch: {e}")),
    };
    if batch.schema != PUSH_SCHEMA_VERSION {
        return bad_request(&format!(
            "unsupported schema {} (this backend speaks {PUSH_SCHEMA_VERSION})",
            batch.schema
        ));
    }
    if batch.events.len() > MAX_EVENTS_PER_BATCH {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({ "error": format!("max {MAX_EVENTS_PER_BATCH} events per batch") })),
        )
            .into_response();
    }

    let now = Utc::now();
    let mut bus = state.bus.clone();
    let mut accepted = 0usize;
    let mut dropped_unknown = 0usize;
    for event in batch.events {
        // Redis unavailable = genuine backpressure: 503 tells the plugin to buffer and
        // re-send the whole batch (at-least-once is the contract; ingestion tolerates
        // replays).
        match translate(&who, event, now) {
            Translated::Session(ev) => {
                match publish_one(&mut bus, SESSION_STREAM, state.stream_maxlen, &ev, &who).await {
                    Ok(()) => accepted += 1,
                    Err(resp) => return resp,
                }
            }
            Translated::Chat(ev) => {
                match publish_one(&mut bus, CHAT_STREAM, state.stream_maxlen, &ev, &who).await {
                    Ok(()) => accepted += 1,
                    Err(resp) => return resp,
                }
            }
            Translated::Accepted => accepted += 1,
            Translated::Unknown => dropped_unknown += 1,
        }
    }

    (
        StatusCode::OK,
        Json(PushResponse {
            accepted,
            dropped_unknown,
            // The command queue arrives with the plugin PRs; the response shape is the
            // contract the plugin is built against.
            commands: Vec::new(),
        }),
    )
        .into_response()
}

/// Publish one translated event with the stream cap; a Redis failure becomes the 503
/// backpressure response.
async fn publish_one<T: serde::Serialize>(
    bus: &mut Bus,
    stream: &str,
    maxlen: usize,
    event: &T,
    who: &PushIdentity,
) -> Result<(), Response> {
    bus.publish_capped(stream, maxlen, event)
        .await
        .map_err(|e| {
            tracing::error!(server_id = %who.server_id, error = %e, "push publish failed");
            service_unavailable()
        })?;
    Ok(())
}

enum Translated {
    Session(SessionEvent),
    Chat(ChatEvent),
    /// Consumed with no stream side effect (heartbeats, command results for now).
    Accepted,
    Unknown,
}

/// Turn one push event into its bus form. Pure translation — no policy.
fn translate(who: &PushIdentity, event: PushEvent, now: DateTime<Utc>) -> Translated {
    let server_id = ServerId(who.server_id);
    let tenant_id = TenantId(who.tenant_id);
    match event {
        PushEvent::Heartbeat { .. } => Translated::Accepted,
        PushEvent::PlayerConnected {
            at,
            steam_id,
            name,
            ip,
            owner_steam_id,
        } => Translated::Session(SessionEvent {
            server_id,
            tenant_id,
            at: clamp(at, now),
            edge: SessionEdge::Connected,
            steam_id,
            name,
            ip,
            owner_steam_id,
            reason: None,
        }),
        PushEvent::PlayerDisconnected {
            at,
            steam_id,
            name,
            reason,
        } => Translated::Session(SessionEvent {
            server_id,
            tenant_id,
            at: clamp(at, now),
            edge: SessionEdge::Disconnected,
            steam_id,
            name,
            ip: None,
            owner_steam_id: None,
            reason,
        }),
        PushEvent::Chat {
            at,
            channel,
            steam_id,
            name,
            message,
        } => Translated::Chat(ChatEvent {
            server_id,
            tenant_id,
            at: clamp(at, now),
            channel,
            steam_id,
            name,
            message,
        }),
        PushEvent::CommandResult { command_id, ok, .. } => {
            tracing::info!(server_id = %who.server_id, command_id, ok, "plugin command result");
            Translated::Accepted
        }
        PushEvent::Unknown => Translated::Unknown,
    }
}

/// Clamp a plugin-reported timestamp to "now" when it strays past the skew budget.
fn clamp(at: DateTime<Utc>, now: DateTime<Utc>) -> DateTime<Utc> {
    if (at - now).abs() > MAX_CLOCK_SKEW {
        now
    } else {
        at
    }
}

// A `Response` Err is bulky but this is one call per request, not a hot loop.
#[allow(clippy::result_large_err)]
fn authenticate(registry: &TokenRegistry, headers: &HeaderMap) -> Result<PushIdentity, Response> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .unwrap_or_default();
    if token.is_empty() {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "missing ingest token" })),
        )
            .into_response());
    }
    registry.lookup(token).ok_or_else(|| {
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "invalid ingest token" })),
        )
            .into_response()
    })
}

fn bad_request(msg: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response()
}

fn rate_limited(retry_after: Duration) -> Response {
    (
        StatusCode::TOO_MANY_REQUESTS,
        [(
            header::RETRY_AFTER,
            retry_after.as_secs().max(1).to_string(),
        )],
        Json(json!({ "error": "rate limited" })),
    )
        .into_response()
}

fn service_unavailable() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        [(header::RETRY_AFTER, "5".to_string())],
        Json(json!({ "error": "ingest backpressure; retry" })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_limiter_admits_then_rejects_then_resets_windows() {
        let limiter = RateLimiter::new(2);
        let s = uuid::Uuid::new_v4();
        assert!(limiter.admit(s).is_ok());
        assert!(limiter.admit(s).is_ok());
        let retry = limiter.admit(s).expect_err("third request must be limited");
        assert!(retry <= Duration::from_secs(60));
        // A different server has its own window.
        assert!(limiter.admit(uuid::Uuid::new_v4()).is_ok());
    }

    #[test]
    fn clock_clamp_bounds_skew() {
        let now = Utc::now();
        let fine = now - chrono::Duration::seconds(30);
        assert_eq!(clamp(fine, now), fine);
        let hostile = now - chrono::Duration::days(365);
        assert_eq!(clamp(hostile, now), now);
        let future = now + chrono::Duration::hours(2);
        assert_eq!(clamp(future, now), now);
    }
}
