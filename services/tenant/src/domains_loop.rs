//! The custom-domain reconcile loop: claims due `site_domains` rows and walks each
//! through the DNS-verify -> issue -> active state machine, creating/tearing down the
//! cert-manager `Certificate` + Traefik `IngressRoute` via a [`CertProvisioner`]. Steps
//! are short and idempotent, so a light lease (push `next_check_at` forward on claim) is
//! enough for multi-replica safety.

use crate::cache::{CacheKey, SiteCache};
use crate::certmgr::{CertProvisioner, DomainSpec};
use crate::domain::domains::{self, SiteDomain};
use chrono::Duration;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration as StdDuration;

const TICK: StdDuration = StdDuration::from_secs(30);
const CLAIM_BATCH: i64 = 16;
/// Lease horizon while a row is being processed (well over the slowest step).
const LEASE_SECS: i64 = 120;
/// How long an issued+serving domain rests before a health re-check.
const ACTIVE_RECHECK: Duration = Duration::hours(6);
/// After this many failed issue polls, surface `failed_issuance` (still rechecked at the
/// backoff cap, since cert-manager keeps retrying the ACME challenge itself).
const MAX_ISSUE_ATTEMPTS: i32 = 8;
/// Poll interval while waiting for a cert to become Ready.
const ISSUE_POLL: Duration = Duration::seconds(20);
/// Re-resolve the edge hostname roughly every 5 minutes (and whenever it looks stale) so
/// a transient startup DNS failure or an edge IP change does not mis-gate forever.
const EDGE_REFRESH_TICKS: u32 = 10;
/// Bound on a single DNS lookup so one blackholed domain cannot stall the whole batch
/// (and blow the lease). Kept well under `LEASE_SECS / CLAIM_BATCH`.
const DNS_TIMEOUT: StdDuration = StdDuration::from_secs(5);

/// Config the loop needs beyond the provisioner.
#[derive(Clone)]
pub struct DomainsConfig {
    /// The edge hostname a tenant's DNS must point at for a domain to pass the pre-check.
    /// `None` (no edge configured, e.g. local/dev) skips the pre-check and lets the ACME
    /// HTTP-01 challenge be the gate; `Some` holds new domains until it resolves.
    pub edge_hostname: Option<String>,
}

/// Run until aborted. Caller guarantees a provisioner is available.
pub async fn run<P: CertProvisioner>(
    owner_pool: sqlx::PgPool,
    provisioner: Arc<P>,
    cache: SiteCache,
    config: DomainsConfig,
) {
    let mut ticker = tokio::time::interval(TICK);
    let mut edge_ips = resolve_edge_ips(config.edge_hostname.as_deref()).await;
    let mut ticks_since_refresh = 0u32;
    loop {
        ticker.tick().await;
        // Re-resolve the edge host periodically (and whenever it is unexpectedly empty)
        // so a transient DNS failure at boot or a changed IP self-heals instead of
        // permanently disabling / mis-gating the pre-check.
        ticks_since_refresh += 1;
        if config.edge_hostname.is_some()
            && (ticks_since_refresh >= EDGE_REFRESH_TICKS || edge_ips.is_empty())
        {
            edge_ips = resolve_edge_ips(config.edge_hostname.as_deref()).await;
            ticks_since_refresh = 0;
        }
        let claimed = match domains::claim_due(&owner_pool, CLAIM_BATCH, LEASE_SECS).await {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(error = ?e, "domain claim query failed; retrying next tick");
                continue;
            }
        };
        for domain in claimed {
            let dns_ok = needs_dns_check(&domain.status)
                && dns_points_at_us(&domain.domain, &edge_ips, config.edge_hostname.is_some())
                    .await;
            process_domain(&owner_pool, provisioner.as_ref(), &cache, &domain, dns_ok).await;
        }
    }
}

fn needs_dns_check(status: &str) -> bool {
    matches!(status, "pending_dns" | "failed_dns")
}

