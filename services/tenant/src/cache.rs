//! Best-effort Redis cache for public site resolution. Every SSR request to a storefront
//! resolves `host -> site config`, so this sits on the hottest public path; Postgres is
//! the fallback on any miss or Redis failure (the cache can never break rendering).
//!
//! Negative results are cached too (shorter TTL): unknown hosts hitting the public edge
//! must not translate into a Postgres query per request.
//!
//! Two subtleties this module owns:
//! * **Lazy, self-healing connection.** Redis being down at boot (or restarting later)
//!   must only cost cache hits, never pod restarts or a permanently disabled cache; the
//!   manager is (re)established on demand, at most once per cooldown window.
//! * **Invalidation tombstones.** An admin edit deletes cache keys, but a public resolve
//!   that read Postgres *before* the edit committed may still be in flight and would
//!   re-write a stale entry after the delete. `invalidate` therefore leaves a short
//!   tombstone that `put` respects, closing the create/rename race window.

use crate::domain::sites::ResolvedSite;
use redis::aio::ConnectionManager;
use redis::AsyncCommands;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, RwLock};

/// Positive entries: config edits propagate within this window (the admin path also
/// deletes keys eagerly, so this is the ceiling, not the norm).
const POSITIVE_TTL_SECS: u64 = 60;
/// Negative entries: long enough to absorb junk-host traffic, short enough that a newly
/// created site is reachable quickly even if eager invalidation misses.
const NEGATIVE_TTL_SECS: u64 = 30;
/// Tombstone left by `invalidate`; `put` skips writes while it exists. Covers resolves
/// that were in flight across an admin edit (a resolve slower than this can still write
/// one stale negative entry, bounded by NEGATIVE_TTL_SECS).
const TOMBSTONE_TTL_SECS: u64 = 5;
/// Minimum spacing between reconnection attempts when Redis is unreachable, so at most
/// one request per window pays the connect cost.
const RECONNECT_COOLDOWN: Duration = Duration::from_secs(10);
/// Bound on a single connection attempt; a hung connect must not stall a public request.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

fn key(host: &str) -> String {
    format!("tenant:site:host:{host}")
}

fn tombstone_key(host: &str) -> String {
    format!("tenant:site:inval:{host}")
}

/// Outcome of a cache read: a hit carries the cached resolution (which may be the cached
/// *absence* of a site); a miss means "ask Postgres".
pub enum CacheLookup {
    Hit(Option<ResolvedSite>),
    Miss,
}

/// Cloneable cache handle. `None` client = caching disabled (no REDIS_URL). All failures
/// degrade to `Miss`/no-op with a warning, never an error to the caller.
#[derive(Clone)]
pub struct SiteCache {
    client: Option<redis::Client>,
    conn: Arc<RwLock<Option<ConnectionManager>>>,
    last_attempt: Arc<Mutex<Option<Instant>>>,
}

impl SiteCache {
    pub fn disabled() -> Self {
        Self {
            client: None,
            conn: Arc::new(RwLock::new(None)),
            last_attempt: Arc::new(Mutex::new(None)),
        }
    }

    /// Build a cache over `url`. Never touches the network here: the connection is
    /// established lazily so a Redis outage at boot heals without a pod restart.
    pub fn new(url: &str) -> anyhow::Result<Self> {
        let client = redis::Client::open(url)?;
        Ok(Self {
            client: Some(client),
            conn: Arc::new(RwLock::new(None)),
            last_attempt: Arc::new(Mutex::new(None)),
        })
    }

    /// The live connection manager, (re)establishing it if absent and the cooldown has
    /// elapsed. Returns `None` (cache disabled/unreachable) rather than erroring.
    async fn manager(&self) -> Option<ConnectionManager> {
        let client = self.client.as_ref()?;
        if let Some(conn) = self.conn.read().await.as_ref() {
            // ConnectionManager itself reconnects after transient drops; once it exists
            // we keep using it.
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
                tracing::info!("site-resolve cache connected to redis");
                *self.conn.write().await = Some(conn.clone());
                Some(conn)
            }
            Ok(Err(e)) => {
                tracing::warn!(error = %e, "site-resolve cache: redis connect failed");
                None
            }
            Err(_) => {
                tracing::warn!("site-resolve cache: redis connect timed out");
                None
            }
        }
    }

    pub async fn get(&self, host: &str) -> CacheLookup {
        let Some(mut conn) = self.manager().await else {
            return CacheLookup::Miss;
        };
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

    /// Cache a resolution, unless an invalidation tombstone says an admin edit landed
    /// while this value was being computed (in which case it may be stale).
    pub async fn put(&self, host: &str, value: &Option<ResolvedSite>) {
        let Some(mut conn) = self.manager().await else {
            return;
        };
        match conn.exists::<_, bool>(tombstone_key(host)).await {
            Ok(true) => return,
            Ok(false) => {}
            Err(e) => {
                tracing::warn!(error = %e, host, "site-cache tombstone check failed");
                return;
            }
        }
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
        if let Err(e) = conn.set_ex::<_, _, ()>(key(host), raw, ttl).await {
            tracing::warn!(error = %e, host, "site-cache write failed");
        }
    }

    /// Eagerly drop entries after an admin edit and leave short tombstones so in-flight
    /// resolves cannot re-cache pre-edit state. Best-effort: a failure just means the
    /// TTL ceiling applies.
    pub async fn invalidate(&self, hosts: &[String]) {
        if hosts.is_empty() {
            return;
        }
        let Some(mut conn) = self.manager().await else {
            return;
        };
        let mut pipe = redis::pipe();
        for host in hosts {
            pipe.del(key(host)).ignore();
            pipe.set_ex(tombstone_key(host), 1, TOMBSTONE_TTL_SECS)
                .ignore();
        }
        if let Err(e) = pipe.query_async::<()>(&mut conn).await {
            tracing::warn!(error = %e, ?hosts, "site-cache invalidation failed");
        }
    }
}
