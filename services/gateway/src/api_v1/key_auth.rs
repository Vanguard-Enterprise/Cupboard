//! `require_api_key`: the `/api/v1/*` front door (Phase 6 decision M). Extracts
//! `Authorization: Bearer cb_...`, exchanges it at auth
//! (`POST /internal/api-keys/exchange`) for a short-lived operator JWT, then forwards
//! that JWT as the downstream bearer so every downstream service keeps verifying the
//! operator Ed25519 signature unchanged.
//!
//! Exchanges are cached in-process, keyed by SHA-256 of the presented raw key (the
//! KEYED hash of keys at rest lives in auth; this unkeyed hash only addresses a
//! process-local map). Positive entries live until the minted JWT's `exp` minus 30s;
//! auth 401s are negative-cached for 60s. Note the limit of that defense: the
//! negative cache only defuses REPEATS of the same garbage token; a stream of UNIQUE
//! `cb_` garbage still costs one uncached auth round trip each. That is acceptable
//! today only because /api/v1 is VPN-only by ingress inheritance (decision P); a
//! per-IP or global exchange cap is a prerequisite for the Phase 7 public exposure.
//! Transport errors and non-401 statuses are NEVER cached: per the degradation
//! matrix, cached keys keep working while auth is down and new keys get 503, healing
//! the moment auth returns.

use crate::AppState;
use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use cupboard_auth_core::{Claims, Keys};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tracing::Instrument;

use super::ApiError;

/// How long an auth rejection (401) is served from memory before re-asking auth.
const NEGATIVE_TTL: Duration = Duration::from_secs(60);
/// Positive entries expire this far before the minted JWT does, so a cached token is
/// never forwarded within a hair of its `exp`.
const EXP_SLACK_SECS: i64 = 30;
/// Expired entries are swept (on insert) at most this often.
const SWEEP_INTERVAL: Duration = Duration::from_secs(60);
/// Bound on the exchange round trip: a blackholed auth pod must yield a prompt 503
/// (degradation matrix), not a hung /api/v1 request. Small because the exchange is a
/// single cluster-internal hash lookup + mint.
const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(5);

enum Entry {
    /// A minted JWT plus its decoded claims, kept together so the rate limiter and
    /// handlers never re-decode the token.
    Valid {
        jwt: String,
        claims: Claims,
        until: Instant,
    },
    /// Auth said 401 for this key; keep answering 401 from memory until `until`.
    Invalid { until: Instant },
}

impl Entry {
    fn until(&self) -> Instant {
        match self {
            Entry::Valid { until, .. } | Entry::Invalid { until } => *until,
        }
    }
}

/// What a cache lookup yielded for a live (unexpired) entry.
enum CacheHit {
    Valid { jwt: String, claims: Claims },
    Invalid,
}

/// In-process exchange cache. Hand-rolled (Mutex over HashMap with a periodic expiry
/// sweep) deliberately: the access pattern is trivial and does not warrant a cache
/// dependency. Lock sections are short and never held across an await.
#[derive(Default)]
pub struct KeyCache {
    inner: Mutex<Inner>,
}

struct Inner {
    map: HashMap<[u8; 32], Entry>,
    last_sweep: Instant,
}

impl Default for Inner {
    fn default() -> Self {
        Inner {
            map: HashMap::new(),
            last_sweep: Instant::now(),
        }
    }
}

impl KeyCache {
    fn lookup(&self, hash: &[u8; 32]) -> Option<CacheHit> {
        let inner = self.inner.lock().expect("key cache lock");
        match inner.map.get(hash) {
            Some(entry) if entry.until() > Instant::now() => Some(match entry {
                Entry::Valid { jwt, claims, .. } => CacheHit::Valid {
                    jwt: jwt.clone(),
                    claims: claims.clone(),
                },
                Entry::Invalid { .. } => CacheHit::Invalid,
            }),
            // Expired entries are left for the insert-time sweep; a miss re-exchanges.
            _ => None,
        }
    }

    fn insert_valid(&self, hash: [u8; 32], jwt: String, claims: Claims) {
        let ttl = claims.exp - chrono::Utc::now().timestamp() - EXP_SLACK_SECS;
        if ttl <= 0 {
            return; // too close to expiry to be worth caching
        }
        self.insert(
            hash,
            Entry::Valid {
                jwt,
                claims,
                until: Instant::now() + Duration::from_secs(ttl as u64),
            },
        );
    }

    fn insert_invalid(&self, hash: [u8; 32]) {
        self.insert(
            hash,
            Entry::Invalid {
                until: Instant::now() + NEGATIVE_TTL,
            },
        );
    }

    fn insert(&self, hash: [u8; 32], entry: Entry) {
        let mut inner = self.inner.lock().expect("key cache lock");
        let now = Instant::now();
        if now.duration_since(inner.last_sweep) >= SWEEP_INTERVAL {
            inner.map.retain(|_, e| e.until() > now);
            inner.last_sweep = now;
        }
        inner.map.insert(hash, entry);
    }
}

