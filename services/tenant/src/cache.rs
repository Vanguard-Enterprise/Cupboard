//! Best-effort Redis cache for public site resolution. Every SSR request to a storefront
//! resolves `host -> site config`, so this sits on the hottest public path; Postgres is
//! the fallback on any miss or Redis failure (the cache can never break rendering).
//!
//! Negative results are cached too (shorter TTL): unknown hosts hitting the public edge
//! must not translate into a Postgres query per request.

use crate::domain::sites::ResolvedSite;
use redis::aio::ConnectionManager;
use redis::AsyncCommands;

/// Positive entries: config edits propagate within this window (the admin path also
/// deletes keys eagerly, so this is the ceiling, not the norm).
const POSITIVE_TTL_SECS: u64 = 60;
/// Negative entries: long enough to absorb junk-host traffic, short enough that a newly
/// created site is reachable quickly even if eager invalidation misses.
const NEGATIVE_TTL_SECS: u64 = 30;

fn key(host: &str) -> String {
    format!("tenant:site:host:{host}")
}

/// Outcome of a cache read: a hit carries the cached resolution (which may be the cached
/// *absence* of a site); a miss means "ask Postgres".
pub enum CacheLookup {
    Hit(Option<ResolvedSite>),
    Miss,
}

/// Cloneable cache handle. `None` inside = caching disabled (no REDIS_URL). All failures
/// degrade to `Miss`/no-op with a warning — never an error to the caller.
#[derive(Clone)]
pub struct SiteCache {
    conn: Option<ConnectionManager>,
}

impl SiteCache {
    pub fn disabled() -> Self {
        Self { conn: None }
    }

    /// Connect with auto-reconnect semantics (`ConnectionManager` re-establishes the
    /// connection after a Redis restart; a plain multiplexed connection would not).
    pub async fn connect(url: &str) -> anyhow::Result<Self> {
        let client = redis::Client::open(url)?;
        let conn = client.get_connection_manager().await?;
        Ok(Self { conn: Some(conn) })
    }

    pub async fn get(&self, host: &str) -> CacheLookup {
        let Some(conn) = &self.conn else {
            return CacheLookup::Miss;
        };
        let mut conn = conn.clone();
        match conn.get::<_, Option<String>>(key(host)).await {
            Ok(Some(raw)) => match serde_json::from_str::<Option<ResolvedSite>>(&raw) {
                Ok(cached) => CacheLookup::Hit(cached),
                Err(e) => {
                    tracing::warn!(error = %e, host, "corrupt site-cache entry; ignoring");
                    CacheLookup::Miss
                }
            },
            Ok(None) => CacheLookup::Miss,
            Err(e) => {
                tracing::warn!(error = %e, host, "site-cache read failed; falling back to db");
                CacheLookup::Miss
            }
        }
    }

    pub async fn put(&self, host: &str, value: &Option<ResolvedSite>) {
        let Some(conn) = &self.conn else { return };
        let ttl = if value.is_some() {
            POSITIVE_TTL_SECS
        } else {
            NEGATIVE_TTL_SECS
        };
        let raw = match serde_json::to_string(value) {
            Ok(raw) => raw,
            Err(e) => {
                tracing::warn!(error = %e, host, "site-cache serialize failed");
                return;
            }
        };
        let mut conn = conn.clone();
        if let Err(e) = conn.set_ex::<_, _, ()>(key(host), raw, ttl).await {
            tracing::warn!(error = %e, host, "site-cache write failed");
        }
    }

    /// Eagerly drop entries after an admin edit so changes propagate immediately rather
    /// than at TTL expiry. Best-effort: a failure just means the TTL ceiling applies.
    pub async fn invalidate(&self, hosts: &[String]) {
        let Some(conn) = &self.conn else { return };
        let mut conn = conn.clone();
        for host in hosts {
            if let Err(e) = conn.del::<_, ()>(key(host)).await {
                tracing::warn!(error = %e, host, "site-cache invalidation failed");
            }
        }
    }
}
