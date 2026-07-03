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
use cupboard_domain::PerfEvent;
use uuid::Uuid;

/// How much history the window keeps.
pub const RETENTION: Duration = Duration::minutes(120);

/// One retained sample (the chart/rules subset of a [`PerfEvent`]).
#[derive(Debug, Clone, serde::Serialize)]
pub struct Sample {
    pub at: DateTime<Utc>,
    pub fps: f64,
    pub entities: i64,
    pub players: i64,
    pub memory_mb: f64,
    #[serde(skip)]
    pub gc_gen2: i64,
    /// Per-plugin cumulative hook ms at sample time.
    #[serde(skip)]
    pub hooks: Vec<(String, f64)>,
}

struct ServerWindow {
    tenant_id: Uuid,
    samples: VecDeque<Sample>,
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
            entities: ev.entities,
            players: ev.players,
            memory_mb: ev.memory_mb,
            gc_gen2: ev.gc_gen2,
            hooks: ev
                .hooks
                .iter()
                .map(|h| (h.plugin.clone(), h.total_ms))
                .collect(),
        };
        let mut inner = self.inner.write().expect("window store poisoned");
        let window = inner.entry(ev.server_id.0).or_insert_with(|| ServerWindow {
            tenant_id: ev.tenant_id.0,
            samples: VecDeque::new(),
        });
        window.tenant_id = ev.tenant_id.0; // ownership follows the (authenticated) event
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
            gc_gen0: 1,
            gc_gen1: 1,
            gc_gen2: 1,
            frame_ms_avg: None,
            frame_ms_max: None,
            hooks: vec![HookTiming {
                plugin: "X".into(),
                total_ms: 10.0,
            }],
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
    }
}
