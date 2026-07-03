//! Parsing of unsolicited Rust console lines into session edges.
//!
//! The console stream narrates everything (saves, kills, AI, …); only two line shapes
//! matter for sessions, both prefixed `ip:port/steamid64/name`:
//!
//! ```text
//! 203.0.113.7:52134/76561197960287930/Alice joined [windows/76561197960287930]
//! 203.0.113.7:52134/76561197960287930/Alice disconnecting: disconnect
//! ```
//!
//! Player names are attacker-controlled and may contain `/` (and, in principle, the
//! marker words). The parse anchors on the *last* ` joined [` (the real marker follows
//! the name) and validates the Steam ID is all digits, so a crafted name degrades to a
//! non-match or a mangled display name — never a wrong Steam ID.

use crate::rcon::ip_of_address;

/// A session edge extracted from one console line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConsoleEvent {
    Joined {
        ip: String,
        steam_id: String,
        name: String,
    },
    Disconnected {
        ip: String,
        steam_id: String,
        name: String,
        reason: String,
    },
}

/// Parse one console line; `None` for the (vast) majority of lines that aren't edges.
pub fn parse_console_line(line: &str) -> Option<ConsoleEvent> {
    // Join: `<prefix> joined [<platform>/<steamid>]` — the line ends with the bracket.
    if line.ends_with(']') {
        if let Some(idx) = line.rfind(" joined [") {
            let (ip, steam_id, name) = split_prefix(&line[..idx])?;
            return Some(ConsoleEvent::Joined { ip, steam_id, name });
        }
    }
    // Disconnect: `<prefix> disconnecting: <reason>`.
    if let Some(idx) = line.find(" disconnecting: ") {
        let (ip, steam_id, name) = split_prefix(&line[..idx])?;
        let reason = line[idx + " disconnecting: ".len()..].trim().to_string();
        return Some(ConsoleEvent::Disconnected {
            ip,
            steam_id,
            name,
            reason,
        });
    }
    None
}

/// Split `ip:port/steamid/name` (name may itself contain `/`).
///
/// Rust echoes player chat to the console, so a message crafted as
/// `<junk>/<steamid>/<name> joined [..]` (or `... disconnecting: ..`) would otherwise
/// parse as a real session edge for an arbitrary Steam ID. The address token of a
/// genuine connect line is always a clean `ip:port`, so we require the extracted IP to
/// parse as an `IpAddr` — a chat-echo prefix (`[CHAT] LOCAL Attacker[..] : ..`) fails
/// that check and is rejected.
fn split_prefix(prefix: &str) -> Option<(String, String, String)> {
    let mut parts = prefix.splitn(3, '/');
    let addr = parts.next()?;
    let steam_id = parts.next()?;
    let name = parts.next()?;
    if steam_id.is_empty() || !steam_id.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let ip = ip_of_address(addr);
    if ip.parse::<std::net::IpAddr>().is_err() {
        return None;
    }
    Some((ip.to_string(), steam_id.to_string(), name.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_join_line() {
        let ev = parse_console_line(
            "203.0.113.7:52134/76561197960287930/Alice joined [windows/76561197960287930]",
        )
        .expect("join parses");
        assert_eq!(
            ev,
            ConsoleEvent::Joined {
                ip: "203.0.113.7".into(),
                steam_id: "76561197960287930".into(),
                name: "Alice".into(),
            }
        );
    }

    #[test]
    fn parses_disconnect_line_with_reason() {
        let ev =
            parse_console_line("203.0.113.7:52134/76561197960287930/Alice disconnecting: closing")
                .expect("disconnect parses");
        assert_eq!(
            ev,
            ConsoleEvent::Disconnected {
                ip: "203.0.113.7".into(),
                steam_id: "76561197960287930".into(),
                name: "Alice".into(),
                reason: "closing".into(),
            }
        );
    }

    #[test]
    fn name_containing_slashes_survives() {
        let ev = parse_console_line(
            "198.51.100.9:1000/76561198000000001/we/ird/name joined [windows/76561198000000001]",
        )
        .expect("parses");
        match ev {
            ConsoleEvent::Joined { name, steam_id, .. } => {
                assert_eq!(name, "we/ird/name");
                assert_eq!(steam_id, "76561198000000001");
            }
            other => panic!("expected join, got {other:?}"),
        }
    }

    #[test]
    fn name_containing_join_marker_anchors_on_last_marker() {
        // A hostile name embedding the marker: the REAL marker is the last one, so the
        // Steam ID stays correct and only the display name absorbs the noise.
        let ev = parse_console_line(
            "198.51.100.9:1000/76561198000000001/x joined [w/1] joined [windows/76561198000000001]",
        )
        .expect("parses");
        match ev {
            ConsoleEvent::Joined { steam_id, name, .. } => {
                assert_eq!(steam_id, "76561198000000001");
                assert_eq!(name, "x joined [w/1]");
            }
            other => panic!("expected join, got {other:?}"),
        }
    }

    #[test]
    fn ordinary_console_lines_are_none() {
        for line in [
            "Saving complete",
            "[event] assets/prefabs/npc/cargo plane/cargo_plane.prefab",
            "76561198000000001 was killed by Bear",
            "Calling 'OnServerInitialized' on 'RustPlugin v1.0.0' took 502ms",
            "",
        ] {
            assert_eq!(parse_console_line(line), None, "line: {line}");
        }
    }

    #[test]
    fn non_numeric_steam_id_rejected() {
        assert_eq!(
            parse_console_line("1.2.3.4:5/notanid/Bob joined [windows/1]"),
            None
        );
    }

    #[test]
    fn chat_echo_cannot_forge_a_session_edge() {
        // A player types these as chat; the server echoes them to the console. The
        // address token is not a real ip:port, so parsing must reject them rather than
        // forge a Disconnected/Joined edge for the embedded Steam ID.
        for forged in [
            "[CHAT] LOCAL Attacker[123/76561190000000000] : 1.2.3.4:5/76561198000000001/Bob disconnecting: bye",
            "[CHAT] Attacker : x/76561198000000001/Bob joined [windows/76561198000000001]",
        ] {
            assert_eq!(parse_console_line(forged), None, "line: {forged}");
        }
    }
}
