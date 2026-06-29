# Cupboard

The complete backend + hosted frontend for a **Rust** *(the game)* server network's
entire operation — server lifecycle, performance metrics, BattleMetrics-style player
tracking & moderation, commerce, support, and white-label hosting.

> 🚧 Phase 0 (walking skeleton). See the [build roadmap](docs/ROADMAP.md).

## Documentation

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — system design + the decision log (source of truth)
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — phased build plan
- [`docs/identity-schema.md`](docs/identity-schema.md) — the Identity & Moderation data model
- [`docs/custom-domain-tls.md`](docs/custom-domain-tls.md) — tenant custom-domain TLS
- [`deploy/`](deploy/) — Kubernetes manifests (mirror into `v-deployments`)

## Layout

```
crates/        shared libraries (domain, telemetry, db)
services/      one binary crate per backend service (gateway, …)
apps/          web (Next.js) + bot (TypeScript)   [later phases]
deploy/        Kustomize manifests
docs/          design docs
```

## Develop

```bash
cargo check --workspace       # type-check
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all
cargo test --workspace

# Run the gateway locally (needs a Postgres):
DATABASE_URL=postgres://localhost/cupboard cargo run -p cupboard-gateway
# then: curl localhost:8080/healthz   /readyz
```

## Build a service image

```bash
docker build --build-arg BIN=cupboard-gateway -t cupboard-gateway .
```

## Stack

Rust (Axum · tokio · sqlx) · PostgreSQL (CloudNativePG) · Redis Streams · Mimir ·
Next.js · TypeScript (discord.js) · deployed via ArgoCD/Kustomize on Talos Kubernetes.
Proprietary — Vanguard Enterprise.
