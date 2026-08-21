//! The v1 recommendation rules — deterministic checks over a server's recent perf
//! window (the plan's starter set: sustained low FPS, FPS degradation, entity count,
//! GC pressure, memory, expensive plugins, stale reporting). Computed on read: always
//! current, nothing to persist, nothing to go stale. Thresholds are const so tuning
//! against real fleet data (the plan's open question) is one-line diffs.

use chrono::{DateTime, Duration, Utc};
use serde::Serialize;

use crate::window::Sample;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Info,
    Warning,
    Critical,
}

#[derive(Debug, Clone, Serialize)]
pub struct Recommendation {
    /// Stable rule id (dashboard grouping / future dismissals).
    pub rule: &'static str,
    pub severity: Severity,
    pub title: String,
    pub detail: String,
}

const STALE_AFTER_MINS: i64 = 5;
const RECENT_WINDOW_MINS: i64 = 10;
const FPS_WARNING: f64 = 60.0;
const FPS_CRITICAL: f64 = 30.0;
/// Recent average below this fraction of the earlier average = degradation.
const FPS_DEGRADATION_RATIO: f64 = 0.7;
/// Degradation needs enough history to compare against.
const DEGRADATION_MIN_HISTORY_MINS: i64 = 30;
const ENTITIES_WARNING: i64 = 300_000;
const ENTITIES_CRITICAL: i64 = 500_000;
/// Gen-2 (full) collections in the recent window that indicate memory churn.
const GC_GEN2_WARNING: i64 = 5;
const MEMORY_WARNING_MB: f64 = 6_144.0;
/// A plugin consuming more than this share of wall time in the recent window.
const PLUGIN_COST_WARNING_RATIO: f64 = 0.05;

