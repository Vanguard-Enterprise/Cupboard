//! The perf consumer: read `cupboard:perf` samples and record them on OTel instruments.
//! The OTLP pipeline (telemetry::init) exports them to alloy-receiver → Mimir.
//!
//! Everything is recorded as gauges. The cumulative series (GC counts, per-plugin hook
//! time) are counters *semantically* — dashboards rate them with `idelta`/`increase` —
//! but arrive as absolute totals from the game server, so gauge recording preserves
//! them without delta bookkeeping here.

use std::time::Duration;

use cupboard_bus::Bus;
use cupboard_domain::{PerfEvent, PERF_STREAM};
use opentelemetry::metrics::{Gauge, Meter};
use opentelemetry::KeyValue;

const GROUP: &str = "metrics";
const READ_COUNT: usize = 100;
const BLOCK_MS: usize = 5000;

struct Instruments {
    fps: Gauge<f64>,
    entities: Gauge<i64>,
    players: Gauge<i64>,
    memory_mb: Gauge<f64>,
    gc_collections: Gauge<i64>,
    frame_ms_avg: Gauge<f64>,
    frame_ms_max: Gauge<f64>,
    hook_total_ms: Gauge<f64>,
}

impl Instruments {
    fn new(meter: &Meter) -> Self {
        Self {
            fps: meter
                .f64_gauge("cupboard.server.fps")
                .with_description("Server framerate at sample time")
                .build(),
            entities: meter
                .i64_gauge("cupboard.server.entities")
                .with_description("Networked entity count")
                .build(),
            players: meter
                .i64_gauge("cupboard.server.players")
                .with_description("Connected player count")
                .build(),
            memory_mb: meter
                .f64_gauge("cupboard.server.memory_mb")
                .with_unit("MBy")
                .with_description("Managed-heap megabytes")
                .build(),
            gc_collections: meter
                .i64_gauge("cupboard.server.gc_collections")
                .with_description("Cumulative GC collections (label: generation; rate it)")
                .build(),
            frame_ms_avg: meter
                .f64_gauge("cupboard.server.frame_ms_avg")
                .with_unit("ms")
                .with_description("Average frame time over the sample window (perf-mod tier)")
                .build(),
            frame_ms_max: meter
                .f64_gauge("cupboard.server.frame_ms_max")
                .with_unit("ms")
                .with_description("Worst frame time over the sample window (perf-mod tier)")
                .build(),
            hook_total_ms: meter
                .f64_gauge("cupboard.plugin.hook_total_ms")
                .with_unit("ms")
                .with_description("Cumulative plugin hook time (label: plugin; rate it)")
                .build(),
        }
    }

    fn record(&self, ev: &PerfEvent) {
        let base = [
            KeyValue::new("tenant_id", ev.tenant_id.to_string()),
            KeyValue::new("server_id", ev.server_id.to_string()),
        ];
        self.fps.record(ev.fps, &base);
        self.entities.record(ev.entities, &base);
        self.players.record(ev.players, &base);
        self.memory_mb.record(ev.memory_mb, &base);
        for (generation, count) in [("0", ev.gc_gen0), ("1", ev.gc_gen1), ("2", ev.gc_gen2)] {
            let mut attrs = base.to_vec();
            attrs.push(KeyValue::new("generation", generation));
            self.gc_collections.record(count, &attrs);
        }
        if let Some(avg) = ev.frame_ms_avg {
            self.frame_ms_avg.record(avg, &base);
        }
        if let Some(max) = ev.frame_ms_max {
            self.frame_ms_max.record(max, &base);
        }
        // The Collector bounds the list to MAX_HOOK_TIMINGS; plugin names are
        // operator-controlled but top-N-bounded, keeping the label set finite.
        for hook in &ev.hooks {
            let mut attrs = base.to_vec();
            attrs.push(KeyValue::new("plugin", hook.plugin.clone()));
            self.hook_total_ms.record(hook.total_ms, &attrs);
        }
    }
}

/// Run the consume→record loop forever (until aborted at shutdown).
pub async fn run(mut bus: Bus, consumer_name: String) {
    let meter = opentelemetry::global::meter("cupboard-metrics");
    let instruments = Instruments::new(&meter);
    tracing::info!(consumer = %consumer_name, "perf consumer starting");

    loop {
        if let Err(e) = bus.ensure_group(PERF_STREAM, GROUP).await {
            tracing::warn!(error = %e, "could not ensure consumer group; retrying");
            tokio::time::sleep(Duration::from_secs(1)).await;
            continue;
        }

        let batch = match bus
            .read::<PerfEvent>(PERF_STREAM, GROUP, &consumer_name, READ_COUNT, BLOCK_MS)
            .await
        {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(error = %e, "bus read failed; retrying");
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
        };

        // Ack everything read — recording can't fail, and unparseable poison must not
        // linger in the pending list.
        let mut ack_ids = batch.failed_ids;
        for d in batch.ok {
            instruments.record(&d.payload);
            tracing::debug!(entry = %d.id, server_id = %d.payload.server_id, fps = d.payload.fps, "recorded perf sample");
            ack_ids.push(d.id);
        }
        if let Err(e) = bus.ack(PERF_STREAM, GROUP, &ack_ids).await {
            tracing::warn!(error = %e, "ack failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use cupboard_domain::{HookTiming, ServerId, TenantId};
    use uuid::Uuid;

    #[test]
    fn recording_a_full_sample_does_not_panic() {
        // No exporter configured: instruments are inert, but attribute construction and
        // the recording paths all execute.
        let meter = opentelemetry::global::meter("test");
        let instruments = Instruments::new(&meter);
        instruments.record(&PerfEvent {
            server_id: ServerId(Uuid::nil()),
            tenant_id: TenantId(Uuid::nil()),
            at: Utc::now(),
            fps: 227.5,
            entities: 84210,
            players: 3,
            memory_mb: 3120.4,
            gc_gen0: 12013,
            gc_gen1: 400,
            gc_gen2: 12,
            frame_ms_avg: Some(4.4),
            frame_ms_max: Some(31.0),
            hooks: vec![HookTiming {
                plugin: "CupboardLink".into(),
                total_ms: 1523.7,
            }],
        });
    }
}
