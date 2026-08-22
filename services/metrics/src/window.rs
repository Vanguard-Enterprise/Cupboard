//! In-memory sliding window of recent perf samples, per server. Feeds the v1
//! recommendation rules and the dashboard's recent-series charts without a Mimir
//! round-trip (Mimir stays the long-term TSDB via the OTel path; PromQL-backed
//! long-range views can layer on later — see docs/phase3-plan.md decision G).
//!
//! Sizing: 2h retention at one sample/30s = 240 samples/server; at launch scale
//! (500 servers) that's trivially small. Single-replica semantics — the window is
//! process-local and rebuilds within minutes of a restart.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, RwLock};

use chrono::{DateTime, Duration, Utc};
use cupboard_domain::{NetworkUpdate, PerfEvent, PerfTimings, PlayerPerf};
use uuid::Uuid;

/// How much history the window keeps.
pub const RETENTION: Duration = Duration::minutes(120);

/// One retained sample (the chart/rules subset of a [`PerfEvent`]). Large breakdowns
/// live only in [`ServerWindow::latest_details`] so a two-hour window does not retain
/// the same payload hundreds of times.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Sample {
    pub at: DateTime<Utc>,
    pub fps: f64,
    pub fps_avg: Option<f64>,
    pub frame_ms: Option<f64>,
    pub entities: i64,
    pub players: i64,
    pub memory_mb: f64,
    pub managed_memory_mb: Option<f64>,
    pub gc_gen2: i64,
    pub gc_gen0: i64,
    pub gc_gen1: i64,
    pub memory_collections: Option<i64>,
    pub memory_allocations: Option<i64>,
    pub gc_triggered: Option<i64>,
    pub frame_ms_avg: Option<f64>,
    pub frame_ms_max: Option<f64>,
    pub task_load_balancer: Option<i64>,
    pub task_invoke_handler: Option<i64>,
    pub task_workshop_skins_queue: Option<i64>,
    pub network_bytes_received: Option<i64>,
    pub network_bytes_sent: Option<i64>,
    pub network_packet_loss: Option<i64>,
    pub players_joining: Option<i64>,
    pub players_queued: Option<i64>,
    pub hooks: Vec<cupboard_domain::HookTiming>,
}

/// The detailed breakdown for the most recent sample. These values are still available
/// to the dashboard, but are intentionally not copied into every retained sample.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct PerfDetails {
    pub timings: PerfTimings,
    pub network_updates: Vec<NetworkUpdate>,
    pub player_metrics: Vec<PlayerPerf>,
}

/// A latest sample plus its detailed breakdowns, flattened to preserve the dashboard API.
#[derive(Debug, Clone, serde::Serialize)]
pub struct LatestSample {
    #[serde(flatten)]
    pub sample: Sample,
    #[serde(flatten)]
    pub details: PerfDetails,
}

/// A tenant-scoped, internally consistent read of one server's recent window.
#[derive(Debug, Clone)]
pub struct WindowSnapshot {
    pub latest: LatestSample,
    pub series: Vec<Sample>,
    pub full: Vec<Sample>,
}

struct ServerWindow {
    tenant_id: Uuid,
    samples: VecDeque<Sample>,
    latest_details: PerfDetails,
}

/// Cheaply cloneable shared store.
#[derive(Clone, Default)]
pub struct WindowStore {
    inner: Arc<RwLock<HashMap<Uuid, ServerWindow>>>,
}

