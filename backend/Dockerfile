# syntax=docker/dockerfile:1
FROM rust:1.96.0-bookworm AS build
WORKDIR /build
COPY Cargo.toml Cargo.lock rust-toolchain.toml build.rs ./
COPY backend ./backend
# The registry and target caches persist in the runner's Docker daemon, so a
# change to backend code recompiles only this crate.
RUN --mount=type=cache,id=cupboard-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=cupboard-api-target,target=/build/target,sharing=locked \
    cargo build --release --locked \
    && cp target/release/cupboard /cupboard

FROM debian:bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/Vanguard-Enterprise/Cupboard"
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /cupboard /usr/local/bin/cupboard
USER 65532:65532
ENV CUPBOARD_API_BIND=0.0.0.0:8080
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/cupboard"]