/// Middleware: require a valid `Authorization: Bearer cb_...` API key. On success the
/// minted operator JWT replaces the incoming Authorization header (downstream services
/// verify it like any operator token) and the decoded [`Claims`] are available via
/// `Extension<Claims>`.
pub async fn require_api_key(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Result<Response, ApiError> {
    // Fail closed when the verifier is missing (the JWT_PUBLIC_KEY_PEM precedent): we
    // could not validate what auth mints.
    let Some(keys) = state.keys.clone() else {
        return Err(ApiError::Unavailable(
            "token verification is not configured".into(),
        ));
    };

    let token = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .filter(|t| t.starts_with("cb_"))
        .ok_or_else(|| {
            ApiError::Unauthorized("expected an API key: Authorization: Bearer cb_...".into())
        })?
        .to_owned();

    let hash = cupboard_crypto::sha256(token.as_bytes());
    let (jwt, claims) = match state.key_cache.lookup(&hash) {
        Some(CacheHit::Valid { jwt, claims }) => (jwt, claims),
        Some(CacheHit::Invalid) => return Err(ApiError::Unauthorized("invalid API key".into())),
        None => exchange(&state, &keys, &token, hash).await?,
    };

    let bearer = HeaderValue::try_from(format!("Bearer {jwt}"))
        .map_err(|_| ApiError::Internal("minted token is not a valid header value".into()))?;
    req.headers_mut().insert(header::AUTHORIZATION, bearer);
    req.extensions_mut().insert(claims);
    Ok(next.run(req).await)
}

#[derive(Deserialize)]
struct ExchangeResponse {
    /// The 5-minute operator-signed JWT minted by auth.
    token: String,
}

/// Cache miss: exchange the raw key at auth for a minted JWT and cache the outcome
/// (positive, or negative for a 401 key verdict; transport failures and any other
/// non-200 status are never cached).
async fn exchange(
    state: &AppState,
    keys: &Keys,
    token: &str,
    hash: [u8; 32],
) -> Result<(String, Claims), ApiError> {
    // Fail closed without the internal token: new keys cannot be exchanged (cached
    // ones keep working via the lookup path above).
    let Some(internal_token) = state.internal_api_token.as_deref() else {
        return Err(ApiError::Unavailable(
            "API-key exchange is not configured".into(),
        ));
    };
    let url = format!(
        "{}/internal/api-keys/exchange",
        state.auth_service_url.trim_end_matches('/')
    );

    let span = tracing::info_span!("api_key.exchange");
    async {
        let resp = match state
            .http
            .post(&url)
            .timeout(EXCHANGE_TIMEOUT)
            .header("x-internal-token", internal_token)
            .json(&serde_json::json!({ "token": token }))
            .send()
            .await
        {
            Ok(resp) => resp,
            Err(e) => {
                // Transport errors (including the timeout above) are NOT
                // negative-cached: the key may be perfectly valid and auth merely
                // unreachable.
                tracing::warn!(error = %e, "api-key exchange request failed");
                return Err(ApiError::Unavailable(
                    "cannot reach the auth service".into(),
                ));
            }
        };

        match resp.status() {
            StatusCode::OK => {
                let body: ExchangeResponse = resp.json().await.map_err(|e| {
                    tracing::warn!(error = %e, "api-key exchange returned an unreadable body");
                    ApiError::Unavailable("auth service returned an unexpected response".into())
                })?;
                // Decode with the gateway's verifier: yields exp for the cache TTL and
                // the claims the limiter/handlers read without re-decoding.
                let claims = keys.decode(&body.token).map_err(|e| {
                    tracing::warn!(error = %e, "minted API-key JWT failed verification");
                    ApiError::Unavailable("cannot verify the minted token".into())
                })?;
                state
                    .key_cache
                    .insert_valid(hash, body.token.clone(), claims.clone());
                Ok((body.token, claims))
            }
            // ONLY a 401 means "auth looked the key up and rejected it"; only that
            // verdict is negative-cached and surfaced as a client-side 401.
            StatusCode::UNAUTHORIZED => {
                state.key_cache.insert_invalid(hash);
                Err(ApiError::Unauthorized("invalid API key".into()))
            }
            status => {
                // Every other non-200 is an exchange-channel failure, not a key
                // verdict: 5xx, and 403 when auth rejects the gateway's own
                // x-internal-token (a broken internal channel). Fail 503 with NO
                // cache entry, so the key is retried as soon as the channel heals.
                tracing::warn!(%status, "api-key exchange returned an unexpected status");
                Err(ApiError::Unavailable("auth service error".into()))
            }
        }
    }
    .instrument(span)
    .await
}
