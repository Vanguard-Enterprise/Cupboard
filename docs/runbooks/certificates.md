# Certificates runbook

Custom-domain TLS for storefronts. cert-manager `Certificate` resources live in
namespace `cupboard-web`; the tenant-configured custom domains get HTTP-01 issued
certs. The metric label `exported_namespace` carries the resource namespace, so both
alerts scope on `exported_namespace="cupboard-web"`.

Background: the grey-cloud custom-domain HTTP-01 setup has known gotchas; see
`docs/custom-domain-tls.md` and the memory note "Cupboard custom-domain TLS".

Degradation matrix: a cert failure degrades one tenant's custom domain, not the
platform. The storefront stays reachable on its default cupboard domain.

## First moves

```
kubectl -n cupboard-web get certificate
kubectl -n cupboard-web describe certificate <name>
kubectl -n cupboard-web get certificaterequest,order,challenge
kubectl -n cert-manager logs deploy/cert-manager --tail=200 | grep <domain>
```

Mimir: `certmanager_certificate_ready_status{exported_namespace="cupboard-web"}`,
`certmanager_certificate_expiration_timestamp_seconds{exported_namespace="cupboard-web"}`.
Platform-wide cert-manager health (`CertManagerAbsent`) is in rules-certmanager; if
cert-manager itself is down, fix that first.

---

## CupboardCertNotReady

`max by (name, exported_namespace) (certmanager_certificate_ready_status{exported_namespace="cupboard-web",condition="False"}) == 1` for 15m. Critical.

A custom-domain cert has been in `Ready=False` for 15m: issuance or renewal is failing.
The affected tenant's custom domain will serve a bad/expired cert or fail TLS.

Diagnose the challenge chain: `Certificate` -> `CertificateRequest` -> `Order` ->
`Challenge`. `kubectl -n cupboard-web describe challenge <name>` shows the HTTP-01
failure reason. Common causes (per docs/custom-domain-tls.md):
- The tenant's DNS is not (or no longer) pointing at the ingress, so the ACME
  validation request never reaches us.
- The domain is proxied (grey-cloud) in a way that intercepts the `/.well-known/
  acme-challenge/` path.
- The ingress route for the challenge path is missing.
- ACME rate limits hit after repeated failures.

Remediation: fix the DNS/proxy, then delete the stuck `Challenge`/`Order` (or annotate
the Certificate to force re-issue) and watch it go Ready. If rate-limited, wait out the
Let's Encrypt window.

## CupboardCertExpiringSoon

`avg by (exported_namespace, name) (certmanager_certificate_expiration_timestamp_seconds{exported_namespace="cupboard-web"} - time()) < 7d` for 1h. Warning.

A custom-domain cert expires in under 7 days and has not renewed. cert-manager renews
at ~2/3 of lifetime (roughly 30 days before expiry for a 90-day LE cert), so hitting
7 days means renewal has been silently failing. Treat as a slow-burn version of
`CupboardCertNotReady`: run the same challenge-chain diagnosis before it goes hard-fail
and breaks TLS for that domain.
