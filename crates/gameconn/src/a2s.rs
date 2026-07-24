//! A2S_INFO (Source query protocol) over UDP — server metadata without RCON.
//!
//! One request/one response with an optional challenge round-trip (servers issue
//! challenges since the 2020 reflection-attack mitigation):
//!
//! ```text
//! → FF FF FF FF 54 "Source Engine Query\0" [challenge]
//! ← FF FF FF FF 41 <4-byte challenge>          (resend the request with it)
//! ← FF FF FF FF 49 <info payload>              (the answer)
//! ```
//!
//! Rust (the game) quirk: the wire `players`/`max_players` fields are single bytes, but
//! Rust servers routinely exceed 255 slots and instead encode the real numbers in the
//! EDF `keywords` string as `mp<max>`, `cp<current>`, `qp<queued>` tokens. The parser
//! prefers those when present and falls back to the byte fields.

use std::time::Duration;

use tokio::net::UdpSocket;

/// `FF FF FF FF` — a single-packet ("simple") response header.
const SIMPLE_HEADER: [u8; 4] = [0xFF, 0xFF, 0xFF, 0xFF];
/// `FF FF FF FE` — a split ("multi-packet") response header. Not expected for A2S_INFO.
const SPLIT_HEADER: [u8; 4] = [0xFF, 0xFF, 0xFF, 0xFE];
/// Payload of an A2S_INFO request, after the simple header.
const INFO_REQUEST: &[u8] = b"TSource Engine Query\0";
/// Response type bytes.
const TYPE_CHALLENGE: u8 = 0x41; // 'A'
const TYPE_INFO: u8 = 0x49; // 'I'

/// Challenge round-trips to tolerate before giving up (normally exactly one).
const MAX_CHALLENGE_RETRIES: u32 = 3;

#[derive(Debug, thiserror::Error)]
pub enum A2sError {
    #[error("a2s io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("a2s query timed out")]
    Timeout,
    #[error("could not resolve host {0}")]
    Resolve(String),
    #[error("refusing to query blocked address for host {0}")]
    BlockedAddress(String),
    #[error("malformed a2s response: {0}")]
    Parse(String),
    #[error("unexpected a2s response type 0x{0:02x}")]
    UnexpectedType(u8),
    #[error("server kept demanding challenges")]
    ChallengeLoop,
}

/// Server metadata from an A2S_INFO reply, with the Rust keyword counts folded in.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ServerInfo {
    /// The server's public hostname (the listing name, not DNS).
    pub hostname: String,
    pub map: String,
    /// Current player count — keyword `cp` when present, else the wire byte.
    pub players: u16,
    /// Player cap — keyword `mp` when present, else the wire byte.
    pub max_players: u16,
    /// Queued-to-join count (Rust keyword `qp`), when reported.
    pub queued: Option<u16>,
    /// The raw EDF keywords string, kept for later enrichment (wipe cycle, tags…).
    pub keywords: Option<String>,
}

