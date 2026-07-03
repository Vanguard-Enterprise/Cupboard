//! Client-side rate limiter: dual fixed windows (per-second + per-minute).
//!
//! BM allows 45 req/s burst and 300 req/min per token, but only the minute bucket is
//! visible in response headers, so the per-second cap must be self-imposed. Defaults
//! (8/s, 240/min) leave headroom for clock skew and anything else the tenant runs
//! against the same token. One `BmClient` exists per connection runner and exactly one
//! runner owns a connection at a time, so this process-local limiter is globally
//! correct per token.

use std::time::Duration;
use tokio::sync::Mutex;
use tokio::time::Instant;

pub struct RateLimiter {
    inner: Mutex<Windows>,
}

struct Windows {
    sec: Window,
    min: Window,
}

struct Window {
    cap: u32,
    len: Duration,
    count: u32,
    start: Instant,
}

impl Window {
    fn new(cap: u32, len: Duration) -> Self {
        Self {
            cap,
            len,
            count: 0,
            start: Instant::now(),
        }
    }

    /// `None` when a slot is free (window rolled or under cap), else time until it rolls.
    fn wait(&mut self, now: Instant) -> Option<Duration> {
        if now.duration_since(self.start) >= self.len {
            self.start = now;
            self.count = 0;
        }
        if self.count < self.cap {
            None
        } else {
            Some(self.len.saturating_sub(now.duration_since(self.start)))
        }
    }
}

impl RateLimiter {
    pub fn new(per_sec: u32, per_min: u32) -> Self {
        Self {
            inner: Mutex::new(Windows {
                sec: Window::new(per_sec.max(1), Duration::from_secs(1)),
                min: Window::new(per_min.max(1), Duration::from_secs(60)),
            }),
        }
    }

    /// Take one request slot, sleeping as long as either window is exhausted.
    pub async fn acquire(&self) {
        loop {
            let wait = {
                let mut w = self.inner.lock().await;
                let now = Instant::now();
                match (w.sec.wait(now), w.min.wait(now)) {
                    (None, None) => {
                        w.sec.count += 1;
                        w.min.count += 1;
                        None
                    }
                    (a, b) => Some(
                        a.unwrap_or(Duration::ZERO)
                            .max(b.unwrap_or(Duration::ZERO))
                            .max(Duration::from_millis(10)),
                    ),
                }
            };
            match wait {
                None => return,
                Some(d) => tokio::time::sleep(d).await,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn second_window_throttles_and_rolls() {
        let limiter = RateLimiter::new(2, 1000);
        let t0 = Instant::now();
        limiter.acquire().await;
        limiter.acquire().await;
        assert!(
            t0.elapsed() < Duration::from_millis(1),
            "first two are free"
        );
        // Third must wait for the 1s window to roll (paused clock auto-advances).
        limiter.acquire().await;
        assert!(
            t0.elapsed() >= Duration::from_millis(900),
            "third waited for the window, elapsed {:?}",
            t0.elapsed()
        );
    }

    #[tokio::test(start_paused = true)]
    async fn minute_window_binds_when_tighter() {
        let limiter = RateLimiter::new(1000, 2);
        let t0 = Instant::now();
        limiter.acquire().await;
        limiter.acquire().await;
        limiter.acquire().await;
        assert!(
            t0.elapsed() >= Duration::from_secs(59),
            "minute window must gate, elapsed {:?}",
            t0.elapsed()
        );
    }
}
