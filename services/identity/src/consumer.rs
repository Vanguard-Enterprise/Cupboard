//! The ingestion consumer: read roster snapshots from the bus consumer group and apply
//! them. Roster ingestion is idempotent and self-healing (each poll re-reports the full
//! roster), so we ack every delivered entry — a failed apply is logged and the next poll
//! re-observes, avoiding poison-pill buildup in the pending list.

use cupboard_bus::Bus;
use cupboard_domain::{RosterEvent, ROSTER_STREAM};
use sqlx::PgPool;
use std::time::Duration;

use crate::domain::ingest;

const GROUP: &str = "identity";
const READ_COUNT: usize = 50;
const BLOCK_MS: usize = 5000;

/// Run the consume loop forever (until the task is aborted at shutdown).
pub async fn run(mut bus: Bus, pool: PgPool, pepper: Vec<u8>, consumer_name: String) {
    tracing::info!(consumer = %consumer_name, "identity ingestion consumer starting");
    loop {
        if let Err(e) = bus.ensure_group(ROSTER_STREAM, GROUP).await {
            tracing::warn!(error = %e, "could not ensure consumer group; retrying");
            tokio::time::sleep(Duration::from_secs(1)).await;
            continue;
        }

        let batch = match bus
            .read::<RosterEvent>(ROSTER_STREAM, GROUP, &consumer_name, READ_COUNT, BLOCK_MS)
            .await
        {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(error = %e, "bus read failed; retrying");
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
        };

        // Ack everything read — successes and unparseable entries (clears poison).
        let mut ack_ids = batch.failed_ids;
        for d in batch.ok {
            match ingest::ingest_roster(&pool, &pepper, &d.payload).await {
                Ok(()) => tracing::debug!(
                    entry = %d.id,
                    server_id = %d.payload.server_id,
                    players = d.payload.players.len(),
                    "ingested roster"
                ),
                Err(e) => {
                    tracing::error!(entry = %d.id, error = %e, "roster ingest failed; dropping (next poll re-reports)")
                }
            }
            ack_ids.push(d.id);
        }
        if let Err(e) = bus.ack(ROSTER_STREAM, GROUP, &ack_ids).await {
            tracing::warn!(error = %e, "ack failed");
        }
    }
}
