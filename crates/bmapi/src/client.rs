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
    /// A mutation may or may not have been applied (timeout after send, or a 5xx
    /// after BM received the request). BM has no idempotency keys, so the caller must
    /// existence-check before re-issuing (outbox `needs_verify`).
    #[error("BattleMetrics mutation outcome unknown: {0}")]
    AmbiguousMutation(String),
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

    /// First page of the org's servers (import "servers" phase). `filter[organizations]`
    /// scopes to the tenant's org.
    pub fn servers_first_page(&self, org_id: &str) -> String {
        self.url(&format!(
            "/servers?filter[organizations]={org_id}&page[size]={PAGE_SIZE}"
        ))
    }

    /// First page of the org's players (import "players" phase). `include=identifiers`
    /// carries each player's identifiers as `included` resources referenced by the
    /// player's `identifiers` relationship.
    pub fn players_first_page(&self, org_id: &str) -> String {
        self.url(&format!(
            "/players?filter[organizations]={org_id}&include=identifiers&page[size]={PAGE_SIZE}"
        ))
    }

    /// First page of one BM player's notes (import "notes" phase).
    pub fn player_notes_first_page(&self, bm_player_id: &str) -> String {
        self.url(&format!(
            "/players/{bm_player_id}/relationships/notes?page[size]={PAGE_SIZE}"
        ))
    }

    /// Bans page filtered to one list + a search term: the outbox's existence check
    /// before re-issuing an ambiguous create. The term is percent-encoded: v1 subjects
    /// are steam ids (digits), but a non-digit value (a pasted profile fragment, a typo)
    /// carrying `#`/`&` would otherwise truncate or corrupt the query and defeat the
    /// existence check, duplicating bans on every ambiguous retry.
    pub fn bans_search_page(&self, ban_list_id: &str, search: &str) -> String {
        let search = percent_encode_query(search);
        self.url(&format!(
            "/bans?filter[banList]={ban_list_id}&filter[search]={search}&include=playerIdentifiers&page[size]={PAGE_SIZE}&sort=-timestamp"
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

/// Input for `POST /bans`. Identifiers are (BM type, value) pairs, e.g.
/// `("steamID", "7656...")`; they are sent as manual entries.
pub struct NewBmBan<'a> {
    pub org_id: &'a str,
    pub ban_list_id: &'a str,
    pub reason: Option<&'a str>,
    pub note: Option<&'a str>,
    pub expires: Option<chrono::DateTime<chrono::Utc>>,
    pub identifiers: &'a [(String, String)],
    /// BM server id for a server-scoped ban (resolved through the sync map). `Some`
    /// sends a `server` relationship and `orgWide: false`; `None` is an org-wide ban.
    pub server_id: Option<&'a str>,
    pub org_wide: bool,
}

impl NewBmBan<'_> {
    fn body(&self) -> serde_json::Value {
        let mut relationships = serde_json::json!({
            "organization": {
                "data": { "type": "organization", "id": self.org_id }
            },
            "banList": {
                "data": { "type": "banList", "id": self.ban_list_id }
            },
        });
        // A server-scoped ban narrows to one server instead of escalating org-wide.
        if let Some(server_id) = self.server_id {
            relationships["server"] = serde_json::json!({
                "data": { "type": "server", "id": server_id }
            });
        }
        serde_json::json!({
            "data": {
                "type": "ban",
                "attributes": {
                    "reason": self.reason,
                    "note": self.note,
                    "expires": self.expires.map(|e| {
                        e.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                    }),
                    "identifiers": self.identifiers.iter().map(|(kind, value)| {
                        serde_json::json!({
                            "type": kind,
                            "identifier": value,
                            "manual": true,
                        })
                    }).collect::<Vec<_>>(),
                    "orgWide": self.org_wide,
                    "autoAddEnabled": false,
                },
                "relationships": relationships,
            }
        })
    }
}

/// Outcome of a delete-shaped mutation.
#[derive(Debug, PartialEq, Eq)]
pub enum DeleteOutcome {
    Deleted,
    /// 404: already gone on BM (convergent with our intent).
    AlreadyGone,
}

impl BmClient {
    /// `POST /bans`. Returns the created resource (its id is the sync-map key and the
    /// echo guard's input). A response we can't decode counts as ambiguous: the ban
    /// exists, only our read of it failed.
    pub async fn create_ban(
        &self,
        ban: &NewBmBan<'_>,
    ) -> Result<crate::types::Resource<crate::types::BanAttrs>, BmError> {
        let value = self
            .send_mutation(reqwest::Method::POST, &self.url("/bans"), Some(ban.body()))
            .await?;
        let doc: crate::types::OneDoc<crate::types::BanAttrs> = serde_json::from_value(value)
            .map_err(|e| BmError::AmbiguousMutation(format!("created but undecodable: {e}")))?;
        Ok(doc.data)
    }

    /// `DELETE /bans/{id}` (BM's unban). 404 is success for our purposes.
    pub async fn delete_ban(&self, ban_id: &str) -> Result<DeleteOutcome, BmError> {
        let url = self.url(&format!("/bans/{ban_id}"));
        match self
            .send_mutation(reqwest::Method::DELETE, &url, None)
            .await
        {
            Ok(_) => Ok(DeleteOutcome::Deleted),
            Err(BmError::Status(404, _)) => Ok(DeleteOutcome::AlreadyGone),
            Err(e) => Err(e),
        }
    }

    /// `PATCH /bans/{id}` to expire now: the fallback unban when the token lacks
    /// `ban:delete`. Returns the expiry it sent (millisecond-truncated, matching the
    /// canonical hash normalization) so the caller can refresh its echo-guard hash.
    pub async fn expire_ban_now(
        &self,
        ban_id: &str,
    ) -> Result<chrono::DateTime<chrono::Utc>, BmError> {
        let url = self.url(&format!("/bans/{ban_id}"));
        let sent = chrono::Utc::now();
        let formatted = sent.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let body = serde_json::json!({
            "data": {
                "type": "ban",
                "id": ban_id,
                "attributes": { "expires": formatted },
            }
        });
        self.send_mutation(reqwest::Method::PATCH, &url, Some(body))
            .await?;
        // Round-trip through the wire format so the returned instant hashes
        // identically to what BM stored.
        Ok(chrono::DateTime::parse_from_rfc3339(&formatted)
            .expect("formatted timestamp parses")
            .with_timezone(&chrono::Utc))
    }

    /// Mutation discipline (decision B): retry only when the request provably never
    /// reached BM (connect failures) or on 429; anything sent-but-unanswered or
    /// answered 5xx is ambiguous and surfaces as [`BmError::AmbiguousMutation`].
    async fn send_mutation(
        &self,
        method: reqwest::Method,
        url: &str,
        body: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, BmError> {
        let mut attempt = 0u32;
        loop {
            self.limiter.acquire().await;
            let mut req = self
                .http
                .request(method.clone(), url)
                .header("Accept", "application/json")
                .bearer_auth(&self.token);
            if let Some(b) = &body {
                req = req.json(b);
            }
            let retry_wait = match req.send().await {
                Err(e) if e.is_connect() => {
                    // Never reached BM; safe to retry.
                    if attempt + 1 >= MAX_GET_ATTEMPTS {
                        return Err(BmError::Transport(e.to_string()));
                    }
                    None
                }
                Err(e) => return Err(BmError::AmbiguousMutation(e.to_string())),
                Ok(res) => {
                    let status = res.status();
                    if status.is_success() {
                        let text = res.text().await.unwrap_or_default();
                        return Ok(if text.trim().is_empty() {
                            serde_json::Value::Null
                        } else {
                            serde_json::from_str(&text).unwrap_or(serde_json::Value::Null)
                        });
                    }
                    match status.as_u16() {
                        401 => return Err(BmError::Unauthorized),
                        403 => return Err(BmError::Forbidden(body_snippet(res).await)),
                        429 => {
                            if attempt + 1 >= MAX_GET_ATTEMPTS {
                                return Err(BmError::RateLimited);
                            }
                            retry_after(&res)
                        }
                        // BM received the request; a 5xx says nothing about whether
                        // it applied.
                        500..=599 => {
                            return Err(BmError::AmbiguousMutation(format!(
                                "HTTP {status}: {}",
                                body_snippet(res).await
                            )))
                        }
                        code => return Err(BmError::Status(code, body_snippet(res).await)),
                    }
                }
            };
            attempt += 1;
            let wait = retry_wait.unwrap_or_else(|| backoff(attempt));
            tracing::debug!(
                url,
                attempt,
                wait_ms = wait.as_millis() as u64,
                "retrying BattleMetrics mutation"
            );
            tokio::time::sleep(wait).await;
        }
    }
}

/// Minimal RFC3986 percent-encoder for a query-string value. No new deps: only the
/// unreserved set passes through; every other byte becomes `%XX`. Used for the ambiguous
/// -create existence check's search term, which is operator-supplied and could carry
/// URL-significant characters.
fn percent_encode_query(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
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
    fn create_ban_body_shape() {
        use chrono::TimeZone as _;
        let identifiers = vec![("steamID".to_string(), "76561198000000001".to_string())];
        let ban = NewBmBan {
            org_id: "42",
            ban_list_id: "list-1",
            reason: Some("cheating"),
            note: None,
            expires: Some(chrono::Utc.with_ymd_and_hms(2027, 1, 2, 3, 4, 5).unwrap()),
            identifiers: &identifiers,
            server_id: None,
            org_wide: true,
        };
        let body = ban.body();
        assert_eq!(body["data"]["type"], "ban");
        assert_eq!(body["data"]["attributes"]["reason"], "cheating");
        assert_eq!(
            body["data"]["attributes"]["expires"],
            "2027-01-02T03:04:05.000Z"
        );
        assert_eq!(
            body["data"]["attributes"]["identifiers"][0]["type"],
            "steamID"
        );
        assert_eq!(body["data"]["attributes"]["identifiers"][0]["manual"], true);
        assert_eq!(body["data"]["attributes"]["orgWide"], true);
        assert_eq!(
            body["data"]["relationships"]["banList"]["data"]["id"],
            "list-1"
        );
        assert_eq!(
            body["data"]["relationships"]["organization"]["data"]["id"],
            "42"
        );
        // No server relationship on an org-wide ban.
        assert!(body["data"]["relationships"]["server"].is_null());
    }

    #[test]
    fn create_ban_body_carries_server_relationship() {
        let identifiers = vec![("steamID".to_string(), "76561198000000001".to_string())];
        let ban = NewBmBan {
            org_id: "42",
            ban_list_id: "list-1",
            reason: None,
            note: None,
            expires: None,
            identifiers: &identifiers,
            server_id: Some("srv-9"),
            org_wide: false,
        };
        let body = ban.body();
        assert_eq!(body["data"]["attributes"]["orgWide"], false);
        assert_eq!(
            body["data"]["relationships"]["server"]["data"]["id"],
            "srv-9"
        );
        assert_eq!(
            body["data"]["relationships"]["server"]["data"]["type"],
            "server"
        );
    }

    #[test]
    fn search_term_is_percent_encoded() {
        let c = BmClient::new("https://stub.example", "t");
        let url = c.bans_search_page("list-1", "765#61&198");
        assert!(
            url.contains("filter[search]=765%2361%26198"),
            "search term must be percent-encoded: {url}"
        );
    }

    #[test]
    fn backoff_grows_and_caps() {
        let early = backoff(1);
        let late = backoff(20);
        assert!(early >= Duration::from_millis(1_600 - 400));
        assert!(late <= Duration::from_millis(72_000));
    }
}
