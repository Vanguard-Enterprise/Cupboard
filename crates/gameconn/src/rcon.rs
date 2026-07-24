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

use std::net::IpAddr;
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
    #[error("refusing to dial blocked address for host {0}")]
    BlockedAddress(String),
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

/// A frame the server sends back. We key off `Identifier` to match a reply, `Type` to
/// spot broadcast chat, and read `Message` as the payload.
#[derive(Deserialize)]
struct RconResponse {
    #[serde(rename = "Identifier")]
    identifier: i32,
    #[serde(rename = "Message")]
    message: String,
    #[serde(rename = "Type", default)]
    kind: String,
}

/// One inbound frame, classified. Replies carry the `Identifier` of the request they
/// answer; everything the server volunteers (`Identifier` 0/-1) is chat or console.
#[derive(Debug)]
pub enum RconFrame {
    /// The reply to a command we sent.
    Reply { id: i32, message: String },
    /// A broadcast chat message (`Type: "Chat"`; the payload is nested JSON).
    Chat(ChatEntry),
    /// An unsolicited console line (joins, disconnects, saves, kills, …).
    Console(String),
}

/// The nested JSON payload of a chat frame.
#[derive(Debug, Clone, Deserialize)]
pub struct ChatEntry {
    /// 0 = global, 1 = team (raw — Rust adds channels without notice).
    #[serde(rename = "Channel", default)]
    pub channel: i64,
    #[serde(rename = "Message", default)]
    pub message: String,
    /// SteamID64 of the sender; `"0"` for server/system messages. The wire type has
    /// flip-flopped between string and number across Rust builds, so accept both.
    #[serde(rename = "UserId", default, deserialize_with = "string_or_number")]
    pub user_id: String,
    #[serde(rename = "Username", default)]
    pub username: String,
    /// Unix seconds, server clock.
    #[serde(rename = "Time", default)]
    pub time: i64,
}

/// Deserialize a JSON string *or* number into a `String`.
fn string_or_number<'de, D: serde::Deserializer<'de>>(de: D) -> Result<String, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum V {
        S(String),
        N(u64),
    }
    Ok(match V::deserialize(de)? {
        V::S(s) => s,
        V::N(n) => n.to_string(),
    })
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

