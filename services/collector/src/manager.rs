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
    query_port: Option<i32>,
}

impl ConnKey {
    fn of(c: &ServerConfig) -> Self {
        Self {
            host: c.rcon_host.clone(),
            port: c.rcon_port,
            password: c.rcon_password.clone(),
            query_port: c.query_port,
        }
    }
}

/// The tasks running for one server: the RCON poller, plus an A2S poller when the server
/// has a query port.
struct Running {
    rcon: JoinHandle<()>,
    a2s: Option<JoinHandle<()>>,
    key: ConnKey,
}

impl Running {
    fn abort(&self) {
        self.rcon.abort();
        if let Some(a2s) = &self.a2s {
            a2s.abort();
        }
    }
}

/// Reconcile loop; runs until aborted. Also refreshes the push-token registry on every
/// fetch, so token issue/rotate/revoke propagate within one reconcile interval.
pub async fn run(
    fleet: FleetClient,
    identity: crate::identity_client::IdentityClient,
    bus: Bus,
    registry: crate::registry::TokenRegistry,
    poll_interval: Duration,
    reconcile_interval: Duration,
    a2s_interval: Duration,
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
        registry.update(&configs);
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
                r.abort();
                tracing::info!(server_id = %id, "stopped connection");
            }
        }

        // Start tasks for new (or just-restarted) servers.
        for (id, config) in &desired {
            if !running.contains_key(id) {
                let key = ConnKey::of(config);
                let rcon = tokio::spawn(crate::rcon_task::run(
                    config.clone(),
                    bus.clone(),
                    fleet.clone(),
                    identity.clone(),
                    poll_interval,
                ));
                // u16 range is guaranteed by fleet's CHECK constraint; anything else is a
                // corrupt row we skip rather than panic on.
                let a2s = config
                    .query_port
                    .and_then(|p| u16::try_from(p).ok())
                    .map(|port| {
                        tokio::spawn(crate::a2s_task::run(
                            config.clone(),
                            fleet.clone(),
                            port,
                            a2s_interval,
                        ))
                    });
                running.insert(*id, Running { rcon, a2s, key });
                tracing::info!(server = %config.name, server_id = %id, "started connection");
            }
        }

        tracing::debug!(active = running.len(), "reconciled connections");
    }
}
