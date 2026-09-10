//! One supervised A2S poller per server that has a `query_port`: query A2S_INFO on a
//! cadence and heartbeat the snapshot to fleet. Deliberately independent of the RCON
//! task — A2S keeps reporting server metadata (hostname, map, player counts) even while
//! RCON credentials are wrong or the console is unreachable, which is exactly when an
//! operator most wants to see that the server itself is up.

use std::time::Duration;

use cupboard_gameconn::a2s;

use crate::fleet_client::{FleetClient, ServerConfig};

/// Per-query UDP wait. A2S is a single datagram exchange; anything slower is "down".
const QUERY_TIMEOUT: Duration = Duration::from_secs(5);

/// Run forever (until aborted by the manager). `query_port` is validated by the caller.
pub async fn run(
    config: ServerConfig,
    fleet: FleetClient,
    query_port: u16,
    interval: Duration,
    allow_private_game_servers: bool,
) {
    let mut ticker = tokio::time::interval(interval);
    // A missed tick means we were slow, not that we owe a burst of queries.
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await; // fires immediately on the first iteration
        let query = if allow_private_game_servers {
            a2s::query_info_trusted(&config.rcon_host, query_port, QUERY_TIMEOUT).await
        } else {
            a2s::query_info(&config.rcon_host, query_port, QUERY_TIMEOUT).await
        };
        match query {
            Ok(info) => {
                tracing::debug!(
                    server = %config.name, players = info.players, map = %info.map,
                    "a2s info"
                );
                if let Err(e) = fleet.post_info(config.id, &info).await {
                    tracing::debug!(server = %config.name, error = %e, "a2s info heartbeat failed");
                }
            }
            // Best-effort by design: no A2S (query port closed/filtered) must not affect
            // RCON ingestion, so failures are quiet — the UI shows a stale/absent snapshot.
            Err(e) => {
                tracing::debug!(server = %config.name, error = %e, "a2s query failed")
            }
        }
    }
}
