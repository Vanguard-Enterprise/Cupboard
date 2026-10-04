//! Bounded, read-only protocol probes. Never retain or log peer payloads or errors:
//! WebRCON request URLs contain the password, and servers can echo it in replies.
use futures_util::{SinkExt, StreamExt};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use std::{net::SocketAddr, time::Duration};
use tokio::net::{TcpStream, UdpSocket, lookup_host};
use tokio_tungstenite::{
    client_async_with_config,
    tungstenite::{Error, Message, protocol::WebSocketConfig},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Connected,
    AuthenticationFailed,
    Unreachable,
    Timeout,
    InvalidConfiguration,
    ProtocolError,
}
impl Outcome {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Connected => "connected",
            Self::AuthenticationFailed => "authentication_failed",
            Self::Unreachable => "unreachable",
            Self::Timeout => "timeout",
            Self::InvalidConfiguration => "invalid_configuration",
            Self::ProtocolError => "protocol_error",
        }
    }
}
const DEADLINE: Duration = Duration::from_secs(5);
const INFO: &[u8] = b"\xff\xff\xff\xffTSource Engine Query\0";

async fn addresses(host: &str, port: i32) -> Result<Vec<SocketAddr>, Outcome> {
    if !crate::servers::host(host) || !(1..=65535).contains(&port) {
        return Err(Outcome::InvalidConfiguration);
    }
    let addresses: Vec<_> = lookup_host((host, port as u16))
        .await
        .map_err(|_| Outcome::Unreachable)?
        .take(8)
        .collect();
    if addresses.is_empty() {
        return Err(Outcome::Unreachable);
    }
    // Private networks are intentional for operator-owned servers. Do not send
    // probes to multicast, broadcast, unspecified, or link-local metadata hosts.
    if addresses.iter().any(|a| match a.ip() {
        std::net::IpAddr::V4(ip) => {
            ip.is_unspecified() || ip.is_multicast() || ip.is_broadcast() || ip.is_link_local()
        }
        std::net::IpAddr::V6(ip) => {
            ip.is_unspecified()
                || ip.is_multicast()
                || ip.is_unicast_link_local()
                || ip.to_ipv4_mapped().is_some_and(|ip| {
                    ip.is_unspecified()
                        || ip.is_multicast()
                        || ip.is_broadcast()
                        || ip.is_link_local()
                })
        }
    }) {
        return Err(Outcome::InvalidConfiguration);
    }
    Ok(addresses)
}

pub(crate) async fn rcon(host: &str, port: i32, password: &str) -> Outcome {
    tokio::time::timeout(DEADLINE, rcon_inner(host, port, password))
        .await
        .unwrap_or(Outcome::Timeout)
}
async fn rcon_inner(host: &str, port: i32, password: &str) -> Outcome {
    if password.is_empty() || password.len() > 1024 || password.chars().any(char::is_control) {
        return Outcome::InvalidConfiguration;
    }
    let addresses = match addresses(host, port).await {
        Ok(a) => a,
        Err(e) => return e,
    };
    let stream = match TcpStream::connect(addresses.as_slice()).await {
        Ok(s) => s,
        Err(_) => return Outcome::Unreachable,
    };
    let authority = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    let url = format!(
        "ws://{authority}:{port}/{}",
        utf8_percent_encode(password, NON_ALPHANUMERIC)
    );
    let config = WebSocketConfig::default()
        .max_message_size(Some(64 * 1024))
        .max_frame_size(Some(64 * 1024));
    let (mut socket, _) = match client_async_with_config(url, stream, Some(config)).await {
        Ok(s) => s,
        Err(Error::Http(response)) if matches!(response.status().as_u16(), 401 | 403) => {
            return Outcome::AuthenticationFailed;
        }
        Err(Error::Io(_)) => return Outcome::Unreachable,
        Err(_) => return Outcome::ProtocolError,
    };
    let identifier = 1;
    let request =
        serde_json::json!({"Identifier":identifier,"Message":"serverinfo","Name":"Cupboard"});
    if socket
        .send(Message::Text(request.to_string().into()))
        .await
        .is_err()
    {
        return Outcome::Unreachable;
    }
    // Ignore broadcasts but bound noisy/malicious peers as well as message size.
    for _ in 0..64 {
        match socket.next().await {
            Some(Ok(Message::Text(text))) => {
                let Ok(reply) = serde_json::from_str::<serde_json::Value>(&text) else {
                    return Outcome::ProtocolError;
                };
                if reply.get("Identifier").and_then(|v| v.as_i64()) != Some(identifier) {
                    continue;
                }
                let info = reply
                    .get("Message")
                    .and_then(|v| v.as_str())
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());
                return if info.is_some_and(|v| {
                    v.get("Hostname").is_some_and(|h| h.is_string())
                        && v.get("Players").and_then(|p| p.as_u64()).is_some()
                }) {
                    Outcome::Connected
                } else {
                    Outcome::ProtocolError
                };
            }
            Some(Ok(Message::Ping(_))) => {
                if socket.flush().await.is_err() {
                    return Outcome::Unreachable;
                }
            }
            Some(Ok(Message::Pong(_))) => {}
            Some(Err(Error::Io(_))) => return Outcome::Unreachable,
            _ => return Outcome::ProtocolError,
        }
    }
    Outcome::ProtocolError
}

