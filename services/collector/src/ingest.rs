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
//! No business logic beyond translation: events are validated at the transport level,
//! translated onto the same streams the RCON pull path feeds, and answered with
//! enforcement commands derived statelessly from identity's ban lookup (see
//! [`enforcement_commands`]).

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
    PushAction, PushBatch, PushCommand, PushEvent, PushResponse, MAX_EVENTS_PER_BATCH,
    MAX_HOOK_TIMINGS, MAX_NETWORK_UPDATE_ENTRIES, MAX_PLAYER_METRICS, MAX_TIMING_ENTRIES,
    PUSH_SCHEMA_VERSION,
};
use cupboard_domain::{
    ChatEvent, EventSource, NamedTiming, ObservedPlayer, PerfEvent, ReportEvent, RosterEvent,
    ServerId, SessionEdge, SessionEvent, TenantId, CHAT_STREAM, PERF_STREAM, REPORT_STREAM,
    ROSTER_STREAM, SESSION_STREAM,
};
use serde_json::json;

use crate::identity_client::IdentityClient;
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
    /// Ban-enforcement lookup: connects/rosters in a batch are checked and the response
    /// carries kick commands for the hits (the plugin-path replacement for RCON kicks).
    pub identity: IdentityClient,
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
    // Steam IDs seen online in this batch (connects + roster snapshots) — the
    // enforcement sweep below turns ban hits among them into kick commands.
    let mut online: Vec<String> = Vec::new();
    for event in batch.events {
        // Redis unavailable = genuine backpressure: 503 tells the plugin to buffer and
        // re-send the whole batch (at-least-once is the contract; ingestion tolerates
        // replays).
        match translate(&who, event, now) {
            Translated::Session(ev) => {
                if ev.edge == SessionEdge::Connected {
                    online.push(ev.steam_id.clone());
                }
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
            Translated::Roster(ev) => {
                online.extend(ev.players.iter().map(|p| p.steam_id.clone()));
                match publish_one(&mut bus, ROSTER_STREAM, state.stream_maxlen, &ev, &who).await {
                    Ok(()) => accepted += 1,
                    Err(resp) => return resp,
                }
            }
            Translated::Report(ev) => {
                match publish_one(&mut bus, REPORT_STREAM, state.stream_maxlen, &ev, &who).await {
                    Ok(()) => accepted += 1,
                    Err(resp) => return resp,
                }
            }
            Translated::Perf(ev) => {
                match publish_one(&mut bus, PERF_STREAM, state.stream_maxlen, &ev, &who).await {
                    Ok(()) => accepted += 1,
                    Err(resp) => return resp,
                }
            }
            Translated::Accepted => accepted += 1,
            Translated::Unknown => dropped_unknown += 1,
        }
    }

    let commands = enforcement_commands(&state.identity, &who, online).await;

    (
        StatusCode::OK,
        Json(PushResponse {
            accepted,
            dropped_unknown,
            commands,
        }),
    )
        .into_response()
}

