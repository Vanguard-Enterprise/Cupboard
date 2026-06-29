# Multi-stage build for a single Cupboard service.
# Build one service:  docker build --build-arg BIN=cupboard-gateway -t cupboard-gateway .
ARG RUST_VERSION=1.96.0

FROM rust:${RUST_VERSION}-slim-bookworm AS builder
ARG BIN=cupboard-gateway
WORKDIR /app
# System deps for building (rustls needs no openssl, but keep ca-certs/pkg tooling minimal).
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config && rm -rf /var/lib/apt/lists/*
COPY . .
RUN cargo build --release --locked -p ${BIN} && \
    cp target/release/${BIN} /app/service-bin

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    useradd --system --uid 10001 --no-create-home cupboard
COPY --from=builder /app/service-bin /usr/local/bin/cupboard-service
USER 10001
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/cupboard-service"]
