//! Claims store connections and keeps one runner task per claim.

use crate::cache::SiteCache;
use crate::config::Config;
use crate::domain::store;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::task::JoinHandle;
use uuid::Uuid;

const TICK: Duration = Duration::from_secs(15);
/// Claims per tick; a small batch keeps a restarted replica from grabbing the whole
/// fleet in one gulp while another replica is also coming up.
const CLAIM_BATCH: i64 = 8;

/// Runs until aborted. Caller guarantees `config.tenant_master_key` is present.
pub async fn run(owner_pool: sqlx::PgPool, cache: SiteCache, config: Arc<Config>) {
    let Some(master_key) = config.tenant_master_key else {
        tracing::error!("store supervisor started without a master key; disabling");
        return;
    };
    // Suffixed so a human reading store_connections can tell which subsystem holds the
    // lease (BM precedent in identity).
    let claimer = format!("{}-store", config.consumer_name);
    let mut running: HashMap<Uuid, JoinHandle<()>> = HashMap::new();
    let mut ticker = tokio::time::interval(TICK);

    loop {
        ticker.tick().await;
        running.retain(|_, handle| !handle.is_finished());

        let claimed = match store::claim_ready(&owner_pool, &claimer, CLAIM_BATCH).await {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(error = ?e, "store claim query failed; retrying next tick");
                continue;
            }
        };
        for conn in claimed {
            // The claim query re-matches rows we already hold (it refreshes their
            // heartbeat); only spawn for connections without a live runner.
            if running.contains_key(&conn.id) {
                continue;
            }
            let id = conn.id;
            let handle = tokio::spawn(runner_entry(
                owner_pool.clone(),
                cache.clone(),
                conn,
                master_key,
                config.paynow_api_base.clone(),
                claimer.clone(),
            ));
            running.insert(id, handle);
            tracing::info!(connection = %id, "store runner started");
        }
    }
}

async fn runner_entry(
    pool: sqlx::PgPool,
    cache: SiteCache,
    conn: store::StoreConnection,
    master_key: [u8; 32],
    paynow_base: String,
    claimer: String,
) {
    super::runner::run(pool, cache, conn, master_key, paynow_base, claimer).await;
}