/// The IP portion of an `ip:port` address, dropping the `:port`. Handles IPv4
/// `1.2.3.4:port` and bracketed IPv6 `[::1]:port`; a bare IPv6 (multiple colons, no
/// brackets) or a plain host is returned unchanged rather than mangled.
pub fn ip_of_address(addr: &str) -> &str {
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

impl PlayerEntry {
    /// The IP portion of [`address`](Self::address) — see [`ip_of_address`].
    pub fn ip(&self) -> &str {
        ip_of_address(&self.address)
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
        // SSRF guard: resolve the host and refuse if any resolved address is in a blocked
        // (cluster-internal) range, then dial the validated IP directly. Connecting by the
        // resolved IP (rather than the hostname) closes the DNS-rebind TOCTOU window that a
        // re-resolving ws client would otherwise leave open; for Rust WebRcon the handshake
        // Host header is not vhosted, so an IP literal is fine.
        let addrs = crate::guard::resolve(host, port)
            .await
            .map_err(|e| GameconnError::Connect(e.to_string()))?;
        let target = addrs
            .first()
            .copied()
            .ok_or_else(|| GameconnError::Connect(format!("could not resolve {host}")))?;
        if addrs.iter().any(|a| crate::guard::is_blocked_addr(a.ip())) {
            return Err(GameconnError::BlockedAddress(host.to_string()));
        }
        let host_str = match target.ip() {
            IpAddr::V4(v4) => v4.to_string(),
            IpAddr::V6(v6) => format!("[{v6}]"),
        };
        let url = format!(
            "ws://{host_str}:{}/{}",
            target.port(),
            encode_path_segment(password)
        );
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

    /// Send a command without waiting for its reply; returns the identifier the reply
    /// will carry. For fire-and-forget commands (kicks) and callers that multiplex
    /// replies with the console stream via [`next_frame`](Self::next_frame).
    pub async fn send_command(&mut self, cmd: &str) -> Result<i32, GameconnError> {
        let id = self.alloc_id();
        let payload = serde_json::to_string(&RconRequest {
            identifier: id,
            message: cmd,
            name: "cupboard",
        })?;
        self.ws.send(Message::Text(payload)).await?;
        Ok(id)
    }

    /// Read the next classified frame — a command reply, broadcast chat, or a console
    /// line. No timeout of its own (the console stream is idle between events); callers
    /// wrap it in `tokio::time::timeout` as needed. Cancel-safe: dropping the future
    /// never loses a frame.
    pub async fn next_frame(&mut self) -> Result<RconFrame, GameconnError> {
        loop {
            match self.ws.next().await {
                Some(Ok(Message::Text(txt))) => {
                    // Frames that aren't valid response objects (rare) are skipped rather
                    // than fatal.
                    if let Ok(resp) = serde_json::from_str::<RconResponse>(txt.as_str()) {
                        return Ok(classify(resp));
                    }
                }
                // Keepalives / binary / continuation frames: ignore and keep waiting.
                Some(Ok(_)) => {}
                Some(Err(e)) => return Err(e.into()),
                None => return Err(GameconnError::Closed),
            }
        }
    }

    /// Send a console command and return the text of the reply frame with the matching
    /// identifier. Interleaved console/chat frames are discarded — use
    /// [`next_frame`](Self::next_frame) when the stream matters.
    pub async fn command(&mut self, cmd: &str) -> Result<String, GameconnError> {
        let id = self.send_command(cmd).await?;
        loop {
            let frame = tokio::time::timeout(self.timeout, self.next_frame())
                .await
                .map_err(|_| GameconnError::Timeout(id))??;
            if let RconFrame::Reply { id: rid, message } = frame {
                if rid == id {
                    return Ok(message);
                }
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

/// Classify one wire frame. Chat is keyed off `Type` (its `Identifier` has varied across
/// builds); a chat frame whose nested payload fails to parse degrades to a console line
/// rather than being dropped.
fn classify(resp: RconResponse) -> RconFrame {
    if resp.kind == "Chat" {
        if let Ok(chat) = serde_json::from_str::<ChatEntry>(&resp.message) {
            return RconFrame::Chat(chat);
        }
    }
    if resp.identifier > 0 {
        RconFrame::Reply {
            id: resp.identifier,
            message: resp.message,
        }
    } else {
        RconFrame::Console(resp.message)
    }
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
    fn classifies_chat_reply_and_console_frames() {
        let chat_payload = r##"{"Channel":0,"Message":"hello","UserId":"76561197960287930","Username":"Alice","Color":"#5af","Time":1751328000}"##;
        let chat = serde_json::from_str::<RconResponse>(&format!(
            r#"{{"Identifier":-1,"Message":{},"Type":"Chat","Stacktrace":null}}"#,
            serde_json::to_string(chat_payload).unwrap()
        ))
        .unwrap();
        match classify(chat) {
            RconFrame::Chat(c) => {
                assert_eq!(c.user_id, "76561197960287930");
                assert_eq!(c.username, "Alice");
                assert_eq!(c.message, "hello");
                assert_eq!(c.channel, 0);
            }
            other => panic!("expected chat, got {other:?}"),
        }

        // Older builds send UserId as a JSON number — must still parse.
        let numeric = serde_json::from_str::<RconResponse>(
            r#"{"Identifier":0,"Message":"{\"Channel\":1,\"Message\":\"team msg\",\"UserId\":76561197960287930,\"Username\":\"Bob\",\"Time\":1}","Type":"Chat"}"#,
        )
        .unwrap();
        match classify(numeric) {
            RconFrame::Chat(c) => {
                assert_eq!(c.user_id, "76561197960287930");
                assert_eq!(c.channel, 1);
            }
            other => panic!("expected chat, got {other:?}"),
        }

        let reply = serde_json::from_str::<RconResponse>(
            r#"{"Identifier":7,"Message":"[]","Type":"Generic"}"#,
        )
        .unwrap();
        assert!(matches!(classify(reply), RconFrame::Reply { id: 7, .. }));

        let console = serde_json::from_str::<RconResponse>(
            r#"{"Identifier":0,"Message":"Saving complete","Type":"Generic"}"#,
        )
        .unwrap();
        match classify(console) {
            RconFrame::Console(line) => assert_eq!(line, "Saving complete"),
            other => panic!("expected console, got {other:?}"),
        }

        // A chat-typed frame with an unparseable payload degrades to console, not a drop.
        let broken = serde_json::from_str::<RconResponse>(
            r#"{"Identifier":-1,"Message":"not json","Type":"Chat"}"#,
        )
        .unwrap();
        assert!(matches!(classify(broken), RconFrame::Console(_)));
    }

    #[test]
    fn encodes_url_reserved_chars_in_password() {
        assert_eq!(encode_path_segment("changeme123"), "changeme123");
        assert_eq!(encode_path_segment("a b/c#d%e"), "a%20b%2Fc%23d%25e");
    }

    #[tokio::test]
    async fn connect_rejects_blocked_literals_without_dialing() {
        for host in ["127.0.0.1", "10.0.0.5"] {
            // `RconClient` is not `Debug`, so match rather than `unwrap_err`.
            match RconClient::connect(host, 28016, "pw").await {
                Err(GameconnError::BlockedAddress(_)) => {}
                Err(other) => panic!("host {host} must be BlockedAddress, got {other:?}"),
                Ok(_) => panic!("host {host} must not connect"),
            }
        }
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
