//! Observability setup shared by all Cupboard services.
//!
//! Three signals, one init:
//!   * **Logs** — structured JSON to stdout, scraped by the cluster's `alloy-logs`
//!     into Loki. Always on, zero app-side config.
//!   * **Traces** — exported over OTLP/gRPC to the cluster's `alloy-receiver`,
//!     bridged from `tracing` spans via `tracing-opentelemetry`.
//!   * **Metrics** — exported over OTLP/gRPC to the same receiver via an
//!     `SdkMeterProvider`; instruments are recorded through the global meter
//!     (`opentelemetry::global::meter`).
//!
//! Traces and metrics turn on only when an OTLP endpoint is supplied
//! (`OTEL_EXPORTER_OTLP_ENDPOINT` in-cluster); local dev with no endpoint stays
//! logs-only, so nothing tries to dial a collector that isn't there.
//!
//! OTel crate matrix is pinned to 0.32 (tracing-opentelemetry 0.33) in the
//! workspace `Cargo.toml` — bump those together.

pub mod http;

use opentelemetry::trace::TracerProvider as _;
use opentelemetry::KeyValue;
use opentelemetry_otlp::WithExportConfig as _;
use opentelemetry_sdk::metrics::SdkMeterProvider;
use opentelemetry_sdk::propagation::TraceContextPropagator;
use opentelemetry_sdk::trace::SdkTracerProvider;
use opentelemetry_sdk::Resource;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

/// Holds the SDK providers so their batch/periodic exporters can be flushed on
/// shutdown. Dropping it (e.g. at the end of `main`, after the server stops)
/// flushes any buffered spans and metrics. A logs-only setup yields an inert
/// guard.
#[must_use = "hold the guard until shutdown; dropping it flushes buffered telemetry"]
pub struct OtelGuard {
    tracer_provider: Option<SdkTracerProvider>,
    meter_provider: Option<SdkMeterProvider>,
}

impl Drop for OtelGuard {
    fn drop(&mut self) {
        // Flush spans first, then metrics. shutdown() blocks until the exporter
        // thread drains; we're still inside the tokio runtime here so the tonic
        // client can send. Errors at teardown are logged, never fatal.
        if let Some(tp) = self.tracer_provider.take() {
            if let Err(err) = tp.shutdown() {
                tracing::warn!(%err, "otel tracer provider shutdown failed");
            }
        }
        if let Some(mp) = self.meter_provider.take() {
            if let Err(err) = mp.shutdown() {
                tracing::warn!(%err, "otel meter provider shutdown failed");
            }
        }
    }
}

/// Initialize global telemetry: JSON logs always, plus OTLP trace + metric export
/// when `otlp_endpoint` is `Some` (gRPC, e.g. `http://alloy-receiver…:4317`).
///
/// `service_name` is attached as the `service.name` resource attribute (so the
/// signal is attributable in Grafana) and to every log event.
///
/// Returns an [`OtelGuard`]; keep it alive for the process lifetime and let it
/// drop at shutdown so buffered telemetry is flushed.
pub fn init(service_name: &'static str, otlp_endpoint: Option<&str>) -> OtelGuard {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,sqlx=warn,hyper=warn,tower_http=info"));

    let fmt_layer = fmt::layer()
        .json()
        .with_current_span(true)
        .with_span_list(false)
        .with_target(true);

    let registry = tracing_subscriber::registry().with(filter).with(fmt_layer);

    let guard = match otlp_endpoint.filter(|e| !e.is_empty()) {
        Some(endpoint) => {
            // Propagate W3C trace context on inbound/outbound requests.
            opentelemetry::global::set_text_map_propagator(TraceContextPropagator::new());

            let resource = build_resource(service_name);

            // Local development can opt into metrics-only export (the dev
            // collector intentionally has no trace pipeline). Keep the tracer
            // provider alive for context propagation, but avoid a batch worker
            // and rejected trace exports when OTEL_TRACES_EXPORTER=none.
            let traces_enabled = std::env::var("OTEL_TRACES_EXPORTER")
                .map(|value| !value.eq_ignore_ascii_case("none"))
                .unwrap_or(true);
            let mut tracer_builder = SdkTracerProvider::builder().with_resource(resource.clone());
            if traces_enabled {
                let span_exporter = opentelemetry_otlp::SpanExporter::builder()
                    .with_tonic()
                    .with_endpoint(endpoint)
                    .build()
                    .expect("build OTLP span exporter");
                tracer_builder = tracer_builder.with_batch_exporter(span_exporter);
            }
            let tracer_provider = tracer_builder.build();

            let metric_exporter = opentelemetry_otlp::MetricExporter::builder()
                .with_tonic()
                .with_endpoint(endpoint)
                .build()
                .expect("build OTLP metric exporter");
            let meter_provider = SdkMeterProvider::builder()
                .with_resource(resource)
                .with_periodic_exporter(metric_exporter)
                .build();

            // Bridge `tracing` spans → OTel spans through this provider's tracer.
            let tracer = tracer_provider.tracer(service_name);
            let otel_layer = tracing_opentelemetry::layer().with_tracer(tracer);

            // Register globally so `global::meter(...)` records into the pipeline
            // and instrumented libraries pick up the tracer.
            opentelemetry::global::set_tracer_provider(tracer_provider.clone());
            opentelemetry::global::set_meter_provider(meter_provider.clone());

            registry.with(otel_layer).init();

            tracing::info!(
                service = service_name,
                otlp_endpoint = endpoint,
                traces_enabled,
                "telemetry initialized (logs + metrics; traces optional)"
            );
            OtelGuard {
                tracer_provider: Some(tracer_provider),
                meter_provider: Some(meter_provider),
            }
        }
        None => {
            registry.init();
            tracing::info!(
                service = service_name,
                "telemetry initialized (logs only; no OTLP endpoint configured)"
            );
            OtelGuard {
                tracer_provider: None,
                meter_provider: None,
            }
        }
    };

    guard
}

/// OTel resource describing this process. `service.name` drives Grafana service
/// grouping; version and environment aid filtering.
fn build_resource(service_name: &'static str) -> Resource {
    let mut builder = Resource::builder()
        .with_service_name(service_name)
        .with_attribute(KeyValue::new("service.version", env!("CARGO_PKG_VERSION")));
    if let Ok(env) = std::env::var("ENVIRONMENT") {
        builder = builder.with_attribute(KeyValue::new("deployment.environment.name", env));
    }
    builder.build()
}
