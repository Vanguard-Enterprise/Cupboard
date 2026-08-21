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
    fps_avg: Gauge<f64>,
    entities: Gauge<i64>,
    players: Gauge<i64>,
    memory_mb: Gauge<f64>,
    managed_memory_mb: Gauge<f64>,
    frame_ms: Gauge<f64>,
    gc_collections: Gauge<i64>,
    memory_collections: Gauge<i64>,
    memory_allocations: Gauge<i64>,
    gc_triggered: Gauge<i64>,
    frame_ms_avg: Gauge<f64>,
    frame_ms_max: Gauge<f64>,
    task_queue: Gauge<i64>,
    network_bytes: Gauge<i64>,
    network_packet_loss: Gauge<i64>,
    player_queue: Gauge<i64>,
    timing_total_ms: Gauge<f64>,
    network_update_count: Gauge<i64>,
    network_update_bytes: Gauge<i64>,
    client_fps: Gauge<f64>,
    client_memory_mb: Gauge<f64>,
    client_ping_ms: Gauge<i64>,
    client_packet_loss: Gauge<i64>,
    hook_total_ms: Gauge<f64>,
}

impl Instruments {
    fn new(meter: &Meter) -> Self {
        Self {
            fps: meter
                .f64_gauge("cupboard.server.fps")
                .with_description("Server framerate at sample time")
                .build(),
            fps_avg: meter
                .f64_gauge("cupboard.server.fps_avg")
                .with_description("Rolling server framerate average")
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
            managed_memory_mb: meter
                .f64_gauge("cupboard.server.managed_memory_mb")
                .with_unit("MBy")
                .with_description("Managed heap megabytes")
                .build(),
            frame_ms: meter
                .f64_gauge("cupboard.server.frame_ms")
                .with_unit("ms")
                .with_description("Instantaneous server frame time")
                .build(),
            gc_collections: meter
                .i64_gauge("cupboard.server.gc_collections")
                .with_description("Cumulative GC collections (label: generation; rate it)")
                .build(),
            memory_collections: meter
                .i64_gauge("cupboard.server.memory_collections")
                .with_description("Cumulative managed memory collections")
                .build(),
            memory_allocations: meter
                .i64_gauge("cupboard.server.memory_allocations")
                .with_description("Cumulative managed memory allocations")
                .build(),
            gc_triggered: meter
                .i64_gauge("cupboard.server.gc_triggered")
                .with_description("Cumulative GC triggers")
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
            task_queue: meter
                .i64_gauge("cupboard.server.task_queue")
                .with_description("Server task queue depth (label: queue)")
                .build(),
            network_bytes: meter
                .i64_gauge("cupboard.server.network_bytes")
                .with_unit("By")
                .with_description("Server network bytes per sample (label: direction)")
                .build(),
            network_packet_loss: meter
                .i64_gauge("cupboard.server.network_packet_loss")
                .with_description("Server packet loss per sample")
                .build(),
            player_queue: meter
                .i64_gauge("cupboard.server.player_queue")
                .with_description("Connection queue depth (label: state)")
                .build(),
            timing_total_ms: meter
                .f64_gauge("cupboard.server.timing_total_ms")
                .with_unit("ms")
                .with_description("Named server timing total (labels: family, name)")
                .build(),
            network_update_count: meter
                .i64_gauge("cupboard.server.network_update_count")
                .with_description("Network update count (label: message_type)")
                .build(),
            network_update_bytes: meter
                .i64_gauge("cupboard.server.network_update_bytes")
                .with_unit("By")
                .with_description("Network update bytes (label: message_type)")
                .build(),
            client_fps: meter
                .f64_gauge("cupboard.client.fps")
                .with_description("Client-reported FPS (label: steam_id)")
                .build(),
            client_memory_mb: meter
                .f64_gauge("cupboard.client.memory_mb")
                .with_unit("MBy")
                .with_description("Client-reported memory (label: steam_id)")
                .build(),
            client_ping_ms: meter
                .i64_gauge("cupboard.client.ping_ms")
                .with_unit("ms")
                .with_description("Client connection latency (label: steam_id)")
                .build(),
            client_packet_loss: meter
                .i64_gauge("cupboard.client.packet_loss")
                .with_description("Client packet loss (label: steam_id)")
                .build(),
            hook_total_ms: meter
                .f64_gauge("cupboard.plugin.hook_total_ms")
                .with_unit("ms")
                .with_description("Cumulative plugin hook time (label: plugin; rate it)")
                .build(),
        }
    }

