//! Best-effort Redis cache for the public storefront read paths (site resolution and
//! the store catalog). These sit on the hottest public SSR paths; Postgres is the
//! fallback on any miss or Redis failure (the cache can never break rendering).
//!
//! Negative results are cached too (shorter TTL): unknown hosts hitting the public edge
//! must not translate into a Postgres query per request.
//!
//! Two subtleties this module owns:
//! * **Lazy, self-healing connection.** Redis being down at boot (or restarting later)
//!   must only cost cache hits, never pod restarts or a permanently disabled cache; the
//!   manager is (re)established on demand, at most once per cooldown window.
//! * **Invalidation tombstones.** A writer (admin edit, catalog sync) deletes cache
//!   keys, but a public read that hit Postgres *before* the write committed may still
//!   be in flight and would re-cache stale state after the delete. `invalidate` leaves
//!   a short tombstone that puts respect, closing that race window.

use redis::aio::ConnectionManager;
use redis::AsyncCommands;
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;

/// Positive entries: edits propagate within this window (writers also delete keys
/// eagerly, so this is the ceiling, not the norm).
const POSITIVE_TTL_SECS: u64 = 60;
/// Negative entries: long enough to absorb junk traffic, short enough that new state is
/// reachable quickly even if eager invalidation misses.
const NEGATIVE_TTL_SECS: u64 = 30;
/// Tombstone left by `invalidate`; puts skip writes while it exists. Covers reads that
/// were in flight across a write (a read slower than this can still write one stale
/// negative entry, bounded by NEGATIVE_TTL_SECS).
const TOMBSTONE_TTL_SECS: u64 = 5;
/// Minimum spacing between reconnection attempts when Redis is unreachable, so at most
/// one request per window pays the connect cost.
const RECONNECT_COOLDOWN: Duration = Duration::from_secs(10);
/// Bound on a single connection attempt; a hung connect must not stall a public request.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

/// The two cached namespaces. Each entry is addressed by a stable key pair
/// (value key + its invalidation tombstone).
#[derive(Debug, Clone)]
pub enum CacheKey {
    /// Site resolution by public hostname.
    SiteHost(String),
    /// Store catalog by tenant.
    Catalog(Uuid),
}

impl CacheKey {
    fn value_key(&self) -> String {
        match self {
            CacheKey::SiteHost(host) => format!("tenant:site:host:{host}"),
            CacheKey::Catalog(tenant) => format!("tenant:store:catalog:{tenant}"),
        }
    }

    fn tombstone_key(&self) -> String {
        match self {
            CacheKey::SiteHost(host) => format!("tenant:site:inval:{host}"),
            CacheKey::Catalog(tenant) => format!("tenant:store:inval:{tenant}"),
        }
    }
}

/// Outcome of a cache read: a hit carries the cached value (which may be the cached
/// *absence* of one); a miss means "ask Postgres".
pub enum CacheLookup<T> {
    Hit(Option<T>),
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
                tracing::info!("public-read cache connected to redis");
                *self.conn.write().await = Some(conn.clone());
                Some(conn)
            }
            Ok(Err(e)) => {
                tracing::warn!(error = %e, "public-read cache: redis connect failed");
                None
            }
            Err(_) => {
                tracing::warn!("public-read cache: redis connect timed out");
                None
            }
        }
    }

    pub async fn get<T: DeserializeOwned>(&self, key: &CacheKey) -> CacheLookup<T> {
        let Some(mut conn) = self.manager().await else {
            return CacheLookup::Miss;
        };
        match conn.get::<_, Option<String>>(key.value_key()).await {
            Ok(Some(raw)) => match serde_json::from_str::<Option<T>>(&raw) {
                Ok(cached) => CacheLookup::Hit(cached),
                Err(e) => {
                    tracing::warn!(error = %e, key = ?key, "corrupt cache entry; ignoring");
                    CacheLookup::Miss
                }
            },
            Ok(None) => CacheLookup::Miss,
            Err(e) => {
                tracing::warn!(error = %e, key = ?key, "cache read failed; falling back to db");
                CacheLookup::Miss
            }
        }
    }

    /// Cache a value, unless an invalidation tombstone says a write landed while this
    /// value was being computed (in which case it may be stale).
    pub async fn put<T: Serialize>(&self, key: &CacheKey, value: &Option<T>) {
        let Some(mut conn) = self.manager().await else {
            return;
        };
        match conn.exists::<_, bool>(key.tombstone_key()).await {
            Ok(true) => return,
            Ok(false) => {}
            Err(e) => {
                tracing::warn!(error = %e, key = ?key, "cache tombstone check failed");
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
                tracing::warn!(error = %e, key = ?key, "cache serialize failed");
                return;
            }
        };
        if let Err(e) = conn.set_ex::<_, _, ()>(key.value_key(), raw, ttl).await {
            tracing::warn!(error = %e, key = ?key, "cache write failed");
        }
    }

    /// Eagerly drop entries after a write and leave short tombstones so in-flight reads
    /// cannot re-cache pre-write state. Best-effort: a failure just means the TTL
    /// ceiling applies.
    pub async fn invalidate(&self, keys: &[CacheKey]) {
        if keys.is_empty() {
            return;
        }
        let Some(mut conn) = self.manager().await else {
            return;
        };
        let mut pipe = redis::pipe();
        for key in keys {
            pipe.del(key.value_key()).ignore();
            pipe.set_ex(key.tombstone_key(), 1, TOMBSTONE_TTL_SECS)
                .ignore();
        }
        if let Err(e) = pipe.query_async::<()>(&mut conn).await {
            tracing::warn!(error = %e, ?keys, "cache invalidation failed");
        }
    }
}
