//! HTTP request metrics, recorded through the global OTel meter and exported via
//! the SDK pipeline set up in `cupboard_telemetry`. When telemetry runs logs-only
//! (no OTLP endpoint), the global meter is a no-op and these recordings are free.

use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;
use opentelemetry::metrics::{Counter, Histogram};
use opentelemetry::KeyValue;
use std::sync::OnceLock;
use std::time::Instant;

struct HttpMetrics {
    requests: Counter<u64>,
    duration: Histogram<f64>,
}

/// Instruments are created once and reused; building them per-request would
/// register duplicate instruments.
fn instruments() -> &'static HttpMetrics {
    static METRICS: OnceLock<HttpMetrics> = OnceLock::new();
    METRICS.get_or_init(|| {
        let meter = opentelemetry::global::meter("cupboard-gateway");
        HttpMetrics {
            requests: meter
                .u64_counter("http.server.request.count")
                .with_description("Total HTTP requests handled")
                .build(),
            duration: meter
                .f64_histogram("http.server.request.duration")
                .with_unit("s")
                .with_description("HTTP server request duration")
                .build(),
        }
    })
}

/// Middleware that counts requests and records latency, labelled by method,
/// route, and status.
pub async fn track(req: Request, next: Next) -> Response {
    let method = req.method().to_string();
    // Phase 0 routes are fixed (`/healthz`, `/readyz`), so the raw path is
    // bounded-cardinality. When parameterized routes land, switch to the
    // `MatchedPath` extension via `route_layer` to avoid per-id label explosion.
    let route = req.uri().path().to_owned();
    let start = Instant::now();

    let response = next.run(req).await;

    let attrs = [
        KeyValue::new("http.request.method", method),
        KeyValue::new("http.route", route),
        KeyValue::new(
            "http.response.status_code",
            i64::from(response.status().as_u16()),
        ),
    ];
    let m = instruments();
    m.requests.add(1, &attrs);
    m.duration.record(start.elapsed().as_secs_f64(), &attrs);

    response
}
