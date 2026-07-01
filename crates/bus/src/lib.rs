//! Thin Redis Streams helper — the Cupboard event bus (ARCHITECTURE Decision 4).
//!
//! The Collector *produces* to a stream with [`Bus::publish`]; Identity/Metrics *consume*
//! via consumer groups ([`Bus::ensure_group`] + [`Bus::read`] + [`Bus::ack`]). Each entry
//! stores the event as JSON under a single `data` field.
//!
//! Payloads are (de)serialized with serde, so producer and consumer share the same typed
//! contract (see `cupboard_domain::events`).
//!
//! **Connection note:** [`read`](Bus::read) issues a *blocking* `XREADGROUP`, which
//! occupies the multiplexed connection for up to its block timeout. Give a consumer its
//! own [`Bus`] (don't also publish on it) so the blocking read can't stall producers.

use redis::streams::{StreamReadOptions, StreamReadReply};
use redis::AsyncCommands as _;
use serde::de::DeserializeOwned;
use serde::Serialize;

/// The field name each stream entry stores its JSON payload under.
const DATA_FIELD: &str = "data";

#[derive(Debug, thiserror::Error)]
pub enum BusError {
    #[error("redis error: {0}")]
    Redis(#[from] redis::RedisError),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("stream entry {0} is missing its `data` field")]
    MissingData(String),
}

/// One consumed, still-unacked stream entry.
#[derive(Debug)]
pub struct Delivery<T> {
    /// The stream entry id (`<ms>-<seq>`), passed back to [`Bus::ack`].
    pub id: String,
    pub payload: T,
}

/// A handle to the Redis Streams bus over a multiplexed async connection.
#[derive(Clone)]
pub struct Bus {
    conn: redis::aio::MultiplexedConnection,
}

impl Bus {
    /// Connect to Redis (e.g. `redis://host:6379`).
    pub async fn connect(url: &str) -> Result<Self, BusError> {
        let client = redis::Client::open(url)?;
        let conn = client.get_multiplexed_async_connection().await?;
        tracing::info!("event bus connected");
        Ok(Self { conn })
    }

    /// `XADD stream * data <json>` — append `payload` and return the new entry id.
    pub async fn publish<T: Serialize>(
        &mut self,
        stream: &str,
        payload: &T,
    ) -> Result<String, BusError> {
        let json = serde_json::to_string(payload)?;
        let id: String = self
            .conn
            .xadd(stream, "*", &[(DATA_FIELD, json.as_str())])
            .await?;
        Ok(id)
    }

    /// Ensure a consumer group exists on `stream`, creating the stream if needed. The
    /// group starts at `$` (only entries added after creation). Idempotent — an existing
    /// group is not an error.
    pub async fn ensure_group(&mut self, stream: &str, group: &str) -> Result<(), BusError> {
        let res: redis::RedisResult<()> =
            self.conn.xgroup_create_mkstream(stream, group, "$").await;
        match res {
            Ok(()) => Ok(()),
            // BUSYGROUP = the group already exists; treat as success.
            Err(e) if e.code() == Some("BUSYGROUP") => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    /// Blocking `XREADGROUP` for new (`>`) entries as `consumer` in `group`, up to `count`
    /// entries, blocking up to `block_ms` for the first one. Returns deserialized
    /// deliveries (still unacked — call [`ack`](Self::ack) once processed).
    pub async fn read<T: DeserializeOwned>(
        &mut self,
        stream: &str,
        group: &str,
        consumer: &str,
        count: usize,
        block_ms: usize,
    ) -> Result<Vec<Delivery<T>>, BusError> {
        let opts = StreamReadOptions::default()
            .group(group, consumer)
            .count(count)
            .block(block_ms);
        let reply: StreamReadReply = self.conn.xread_options(&[stream], &[">"], &opts).await?;

        let mut out = Vec::new();
        for key in reply.keys {
            for entry in key.ids {
                let json: String = entry
                    .get(DATA_FIELD)
                    .ok_or_else(|| BusError::MissingData(entry.id.clone()))?;
                let payload = serde_json::from_str::<T>(&json)?;
                out.push(Delivery {
                    id: entry.id,
                    payload,
                });
            }
        }
        Ok(out)
    }

    /// `XACK` the given entry ids in `group`, marking them processed.
    pub async fn ack(&mut self, stream: &str, group: &str, ids: &[String]) -> Result<(), BusError> {
        if ids.is_empty() {
            return Ok(());
        }
        let _: i64 = self.conn.xack(stream, group, ids).await?;
        Ok(())
    }
}