pub(crate) async fn a2s(host: &str, port: i32) -> Outcome {
    tokio::time::timeout(DEADLINE, a2s_inner(host, port))
        .await
        .unwrap_or(Outcome::Timeout)
}
async fn a2s_inner(host: &str, port: i32) -> Outcome {
    let addresses = match addresses(host, port).await {
        Ok(a) => a,
        Err(e) => return e,
    };
    // Probe resolved addresses concurrently so an unreachable IPv6 address does
    // not hide a working IPv4 address. DNS is resolved once, before connecting.
    let mut attempts = futures_util::stream::FuturesUnordered::new();
    for address in addresses {
        attempts.push(a2s_address(address));
    }
    let mut result = Outcome::Unreachable;
    while let Some(outcome) = attempts.next().await {
        if outcome == Outcome::Connected {
            return outcome;
        }
        if outcome != Outcome::Unreachable {
            result = outcome;
        }
    }
    result
}
async fn a2s_address(address: SocketAddr) -> Outcome {
    let Ok(socket) = UdpSocket::bind(if address.is_ipv4() {
        "0.0.0.0:0"
    } else {
        "[::]:0"
    })
    .await
    else {
        return Outcome::Unreachable;
    };
    if socket.connect(address).await.is_err() {
        return Outcome::Unreachable;
    }
    let mut request = INFO.to_vec();
    let mut buffer = [0; 65536];
    for _ in 0..3 {
        if socket.send(&request).await.is_err() {
            return Outcome::Unreachable;
        }
        let len = match socket.recv(&mut buffer).await {
            Ok(n) => n,
            Err(_) => return Outcome::Unreachable,
        };
        let packet = &buffer[..len];
        if packet.len() == 9 && packet.starts_with(b"\xff\xff\xff\xffA") {
            request = INFO.to_vec();
            request.extend_from_slice(&packet[5..]);
            continue;
        }
        return if valid_info(packet) {
            Outcome::Connected
        } else {
            Outcome::ProtocolError
        };
    }
    Outcome::ProtocolError
}

