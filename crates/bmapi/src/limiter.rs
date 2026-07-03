//! Client-side rate limiter: dual sliding windows (per-second + per-minute).
//!
//! BM allows 45 req/s burst and 300 req/min per token, but only the minute bucket is
//! visible in response headers, so the per-second cap must be self-imposed. Defaults
//! (8/s, 240/min) leave headroom for clock skew and anything else the tenant runs
//! against the same token. One `BmClient` exists per connection runner and exactly one
//! runner owns a connection at a time, so this process-local limiter is globally
//! correct per token.
//!
//! Sliding (a timestamp log per window), not fixed windows: fixed windows admit up to
//! 2x the cap across a boundary (a burst at the tail of one window plus a burst at the
//! head of the next), which is exactly how a client trips BM's server-side sliding
//! limiter while believing it is under budget. The log is at most `cap` entries.

use std::collections::VecDeque;
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
    cap: usize,
    len: Duration,
    log: VecDeque<Instant>,
}

impl Window {
    fn new(cap: u32, len: Duration) -> Self {
        let cap = cap.max(1) as usize;
        Self {
            cap,
            len,
            log: VecDeque::with_capacity(cap),
        }
    }

    /// `None` when a slot is free in the sliding window ending at `now`, else time
    /// until the oldest in-window entry ages out.
    fn wait(&mut self, now: Instant) -> Option<Duration> {
        while self
            .log
            .front()
            .is_some_and(|t| now.duration_since(*t) >= self.len)
        {
            self.log.pop_front();
        }
        if self.log.len() < self.cap {
            None
        } else {
            let oldest = *self.log.front().expect("len >= cap >= 1");
            Some(
                (oldest + self.len)
                    .saturating_duration_since(now)
                    .max(Duration::from_millis(1)),
            )
        }
    }

    fn commit(&mut self, now: Instant) {
        self.log.push_back(now);
    }
}

impl RateLimiter {
    pub fn new(per_sec: u32, per_min: u32) -> Self {
        Self {
            inner: Mutex::new(Windows {
                sec: Window::new(per_sec, Duration::from_secs(1)),
                min: Window::new(per_min, Duration::from_secs(60)),
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
                        w.sec.commit(now);
                        w.min.commit(now);
                        None
                    }
                    (a, b) => Some(a.unwrap_or(Duration::ZERO).max(b.unwrap_or(Duration::ZERO))),
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

    #[tokio::test(start_paused = true)]
    async fn sliding_window_blocks_boundary_bursts() {
        // A fixed window would grant 2 at t=0.9 and 2 more right after t=1.0 (4 in
        // ~0.15s); the sliding window must hold the second burst until the first ages
        // out at t=1.9.
        let limiter = RateLimiter::new(2, 1000);
        tokio::time::sleep(Duration::from_millis(900)).await;
        limiter.acquire().await; // t=0.9
        limiter.acquire().await; // t=0.9
        tokio::time::sleep(Duration::from_millis(150)).await; // t=1.05
        let t0 = Instant::now();
        limiter.acquire().await;
        assert!(
            t0.elapsed() >= Duration::from_millis(800),
            "third must wait for the sliding window, waited only {:?}",
            t0.elapsed()
        );
    }
}
