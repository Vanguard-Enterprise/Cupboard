//! Rust "WebRcon" client — a WebSocket carrying JSON command/response frames.
//!
//! Wire format (both directions are one JSON object per text frame):
//!
//! ```json
//! // request  → { "Identifier": 1, "Message": "playerlist", "Name": "cupboard" }
//! // response ← { "Identifier": 1, "Message": "[ ... ]", "Type": "Generic" }
//! ```
//!
//! The server echoes our `Identifier` back, which is how a reply is correlated to its
//! request. Unsolicited console output and chat arrive with `Identifier` 0 (or -1); the
//! request/response [`RconClient::command`] path skips those, so a poll only ever
//! returns the frame it asked for.

use std::time::Duration;

use futures_util::{SinkExt as _, StreamExt as _};
use serde::{Deserialize, Serialize};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

/// Default time to wait for a single command's reply before giving up.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Debug, thiserror::Error)]
pub enum GameconnError {
    #[error("rcon connect failed: {0}")]
    Connect(String),
    #[error("websocket error: {0}")]
    Ws(#[from] tokio_tungstenite::tungstenite::Error),
    #[error("connection closed by server")]
    Closed,
    #[error("timed out waiting for reply to command (identifier {0})")]
    Timeout(i32),
    #[error("could not parse rcon payload: {0}")]
    Json(#[from] serde_json::Error),
}

/// A frame we send to the server.
#[derive(Serialize)]
struct RconRequest<'a> {
    #[serde(rename = "Identifier")]
    identifier: i32,
    #[serde(rename = "Message")]
    message: &'a str,
    #[serde(rename = "Name")]
    name: &'a str,
}

/// A frame the server sends back. `Type`/`Stacktrace` are informational; we key off
/// `Identifier` to match a reply and read `Message` as the payload.
#[derive(Deserialize)]
struct RconResponse {
    #[serde(rename = "Identifier")]
    identifier: i32,
    #[serde(rename = "Message")]
    message: String,
}

/// One connected player as reported by the `playerlist` command.
///
/// `owner_steam_id` differing from `steam_id` means the game copy is **family-shared** —
/// a strong alt signal the Identity graph consumes later (`docs/identity-schema.md`).
#[derive(Debug, Clone, Deserialize)]
pub struct PlayerEntry {
    #[serde(rename = "SteamID")]
    pub steam_id: String,
    #[serde(rename = "OwnerSteamID", default)]
    pub owner_steam_id: String,
    #[serde(rename = "DisplayName", default)]
    pub display_name: String,
    #[serde(rename = "Ping", default)]
    pub ping: i64,
    /// `ip:port` as the server sees the client; use [`PlayerEntry::ip`] for just the IP.
    #[serde(rename = "Address", default)]
    pub address: String,
    #[serde(rename = "ConnectedSeconds", default)]
    pub connected_seconds: i64,
    #[serde(rename = "Health", default)]
    pub health: f64,
}

impl PlayerEntry {
    /// The IP portion of [`address`](Self::address), dropping the `:port`. Handles IPv4
    /// `1.2.3.4:port` and bracketed IPv6 `[::1]:port`; a bare IPv6 (multiple colons, no
    /// brackets) or a plain host is returned unchanged rather than mangled.
    pub fn ip(&self) -> &str {
        let addr = &self.address;
        if let Some(rest) = addr.strip_prefix('[') {
            // Bracketed IPv6: return whatever is inside the brackets.
            if let Some(end) = rest.find(']') {
                return &rest[..end];
            }
        }
        // Only strip a trailing port when there's exactly one colon (IPv4:port).
        if addr.matches(':').count() == 1 {
            if let Some((ip, _port)) = addr.rsplit_once(':') {
                return ip;
            }
        }
        addr
    }

    /// Whether this player is on a family-shared copy: the owner is a real Steam ID that
    /// differs from the player's. The server reports `"0"` (or empty) when there's no
    /// owner data — that is *not* a share, so it's excluded.
    pub fn is_family_share(&self) -> bool {
        !self.owner_steam_id.is_empty()
            && self.owner_steam_id != "0"
            && self.owner_steam_id != self.steam_id
    }
}

/// A live RCON connection to one server. Poll it with [`command`](Self::command) or the
/// typed [`playerlist`](Self::playerlist) helper.
pub struct RconClient {
    ws: Ws,
    next_id: i32,
    timeout: Duration,
}

impl RconClient {
    /// Dial `ws://{host}:{port}/{password}` and complete the WebSocket handshake. The
    /// password is percent-encoded into the path so values with URL-reserved characters
    /// (space, `/`, `#`, `?`, `%`, …) still produce a valid URL.
    pub async fn connect(host: &str, port: u16, password: &str) -> Result<Self, GameconnError> {
        let url = format!("ws://{host}:{port}/{}", encode_path_segment(password));
        let (ws, _resp) = connect_async(&url)
            .await
            .map_err(|e| GameconnError::Connect(e.to_string()))?;
        Ok(Self {
            ws,
            next_id: 1,
            timeout: DEFAULT_TIMEOUT,
        })
    }

    /// Override the per-command reply timeout (default 10s).
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    fn alloc_id(&mut self) -> i32 {
        let id = self.next_id;
        // Stay positive and skip 0/-1, which the server reuses for unsolicited console
        // and chat frames — using them would let broadcast spam masquerade as our reply.
        // Wrap back to 1 (not 0) on overflow.
        self.next_id = self.next_id.checked_add(1).unwrap_or(1);
        id
    }

