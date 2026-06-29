# Deploy manifests (draft)

These mirror the **`v-deployments`** GitOps repo's conventions (ArgoCD app-of-apps +
Kustomize, cloned from the `rustlens` pattern). They live here for review; to deploy,
copy them into `v-deployments` and register the ArgoCD `Application`s under
`argocd/applications/use1/`.

> ⚠️ Drafts — verify against the live cluster (reachable only over NetBird VPN) before
> applying. The cluster is memory-bound: resource requests are conservative.

Layout:
- `staging/postgres/` — CNPG Postgres cluster + PgBouncer pooler + ExternalSecret.
- `staging/gateway/` — Gateway namespace, config, secret, Deployment, Service, IngressRoute.
- `argocd/` — one ArgoCD `Application` per component (with argocd-image-updater annotations).

Vault keys expected (KV v2, `ClusterSecretStore vault-backend`):
- `cupboard/staging/pg/cupboard` → `username`, `db_password`
