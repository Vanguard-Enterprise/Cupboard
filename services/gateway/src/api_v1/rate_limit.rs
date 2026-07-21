//! Redis fixed-window rate limiter for `/api/v1/*` (Phase 6 decision N). Runs AFTER
//! `require_api_key`: it reads the injected claims' org and plan. Key
//! `ratelimit:{org}:{unix_minute}`, atomic INCR + EXPIRE-on-first via a tiny Lua
//! script; the limit comes from the `plan` claim via [`cupboard_domain::PlanLimits`]
//! (absent claim = Free tier).
//!
//! Per-org, not per-key: limits are a plan entitlement, and per-key would let an org
//! multiply quota by minting keys. Fixed window over sliding: one round trip, and the
//! worst case (2x burst at a window boundary) is a fairness concern, not a security
//! one; sliding-window Lua is the documented upgrade.
//!
//! Redis down or unconfigured fails **OPEN** (availability over billing fairness),
//! with a counter metric plus a rate-limited warn so the outage is visible without
//! flooding the logs. The connection is lazy and self-healing (the tenant service's
//! site-cache pattern): cooldown-gated connects, every network step timeout-bounded.

use crate::AppState;
use axum::extract::{Request, State};
use axum::http::{HeaderName, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use cupboard_auth_core::Claims;
use cupboard_domain::Plan;
use opentelemetry::metrics::Counter;
use redis::aio::ConnectionManager;
use serde_json::json;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, RwLock};
use tracing::Instrument;

use super::ApiError;

/// Fixed-window length; also the basis of `X-RateLimit-Reset` / `Retry-After`.
const WINDOW_SECS: i64 = 60;
/// Key TTL, set only on the first increment of a window: one window plus slack so a
/// key never outlives its usefulness. Redis expiry is the garbage collection.
const KEY_TTL_SECS: i64 = 90;
/// Minimum spacing between reconnection attempts when Redis is unreachable, so at
/// most one request per window pays the connect cost.
const RECONNECT_COOLDOWN: Duration = Duration::from_secs(10);
/// Bound on a single connection attempt; a hung connect must not stall API requests.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
/// Bound on the INCR round trip itself; slower than this and we fail open.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(2);
/// Minimum spacing between fail-open warn logs (the counter metric records every one).
const WARN_INTERVAL_SECS: i64 = 30;

/// Atomic INCR + EXPIRE-on-first-increment. EVAL'd directly rather than via the
/// script cache: it is one round trip either way for a script this small.
const INCR_SCRIPT: &str = "local n = redis.call('INCR', KEYS[1]) \
     if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end \
     return n";

static X_RATELIMIT_LIMIT: HeaderName = HeaderName::from_static("x-ratelimit-limit");
static X_RATELIMIT_REMAINING: HeaderName = HeaderName::from_static("x-ratelimit-remaining");
static X_RATELIMIT_RESET: HeaderName = HeaderName::from_static("x-ratelimit-reset");
static RETRY_AFTER: HeaderName = HeaderName::from_static("retry-after");

/// Fail-open occurrences (Redis unreachable, command error/timeout, or limiter
/// disabled). Created once; the global meter is a no-op when telemetry is logs-only.
fn fail_open_counter() -> &'static Counter<u64> {
    static COUNTER: OnceLock<Counter<u64>> = OnceLock::new();
    COUNTER.get_or_init(|| {
        opentelemetry::global::meter("cupboard.gateway")
            .u64_counter("gateway.ratelimit.fail_open")
            .with_description("API rate-limit checks that failed open (Redis unavailable)")
            .build()
    })
}

/// Cloneable limiter handle. `None` client = limiter disabled (no REDIS_URL): every
/// check fails open. All Redis failures degrade to "unlimited", never to an error.
#[derive(Clone)]
pub struct Limiter {
    client: Option<redis::Client>,
    conn: Arc<RwLock<Option<ConnectionManager>>>,
    last_attempt: Arc<Mutex<Option<Instant>>>,
}

impl Limiter {
    pub fn disabled() -> Self {
        Self {
            client: None,
            conn: Arc::new(RwLock::new(None)),
            last_attempt: Arc::new(Mutex::new(None)),
        }
    }

    /// Build a limiter over `url`. Never touches the network here: the connection is
    /// established lazily so a Redis outage at boot heals without a pod restart.
    pub fn new(url: &str) -> anyhow::Result<Self> {
        let client = redis::Client::open(url)?;
        Ok(Self {
            client: Some(client),
            conn: Arc::new(RwLock::new(None)),
            last_attempt: Arc::new(Mutex::new(None)),
        })
    }