    /// Send a console command and return the text of the reply frame with the matching
    /// identifier. Interleaved console/chat frames (different identifier) are discarded.
    pub async fn command(&mut self, cmd: &str) -> Result<String, GameconnError> {
        let id = self.alloc_id();
        let payload = serde_json::to_string(&RconRequest {
            identifier: id,
            message: cmd,
            name: "cupboard",
        })?;
        self.ws.send(Message::Text(payload)).await?;

        loop {
            let next = tokio::time::timeout(self.timeout, self.ws.next())
                .await
                .map_err(|_| GameconnError::Timeout(id))?;
            match next {
                Some(Ok(Message::Text(txt))) => {
                    // Frames that aren't valid response objects (rare) are skipped rather
                    // than fatal — keep reading for our reply until the timeout.
                    if let Ok(resp) = serde_json::from_str::<RconResponse>(txt.as_str()) {
                        if resp.identifier == id {
                            return Ok(resp.message);
                        }
                    }
                }
                // Keepalives / binary / continuation frames: ignore and keep waiting.
                Some(Ok(_)) => {}
                Some(Err(e)) => return Err(e.into()),
                None => return Err(GameconnError::Closed),
            }
        }
    }

    /// Run `playerlist` and parse the current roster.
    pub async fn playerlist(&mut self) -> Result<Vec<PlayerEntry>, GameconnError> {
        let raw = self.command("playerlist").await?;
        Ok(parse_playerlist(&raw)?)
    }
}

/// Parse the JSON array returned by the `playerlist` command. Extracted for unit testing
/// against captured fixtures (CI has no live server to dial).
pub fn parse_playerlist(raw: &str) -> Result<Vec<PlayerEntry>, serde_json::Error> {
    serde_json::from_str(raw)
}

/// Percent-encode a URL path segment, leaving only the unreserved set (RFC 3986) intact.
fn encode_path_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // A representative `playerlist` payload captured from a Rust server. Note `Address`
    // carries the port and the second player is on a family-shared copy.
    const FIXTURE: &str = r#"[
        {"SteamID":"76561197960287930","OwnerSteamID":"76561197960287930","DisplayName":"Alice","Ping":24,"Address":"203.0.113.7:52134","ConnectedSeconds":842,"Health":100.0},
        {"SteamID":"76561198000000001","OwnerSteamID":"76561197960287930","DisplayName":"Bob","Ping":51,"Address":"198.51.100.22:41000","ConnectedSeconds":17,"Health":75.5},
        {"SteamID":"76561198000000002","OwnerSteamID":"0","DisplayName":"Carol","Ping":33,"Address":"192.0.2.5:33333","ConnectedSeconds":5,"Health":100.0}
    ]"#;

    #[test]
    fn parses_roster_fixture() {
        let players = parse_playerlist(FIXTURE).expect("fixture parses");
        assert_eq!(players.len(), 3);
        assert_eq!(players[0].steam_id, "76561197960287930");
        assert_eq!(players[0].display_name, "Alice");
        assert_eq!(players[0].connected_seconds, 842);
    }

    #[test]
    fn strips_port_from_address() {
        let players = parse_playerlist(FIXTURE).unwrap();
        assert_eq!(players[0].ip(), "203.0.113.7");
        assert_eq!(players[1].ip(), "198.51.100.22");
    }

    #[test]
    fn detects_family_share() {
        let players = parse_playerlist(FIXTURE).unwrap();
        assert!(
            !players[0].is_family_share(),
            "owner == self is not a share"
        );
        assert!(players[1].is_family_share(), "Bob plays Alice's copy");
        assert!(
            !players[2].is_family_share(),
            "owner \"0\" is a no-data sentinel, not a share"
        );
    }

    #[test]
    fn empty_roster_parses() {
        assert!(parse_playerlist("[]").unwrap().is_empty());
    }

    #[test]
    fn ip_handles_ipv6_and_ports() {
        let mk = |addr: &str| PlayerEntry {
            steam_id: "1".into(),
            owner_steam_id: String::new(),
            display_name: String::new(),
            ping: 0,
            address: addr.into(),
            connected_seconds: 0,
            health: 0.0,
        };
        assert_eq!(mk("1.2.3.4:28015").ip(), "1.2.3.4");
        assert_eq!(mk("[2001:db8::1]:28015").ip(), "2001:db8::1");
        // Bare IPv6 (no brackets, no port) must not be mangled.
        assert_eq!(mk("2001:db8::1").ip(), "2001:db8::1");
        assert_eq!(mk("fe80::1:2:3").ip(), "fe80::1:2:3");
    }

    #[test]
    fn encodes_url_reserved_chars_in_password() {
        assert_eq!(encode_path_segment("changeme123"), "changeme123");
        assert_eq!(encode_path_segment("a b/c#d%e"), "a%20b%2Fc%23d%25e");
    }

    #[test]
    fn ip_without_port_returned_whole() {
        let p = PlayerEntry {
            steam_id: "1".into(),
            owner_steam_id: String::new(),
            display_name: String::new(),
            ping: 0,
            address: "10.0.0.5".into(),
            connected_seconds: 0,
            health: 0.0,
        };
        assert_eq!(p.ip(), "10.0.0.5");
    }
}