impl WindowStore {
    /// Record one consumed perf event, pruning anything past retention.
    pub fn insert(&self, ev: &PerfEvent) {
        let sample = Sample {
            at: ev.at,
            fps: ev.fps,
            fps_avg: ev.fps_avg,
            frame_ms: ev.frame_ms,
            entities: ev.entities,
            players: ev.players,
            memory_mb: ev.memory_mb,
            managed_memory_mb: ev.managed_memory_mb,
            gc_gen0: ev.gc_gen0,
            gc_gen1: ev.gc_gen1,
            gc_gen2: ev.gc_gen2,
            memory_collections: ev.memory_collections,
            memory_allocations: ev.memory_allocations,
            gc_triggered: ev.gc_triggered,
            frame_ms_avg: ev.frame_ms_avg,
            frame_ms_max: ev.frame_ms_max,
            task_load_balancer: ev.task_load_balancer,
            task_invoke_handler: ev.task_invoke_handler,
            task_workshop_skins_queue: ev.task_workshop_skins_queue,
            network_bytes_received: ev.network_bytes_received,
            network_bytes_sent: ev.network_bytes_sent,
            network_packet_loss: ev.network_packet_loss,
            players_joining: ev.players_joining,
            players_queued: ev.players_queued,
            hooks: ev.hooks.to_vec(),
        };
        let mut inner = self.inner.write().expect("window store poisoned");
        let window = inner.entry(ev.server_id.0).or_insert_with(|| ServerWindow {
            tenant_id: ev.tenant_id.0,
            samples: VecDeque::new(),
            latest_details: PerfDetails::default(),
        });
        window.tenant_id = ev.tenant_id.0; // ownership follows the (authenticated) event
        window.latest_details = PerfDetails {
            timings: ev.timings.clone(),
            network_updates: ev.network_updates.clone(),
            player_metrics: ev.player_metrics.clone(),
        };
        window.samples.push_back(sample);
        let cutoff = Utc::now() - RETENTION;
        while window.samples.front().is_some_and(|s| s.at < cutoff) {
            window.samples.pop_front();
        }
    }

    /// The tenant's servers with their latest sample, most recent first.
    pub fn latest_for_tenant(&self, tenant: Uuid) -> Vec<(Uuid, Sample)> {
        let inner = self.inner.read().expect("window store poisoned");
        let mut rows: Vec<(Uuid, Sample)> = inner
            .iter()
            .filter(|(_, w)| w.tenant_id == tenant)
            .filter_map(|(id, w)| w.samples.back().map(|s| (*id, s.clone())))
            .collect();
        rows.sort_by_key(|(_, s)| std::cmp::Reverse(s.at));
        rows
    }

    /// One server's latest sample and detailed breakdowns, tenant-scoped.
    pub fn latest(&self, tenant: Uuid, server: Uuid) -> Option<LatestSample> {
        let inner = self.inner.read().expect("window store poisoned");
        let window = inner.get(&server).filter(|w| w.tenant_id == tenant)?;
        Some(LatestSample {
            sample: window.samples.back()?.clone(),
            details: window.latest_details.clone(),
        })
    }

    /// Read the latest sample, requested chart range, and full rule window under one
    /// lock so a concurrent insert cannot mix different points in one API response.
    pub fn snapshot(&self, tenant: Uuid, server: Uuid, minutes: i64) -> Option<WindowSnapshot> {
        let inner = self.inner.read().expect("window store poisoned");
        let window = inner.get(&server).filter(|w| w.tenant_id == tenant)?;
        let now = Utc::now();
        let full_cutoff = now - RETENTION;
        let full: Vec<Sample> = window
            .samples
            .iter()
            .filter(|sample| sample.at >= full_cutoff)
            .cloned()
            .collect();
        let series_cutoff = now - Duration::minutes(minutes.clamp(5, 120));
        let series = full
            .iter()
            .filter(|sample| sample.at >= series_cutoff)
            .cloned()
            .collect();
        let latest = LatestSample {
            sample: window.samples.back()?.clone(),
            details: window.latest_details.clone(),
        };
        Some(WindowSnapshot {
            latest,
            series,
            full,
        })
    }