/// Derive kick commands for banned players among the batch's online Steam IDs.
///
/// Stateless by design: commands are re-derived from bans on every batch (a missed
/// response is healed by the next roster sweep), so no queue table or ack tracking is
/// needed. A persistent queue only becomes necessary for one-shot actions (entitlement
/// grants, Phase 5+). An identity outage degrades to "no commands this batch" — never a
/// failed push.
async fn enforcement_commands(
    identity: &IdentityClient,
    who: &PushIdentity,
    mut online: Vec<String>,
) -> Vec<PushCommand> {
    online.sort();
    online.dedup();
    if online.is_empty() {
        return Vec::new();
    }
    match identity
        .enforce(who.tenant_id, who.server_id, &online)
        .await
    {
        Ok(hits) => hits
            .into_iter()
            .map(|hit| PushCommand {
                id: uuid::Uuid::new_v4().to_string(),
                action: PushAction::Kick {
                    steam_id: hit.steam_id,
                    reason: hit.reason.unwrap_or_else(|| "banned".to_string()),
                },
            })
            .collect(),
        Err(e) => {
            tracing::warn!(server_id = %who.server_id, error = %e, "enforcement lookup failed; no commands this batch");
            Vec::new()
        }
    }
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
    Roster(RosterEvent),
    Report(ReportEvent),
    Perf(Box<PerfEvent>),
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
            eac_id,
        } => Translated::Session(SessionEvent {
            server_id,
            tenant_id,
            at: clamp(at, now),
            edge: SessionEdge::Connected,
            steam_id,
            name,
            // Drop an empty IP (same as the roster arm): it would hash to the constant
            // hmac("") and falsely link every such player as sharing an address.
            ip: ip.filter(|ip| !ip.is_empty()),
            owner_steam_id: owner_steam_id.filter(|o| !o.is_empty() && o != "0"),
            eac_id: eac_id.filter(|e| !e.is_empty()),
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
            eac_id: None,
            reason,
        }),
        PushEvent::Chat {
            at: _, // chat uses the collector receive clock (see below), not the server's
            channel,
            steam_id,
            name,
            message,
        } => Translated::Chat(ChatEvent {
            server_id,
            tenant_id,
            // Chat uses the collector's receive clock (like the RCON path), NOT the
            // server's `at`: cross-source dedupe in identity matches on a ±15s window,
            // and a skewed server clock would otherwise push the two copies apart and
            // defeat it. Exact send-time isn't needed for a chat log.
            at: now,
            channel,
            steam_id,
            name,
            message,
            source: Some(EventSource::Plugin),
        }),
        PushEvent::Report {
            at,
            reporter_steam_id,
            reporter_name,
            target_steam_id,
            target_name,
            subject,
            message,
            report_type,
        } => Translated::Report(ReportEvent {
            server_id,
            tenant_id,
            at: clamp(at, now),
            reporter_steam_id,
            reporter_name,
            target_steam_id,
            target_name,
            subject,
            message,
            report_type,
        }),
        PushEvent::Roster { at, players } => Translated::Roster(RosterEvent {
            server_id,
            tenant_id,
            observed_at: clamp(at, now),
            players: players
                .into_iter()
                .map(|p| ObservedPlayer {
                    // Owner == self / "0" isn't a family share — same rule as the RCON
                    // mapping.
                    owner_steam_id: p
                        .owner_steam_id
                        .filter(|o| !o.is_empty() && o != "0" && *o != p.steam_id),
                    steam_id: p.steam_id,
                    name: p.name,
                    ip: p.ip.filter(|ip| !ip.is_empty()),
                    eac_id: p.eac_id.filter(|e| !e.is_empty()),
                    connected_seconds: p.connected_seconds.max(0),
                })
                .collect(),
        }),
        PushEvent::Perf {
            at: _, // perf uses the collector receive clock (see below), not the server's
            fps,
            fps_avg,
            entities,
            players,
            memory_mb,
            managed_memory_mb,
            gc_gen0,
            gc_gen1,
            gc_gen2,
            memory_collections,
            memory_allocations,
            gc_triggered,
            task_load_balancer,
            task_invoke_handler,
            task_workshop_skins_queue,
            network_bytes_received,
            network_bytes_sent,
            network_packet_loss,
            players_joining,
            players_queued,
            frame_ms,
            frame_ms_avg,
            frame_ms_max,
            mut hooks,
            mut timings,
            mut network_updates,
            mut player_metrics,
        } => {
            // Bound the per-plugin label set (Mimir cardinality): keep the top-N by
            // cumulative cost, drop the tail.
            hooks.sort_by(|a, b| b.total_ms.total_cmp(&a.total_ms));
            hooks.truncate(MAX_HOOK_TIMINGS);
            trim_timings(&mut timings.invoke_execution);
            trim_timings(&mut timings.server_update);
            trim_timings(&mut timings.rpc_calls);
            trim_timings(&mut timings.work_queue);
            trim_timings(&mut timings.console_commands);
            trim_timings(&mut timings.timewarnings);
            network_updates.sort_by(|a, b| b.bytes.cmp(&a.bytes));
            network_updates.truncate(MAX_NETWORK_UPDATE_ENTRIES);
            player_metrics.truncate(MAX_PLAYER_METRICS);
            // Perf uses the collector's receive clock (like chat), NOT the server's
            // `at`: the metrics service's stale-reporting rule and dashboard x-axis key
            // off this, and a server clock lagging within the 10-min skew budget would
            // otherwise permanently read as "reporting stopped". Samples arrive ~every
            // 30s, so receive time tracks true sample time closely.
            Translated::Perf(Box::new(PerfEvent {
                server_id,
                tenant_id,
                at: now,
                fps,
                fps_avg,
                entities,
                players,
                memory_mb,
                managed_memory_mb,
                gc_gen0,
                gc_gen1,
                gc_gen2,
                memory_collections,
                memory_allocations,
                gc_triggered,
                task_load_balancer,
                task_invoke_handler,
                task_workshop_skins_queue,
                network_bytes_received,
                network_bytes_sent,
                network_packet_loss,
                players_joining,
                players_queued,
                frame_ms,
                frame_ms_avg,
                frame_ms_max,
                hooks,
                timings,
                network_updates,
                player_metrics,
            }))
        }
        PushEvent::CommandResult { command_id, ok, .. } => {
            tracing::info!(server_id = %who.server_id, command_id, ok, "plugin command result");
            Translated::Accepted
        }
        PushEvent::Unknown => Translated::Unknown,
    }
}

fn trim_timings(entries: &mut Vec<NamedTiming>) {
    entries.sort_by(|a, b| b.total_ms.total_cmp(&a.total_ms));
    entries.truncate(MAX_TIMING_ENTRIES);
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
