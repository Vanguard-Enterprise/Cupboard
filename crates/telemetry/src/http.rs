//! Shared HTTP server-request metrics middleware, recorded through the global OTel
//! meter set up by [`crate::init`]. Every Cupboard axum service uses this instead of
//! re-implementing it. When telemetry runs logs-only (no OTLP endpoint), the global
//! meter is a no-op and these recordings are free.
//!
//! **Apply via `Router::route_layer`, not `Router::layer`.** `route_layer` nests the
//! middleware *inside* routing, so [`MatchedPath`] is populated and the `http.route`
//! label is the bounded template (`/members/{id}`) rather than the unbounded raw path
//! (`/members/2f1c…`). Metrics for unmatched (404) requests are intentionally skipped.

use axum::extract::{MatchedPath, Request};
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

/// Instruments are created once and reused; building them per-request would register
/// duplicate instruments. The meter *scope* name is fixed (`cupboard.http`); the owning
/// service is still attributed via the `service.name` resource attribute.
fn instruments() -> &'static HttpMetrics {
    static METRICS: OnceLock<HttpMetrics> = OnceLock::new();
    METRICS.get_or_init(|| {
        let meter = opentelemetry::global::meter("cupboard.http");
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

/// Middleware that counts requests and records latency, labelled by method, matched
/// route, and status. See the module docs for why this must be applied with
/// `route_layer`.
pub async fn track(req: Request, next: Next) -> Response {
    let method = req.method().to_string();
    // The matched route template is bounded-cardinality; fall back to the raw path only
    // if routing somehow didn't populate it.
    let route = req
        .extensions()
        .get::<MatchedPath>()
        .map(|m| m.as_str().to_owned())
        .unwrap_or_else(|| req.uri().path().to_owned());
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
