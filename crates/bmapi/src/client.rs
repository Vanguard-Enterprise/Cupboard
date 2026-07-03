//! The BattleMetrics HTTP client: bearer auth, client-side rate limiting, retry with
//! backoff, and JSON:API page fetches.
//!
//! GETs retry up to 5x on 429/5xx/transport errors, honoring `Retry-After` when BM
//! sends one (undocumented, so never relied on) and falling back to jittered
//! exponential backoff. 401/403/4xx are terminal. Mutating verbs land in later PRs
//! with `needs_verify` semantics; only reads live here for now.

use crate::limiter::RateLimiter;
use crate::types::ListDoc;
use rand::Rng as _;
use serde::de::DeserializeOwned;
use std::time::Duration;

pub const DEFAULT_BASE: &str = "https://api.battlemetrics.com";
/// JSON:API max page size.
pub const PAGE_SIZE: u32 = 100;

const MAX_GET_ATTEMPTS: u32 = 5;
const BACKOFF_BASE_MS: u64 = 1_000;
const BACKOFF_CAP_MS: u64 = 60_000;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Probe budget: it runs on a request path (connection setup), where the background
/// retry policy's worst case (minutes) would park the caller's HTTP request.
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
/// Cap a server-supplied Retry-After so a hostile/broken header can't park a runner.
const RETRY_AFTER_CAP: Duration = Duration::from_secs(120);

#[derive(Debug, thiserror::Error)]
pub enum BmError {
    #[error("BattleMetrics rejected the token (401)")]
    Unauthorized,
    #[error("BattleMetrics denied access (403): {0}")]
    Forbidden(String),
    #[error("BattleMetrics rate limit persisted through retries")]
    RateLimited,
    #[error("BattleMetrics returned HTTP {0}: {1}")]
    Status(u16, String),
    #[error("transport error talking to BattleMetrics: {0}")]
    Transport(String),
    #[error("could not decode BattleMetrics response: {0}")]
    Decode(String),
}

impl BmError {
    /// Errors that mean the token/connection is bad (surface to the tenant) vs
    /// transient service trouble (keep the job resumable).
    pub fn is_auth(&self) -> bool {
        matches!(self, BmError::Unauthorized | BmError::Forbidden(_))
    }
}

pub struct BmClient {
    http: reqwest::Client,
    base: String,
    token: String,
    limiter: RateLimiter,
}

enum Attempt {
    Done(serde_json::Value),
    Fatal(BmError),
    /// Retryable; `Some` = server-suggested wait (Retry-After), `None` = backoff.
    Retry(BmError, Option<Duration>),
}

impl BmClient {
    /// Client with the default limiter budget (8 req/s, 240 req/min).
    pub fn new(base: impl Into<String>, token: impl Into<String>) -> Self {
        Self::with_limits(base, token, 8, 240)
    }

    pub fn with_limits(
        base: impl Into<String>,
        token: impl Into<String>,
        per_sec: u32,
        per_min: u32,
    ) -> Self {
        let mut base = base.into();
        while base.ends_with('/') {
            base.pop();
        }
        Self {
            http: reqwest::Client::builder()
                .timeout(REQUEST_TIMEOUT)
                .build()
                .expect("reqwest client construction is infallible with these options"),
            base,
            token: token.into(),
            limiter: RateLimiter::new(per_sec, per_min),
        }
    }

    pub fn url(&self, path_and_query: &str) -> String {
        format!("{}{}", self.base, path_and_query)
    }

    /// First page of the org's ban lists (owned + subscribed).
    pub fn ban_lists_first_page(&self) -> String {
        self.url(&format!("/ban-lists?page[size]={PAGE_SIZE}"))
    }

    /// First page of one ban list's bans. `include=playerIdentifiers` resolves numeric
    /// identifier references; `-timestamp` keeps the iterator order the sync tail poll
    /// relies on.
    pub fn bans_first_page(&self, ban_list_id: &str) -> String {
        self.url(&format!(
            "/bans?filter[banList]={ban_list_id}&include=playerIdentifiers&page[size]={PAGE_SIZE}&sort=-timestamp"
        ))
    }

