//! One supervised connection to one server: connect RCON, poll the roster on a cadence,
//! publish each snapshot to the bus, and heartbeat status back to fleet. On any error the
//! loop returns, the supervisor backs off, and it reconnects. This is the unit that will
//! be sharded across Collector replicas later; today one replica runs all of them.

use std::time::Duration;

use chrono::Utc;
use cupboard_bus::Bus;
use cupboard_domain::ROSTER_STREAM;
use cupboard_gameconn::{GameconnError, RconClient};

use crate::fleet_client::{FleetClient, ServerConfig};
use crate::identity_client::IdentityClient;
use crate::mapping::to_roster_event;

const INITIAL_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(30);

/// Run forever (until the task is aborted by the manager): (re)connect and poll.
pub async fn run(
    config: ServerConfig,
    mut bus: Bus,
    fleet: FleetClient,
    identity: IdentityClient,
    poll_interval: Duration,
) {
    let mut backoff = INITIAL_BACKOFF;
    loop {
        match RconClient::connect(
            &config.rcon_host,
            config.rcon_port as u16,
            &config.rcon_password,
        )
        .await
        {
            Ok(client) => {
                backoff = INITIAL_BACKOFF; // reset on a good connection
                tracing::info!(server = %config.name, server_id = %config.id, "rcon connected");
                report(&fleet, &config, "connected", None).await;
                if let Err(e) =
                    poll_loop(&config, client, &mut bus, &fleet, &identity, poll_interval).await
                {
                    tracing::warn!(server = %config.name, error = %e, "rcon poll ended; reconnecting");
                    report(&fleet, &config, "down", Some(&e.to_string())).await;
                }
            }
            Err(e) => {
                tracing::warn!(server = %config.name, error = %e, "rcon connect failed");
                report(&fleet, &config, "down", Some(&e.to_string())).await;
            }
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}

/// Poll `playerlist` on the cadence: publish the snapshot, then enforce bans (kick banned
/// players). Returns on the first RCON error so the supervisor can reconnect.
async fn poll_loop(
    config: &ServerConfig,
    mut client: RconClient,
    bus: &mut Bus,
    fleet: &FleetClient,
    identity: &IdentityClient,
    poll_interval: Duration,
) -> Result<(), GameconnError> {
    let mut ticker = tokio::time::interval(poll_interval);
    loop {
        ticker.tick().await; // fires immediately on the first iteration
        let players = client.playerlist().await?;
        let event = to_roster_event(config.id, config.tenant_id, &players, Utc::now());
        match bus.publish(ROSTER_STREAM, &event).await {
            Ok(entry) => tracing::debug!(
                server = %config.name, players = players.len(), entry = %entry, "published roster"
            ),
            // A bus hiccup shouldn't tear down a healthy RCON connection; log and continue.
            Err(e) => {
                tracing::error!(server = %config.name, error = %e, "failed to publish roster")
            }
        }
        report(fleet, config, "connected", None).await;
        enforce_bans(config, &mut client, identity, &players).await?;
    }
}

/// Ask identity which connected players are banned and kick them over RCON. A ban check
/// failure (identity down) is logged but doesn't tear the connection down; an RCON error
/// while kicking propagates so the supervisor reconnects.
async fn enforce_bans(
    config: &ServerConfig,
    client: &mut RconClient,
    identity: &IdentityClient,
    players: &[cupboard_gameconn::PlayerEntry],
) -> Result<(), GameconnError> {
    if players.is_empty() {
        return Ok(());
    }
    let steam_ids: Vec<String> = players.iter().map(|p| p.steam_id.clone()).collect();
    let hits = match identity
        .enforce(config.tenant_id, config.id, &steam_ids)
        .await
    {
        Ok(h) => h,
        Err(e) => {
            tracing::warn!(server = %config.name, error = %e, "ban enforcement lookup failed; skipping this poll");
            return Ok(());
        }
    };
    for hit in hits {
        let reason = sanitize_reason(hit.reason.as_deref().unwrap_or("banned"));
        // Rust `kick` accepts a Steam ID; kicking each poll keeps a banned player off.
        let cmd = format!("kick \"{}\" \"{}\"", hit.steam_id, reason);
        client.command(&cmd).await?;
        tracing::info!(server = %config.name, steam_id = %hit.steam_id, "kicked banned player");
    }
    Ok(())
}

/// Strip characters that would break the quoted RCON argument.
fn sanitize_reason(reason: &str) -> String {
    reason
        .replace(['"', '\n', '\r'], " ")
        .chars()
        .take(128)
        .collect()
}

/// Best-effort status heartbeat; a fleet outage must not disrupt polling.
async fn report(fleet: &FleetClient, config: &ServerConfig, status: &str, error: Option<&str>) {
    if let Err(e) = fleet.post_status(config.id, status, error).await {
        tracing::debug!(server = %config.name, error = %e, "status heartbeat failed");
    }
}

#[cfg(test)]
mod tests {
    use super::sanitize_reason;

    #[test]
    fn sanitize_strips_quote_injection_and_bounds_length() {
        assert_eq!(sanitize_reason("cheating"), "cheating");
        // Quotes/newlines can't break out of the quoted RCON arg.
        assert_eq!(sanitize_reason("a\"b\nc\rd"), "a b c d");
        assert_eq!(sanitize_reason(&"x".repeat(500)).len(), 128);
    }
}
