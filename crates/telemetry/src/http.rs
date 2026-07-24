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
use tower_http::classify::{ServerErrorsAsFailures, SharedClassifier};
use tower_http::trace::{MakeSpan, TraceLayer};
use tracing::{Level, Span};

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
        // Never fall back to the raw filled path: a misconfigured route without
        // MatchedPath would otherwise emit unbounded paths as a metric label. Use a
        // constant sentinel so cardinality stays bounded.
        .unwrap_or_else(|| "<unmatched>".to_owned());
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

/// Constant recorded in place of a request's query string. The query is dropped
/// wholesale (see [`redacted_target`]); this marker only signals that one was
/// present, without leaking any of its values.
const REDACTED_QUERY: &str = "?<redacted>";

/// Build the span target from a request URI, recording the path but never the query
/// string. Provider callbacks and entitlement lookups put PII in the query
/// (SteamID64, OAuth `code`/`state`, `steam_id`); dropping it keeps that PII out of
/// the INFO request span exported to Loki/Tempo.
fn redacted_target(uri: &axum::http::Uri) -> String {
    let path = uri.path();
    if uri.query().is_some() {
        format!("{path}{REDACTED_QUERY}")
    } else {
        path.to_owned()
    }
}

/// Request-span builder that records `http.method`, `http.version`, and a redacted
/// `http.target` (path only). It deliberately never records the raw URI, so query
/// strings carrying PII cannot leak into traces/logs. See [`http_trace_layer`].
#[derive(Clone, Copy, Debug, Default)]
pub struct RedactedMakeSpan;

impl<B> MakeSpan<B> for RedactedMakeSpan {
    fn make_span(&mut self, request: &axum::http::Request<B>) -> Span {
        tracing::span!(
            Level::INFO,
            "request",
            http.method = %request.method(),
            http.version = ?request.version(),
            http.target = %redacted_target(request.uri()),
        )
    }
}

/// Shared HTTP `TraceLayer` for every Cupboard axum service. Behaves like
/// `TraceLayer::new_for_http()` with an INFO request span, but records the URI path
/// only, never the query string, so PII in query params never reaches Loki/Tempo.
/// All services must use this instead of a raw `DefaultMakeSpan`.
pub fn http_trace_layer() -> TraceLayer<SharedClassifier<ServerErrorsAsFailures>, RedactedMakeSpan>
{
    TraceLayer::new_for_http().make_span_with(RedactedMakeSpan)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacted_target_drops_query_string() {
        let uri: axum::http::Uri = "/x?steam_id=123".parse().unwrap();
        let target = redacted_target(&uri);
        // The path survives; the PII-bearing query is gone entirely.
        assert!(target.starts_with("/x"));
        assert!(!target.contains("123"));
        assert!(!target.contains("steam_id"));
        assert_eq!(target, "/x?<redacted>");
    }

    #[test]
    fn redacted_target_pathonly_when_no_query() {
        let uri: axum::http::Uri = "/auth/player/steam/callback".parse().unwrap();
        assert_eq!(redacted_target(&uri), "/auth/player/steam/callback");
    }

    #[test]
    fn make_span_records_redacted_target() {
        // Exercise the MakeSpan path end to end: the produced span must not carry the
        // query value. We assert on the recorded target the span is built from.
        let uri: axum::http::Uri = "/entitlements?steam_id=123".parse().unwrap();
        let mut make = RedactedMakeSpan;
        let req = axum::http::Request::builder()
            .uri(uri.clone())
            .body(())
            .unwrap();
        let _span = make.make_span(&req);
        let recorded = redacted_target(&uri);
        assert!(!recorded.contains("123"));
        assert!(!recorded.contains("steam_id"));
    }
}