    fn record(&self, ev: &PerfEvent) {
        // tenant_id dropped for cardinality: functionally determined by server_id, so
        // it adds no series value; recover tenant grouping via a query-time join.
        let base = [KeyValue::new("server_id", ev.server_id.to_string())];
        self.fps.record(ev.fps, &base);
        if let Some(value) = ev.fps_avg {
            self.fps_avg.record(value, &base);
        }
        self.entities.record(ev.entities, &base);
        self.players.record(ev.players, &base);
        self.memory_mb.record(ev.memory_mb, &base);
        if let Some(value) = ev.managed_memory_mb {
            self.managed_memory_mb.record(value, &base);
        }
        if let Some(value) = ev.frame_ms {
            self.frame_ms.record(value, &base);
        }
        for (generation, count) in [("0", ev.gc_gen0), ("1", ev.gc_gen1), ("2", ev.gc_gen2)] {
            let mut attrs = base.to_vec();
            attrs.push(KeyValue::new("generation", generation));
            self.gc_collections.record(count, &attrs);
        }
        if let Some(value) = ev.memory_collections {
            self.memory_collections.record(value, &base);
        }
        if let Some(value) = ev.memory_allocations {
            self.memory_allocations.record(value, &base);
        }
        if let Some(value) = ev.gc_triggered {
            self.gc_triggered.record(value, &base);
        }
        if let Some(avg) = ev.frame_ms_avg {
            self.frame_ms_avg.record(avg, &base);
        }
        if let Some(max) = ev.frame_ms_max {
            self.frame_ms_max.record(max, &base);
        }
        for (queue, value) in [
            ("load_balancer", ev.task_load_balancer),
            ("invoke_handler", ev.task_invoke_handler),
            ("workshop_skins_queue", ev.task_workshop_skins_queue),
        ] {
            if let Some(value) = value {
                let attrs = [base[0].clone(), KeyValue::new("queue", queue)];
                self.task_queue.record(value, &attrs);
            }
        }
        for (direction, value) in [
            ("received", ev.network_bytes_received),
            ("sent", ev.network_bytes_sent),
        ] {
            if let Some(value) = value {
                let attrs = [base[0].clone(), KeyValue::new("direction", direction)];
                self.network_bytes.record(value, &attrs);
            }
        }
        if let Some(value) = ev.network_packet_loss {
            self.network_packet_loss.record(value, &base);
        }
        for (state, value) in [
            ("joining", ev.players_joining),
            ("queued", ev.players_queued),
        ] {
            if let Some(value) = value {
                let attrs = [base[0].clone(), KeyValue::new("state", state)];
                self.player_queue.record(value, &attrs);
            }
        }
        for (family, entries) in [
            ("invoke_execution", &ev.timings.invoke_execution),
            ("server_update", &ev.timings.server_update),
            ("rpc_calls", &ev.timings.rpc_calls),
            ("work_queue", &ev.timings.work_queue),
            ("console_commands", &ev.timings.console_commands),
            ("timewarnings", &ev.timings.timewarnings),
        ] {
            for entry in entries {
                let attrs = [
                    base[0].clone(),
                    KeyValue::new("family", family),
                    KeyValue::new("name", entry.name.clone()),
                ];
                self.timing_total_ms.record(entry.total_ms, &attrs);
            }
        }
        for update in &ev.network_updates {
            let attrs = [
                base[0].clone(),
                KeyValue::new("message_type", update.message_type.clone()),
            ];
            self.network_update_count.record(update.count, &attrs);
            self.network_update_bytes.record(update.bytes, &attrs);
        }
        for player in &ev.player_metrics {
            // Per-player labels are intentionally kept out of the server gauges but are
            // useful in Mimir for operators troubleshooting one connection.
            let attrs = [
                base[0].clone(),
                KeyValue::new("steam_id", player.steam_id.clone()),
            ];
            if let Some(value) = player.client_fps {
                self.client_fps.record(value, &attrs);
            }
            if let Some(value) = player.client_memory_mb {
                self.client_memory_mb.record(value, &attrs);
            }
            if let Some(value) = player.ping_ms {
                self.client_ping_ms.record(value, &attrs);
            }
            if let Some(value) = player.packet_loss {
                self.client_packet_loss.record(value, &attrs);
            }
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

/// Run the consume→record loop forever (until aborted at shutdown). Each sample is
/// recorded twice: onto the OTel instruments (→ Mimir) and into the sliding window
/// (→ rules + dashboard series).
pub async fn run(mut bus: Bus, window: crate::window::WindowStore, consumer_name: String) {
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
            window.insert(&d.payload);
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
            fps_avg: Some(220.0),
            entities: 84210,
            players: 3,
            memory_mb: 3120.4,
            managed_memory_mb: Some(1200.0),
            gc_gen0: 12013,
            gc_gen1: 400,
            gc_gen2: 12,
            frame_ms: Some(4.0),
            memory_collections: Some(5),
            memory_allocations: Some(12),
            gc_triggered: Some(2),
            task_load_balancer: Some(1),
            task_invoke_handler: Some(2),
            task_workshop_skins_queue: Some(0),
            network_bytes_received: Some(100),
            network_bytes_sent: Some(200),
            network_packet_loss: Some(0),
            players_joining: Some(0),
            players_queued: Some(0),
            frame_ms_avg: Some(4.4),
            frame_ms_max: Some(31.0),
            hooks: vec![HookTiming {
                plugin: "CupboardLink".into(),
                total_ms: 1523.7,
            }],
            timings: Default::default(),
            network_updates: Vec::new(),
            player_metrics: Vec::new(),
        });
    }
}
