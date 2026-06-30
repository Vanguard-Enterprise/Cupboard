# Deploy

Cupboard deploys into the **`v-deployments`** GitOps cluster (ArgoCD app-of-apps +
Kustomize). The real, authoritative manifests live there — this directory is just a
pointer + runbook so the app repo documents how it ships.

> The earlier monolithic drafts that used to live here have been promoted to
> split-file overlays in `v-deployments`, cloned from the `rustlens` pattern. Edit
> them there, not here, to avoid drift.

## Where the manifests live (in `v-deployments`)

| Component | Path | ArgoCD app |
|-----------|------|------------|
| Gateway overlay (ns, config, secrets, deploy, svc, internal ingress, alerts) | `applications/cupboard/overlays/gateway/` | `argocd/applications/use1/cupboard-gateway.yaml` |
| Postgres (CNPG cluster + rw pooler + bootstrap secret + podmonitor) | `applications/cloudnative-postgres/overlays/cupboard/` | `argocd/applications/use1/cnpg-cupboard.yaml` |

Phase 0 is **staging only**: single Postgres instance, no S3 backup, internal-only
ingress (NetBird), one gateway replica. Redis/event-bus and prod come in later phases.

## Prerequisites (one-time, manual)

The cluster API and internal ingress are reachable **only over the NetBird VPN**.

1. **Vault key** `cupboard/staging/pg/cupboard` (KV v2, `ClusterSecretStore vault-backend`):
   - `username` — e.g. `cupboard`
   - `db_password` — generated
   Used both to bootstrap the CNPG `cupboard` owner role and to compose the gateway's
   `DATABASE_URL`.
2. **GHCR pull creds** — reuses the existing `dockerconfig/aliencord-github` Vault key
   (shared with rustlens); nothing new to create.

## Ship it

1. **Build the image.** Push the Cupboard repo to `main`; CI builds and pushes
   `ghcr.io/vanguard-enterprise/cupboard-gateway:main` (+ `:<sha>`) to GHCR.
2. **Land the manifests.** Commit the new files in `v-deployments` and push to `main`.
3. **Register.** ArgoCD picks up `cnpg-cupboard` and `cupboard-gateway` from
   `argocd/applications/use1/` (app-of-apps); both auto-sync. Bring up the DB app
   first (or just let both sync — the gateway's `readyz` gates on the DB).
4. **Image pinning.** `argocd-image-updater` detects the new `:main` digest and writes
   it back into the gateway overlay's `kustomization.yaml` `images:` block.

## Verify (Phase 0 Definition of Done)

- `kubectl -n cupboard-db get cluster,pooler` → cluster healthy, rw pooler ready.
- `kubectl -n cupboard-gateway get pods` → gateway `Running`, readiness green
  (proves DB connectivity + migrations applied; gateway runs `0001_init.sql` on boot).
- `curl https://cupboard-staging.vngenterprise.com/healthz` (on NetBird) → `{"status":"ok",...}`.
- Grafana: `service.name=cupboard-gateway` present — logs in Loki, traces in Tempo,
  `http_server_request_*` metrics in Mimir.
- Confirm the `_cupboard_meta` row: `schema_baseline = 0001` in the `cupboard` DB.

---

# Phase 1 — Tenancy & Auth

Adds the **auth** service (ClusterIP, behind the gateway), the **web** dashboard, a
non-owner `cupboard_app` DB role for RLS, and new Vault keys. Manifests live in
`v-deployments`:

| Component | Overlay | ArgoCD app |
|-----------|---------|------------|
| Auth (ns, config, secrets, deploy, svc — no ingress) | `applications/cupboard/overlays/auth/` | `argocd/applications/use1/cupboard-auth.yaml` |
| Web dashboard (+ internal ingress) | `applications/cupboard/overlays/web/` | `argocd/applications/use1/cupboard-web.yaml` |
| CNPG `cupboard_app` managed role + secret | `applications/cloudnative-postgres/overlays/cupboard/` (cluster.yaml + external-secrets.yaml) | `cnpg-cupboard` (existing) |
| Gateway: `AUTH_SERVICE_URL` + JWT pubkey | gateway overlay configmap + external-secret | `cupboard-gateway` (existing) |

Hosts: dashboard at `cupboard-app-staging.vngenterprise.com`; the gateway keeps
`cupboard-staging.vngenterprise.com` (API front door + Discord browser redirect). The web
BFF reaches the gateway over ClusterIP.

## Prerequisites — new Vault keys (KV v2, `ClusterSecretStore vault-backend`)

1. **`cupboard/staging/pg/cupboard_app`** — `db_password` (generate): the non-owner role's
   password. CNPG creates the role from this (managed role); auth's app pool uses it.
   ```sh
   vault kv put cupboard/staging/pg/cupboard_app db_password="$(openssl rand -base64 32)"
   ```
2. **`cupboard/staging/auth`** — the EdDSA signing keypair + token pepper:
   ```sh
   openssl genpkey -algorithm ed25519 -out jwt_priv.pem
   openssl pkey -in jwt_priv.pem -pubout -out jwt_pub.pem
   vault kv put cupboard/staging/auth \
     jwt_private_key=@jwt_priv.pem \
     jwt_public_key=@jwt_pub.pem \
     token_pepper="$(openssl rand -base64 48)"
   rm jwt_priv.pem jwt_pub.pem
   ```
   (Discord login + signed cookies stay off until you also add `discord_client_id`,
   `discord_client_secret`, `cookie_signing_key` here AND wire them in the auth
   ExternalSecret + configmap. The service runs email/password-only without them.)

> ⚠️ Both DB passwords are **urlquery-encoded** in the composed `DATABASE_URL`s (Vault
> base64 passwords otherwise break sqlx's URL parser). Already handled in the templates.

## Ship it

1. **Build images.** Push the Cupboard repo to `main`; CI builds + pushes
   `cupboard-auth` (Rust matrix) and `cupboard-web` (Node job) to GHCR.
2. **Land manifests.** Commit the `v-deployments` changes and push to `main`.
3. **Register the new ArgoCD apps.** The root app-of-apps `use1` is **`syncPolicy:None`**
   — it won't pick up the new `cupboard-auth` / `cupboard-web` Application files on its
   own. Either sync `use1` manually in the ArgoCD UI, or apply the CRs directly:
   ```sh
   kubectl apply -f argocd/applications/use1/cupboard-auth.yaml
   kubectl apply -f argocd/applications/use1/cupboard-web.yaml
   ```
4. **Order.** CNPG reconciles the `cupboard_app` role first (so auth's app pool + the
   migration grants work); then auth (runs its `auth`-schema migrations on boot); then
   the gateway picks up `AUTH_SERVICE_URL` + the JWT pubkey; then web.

## Verify (Phase 1 Definition of Done)

- `kubectl -n cupboard-auth get pods` → auth `Running`, readiness green (proves the
  `auth` schema migrated + permission catalog seeded).
- **Flow** (through the gateway at `cupboard-staging.vngenterprise.com`, on NetBird):
  signup → create org → invite staff (use the returned `accept_url`) → second user
  accepts + sets a password → both log in → switch org → an RBAC-gated action is enforced
  (a Moderator gets 403 on `roles.manage`).
- **RLS:** the `cupboard-auth` RLS integration test passes in CI against a non-owner role;
  in-cluster, confirm tenant A's token never returns tenant B's roles/members.
- **Dashboard:** `https://cupboard-app-staging.vngenterprise.com` → login works, tenant
  switcher lists orgs, nav hides routes the role lacks.
- Grafana: `service.name=cupboard-auth` logs/traces/metrics present.