/// Stable k8s resource names for a domain (DNS-1123 safe).
pub fn spec_for(domain: &SiteDomain) -> DomainSpec {
    let base = format!("cb-dom-{}", &domain.id.simple().to_string()[..12]);
    DomainSpec {
        domain: domain.domain.clone(),
        cert_name: base.clone(),
        secret_name: format!("{base}-tls"),
        route_name: base,
    }
}

/// Advance one domain by one step. `dns_ok` is only meaningful in the DNS phase (the
/// caller computes it there). Every DB write is guarded on the status the loop claimed
/// (`domain.status`), so a concurrent operator remove/retry that landed mid-flight wins
/// and is never silently reverted.
pub async fn process_domain<P: CertProvisioner>(
    pool: &sqlx::PgPool,
    prov: &P,
    cache: &SiteCache,
    domain: &SiteDomain,
    dns_ok: bool,
) {
    let spec = spec_for(domain);
    let id = domain.id;
    let expected = domain.status.as_str();

    match expected {
        "disabled" => {
            // Stop serving the host immediately. The operator remove path also
            // invalidates, but a teardown that keeps failing must not leave the storefront
            // reachable via a stale positive cache entry until its TTL lapses.
            let _ = cache
                .invalidate(&[CacheKey::SiteHost(domain.domain.clone())])
                .await;
            if let Err(e) = prov.teardown(&spec).await {
                // Leave the row so we retry teardown next tick rather than orphaning CRs.
                tracing::warn!(domain = %domain.domain, error = %e, "domain teardown failed; will retry");
                let _ = domains::transition(
                    pool,
                    id,
                    expected,
                    "disabled",
                    Some(&e.to_string()),
                    0,
                    Duration::minutes(5),
                )
                .await;
                return;
            }
            let _ = domains::delete_row(pool, id).await;
            tracing::info!(domain = %domain.domain, "custom domain removed");
        }

        "pending_dns" | "failed_dns" => {
            if !dns_ok {
                let attempt = domain.attempt_count + 1;
                let _ = domains::transition(
                    pool,
                    id,
                    expected,
                    "failed_dns",
                    Some("DNS does not point at our edge yet"),
                    attempt,
                    domains::backoff(attempt),
                )
                .await;
                return;
            }
            // DNS points at us: provision and move to the issue phase.
            let _ =
                domains::set_resource_names(pool, id, &spec.secret_name, &spec.route_name).await;
            match prov.ensure(&spec).await {
                Ok(()) => {
                    let _ = domains::transition(pool, id, expected, "issuing", None, 0, ISSUE_POLL)
                        .await;
                }
                Err(e) => {
                    let attempt = domain.attempt_count + 1;
                    let _ = domains::transition(
                        pool,
                        id,
                        expected,
                        "dns_ok",
                        Some(&format!("provisioning: {e}")),
                        attempt,
                        domains::backoff(attempt),
                    )
                    .await;
                }
            }
        }

        "dns_ok" | "issuing" | "failed_issuance" | "active" => {
            let was_active = expected == "active";
            // Ensure the resources exist (idempotent; also self-heals a deleted CR).
            if let Err(e) = prov.ensure(&spec).await {
                if was_active {
                    // A transient control-plane error during a routine recheck must not
                    // take a live storefront offline. Keep it active; recheck on cadence.
                    let _ = domains::transition(
                        pool,
                        id,
                        expected,
                        "active",
                        Some(&format!("recheck: {e}")),
                        0,
                        ACTIVE_RECHECK,
                    )
                    .await;
                } else {
                    let attempt = domain.attempt_count + 1;
                    let _ = domains::transition(
                        pool,
                        id,
                        expected,
                        "issuing",
                        Some(&format!("provisioning: {e}")),
                        attempt,
                        domains::backoff(attempt),
                    )
                    .await;
                }
                return;
            }
            match prov.certificate_ready(&spec.cert_name).await {
                Ok(true) => {
                    let applied =
                        domains::transition(pool, id, expected, "active", None, 0, ACTIVE_RECHECK)
                            .await
                            .unwrap_or(false);
                    if applied && !was_active {
                        // Invalidate the exact domain so the storefront starts resolving
                        // immediately (the miss will repopulate from the now-active row).
                        let _ = cache
                            .invalidate(&[CacheKey::SiteHost(domain.domain.clone())])
                            .await;
                        tracing::info!(domain = %domain.domain, "custom domain active");
                    }
                }
                Ok(false) if was_active => {
                    // cert-manager renews well before expiry; a transient not-ready on an
                    // already-active domain must not flap it out of service.
                    let _ =
                        domains::transition(pool, id, expected, "active", None, 0, ACTIVE_RECHECK)
                            .await;
                }
                Ok(false) => {
                    let attempt = domain.attempt_count + 1;
                    let (status, delay) = if attempt >= MAX_ISSUE_ATTEMPTS {
                        ("failed_issuance", domains::backoff(attempt))
                    } else {
                        ("issuing", ISSUE_POLL)
                    };
                    let _ = domains::transition(
                        pool,
                        id,
                        expected,
                        status,
                        Some("waiting for the certificate to be issued (check DNS + CAA)"),
                        attempt,
                        delay,
                    )
                    .await;
                }
                Err(e) if was_active => {
                    let _ = domains::transition(
                        pool,
                        id,
                        expected,
                        "active",
                        Some(&format!("recheck: {e}")),
                        0,
                        ACTIVE_RECHECK,
                    )
                    .await;
                }
                Err(e) => {
                    let attempt = domain.attempt_count + 1;
                    let _ = domains::transition(
                        pool,
                        id,
                        expected,
                        "issuing",
                        Some(&format!("checking certificate: {e}")),
                        attempt,
                        domains::backoff(attempt),
                    )
                    .await;
                }
            }
        }

        other => {
            tracing::warn!(domain = %domain.domain, status = other, "unknown domain status; skipping");
        }
    }
}

