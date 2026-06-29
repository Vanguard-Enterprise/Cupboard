//! Logs-only init (no OTLP endpoint, i.e. local dev) must produce an inert guard
//! that drops cleanly without trying to reach a collector.
//!
//! Separate test binary because `init` installs the process-global tracing
//! subscriber, which can only be set once per process.

#[test]
fn logs_only_init_is_inert() {
    let guard = cupboard_telemetry::init("telemetry-smoke-logs", None);
    drop(guard);
}
