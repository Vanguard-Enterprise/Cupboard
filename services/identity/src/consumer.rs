//! The ingestion consumers: one loop per stream (roster, sessions, chat), each on its own
//! Bus connection (a blocking `XREADGROUP` occupies the whole connection) but sharing the
//! `identity` consumer-group name.
//!
//! Every delivered entry is acked — successes, unparseable poison, and failed applies
//! alike. Roster ingestion is self-healing (the next poll re-reports everything); edge and
//! chat events are individually droppable (a lost line is better than a poisoned pending
//! list that blocks the stream).

use cupboard_bus::Bus;
use cupboard_domain::{
    ChatEvent, ReportEvent, RosterEvent, SessionEvent, CHAT_STREAM, REPORT_STREAM, ROSTER_STREAM,
    SESSION_STREAM,
};
use serde::de::DeserializeOwned;
use sqlx::PgPool;
use std::future::Future;
use std::time::Duration;

use crate::domain::ingest;

const GROUP: &str = "identity";
const READ_COUNT: usize = 50;
const BLOCK_MS: usize = 5000;

/// Consume roster snapshots forever.
pub async fn run_roster(bus: Bus, pool: PgPool, pepper: Vec<u8>, consumer_name: String) {
    consume::<RosterEvent, _, _>(bus, ROSTER_STREAM, consumer_name, move |ev| {
        let pool = pool.clone();
        let pepper = pepper.clone();
        async move { ingest::ingest_roster(&pool, &pepper, &ev).await }
    })
    .await
}

/// Consume real-time connect/disconnect edges forever.
pub async fn run_sessions(bus: Bus, pool: PgPool, pepper: Vec<u8>, consumer_name: String) {
    consume::<SessionEvent, _, _>(bus, SESSION_STREAM, consumer_name, move |ev| {
        let pool = pool.clone();
        let pepper = pepper.clone();
        async move { ingest::ingest_session_edge(&pool, &pepper, &ev).await }
    })
    .await
}

/// Consume chat messages forever.
pub async fn run_chat(bus: Bus, pool: PgPool, pepper: Vec<u8>, consumer_name: String) {
    consume::<ChatEvent, _, _>(bus, CHAT_STREAM, consumer_name, move |ev| {
        let pool = pool.clone();
        let pepper = pepper.clone();
        async move { ingest::ingest_chat(&pool, &pepper, &ev).await }
    })
    .await
}

/// Consume F7 reports forever.
pub async fn run_reports(bus: Bus, pool: PgPool, pepper: Vec<u8>, consumer_name: String) {
    consume::<ReportEvent, _, _>(bus, REPORT_STREAM, consumer_name, move |ev| {
        let pool = pool.clone();
        let pepper = pepper.clone();
        async move { ingest::ingest_report(&pool, &pepper, &ev).await }
    })
    .await
}

/// The shared consume loop: ensure the group, read a batch, apply each event, ack
/// everything read (see module docs for why failures ack too).
async fn consume<T, F, Fut>(mut bus: Bus, stream: &'static str, consumer_name: String, mut apply: F)
where
    T: DeserializeOwned + std::fmt::Debug,
    F: FnMut(T) -> Fut,
    Fut: Future<Output = anyhow::Result<()>>,
{
    tracing::info!(consumer = %consumer_name, stream, "identity consumer starting");
    loop {
        if let Err(e) = bus.ensure_group(stream, GROUP).await {
            tracing::warn!(stream, error = %e, "could not ensure consumer group; retrying");
            tokio::time::sleep(Duration::from_secs(1)).await;
            continue;
        }

        let batch = match bus
            .read::<T>(stream, GROUP, &consumer_name, READ_COUNT, BLOCK_MS)
            .await
        {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(stream, error = %e, "bus read failed; retrying");
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
        };

        // Ack everything read — successes and unparseable entries (clears poison).
        let mut ack_ids = batch.failed_ids;
        for d in batch.ok {
            match apply(d.payload).await {
                Ok(()) => tracing::debug!(stream, entry = %d.id, "ingested event"),
                Err(e) => {
                    tracing::error!(stream, entry = %d.id, error = %e, "ingest failed; dropping")
                }
            }
            ack_ids.push(d.id);
        }
        if let Err(e) = bus.ack(stream, GROUP, &ack_ids).await {
            tracing::warn!(stream, error = %e, "ack failed");
        }
    }
}