    /// The live connection manager, (re)establishing it if absent and the cooldown
    /// has elapsed. Returns `None` (fail open) rather than erroring.
    async fn manager(&self) -> Option<ConnectionManager> {
        let client = self.client.as_ref()?;
        if let Some(conn) = self.conn.read().await.as_ref() {
            // ConnectionManager reconnects itself after transient drops; once it
            // exists we keep using it.
            return Some(conn.clone());
        }

        // Rate-limit connection attempts; hold the attempt lock across the connect so
        // concurrent requests do not stampede Redis.
        let mut last = self.last_attempt.lock().await;
        if let Some(conn) = self.conn.read().await.as_ref() {
            return Some(conn.clone()); // someone else connected while we waited
        }
        if let Some(at) = *last {
            if at.elapsed() < RECONNECT_COOLDOWN {
                return None;
            }
        }
        *last = Some(Instant::now());
        match tokio::time::timeout(CONNECT_TIMEOUT, client.get_connection_manager()).await {
            Ok(Ok(conn)) => {
                tracing::info!("rate limiter connected to redis");
                *self.conn.write().await = Some(conn.clone());
                Some(conn)
            }
            Ok(Err(e)) => {
                tracing::warn!(error = %e, "rate limiter: redis connect failed");
                None
            }
            Err(_) => {
                tracing::warn!("rate limiter: redis connect timed out");
                None
            }
        }
    }

    /// Atomically increment `key` (EXPIRE on first hit) and return the new count.
    /// `None` = Redis unavailable, fail open.
    async fn incr(&self, key: &str) -> Option<i64> {
        let mut conn = self.manager().await?;
        let mut cmd = redis::cmd("EVAL");
        cmd.arg(INCR_SCRIPT).arg(1).arg(key).arg(KEY_TTL_SECS);
        let fut = cmd.query_async::<i64>(&mut conn);
        match tokio::time::timeout(COMMAND_TIMEOUT, fut).await {
            Ok(Ok(count)) => Some(count),
            Ok(Err(e)) => {
                tracing::warn!(error = %e, "rate limiter: INCR failed");
                None
            }
            Err(_) => {
                tracing::warn!("rate limiter: INCR timed out");
                None
            }
        }
    }
}

/// Record a fail-open: always count it, warn at most every [`WARN_INTERVAL_SECS`].
fn record_fail_open() {
    fail_open_counter().add(1, &[]);
    static LAST_WARN: AtomicI64 = AtomicI64::new(0);
    let now = chrono::Utc::now().timestamp();
    let last = LAST_WARN.load(Ordering::Relaxed);
    if now - last >= WARN_INTERVAL_SECS
        && LAST_WARN
            .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
    {
        tracing::warn!("rate limiter unavailable; failing OPEN (requests pass unlimited)");
    }
}

fn set_ratelimit_headers(resp: &mut Response, limit: u32, remaining: i64, reset: i64) {
    let headers = resp.headers_mut();
    headers.insert(X_RATELIMIT_LIMIT.clone(), HeaderValue::from(limit));
    headers.insert(X_RATELIMIT_REMAINING.clone(), HeaderValue::from(remaining));
    headers.insert(X_RATELIMIT_RESET.clone(), HeaderValue::from(reset));
}

/// Middleware: enforce the per-org fixed-window limit for the request's plan tier.
/// Under the limit (or failing open) the request proceeds; over it, 429 in the v1
/// envelope with `Retry-After` and the `X-RateLimit-*` headers.
pub async fn rate_limit(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Result<Response, ApiError> {
    // require_api_key always runs first and injects the claims; their absence here is
    // a router-wiring bug, not a client error.
    let Some(claims) = req.extensions().get::<Claims>() else {
        return Err(ApiError::Internal(
            "claims missing before the rate limiter".into(),
        ));
    };
    let Some(org) = claims.org else {
        // Exchange-minted tokens always carry the key's org (decision M).
        return Err(ApiError::Internal("API-key token carries no org".into()));
    };
    let limit = Plan::from_claim(claims.plan.as_deref())
        .limits()
        .rate_per_min;

    let now = chrono::Utc::now().timestamp();
    let minute = now / WINDOW_SECS;
    let reset = (minute + 1) * WINDOW_SECS;
    let key = format!("ratelimit:{}:{}", org.0, minute);

    let span = tracing::info_span!("rate_limit.check", org = %org.0, limit);
    let count = state.limiter.incr(&key).instrument(span).await;

    let Some(count) = count else {
        record_fail_open();
        // No X-RateLimit-* headers when we did not actually count.
        return Ok(next.run(req).await);
    };

    if count > i64::from(limit) {
        let mut resp = (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({
                "error": "too_many_requests",
                "message": "rate limit exceeded; retry after the current window",
            })),
        )
            .into_response();
        resp.headers_mut()
            .insert(RETRY_AFTER.clone(), HeaderValue::from((reset - now).max(1)));
        set_ratelimit_headers(&mut resp, limit, 0, reset);
        return Ok(resp);
    }

    let remaining = (i64::from(limit) - count).max(0);
    let mut resp = next.run(req).await;
    set_ratelimit_headers(&mut resp, limit, remaining, reset);
    Ok(resp)
}