    /// Cheap token validation: one minimal authenticated read, exactly one attempt,
    /// tight timeout. Unlike the paginating reads this is called on a request path,
    /// so a transient 429/5xx surfaces to the caller instead of being retried for
    /// minutes.
    pub async fn probe(&self) -> Result<(), BmError> {
        self.limiter.acquire().await;
        match self
            .try_get_with(&self.url("/ban-lists?page[size]=1"), Some(PROBE_TIMEOUT))
            .await
        {
            Attempt::Done(_) => Ok(()),
            Attempt::Fatal(e) | Attempt::Retry(e, _) => Err(e),
        }
    }

    /// GET one JSON:API list page. `url` is absolute: first pages come from the
    /// helpers above, subsequent pages from `links.next` verbatim (the resumable
    /// cursor the import job persists).
    pub async fn list_page<A: DeserializeOwned + Default>(
        &self,
        url: &str,
    ) -> Result<ListDoc<A>, BmError> {
        let value = self.get_value(url).await?;
        serde_json::from_value(value).map_err(|e| BmError::Decode(e.to_string()))
    }

    async fn get_value(&self, url: &str) -> Result<serde_json::Value, BmError> {
        let mut attempt = 0u32;
        loop {
            self.limiter.acquire().await;
            match self.try_get(url).await {
                Attempt::Done(v) => return Ok(v),
                Attempt::Fatal(e) => return Err(e),
                Attempt::Retry(e, wait) => {
                    attempt += 1;
                    if attempt >= MAX_GET_ATTEMPTS {
                        return Err(e);
                    }
                    let wait = wait.unwrap_or_else(|| backoff(attempt));
                    tracing::debug!(
                        url,
                        attempt,
                        wait_ms = wait.as_millis() as u64,
                        error = %e,
                        "retrying BattleMetrics GET"
                    );
                    tokio::time::sleep(wait).await;
                }
            }
        }
    }

    async fn try_get(&self, url: &str) -> Attempt {
        self.try_get_with(url, None).await
    }

    async fn try_get_with(&self, url: &str, timeout: Option<Duration>) -> Attempt {
        let mut req = self
            .http
            .get(url)
            .header("Accept", "application/json")
            .bearer_auth(&self.token);
        if let Some(t) = timeout {
            req = req.timeout(t);
        }
        let sent = req.send().await;
        let res = match sent {
            Ok(r) => r,
            Err(e) => return Attempt::Retry(BmError::Transport(e.to_string()), None),
        };
        let status = res.status();
        if status.is_success() {
            return match res.json().await {
                Ok(v) => Attempt::Done(v),
                Err(e) => Attempt::Fatal(BmError::Decode(e.to_string())),
            };
        }
        match status.as_u16() {
            401 => Attempt::Fatal(BmError::Unauthorized),
            403 => Attempt::Fatal(BmError::Forbidden(body_snippet(res).await)),
            429 => {
                let wait = retry_after(&res);
                Attempt::Retry(BmError::RateLimited, wait)
            }
            500..=599 => Attempt::Retry(
                BmError::Status(status.as_u16(), body_snippet(res).await),
                None,
            ),
            code => Attempt::Fatal(BmError::Status(code, body_snippet(res).await)),
        }
    }
}

fn retry_after(res: &reqwest::Response) -> Option<Duration> {
    let secs: u64 = res
        .headers()
        .get("Retry-After")?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()?;
    Some(Duration::from_secs(secs).min(RETRY_AFTER_CAP))
}

async fn body_snippet(res: reqwest::Response) -> String {
    let text = res.text().await.unwrap_or_default();
    let mut snippet: String = text.chars().take(300).collect();
    if snippet.len() < text.len() {
        snippet.push_str("...");
    }
    snippet
}

fn backoff(attempt: u32) -> Duration {
    let exp = BACKOFF_BASE_MS
        .saturating_mul(1u64 << attempt.min(6))
        .min(BACKOFF_CAP_MS);
    let jittered = (exp as f64 * rand::thread_rng().gen_range(0.8..1.2)) as u64;
    Duration::from_millis(jittered.max(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_is_normalized_and_joined() {
        let c = BmClient::new("https://stub.example/", "t");
        assert_eq!(c.url("/bans?x=1"), "https://stub.example/bans?x=1");
    }

    #[test]
    fn backoff_grows_and_caps() {
        let early = backoff(1);
        let late = backoff(20);
        assert!(early >= Duration::from_millis(1_600 - 400));
        assert!(late <= Duration::from_millis(72_000));
    }
}