    /// One server's samples from the last `minutes`, oldest first. `None` when the
    /// server is unknown **or belongs to another tenant** (indistinguishable on
    /// purpose — don't leak existence across tenants).
    pub fn series(&self, tenant: Uuid, server: Uuid, minutes: i64) -> Option<Vec<Sample>> {
        let inner = self.inner.read().expect("window store poisoned");
        let window = inner.get(&server).filter(|w| w.tenant_id == tenant)?;
        let cutoff = Utc::now() - Duration::minutes(minutes.clamp(5, 120));
        Some(
            window
                .samples
                .iter()
                .filter(|s| s.at >= cutoff)
                .cloned()
                .collect(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cupboard_domain::{HookTiming, ServerId, TenantId};

    fn event(server: Uuid, tenant: Uuid, at: DateTime<Utc>, fps: f64) -> PerfEvent {
        PerfEvent {
            server_id: ServerId(server),
            tenant_id: TenantId(tenant),
            at,
            fps,
            entities: 1000,
            players: 2,
            memory_mb: 900.0,
            managed_memory_mb: Some(500.0),
            gc_gen0: 1,
            gc_gen1: 1,
            gc_gen2: 1,
            fps_avg: None,
            frame_ms: None,
            frame_ms_avg: None,
            frame_ms_max: None,
            memory_collections: None,
            memory_allocations: None,
            gc_triggered: None,
            task_load_balancer: None,
            task_invoke_handler: None,
            task_workshop_skins_queue: None,
            network_bytes_received: None,
            network_bytes_sent: None,
            network_packet_loss: None,
            players_joining: None,
            players_queued: None,
            hooks: vec![HookTiming {
                plugin: "X".into(),
                total_ms: 10.0,
            }],
            timings: Default::default(),
            network_updates: Vec::new(),
            player_metrics: Vec::new(),
        }
    }

    #[test]
    fn tenant_isolation_and_retention() {
        let store = WindowStore::default();
        let (t1, t2) = (Uuid::new_v4(), Uuid::new_v4());
        let (s1, s2) = (Uuid::new_v4(), Uuid::new_v4());
        let now = Utc::now();

        store.insert(&event(s1, t1, now - Duration::minutes(180), 100.0)); // beyond retention
        store.insert(&event(s1, t1, now - Duration::minutes(10), 200.0));
        store.insert(&event(s1, t1, now, 210.0));
        store.insert(&event(s2, t2, now, 60.0));

        // t1 sees only its server; the stale sample was pruned.
        let series = store.series(t1, s1, 60).expect("own server visible");
        assert_eq!(series.len(), 2);
        assert_eq!(series[0].fps, 200.0);

        // Cross-tenant reads look identical to unknown servers.
        assert!(store.series(t2, s1, 60).is_none());
        assert!(store.series(t1, s2, 60).is_none());

        let latest = store.latest_for_tenant(t1);
        assert_eq!(latest.len(), 1);
        assert_eq!(latest[0].1.fps, 210.0);

        let snapshot = store.snapshot(t1, s1, 60).expect("own server snapshot");
        assert_eq!(snapshot.full.len(), 2);
        assert_eq!(snapshot.series.len(), 2);
        assert_eq!(snapshot.latest.sample.fps, 210.0);
    }

    #[test]
    fn latest_details_are_not_repeated_in_history() {
        let store = WindowStore::default();
        let server = Uuid::new_v4();
        let tenant = Uuid::new_v4();
        let now = Utc::now();
        let mut first = event(server, tenant, now - Duration::minutes(1), 200.0);
        first.player_metrics = vec![PlayerPerf {
            steam_id: "76561198000000042".into(),
            ip: Some("192.0.2.1".into()),
            ping_ms: Some(40),
            packet_loss: None,
            client_fps: None,
            client_memory_mb: None,
        }];
        store.insert(&first);
        store.insert(&event(server, tenant, now, 210.0));

        let series = store
            .series(tenant, server, 60)
            .expect("own server visible");
        let latest = store.latest(tenant, server).expect("latest sample visible");
        assert_eq!(series.len(), 2);
        assert_eq!(latest.sample.fps, 210.0);
        assert!(latest.details.player_metrics.is_empty());
    }
}
