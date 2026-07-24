//! Shared SSRF address guard for the outbound game-server dial paths.
//!
//! Legitimate targets are public customer game servers (the Phase 7 NetworkPolicy
//! "internet-except-RFC1918" carve-out). A tenant-supplied host that resolves into a
//! blocked range means someone is trying to point the collector at cluster-internal
//! infrastructure (cloud metadata, private/loopback ranges, cluster DNS) and read the
//! written-back connection status or A2S banner as an internal-reachability oracle.
//!
//! The guard validates the RESOLVED address(es), not the hostname string, so a DNS
//! rebind that maps a public name to a private IP is still caught. Both the RCON and A2S
//! dial paths run it before touching the network.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

/// True if `ip` is in a range the collector must never dial: IPv4 private, loopback,
/// link-local, CGNAT, unspecified, broadcast, or documentation; IPv6 loopback,
/// unspecified, link-local, ULA, or documentation; plus the IPv4-mapped IPv6 form of any
/// blocked v4 address.
pub fn is_blocked_addr(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_v4(v4),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => is_blocked_v4(v4),
            None => is_blocked_v6(v6),
        },
    }
}

fn is_blocked_v4(ip: Ipv4Addr) -> bool {
    // 10/8, 172.16/12, 192.168/16 (private); 127/8 (loopback); 169.254/16 (link-local);
    // 0.0.0.0 (unspecified); 255.255.255.255 (broadcast).
    if ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
    {
        return true;
    }
    let o = ip.octets();
    // CGNAT / shared address space: 100.64.0.0/10.
    if o[0] == 100 && (64..=127).contains(&o[1]) {
        return true;
    }
    // Documentation (RFC 5737): TEST-NET-1/2/3.
    (o[0] == 192 && o[1] == 0 && o[2] == 2)
        || (o[0] == 198 && o[1] == 51 && o[2] == 100)
        || (o[0] == 203 && o[1] == 0 && o[2] == 113)
}

fn is_blocked_v6(ip: Ipv6Addr) -> bool {
    if ip.is_loopback() || ip.is_unspecified() {
        return true;
    }
    let seg = ip.segments();
    // Link-local unicast fe80::/10.
    if (seg[0] & 0xffc0) == 0xfe80 {
        return true;
    }
    // Unique local addresses fc00::/7.
    if (seg[0] & 0xfe00) == 0xfc00 {
        return true;
    }
    // Documentation 2001:db8::/32.
    seg[0] == 0x2001 && seg[1] == 0x0db8
}

/// Resolve `host:port` to its socket addresses.
pub async fn resolve(host: &str, port: u16) -> std::io::Result<Vec<SocketAddr>> {
    Ok(tokio::net::lookup_host((host, port)).await?.collect())
}

/// Whether `host` resolves to at least one blocked address. Propagates the resolver error
/// so callers can distinguish "could not resolve" (transient) from "resolved to blocked".
pub async fn resolves_to_blocked(host: &str, port: u16) -> std::io::Result<bool> {
    Ok(resolve(host, port)
        .await?
        .iter()
        .any(|a| is_blocked_addr(a.ip())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_internal_and_allows_public() {
        let blocked = [
            "10.0.0.1",
            "172.16.5.5",
            "192.168.1.1",
            "127.0.0.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "255.255.255.255",
            "203.0.113.7",
            "::1",
            "::",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "2001:db8::1",
            "::ffff:10.0.0.1",
            "::ffff:127.0.0.1",
        ];
        for s in blocked {
            let ip: IpAddr = s.parse().unwrap();
            assert!(is_blocked_addr(ip), "{s} must be blocked");
        }

        let allowed = [
            "1.2.3.4",
            "8.8.8.8",
            "203.0.114.1",
            "2606:4700:4700::1111",
            "::ffff:8.8.8.8",
        ];
        for s in allowed {
            let ip: IpAddr = s.parse().unwrap();
            assert!(!is_blocked_addr(ip), "{s} must be allowed");
        }
    }
}