/// Resolve the edge hostname to the IPs a custom domain must point at. `None` (no edge
/// configured) returns empty and disables the pre-check; a resolution failure also
/// returns empty, but the loop then *holds* new domains (see `dns_points_at_us`) and
/// retries rather than provisioning arbitrary hostnames.
async fn resolve_edge_ips(edge_hostname: Option<&str>) -> Vec<IpAddr> {
    let Some(host) = edge_hostname else {
        return Vec::new();
    };
    match tokio::time::timeout(DNS_TIMEOUT, tokio::net::lookup_host(format!("{host}:443"))).await {
        Ok(Ok(addrs)) => addrs.map(|s| s.ip()).collect(),
        _ => {
            tracing::warn!(
                edge = host,
                "could not resolve edge hostname; new domains held until it resolves"
            );
            Vec::new()
        }
    }
}

/// Does the domain currently resolve to one of our edge IPs? Best-effort, timeout-bounded
/// A/AAAA lookup via the system resolver.
///
/// - No edge configured (`edge_configured == false`): skip the pre-check (issue anyway and
///   let the ACME challenge gate). This is the local/dev posture.
/// - Edge configured but currently unresolved (`edge_ips` empty): hold, since we cannot
///   verify the target and must not provision an arbitrary hostname.
async fn dns_points_at_us(domain: &str, edge_ips: &[IpAddr], edge_configured: bool) -> bool {
    if !edge_configured {
        return true;
    }
    if edge_ips.is_empty() {
        return false;
    }
    match tokio::time::timeout(
        DNS_TIMEOUT,
        tokio::net::lookup_host(format!("{domain}:443")),
    )
    .await
    {
        Ok(Ok(addrs)) => addrs.map(|s| s.ip()).any(|ip| edge_ips.contains(&ip)),
        _ => false,
    }
}
