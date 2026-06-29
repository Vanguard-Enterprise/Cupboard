//! Smoke test for the OTLP export path.
//!
//! It doesn't assert that spans/metrics land in a collector — it proves the
//! wiring is sound at runtime: the OTLP/gRPC exporters build, a span and a metric
//! record without panicking, and dropping the guard flushes within a bounded time
//! (catching "no reactor running" panics and shutdown deadlocks against a dead
//! endpoint, the most likely regressions when the OTel crate matrix moves).

use std::time::Duration;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn otlp_init_records_and_flushes() {
    // A free port with nothing listening: the exporter's lazy connect fails fast
    // (connection refused) rather than hanging on a half-open handshake.
    let endpoint = {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        drop(l);
        format!("http://{addr}")
    };

    let guard = cupboard_telemetry::init("telemetry-smoke", Some(&endpoint));

    // Emit a span (→ trace pipeline) and a metric (→ meter pipeline).
    {
        let span = tracing::info_span!("smoke_span", test = true);
        let _enter = span.enter();
        tracing::info!("inside smoke span");
    }
    opentelemetry::global::meter("telemetry-smoke")
        .u64_counter("smoke.count")
        .build()
        .add(1, &[]);

    // Drop on a blocking thread so a deadlocked shutdown trips the timeout
    // instead of wedging the runtime worker that would otherwise drive export.
    let flushed = tokio::time::timeout(
        Duration::from_secs(20),
        tokio::task::spawn_blocking(move || drop(guard)),
    )
    .await;

    assert!(
        flushed.is_ok(),
        "telemetry shutdown did not flush within 20s (possible runtime deadlock)"
    );
    flushed.unwrap().expect("shutdown task panicked");
}