/// Query one server's A2S_INFO. `timeout` bounds each UDP wait (not the whole exchange;
/// worst case is `MAX_CHALLENGE_RETRIES + 1` waits).
pub async fn query_info(host: &str, port: u16, timeout: Duration) -> Result<ServerInfo, A2sError> {
    // Resolve first so the local bind can match the peer's address family, and run the
    // SSRF guard over every resolved address before sending a single packet.
    let addrs = crate::guard::resolve(host, port).await?;
    let peer = *addrs
        .first()
        .ok_or_else(|| A2sError::Resolve(host.to_string()))?;
    if addrs.iter().any(|a| crate::guard::is_blocked_addr(a.ip())) {
        return Err(A2sError::BlockedAddress(host.to_string()));
    }
    let bind_addr = if peer.is_ipv6() {
        "[::]:0"
    } else {
        "0.0.0.0:0"
    };
    let socket = UdpSocket::bind(bind_addr).await?;
    socket.connect(peer).await?;

    let mut challenge: Option<[u8; 4]> = None;
    let mut buf = vec![0u8; 4096];
    for _ in 0..=MAX_CHALLENGE_RETRIES {
        let mut request = Vec::with_capacity(SIMPLE_HEADER.len() + INFO_REQUEST.len() + 4);
        request.extend_from_slice(&SIMPLE_HEADER);
        request.extend_from_slice(INFO_REQUEST);
        if let Some(c) = challenge {
            request.extend_from_slice(&c);
        }
        socket.send(&request).await?;

        let n = tokio::time::timeout(timeout, socket.recv(&mut buf))
            .await
            .map_err(|_| A2sError::Timeout)??;
        let packet = &buf[..n];

        if packet.len() < 5 {
            return Err(A2sError::Parse("response shorter than header".into()));
        }
        if packet[..4] == SPLIT_HEADER {
            return Err(A2sError::Parse("split-packet A2S_INFO response".into()));
        }
        if packet[..4] != SIMPLE_HEADER {
            return Err(A2sError::Parse("bad response header".into()));
        }
        match packet[4] {
            TYPE_CHALLENGE => {
                let c: [u8; 4] = packet[5..]
                    .try_into()
                    .map_err(|_| A2sError::Parse("challenge shorter than 4 bytes".into()))?;
                challenge = Some(c);
            }
            TYPE_INFO => return parse_info(&packet[5..]),
            other => return Err(A2sError::UnexpectedType(other)),
        }
    }
    Err(A2sError::ChallengeLoop)
}

/// Parse an A2S_INFO payload (the bytes after `FF FF FF FF 49`).
pub fn parse_info(payload: &[u8]) -> Result<ServerInfo, A2sError> {
    let mut cur = Cursor {
        buf: payload,
        pos: 0,
    };

    let _protocol = cur.u8()?;
    let hostname = cur.cstring()?;
    let map = cur.cstring()?;
    let _folder = cur.cstring()?;
    let _game = cur.cstring()?;
    let _app_id = cur.u16_le()?;
    let players_byte = cur.u8()?;
    let max_players_byte = cur.u8()?;
    let _bots = cur.u8()?;
    let _server_type = cur.u8()?;
    let _environment = cur.u8()?;
    let _visibility = cur.u8()?;
    let _vac = cur.u8()?;
    let _version = cur.cstring()?;

    // Extra Data Flag + its optional fields; only keywords matter to us, but the earlier
    // fields must be walked to reach them.
    let mut keywords = None;
    if let Ok(edf) = cur.u8() {
        if edf & 0x80 != 0 {
            let _port = cur.u16_le()?;
        }
        if edf & 0x10 != 0 {
            cur.skip(8)?; // server Steam ID
        }
        if edf & 0x40 != 0 {
            let _stv_port = cur.u16_le()?;
            let _stv_name = cur.cstring()?;
        }
        if edf & 0x20 != 0 {
            keywords = Some(cur.cstring()?);
        }
    }

    let (kw_players, kw_max, kw_queued) = keyword_counts(keywords.as_deref().unwrap_or(""));
    Ok(ServerInfo {
        hostname,
        map,
        players: kw_players.unwrap_or(players_byte as u16),
        max_players: kw_max.unwrap_or(max_players_byte as u16),
        queued: kw_queued,
        keywords,
    })
}

/// Extract Rust's `cp`/`mp`/`qp` numeric tokens from the keywords string.
fn keyword_counts(keywords: &str) -> (Option<u16>, Option<u16>, Option<u16>) {
    let (mut cp, mut mp, mut qp) = (None, None, None);
    for token in keywords.split(',') {
        for (prefix, slot) in [("cp", &mut cp), ("mp", &mut mp), ("qp", &mut qp)] {
            if let Some(rest) = token.strip_prefix(prefix) {
                if !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()) {
                    *slot = rest.parse::<u16>().ok();
                }
            }
        }
    }
    (cp, mp, qp)
}

