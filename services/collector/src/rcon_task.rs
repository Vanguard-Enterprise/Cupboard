//! One supervised connection to one server: connect RCON, then run a single frame loop
//! that multiplexes the two ingestion shapes on one WebSocket —
//!
//! - **cadence**: send `playerlist` every poll interval, match its reply by identifier,
//!   publish the roster snapshot (the self-healing baseline), and enforce bans;
//! - **stream**: everything the server volunteers in between — chat frames and console
//!   join/disconnect lines — becomes real-time chat/session events, including an
//!   instant ban check on every join (no more waiting out the poll interval).
//!
//! On any error the loop returns, the supervisor backs off, and it reconnects. This is
//! the unit that will be sharded across Collector replicas later.

use std::time::Duration;

use chrono::Utc;
use cupboard_bus::Bus;
use cupboard_domain::{CHAT_STREAM, ROSTER_STREAM, SESSION_STREAM};
use cupboard_gameconn::rcon::parse_playerlist;
use cupboard_gameconn::{ConsoleEvent, GameconnError, RconClient, RconFrame};
use tokio::time::Instant;

use crate::fleet_client::{FleetClient, ServerConfig};
use crate::identity_client::IdentityClient;
use crate::mapping::{to_chat_event, to_roster_event, to_session_event};

