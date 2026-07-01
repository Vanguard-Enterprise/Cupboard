//! Connection manager: periodically fetch the server list from fleet and reconcile the
//! set of running per-server tasks — start new/changed connections, stop removed ones.
//!
//! Phase 2 runs a single Collector replica owning every connection. The per-server task is
//! the shardable unit; a claim/lease layer can slot in here later without reshaping the
//! task itself.

use std::collections::HashMap;
use std::time::Duration;

use cupboard_bus::Bus;
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::fleet_client::{FleetClient, ServerConfig};

/// The connection-identifying fields; a change means we must reconnect.
#[derive(PartialEq, Clone)]
struct ConnKey {
    host: String,
    port: i32,
    password: String,
}

impl ConnKey {
    fn of(c: &ServerConfig) -> Self {
        Self {
            host: c.rcon_host.clone(),
            port: c.rcon_port,
            password: c.rcon_password.clone(),
        }
    }
}

struct Running {
    handle: JoinHandle<()>,
    key: ConnKey,
}

/// Reconcile loop; runs until aborted.
pub async fn run(
    fleet: FleetClient,
    bus: Bus,
    poll_interval: Duration,
    reconcile_interval: Duration,
) {
    let mut running: HashMap<Uuid, Running> = HashMap::new();
    let mut ticker = tokio::time::interval(reconcile_interval);

    loop {
        ticker.tick().await;

        let configs = match fleet.fetch_configs().await {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(error = %e, "config fetch failed; keeping current connections");
                continue;
            }
        };
        let desired: HashMap<Uuid, ServerConfig> = configs.into_iter().map(|c| (c.id, c)).collect();

        // Stop tasks whose server vanished or whose connection details changed.
        let stale: Vec<Uuid> = running
            .iter()
            .filter_map(|(id, r)| match desired.get(id) {
                None => Some(*id),
                Some(c) if ConnKey::of(c) != r.key => Some(*id),
                Some(_) => None,
            })
            .collect();
        for id in stale {
            if let Some(r) = running.remove(&id) {
                r.handle.abort();
                tracing::info!(server_id = %id, "stopped connection");
            }
        }

        // Start tasks for new (or just-restarted) servers.
        for (id, config) in &desired {
            if !running.contains_key(id) {
                let key = ConnKey::of(config);
                let handle = tokio::spawn(crate::rcon_task::run(
                    config.clone(),
                    bus.clone(),
                    fleet.clone(),
                    poll_interval,
                ));
                running.insert(*id, Running { handle, key });
                tracing::info!(server = %config.name, server_id = %id, "started connection");
            }
        }

        tracing::debug!(active = running.len(), "reconciled connections");
    }
}