// Validate all required Source INFO fields before reporting success. Optional
// EDF fields are bounded by the datagram. Split/compressed responses are not
// accepted as proof of connectivity in this first Rust INFO probe.
fn valid_info(packet: &[u8]) -> bool {
    if !packet.starts_with(b"\xff\xff\xff\xffI") || packet.len() < 6 {
        return false;
    }
    let mut rest = &packet[6..];
    for _ in 0..4 {
        let Some(end) = rest.iter().position(|b| *b == 0) else {
            return false;
        };
        rest = &rest[end + 1..];
    }
    // App ID, players, max players, bots, server type, environment, visibility, VAC.
    if rest.len() < 9 {
        return false;
    }
    rest[9..].contains(&0)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use tokio::net::TcpListener;
    use tokio_tungstenite::{accept_async, accept_hdr_async};

    pub(crate) fn info_packet() -> Vec<u8> {
        b"\xff\xff\xff\xffI\x11Test Rust\0Procedural Map\0rust\0Rust\0\x60\x09\x00\x64\x00dl\x00\x01\x32\0".to_vec()
    }
    pub(crate) async fn success_servers() -> (u16, u16, tokio::task::JoinHandle<()>) {
        let tcp = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let ports = (
            tcp.local_addr().unwrap().port(),
            udp.local_addr().unwrap().port(),
        );
        let task = tokio::spawn(async move {
            tokio::join!(
                async {
                    let (stream, _) = tcp.accept().await.unwrap();
                    let mut ws = accept_async(stream).await.unwrap();
                    let command = ws.next().await.unwrap().unwrap().into_text().unwrap();
                    let value: serde_json::Value = serde_json::from_str(&command).unwrap();
                    assert_eq!(value["Message"], "serverinfo");
                    ws.send(Message::Text(
                        serde_json::json!({"Identifier":0,"Message":"broadcast"})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .unwrap();
                    ws.send(Message::Text(serde_json::json!({"Identifier":value["Identifier"],"Message":"{\"Hostname\":\"Test Rust\",\"Players\":0}"}).to_string().into())).await.unwrap();
                },
                async {
                    let mut buffer = [0; 1024];
                    let (n, peer) = udp.recv_from(&mut buffer).await.unwrap();
                    assert_eq!(&buffer[..n], INFO);
                    udp.send_to(b"\xff\xff\xff\xffA\x12\x34\x56\x78", peer)
                        .await
                        .unwrap();
                    let (n, peer) = udp.recv_from(&mut buffer).await.unwrap();
                    assert_eq!(&buffer[..n], [INFO, b"\x12\x34\x56\x78"].concat());
                    udp.send_to(&info_packet(), peer).await.unwrap();
                }
            );
        });
        (ports.0, ports.1, task)
    }
    #[tokio::test]
    async fn authenticates_correlates_rcon_and_answers_a2s_challenge() {
        let (rcon_port, a2s_port, task) = success_servers().await;
        let (r, a) = tokio::join!(
            rcon("127.0.0.1", rcon_port.into(), "a password"),
            a2s("127.0.0.1", a2s_port.into())
        );
        assert_eq!(r, Outcome::Connected);
        assert_eq!(a, Outcome::Connected);
        task.await.unwrap();
    }
    #[tokio::test]
    #[allow(clippy::result_large_err)] // Tungstenite callback requires its unboxed HTTP response.
    async fn distinguishes_authentication_rejection_and_encodes_secret_path() {
        let tcp = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = tcp.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let (stream, _) = tcp.accept().await.unwrap();
            let _ = accept_hdr_async(
                stream,
                |req: &tokio_tungstenite::tungstenite::handshake::server::Request, _response| {
                    assert_eq!(req.uri().path(), "/secret%2F%3F%23%20%25");
                    Err(tokio_tungstenite::tungstenite::http::Response::builder()
                        .status(401)
                        .body(Some("secret/?# %".to_owned()))
                        .unwrap())
                },
            )
            .await;
        });
        assert_eq!(
            rcon("127.0.0.1", port.into(), "secret/?# %").await,
            Outcome::AuthenticationFailed
        );
        task.await.unwrap();
    }
    #[tokio::test]
    async fn rejects_wrong_protocol_and_truncated_a2s_responses() {
        let packet = info_packet();
        assert!(valid_info(&packet));
        for len in 0..packet.len() {
            assert!(!valid_info(&packet[..len]));
        }
        let udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let port = udp.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let (_, peer) = udp.recv_from(&mut [0; 1024]).await.unwrap();
            udp.send_to(b"secret-containing-invalid-response", peer)
                .await
                .unwrap();
        });
        assert_eq!(a2s("127.0.0.1", port.into()).await, Outcome::ProtocolError);
        task.await.unwrap();
    }
    #[tokio::test]
    async fn classifies_unreachable_invalid_and_silent_endpoints() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert_eq!(
            rcon("127.0.0.1", port.into(), "test").await,
            Outcome::Unreachable
        );
        for host in [
            "https://bad",
            "169.254.169.254",
            "::ffff:169.254.169.254",
            "224.0.0.1",
            "0.0.0.0",
        ] {
            assert_eq!(a2s(host, 27017).await, Outcome::InvalidConfiguration);
        }
        assert_eq!(
            rcon("127.0.0.1", 0, "test").await,
            Outcome::InvalidConfiguration
        );
        let tcp = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let (r, a) = tokio::join!(
            rcon("127.0.0.1", tcp.local_addr().unwrap().port().into(), "test"),
            a2s("127.0.0.1", udp.local_addr().unwrap().port().into())
        );
        assert_eq!(r, Outcome::Timeout);
        assert_eq!(a, Outcome::Timeout);
    }
}