const INITIAL_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// How long a `playerlist` reply may take before the connection is declared dead.
const REPLY_TIMEOUT: Duration = Duration::from_secs(10);
/// Bound on the dial + WS handshake. A *filtered* port (firewall drops SYNs — exactly
/// what a down game server behind NAT looks like) otherwise hangs the connect for the
/// OS TCP timeout (minutes), starving the supervisor's backoff loop.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Run forever (until the task is aborted by the manager): (re)connect and poll.
pub async fn run(
    config: ServerConfig,
    mut bus: Bus,
    fleet: FleetClient,
    identity: IdentityClient,
    poll_interval: Duration,
    stream_maxlen: usize,
) {
    // A poll interval below the reply timeout would let the frame loop's wake instant sit
    // in the past while a reply is still pending, hot-spinning the loop. Floor it.
    let poll_interval = poll_interval.max(REPLY_TIMEOUT);
    let mut backoff = INITIAL_BACKOFF;
    loop {
        let dial = match tokio::time::timeout(
            CONNECT_TIMEOUT,
            RconClient::connect(
                &config.rcon_host,
                config.rcon_port as u16,
                &config.rcon_password,
            ),
        )
        .await
        {
            Ok(result) => result,
            Err(_elapsed) => Err(GameconnError::Connect(format!(
                "connect timed out after {CONNECT_TIMEOUT:?}"
            ))),
        };
        match dial {
            Ok(client) => {
                backoff = INITIAL_BACKOFF; // reset on a good connection
                tracing::info!(server = %config.name, server_id = %config.id, "rcon connected");
                report(&fleet, &config, "connected", None).await;
                if let Err(e) = frame_loop(
                    &config,
                    client,
                    &mut bus,
                    &fleet,
                    &identity,
                    poll_interval,
                    stream_maxlen,
                )
                .await
                {
                    tracing::warn!(server = %config.name, error = %e, "rcon loop ended; reconnecting");
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

/// The connection's main loop. Returns on the first RCON error (or an unanswered poll)
/// so the supervisor can reconnect.
#[allow(clippy::too_many_arguments)]
async fn frame_loop(
    config: &ServerConfig,
    mut client: RconClient,
    bus: &mut Bus,
    fleet: &FleetClient,
    identity: &IdentityClient,
    poll_interval: Duration,
    stream_maxlen: usize,
) -> Result<(), GameconnError> {
    let mut next_poll = Instant::now(); // poll immediately on connect
    let mut pending: Option<(i32, Instant)> = None;
    // Liveness deadline armed by any command we send (poll or kick): a live connection
    // returns *some* frame; if none arrives by the deadline the connection is wedged
    // (writes buffer, nothing comes back — a half-open NAT/hang) so we reconnect. Kicks
    // are fire-and-forget for the frame loop, so without this a kick on a wedged socket
    // would go unnoticed until the next poll's own timeout.
    let mut liveness: Option<Instant> = None;

    loop {
        let now = Instant::now();
        // An unanswered `playerlist` past its deadline means the connection is wedged.
        if let Some((id, deadline)) = pending {
            if now >= deadline {
                return Err(GameconnError::Timeout(id));
            }
        }
        if liveness.is_some_and(|d| now >= d) {
            return Err(GameconnError::Timeout(0)); // sent a command, no frame came back
        }
        if now >= next_poll && pending.is_none() {
            let id = client.send_command("playerlist").await?;
            pending = Some((id, now + REPLY_TIMEOUT));
            next_poll = now + poll_interval;
        }

        // Read frames until the earliest deadline (poll tick, reply timeout, liveness).
        let mut wake = next_poll;
        if let Some((_, deadline)) = pending {
            wake = wake.min(deadline);
        }
        if let Some(deadline) = liveness {
            wake = wake.min(deadline);
        }
        let frame = match tokio::time::timeout_at(wake, client.next_frame()).await {
            Err(_elapsed) => continue, // a deadline fired; the loop top handles it
            Ok(frame) => frame?,
        };
        // Any inbound frame proves the socket is alive — clear the liveness watch.
        liveness = None;

        match frame {
            RconFrame::Reply { id, message } if pending.map(|(p, _)| p) == Some(id) => {
                pending = None;
                let players = parse_playerlist(&message)?;
                let event = to_roster_event(config.id, config.tenant_id, &players, Utc::now());
                publish(bus, ROSTER_STREAM, stream_maxlen, &event, config, "roster").await;
                report(fleet, config, "connected", None).await;
                let steam_ids: Vec<String> = players.iter().map(|p| p.steam_id.clone()).collect();
                if enforce_bans(config, &mut client, identity, &steam_ids).await? {
                    liveness.get_or_insert(Instant::now() + REPLY_TIMEOUT);
                }
            }
            // Replies we didn't ask for a result from (kicks) — nothing to do.
            RconFrame::Reply { .. } => {}
            RconFrame::Chat(entry) => {
                let event = to_chat_event(config.id, config.tenant_id, &entry, Utc::now());
                publish(bus, CHAT_STREAM, stream_maxlen, &event, config, "chat").await;
            }
            RconFrame::Console(line) => {
                if let Some(edge) = cupboard_gameconn::parse_console_line(&line) {
                    let joined_steam_id = match &edge {
                        ConsoleEvent::Joined { steam_id, .. } => Some(steam_id.clone()),
                        ConsoleEvent::Disconnected { .. } => None,
                    };
                    let event = to_session_event(config.id, config.tenant_id, &edge, Utc::now());
                    publish(
                        bus,
                        SESSION_STREAM,
                        stream_maxlen,
                        &event,
                        config,
                        "session",
                    )
                    .await;
                    // Instant enforcement: a banned player is kicked on the join edge,
                    // not at the next poll.
                    if let Some(steam_id) = joined_steam_id {
                        if enforce_bans(config, &mut client, identity, &[steam_id]).await? {
                            liveness.get_or_insert(Instant::now() + REPLY_TIMEOUT);
                        }
                    }
                }
            }
        }
    }
}

/// Publish one event with the same `XADD MAXLEN ~` cap the push path uses, so a stalled
/// consumer can't grow chat/session/roster streams unbounded. A bus hiccup must not tear
/// down a healthy RCON connection (roster self-heals next poll; a lost chat line is
/// acceptable), so failures only log.
async fn publish<T: serde::Serialize>(
    bus: &mut Bus,
    stream: &str,
    maxlen: usize,
    event: &T,
    config: &ServerConfig,
    what: &str,
) {
    if let Err(e) = bus.publish_capped(stream, maxlen, event).await {
        tracing::error!(server = %config.name, error = %e, "failed to publish {what} event");
    }
}

/// Ask identity which of `steam_ids` are banned here and kick the hits (fire-and-forget;
/// their replies surface as unmatched `Reply` frames). Returns whether any kick was sent,
/// so the caller can arm the liveness watch. A ban-lookup failure (identity down) is
/// logged but doesn't tear the connection down; an RCON send error propagates so the
/// supervisor reconnects.
async fn enforce_bans(
    config: &ServerConfig,
    client: &mut RconClient,
    identity: &IdentityClient,
    steam_ids: &[String],
) -> Result<bool, GameconnError> {
    if steam_ids.is_empty() {
        return Ok(false);
    }
    let hits = match identity
        .enforce(config.tenant_id, config.id, steam_ids)
        .await
    {
        Ok(h) => h,
        Err(e) => {
            tracing::warn!(server = %config.name, error = %e, "ban enforcement lookup failed; skipping");
            return Ok(false);
        }
    };
    let mut kicked = false;
    for hit in hits {
        // Both fields are quoted into the RCON command, so both must be sanitized — a
        // hostile/non-standard server could report a Steam ID with quotes/backslashes.
        let steam_id = sanitize_arg(&hit.steam_id);
        let reason = sanitize_arg(hit.reason.as_deref().unwrap_or("banned"));
        // Rust `kick` accepts a Steam ID; kicking each poll keeps a banned player off.
        let cmd = format!("kick \"{steam_id}\" \"{reason}\"");
        client.send_command(&cmd).await?;
        kicked = true;
        // SteamID64 is PII (HMAC-hashed at rest); never log it raw.
        tracing::info!(server = %config.name, server_id = %config.id, "kicked banned player");
    }
    Ok(kicked)
}

/// Strip characters that could break out of (or malform) a quoted RCON argument — quotes,
/// backslashes, and newlines — and bound the length.
fn sanitize_arg(value: &str) -> String {
    value
        .replace(['"', '\\', '\n', '\r'], " ")
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
    use super::sanitize_arg;

    #[test]
    fn sanitize_strips_injection_and_bounds_length() {
        assert_eq!(sanitize_arg("cheating"), "cheating");
        // Quotes, backslashes, and newlines can't break out of the quoted RCON arg.
        assert_eq!(sanitize_arg("a\"b\nc\rd\\e"), "a b c d e");
        assert_eq!(sanitize_arg(&"x".repeat(500)).len(), 128);
    }
}
