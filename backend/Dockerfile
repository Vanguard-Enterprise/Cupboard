FROM rust:1.96.0-bookworm AS build
WORKDIR /build
COPY Cargo.toml Cargo.lock rust-toolchain.toml build.rs ./
RUN mkdir backend && printf 'fn main() {}\n' > backend/main.rs && touch backend/lib.rs \
    && cargo build --release --locked \
    && cargo clean --release --package cupboard
COPY backend ./backend
RUN cargo build --release --locked

FROM debian:bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/Vanguard-Enterprise/Cupboard"
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /build/target/release/cupboard /usr/local/bin/cupboard
USER 65532:65532
ENV CUPBOARD_API_BIND=0.0.0.0:8080
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/cupboard"]