/// Evaluate all rules over one server's window (oldest-first samples).
pub fn evaluate(samples: &[Sample], now: DateTime<Utc>) -> Vec<Recommendation> {
    let mut out = Vec::new();
    let Some(latest) = samples.last() else {
        return out;
    };

    // Stale reporting: the pipeline is quiet — likely the plugin was unloaded or the
    // server stopped. Rules below still evaluate the history that exists.
    if now - latest.at > Duration::minutes(STALE_AFTER_MINS) {
        out.push(Recommendation {
            rule: "stale-reporting",
            severity: Severity::Info,
            title: "Performance reporting stopped".into(),
            detail: format!(
                "No perf sample for {} minutes — the server may be down or the Cupboard \
                 plugin unloaded/disabled.",
                (now - latest.at).num_minutes()
            ),
        });
    }

    let recent_cutoff = now - Duration::minutes(RECENT_WINDOW_MINS);
    let recent: Vec<&Sample> = samples.iter().filter(|s| s.at >= recent_cutoff).collect();
    let earlier: Vec<&Sample> = samples.iter().filter(|s| s.at < recent_cutoff).collect();

    // Sustained low FPS (recent average, not a single dip).
    if !recent.is_empty() {
        let avg_fps = recent.iter().map(|s| s.fps).sum::<f64>() / recent.len() as f64;
        if avg_fps < FPS_CRITICAL {
            out.push(Recommendation {
                rule: "low-fps",
                severity: Severity::Critical,
                title: format!("Critically low FPS ({avg_fps:.0})"),
                detail: format!(
                    "Average server FPS over the last {RECENT_WINDOW_MINS} minutes is \
                     {avg_fps:.0}. Players will feel this. Check the expensive-plugin \
                     recommendation, entity count, and host CPU."
                ),
            });
        } else if avg_fps < FPS_WARNING {
            out.push(Recommendation {
                rule: "low-fps",
                severity: Severity::Warning,
                title: format!("Low FPS ({avg_fps:.0})"),
                detail: format!(
                    "Average server FPS over the last {RECENT_WINDOW_MINS} minutes is \
                     {avg_fps:.0} (target 60+)."
                ),
            });
        }

        // Degradation: recent average well below the earlier baseline.
        if let (Some(first), false) = (samples.first(), earlier.is_empty()) {
            if now - first.at >= Duration::minutes(DEGRADATION_MIN_HISTORY_MINS) {
                let baseline = earlier.iter().map(|s| s.fps).sum::<f64>() / earlier.len() as f64;
                if baseline > 0.0 && avg_fps < baseline * FPS_DEGRADATION_RATIO {
                    out.push(Recommendation {
                        rule: "fps-degrading",
                        severity: Severity::Warning,
                        title: "FPS degrading".into(),
                        detail: format!(
                            "FPS dropped from a {baseline:.0} average to {avg_fps:.0} in the \
                             last {RECENT_WINDOW_MINS} minutes — something recent (plugin \
                             reload, raid event, entity spike) is costing frames."
                        ),
                    });
                }
            }
        }
    }

    // Entity count — the main long-term FPS driver on Rust servers.
    if latest.entities > ENTITIES_CRITICAL {
        out.push(Recommendation {
            rule: "entity-count",
            severity: Severity::Critical,
            title: format!("Very high entity count ({})", latest.entities),
            detail: "Entity count is at a level that degrades performance for everyone. \
                     Consider entity cleanup plugins, decay tuning, or an earlier map wipe."
                .into(),
        });
    } else if latest.entities > ENTITIES_WARNING {
        out.push(Recommendation {
            rule: "entity-count",
            severity: Severity::Warning,
            title: format!("High entity count ({})", latest.entities),
            detail: "Entity growth is the usual cause of slow FPS decay across a wipe. \
                     Watch the trend; plan cleanup before it hurts."
                .into(),
        });
    }

    // GC pressure: frequent gen-2 (full) collections in the recent window.
    if let (Some(first), Some(last)) = (recent.first(), recent.last()) {
        let gen2 = last.gc_gen2 - first.gc_gen2;
        if gen2 > GC_GEN2_WARNING {
            out.push(Recommendation {
                rule: "gc-pressure",
                severity: Severity::Warning,
                title: format!("GC pressure ({gen2} full collections in {RECENT_WINDOW_MINS}m)"),
                detail: "Frequent full garbage collections cause visible hitches. A plugin \
                         is likely churning allocations — correlate with the plugin hook \
                         costs below."
                    .into(),
            });
        }
    }

    if latest.memory_mb > MEMORY_WARNING_MB {
        out.push(Recommendation {
            rule: "high-memory",
            severity: Severity::Warning,
            title: format!("High managed memory ({:.1} GB)", latest.memory_mb / 1024.0),
            detail: "The managed heap is unusually large; a leaking plugin is the common \
                     cause. A scheduled restart relieves it short-term."
                .into(),
        });
    }

    // Expensive plugins: cumulative hook-time delta over the recent window as a share
    // of wall time. Counter resets (plugin reloads) make the delta negative — skip.
    if let (Some(first), Some(last)) = (recent.first(), recent.last()) {
        let wall_ms = (last.at - first.at).num_milliseconds() as f64;
        if wall_ms > 60_000.0 {
            for hook in &last.hooks {
                let Some(start) = first.hooks.iter().find(|h| h.plugin == hook.plugin) else {
                    continue;
                };
                let delta = hook.total_ms - start.total_ms;
                if delta > wall_ms * PLUGIN_COST_WARNING_RATIO {
                    out.push(Recommendation {
                        rule: "expensive-plugin",
                        severity: Severity::Warning,
                        title: format!("Plugin '{}' is expensive", hook.plugin),
                        detail: format!(
                            "'{}' spent {:.1}s in hooks over the last {:.0} minutes \
                             ({:.1}% of wall time). Profile it or look for an alternative.",
                            hook.plugin,
                            delta / 1000.0,
                            wall_ms / 60_000.0,
                            100.0 * delta / wall_ms
                        ),
                    });
                }
            }
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(mins_ago: i64, fps: f64, now: DateTime<Utc>) -> Sample {
        Sample {
            at: now - Duration::minutes(mins_ago),
            fps,
            entities: 50_000,
            players: 10,
            memory_mb: 2_000.0,
            gc_gen2: 0,
            hooks: Vec::new(),
        }
    }

    #[test]
    fn healthy_server_yields_no_recommendations() {
        let now = Utc::now();
        let samples: Vec<Sample> = (0..20).map(|i| sample(20 - i, 220.0, now)).collect();
        assert!(evaluate(&samples, now).is_empty());
    }

    #[test]
    fn sustained_low_fps_flags_by_severity() {
        let now = Utc::now();
        let warn: Vec<Sample> = (0..10).map(|i| sample(10 - i, 45.0, now)).collect();
        let recs = evaluate(&warn, now);
        assert!(recs
            .iter()
            .any(|r| r.rule == "low-fps" && r.severity == Severity::Warning));

        let crit: Vec<Sample> = (0..10).map(|i| sample(10 - i, 12.0, now)).collect();
        let recs = evaluate(&crit, now);
        assert!(recs
            .iter()
            .any(|r| r.rule == "low-fps" && r.severity == Severity::Critical));
    }

    #[test]
    fn degradation_needs_history_and_a_real_drop() {
        let now = Utc::now();
        // 60 minutes of 200 fps, then 10 minutes of 90 fps: degraded but above the
        // absolute floor → only the degradation rule fires.
        let mut samples: Vec<Sample> = (0..50).map(|i| sample(60 - i, 200.0, now)).collect();
        samples.extend((0..10).map(|i| sample(10 - i, 90.0, now)));
        let recs = evaluate(&samples, now);
        assert!(recs.iter().any(|r| r.rule == "fps-degrading"));
        assert!(!recs.iter().any(|r| r.rule == "low-fps"));

        // Too little history → no degradation verdict.
        let short: Vec<Sample> = (0..10).map(|i| sample(10 - i, 90.0, now)).collect();
        assert!(!evaluate(&short, now)
            .iter()
            .any(|r| r.rule == "fps-degrading"));
    }

    #[test]
    fn entity_gc_memory_and_plugin_rules_fire() {
        let now = Utc::now();
        let mut a = sample(9, 200.0, now);
        a.gc_gen2 = 100;
        a.hooks = vec![cupboard_domain::HookTiming {
            plugin: "LagMachine".into(),
            total_ms: 0.0,
        }];
        let mut b = sample(1, 200.0, now);
        b.entities = 600_000;
        b.memory_mb = 8_000.0;
        b.gc_gen2 = 110;
        // 8 minutes wall ≈ 480s; 60s of hook time ≈ 12.5% > 5%.
        b.hooks = vec![cupboard_domain::HookTiming {
            plugin: "LagMachine".into(),
            total_ms: 60_000.0,
        }];

        let recs = evaluate(&[a, b], now);
        let rules: Vec<&str> = recs.iter().map(|r| r.rule).collect();
        assert!(rules.contains(&"entity-count"));
        assert!(rules.contains(&"gc-pressure"));
        assert!(rules.contains(&"high-memory"));
        assert!(rules.contains(&"expensive-plugin"));
    }

    #[test]
    fn stale_reporting_flags() {
        let now = Utc::now();
        let samples = vec![sample(30, 200.0, now)];
        let recs = evaluate(&samples, now);
        assert!(recs.iter().any(|r| r.rule == "stale-reporting"));
    }
}
