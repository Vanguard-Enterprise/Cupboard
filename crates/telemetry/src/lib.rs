//! Observability setup shared by all Cupboard services.
//!
//! Phase 0: structured JSON logs to stdout, which the cluster's `alloy-logs`
//! collector scrapes into Loki — so logs flow with zero app-side OTLP config.
//!
//! TODO (Phase 0, second pass): add OTLP trace export to the cluster's
//! `alloy-receiver` (`OTEL_EXPORTER_OTLP_ENDPOINT`, gRPC :4317) via
//! `tracing-opentelemetry`, and Pyroscope profiling. Kept out of the initial cut
//! so the OTel crate-version matrix is pinned deliberately, not by accident.

use tracing_subscriber::{fmt, prelude::*, EnvFilter};

/// Initialize global tracing. Reads `RUST_LOG` for filtering (defaults to `info`).
///
/// `service_name` is attached to every event so logs are attributable in Loki.
pub fn init(service_name: &'static str) {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,sqlx=warn,hyper=warn,tower_http=info"));

    let fmt_layer = fmt::layer()
        .json()
        .with_current_span(true)
        .with_span_list(false)
        .with_target(true);

    tracing_subscriber::registry()
        .with(filter)
        .with(fmt_layer)
        .init();

    tracing::info!(service = service_name, "telemetry initialized");
}
