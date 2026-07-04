//! Claims BM connections with runnable work and keeps one runner task per claim.

use super::fleet_client::FleetClient;
use crate::config::Config;
use crate::domain::bm;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::task::JoinHandle;
use uuid::Uuid;

const TICK: Duration = Duration::from_secs(15);
/// Claims per tick; a small batch keeps a restarted replica from grabbing the whole
/// fleet in one gulp while another replica is also coming up.
const CLAIM_BATCH: i64 = 8;

/// Runs until aborted. Caller guarantees `config.identity_master_key` is present.
pub async fn run(owner_pool: sqlx::PgPool, config: Arc<Config>) {
    let Some(master_key) = config.identity_master_key else {
        tracing::error!("BM supervisor started without a master key; disabling");
        return;
    };
    // Distinct from the consumer name proper so a human reading bm_connections can
    // tell which subsystem holds the lease.
    let claimer = format!("{}-bm", config.consumer_name);
    let pepper = config.value_pepper.as_bytes().to_vec();
    // Fleet client for the import's servers phase. Needs both the URL and the shared
    // internal token; absent either, the servers phase skips with a counted reason.
    let fleet = match (
        config.fleet_internal_url.as_deref(),
        config.internal_api_token.as_deref(),
    ) {
        (Some(url), Some(token)) => Some(FleetClient::new(
            reqwest::Client::new(),
            url.to_string(),
            token.to_string(),
        )),
        _ => {
            tracing::info!(
                "fleet internal URL/token unset: BM import servers phase will skip \
                 (players/notes still import)"
            );
            None
        }
    };
    let mut running: HashMap<Uuid, JoinHandle<()>> = HashMap::new();
    let mut ticker = tokio::time::interval(TICK);

    loop {
        ticker.tick().await;
        running.retain(|_, handle| !handle.is_finished());

        let claimed = match bm::claim_ready(&owner_pool, &claimer, CLAIM_BATCH).await {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(error = ?e, "BM claim query failed; retrying next tick");
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
                conn,
                master_key,
                config.bm_api_base.clone(),
                claimer.clone(),
                pepper.clone(),
                fleet.clone(),
            ));
            running.insert(id, handle);
            tracing::info!(connection = %id, "BM runner started");
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn runner_entry(
    pool: sqlx::PgPool,
    conn: bm::BmConnection,
    master_key: [u8; 32],
    bm_api_base: String,
    claimer: String,
    pepper: Vec<u8>,
    fleet: Option<FleetClient>,
) {
    super::runner::run(pool, conn, master_key, bm_api_base, claimer, pepper, fleet).await;
}
