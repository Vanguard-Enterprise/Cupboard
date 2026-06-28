# Open design problem: TLS for tenant custom domains

**Status:** open — needs a decision before the white-label storefront/admin hosting ships.

## The requirement

Cupboard hosts each tenant's storefront *and* admin panel. When a tenant connects
their **own domain** (e.g. `store.theircommunity.gg`), both surfaces must serve over
HTTPS on that domain. Domains are **arbitrary and tenant-supplied** — we do not
control their DNS.

## Why the existing setup doesn't cover it

The `v-deployments` cluster issues TLS via **cert-manager**, but:

- The only `ClusterIssuer` is `letsencrypt-production`, using an **ACME DNS-01**
  solver via Cloudflare.
- It is **scoped by `dnsZones`** to a fixed set of Cloudflare-owned zones
  (`vngenterprise.com`, `vng.bet`, `rustlens.com`, `hyplex.gg`, `mancini.beer`).
- There is **no HTTP-01 solver**.

So we can issue `*.<our-zone>` wildcards, but we **cannot** issue a cert for a
domain we don't own in Cloudflare. That's exactly the white-label case.

Cupboard's *own* domains (e.g. a `*.cupboard.<zone>` wildcard) reuse the existing
pattern fine — this problem is only about **tenant-supplied** domains.

## Tenant onboarding flow (independent of solver choice)

1. Tenant enters their domain in the dashboard.
2. We show them a DNS record to add (a `CNAME`/`A` pointing at our edge).
3. We verify the record resolves to us.
4. Only then do we request a cert and start serving the domain.

## Options for cert issuance

### A. cert-manager **HTTP-01** + per-domain `Certificate`/`Ingress` via the k8s API
The **Sites** service (in the `tenant` service) creates a `Certificate` (or an
annotated IngressRoute) per verified domain through the Kubernetes API; cert-manager
solves HTTP-01 over Traefik.
- ➕ Stays within the existing cert-manager/Traefik toolchain.
- ➖ Cupboard must hold k8s API credentials and create CRs at runtime; one cert
  object per tenant domain (hundreds → fine, tens of thousands → watch etcd load).

### B. Traefik **on-demand ACME** (built-in certResolver, HTTP challenge)
Let Traefik obtain certs on first request for known hosts.
- ➕ No per-domain CRs; Traefik manages the cert store.
- ➖ Diverges from the cert-manager-everywhere convention; cert storage/HA needs care.

### C. Dedicated **edge proxy with on-demand TLS** (e.g. Caddy) for the storefront tier
A separate ingress in front of the storefront/admin that issues certs on-demand,
gated by an "is this a known tenant domain?" check.
- ➕ Purpose-built for exactly this (Caddy on-demand TLS is near-zero-ops); clean
  separation from the platform's internal ingress.
- ➖ Adds a component to run; two ingress paths to reason about.

## Recommendation (to confirm)

Lean **A** (cert-manager HTTP-01, CRs created by the Sites service) at the scale of
hundreds of tenants — it reuses the existing toolchain and keeps one mental model.
Revisit **C** (Caddy on-demand edge) if/when tenant-domain counts reach the tens of
thousands, where per-domain CRs become an etcd-load concern.

Either way, **rate-limit cert issuance** (Let's Encrypt limits) and verify domain
ownership before requesting a cert.