/// Minimal byte-walking cursor for the fixed-order A2S payload.
struct Cursor<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl Cursor<'_> {
    fn u8(&mut self) -> Result<u8, A2sError> {
        let b = *self
            .buf
            .get(self.pos)
            .ok_or_else(|| A2sError::Parse("truncated payload".into()))?;
        self.pos += 1;
        Ok(b)
    }

    fn u16_le(&mut self) -> Result<u16, A2sError> {
        let lo = self.u8()?;
        let hi = self.u8()?;
        Ok(u16::from_le_bytes([lo, hi]))
    }

    fn skip(&mut self, n: usize) -> Result<(), A2sError> {
        if self.pos + n > self.buf.len() {
            return Err(A2sError::Parse("truncated payload".into()));
        }
        self.pos += n;
        Ok(())
    }

    fn cstring(&mut self) -> Result<String, A2sError> {
        let rest = &self.buf[self.pos..];
        let end = rest
            .iter()
            .position(|&b| b == 0)
            .ok_or_else(|| A2sError::Parse("unterminated string".into()))?;
        self.pos += end + 1;
        Ok(String::from_utf8_lossy(&rest[..end]).into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a syntactically valid info payload (post-header bytes) for tests.
    fn build_payload(
        hostname: &str,
        map: &str,
        players: u8,
        max_players: u8,
        keywords: Option<&str>,
    ) -> Vec<u8> {
        let mut p = Vec::new();
        p.push(17); // protocol
        for s in [hostname, map, "rust", "Rust"] {
            p.extend_from_slice(s.as_bytes());
            p.push(0);
        }
        p.extend_from_slice(&[0x4A, 0xDA]); // app id, low 16 bits of Rust's 252490
        p.push(players);
        p.push(max_players);
        p.push(0); // bots
        p.push(b'd'); // server type
        p.push(b'l'); // environment
        p.push(0); // visibility
        p.push(1); // vac
        p.extend_from_slice(b"2569\0"); // version
        if let Some(kw) = keywords {
            p.push(0x20 | 0x80 | 0x10); // EDF: port + steamid + keywords
            p.extend_from_slice(&28015u16.to_le_bytes()); // port
            p.extend_from_slice(&[0u8; 8]); // steam id
            p.extend_from_slice(kw.as_bytes());
            p.push(0);
        }
        p
    }

    #[test]
    fn parses_rust_style_info_with_keyword_counts() {
        let payload = build_payload(
            "Cupboard Test | 2x",
            "Procedural Map",
            255, // the byte caps out; the truth is in the keywords
            255,
            Some("mp300,cp287,qp12,pt~rak,v2569,h1a2b3c"),
        );
        let info = parse_info(&payload).expect("parses");
        assert_eq!(info.hostname, "Cupboard Test | 2x");
        assert_eq!(info.map, "Procedural Map");
        assert_eq!(info.players, 287);
        assert_eq!(info.max_players, 300);
        assert_eq!(info.queued, Some(12));
    }

    #[test]
    fn falls_back_to_byte_counts_without_keywords() {
        let payload = build_payload("Small Server", "HapisIsland", 12, 100, None);
        let info = parse_info(&payload).expect("parses");
        assert_eq!(info.players, 12);
        assert_eq!(info.max_players, 100);
        assert_eq!(info.queued, None);
        assert!(info.keywords.is_none());
    }

    #[test]
    fn ignores_non_numeric_keyword_lookalikes() {
        // `mp` inside other tokens (or with a non-numeric tail) must not be picked up.
        let (cp, mp, qp) = keyword_counts("cpfoo,mp,tramp42,qp7");
        assert_eq!(cp, None);
        assert_eq!(mp, None);
        assert_eq!(qp, Some(7));
    }

    #[test]
    fn truncated_payload_is_an_error_not_a_panic() {
        let payload = build_payload("X", "Y", 1, 2, Some("mp10,cp1"));
        for len in 0..payload.len() {
            // Every prefix must fail cleanly or parse (the EDF block is optional).
            let _ = parse_info(&payload[..len]);
        }
    }

    #[tokio::test]
    async fn query_info_rejects_blocked_literal_without_sending() {
        let err = query_info("127.0.0.1", 28015, Duration::from_millis(50))
            .await
            .unwrap_err();
        assert!(
            matches!(err, A2sError::BlockedAddress(_)),
            "loopback must be refused as BlockedAddress, got {err:?}"
        );
    }

    #[test]
    fn unterminated_string_is_an_error() {
        let err = parse_info(&[17, b'n', b'o', b'z', b'e', b'r', b'o']).unwrap_err();
        assert!(matches!(err, A2sError::Parse(_)));
    }
}
