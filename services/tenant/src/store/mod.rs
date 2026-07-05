//! Store runner subsystem: one supervisor reconcile loop claiming connections, one
//! runner task per claimed connection (the BM supervisor/runner pattern). The runner
//! owns all provider I/O; nothing on a request path ever calls a provider except the
//! operator connect probe.

pub mod runner;
pub mod supervisor;
