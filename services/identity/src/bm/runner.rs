//! One runner per claimed BM connection: decrypts the token, owns the rate-limited
//! client, heartbeats the lease, and executes live import jobs to completion.

use super::fleet_client::FleetClient;
use crate::domain::bm;
use cupboard_bmapi::BmClient;
use cupboard_crypto::Envelope;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;

const HEARTBEAT_EVERY: Duration = Duration::from_secs(30);

#[allow(clippy::too_many_arguments)]
pub async fn run(
    pool: sqlx::PgPool,
    conn: bm::BmConnection,
    master_key: [u8; 32],
    bm_api_base: String,
    claimer: String,
    pepper: Vec<u8>,
    fleet: Option<FleetClient>,
) {
    let envelope = Envelope {
        wrapped_dek: conn.token_dek.clone(),
        ciphertext: conn.token_enc.clone(),
    };
    let token = cupboard_crypto::open(&master_key, &envelope)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok());
    let Some(token) = token else {
        let msg = "stored token cannot be decrypted; reconnect with a fresh token";
        // Fenced on the token bytes we tried: if the tenant reconnected between claim
        // and decrypt, the failure is stale and the next claim reads the fresh row.
        match bm::set_connection_error_if_token_unchanged(&pool, conn.id, &conn.token_enc, msg)
            .await
        {
            Ok(true) => {
                tracing::error!(connection = %conn.id,
                    "BM token decrypt failed (master key changed?)");
                // A live job can never progress with an unreadable token; fail it now
                // rather than letting claims bounce forever.
                if let Ok(Some(job)) = bm::next_live_job(&pool, conn.id).await {
                    let _ = bm::finish_job(&pool, job.id, "failed", Some(msg), &claimer).await;
                }
            }
            Ok(false) => {
                tracing::info!(connection = %conn.id,
                    "token rotated between claim and decrypt; runner exits for re-claim");
            }
            Err(e) => tracing::warn!(connection = %conn.id, error = ?e, "token fence failed"),
        }
        let _ = bm::release_claim(&pool, conn.id, &claimer).await;
        return;
    };
    let client = BmClient::new(&bm_api_base, &token);

    // The heartbeat task flips `lost` when another claimer takes the lease; the
    // import loop checks it at every page boundary.
    let lost = Arc::new(AtomicBool::new(false));
    let hb = tokio::spawn(heartbeat_loop(
        pool.clone(),
        conn.id,
        claimer.clone(),
        lost.clone(),
    ));

    // Cadence state seeds from the persisted timestamps: a pod restart or re-claim
    // must not trigger an immediate full re-scan of every connection (a 100k-ban org
    // is ~1000 BM requests per scan).
    let (mut last_tail, mut last_scan) = match bm::sync_timestamps(&pool, conn.id).await {
        Ok((tail, scan)) => (instant_ago(tail), instant_ago(scan)),
        Err(e) => {
            tracing::warn!(connection = %conn.id, error = ?e, "cadence seed failed; starting cold");
            (None, None)
        }
    };
    // After a failed tail tick the next one walks every page: a committed page 1
    // would otherwise hide a stranded backlog until the next re-scan.
    let mut tail_deep = false;

    while !lost.load(Ordering::Relaxed) {
        // Fresh row every tick: sync toggles, cadence changes, and token rotation all
        // apply within seconds instead of at the next claim.
        let current = match bm::fresh_connection(&pool, conn.id).await {
            Ok(Some(c)) => c,
            Ok(None) => break,
            Err(e) => {
                tracing::warn!(connection = %conn.id, error = ?e, "connection refresh failed");
                break;
            }
        };
        if current.token_enc != conn.token_enc {
            tracing::info!(connection = %conn.id, "token rotated; runner restarts for a fresh client");
            break;
        }

        // Outbound drain FIRST, before import work: imports run in bounded slices
        // (import.rs PAGES_PER_SLICE), and a staff unban must reach BM between
        // slices, not after a multi-hour initial import finishes. The due-scan is one
        // cheap indexed query when idle.
        if current.sync_enabled && current.sync_bans_outbound {
            match super::outbox::drain(&pool, &client, &current, &claimer).await {
                Ok(0) => {}
                Ok(n) => tracing::info!(connection = %conn.id, ops = n, "outbox drained"),
                Err(e) if e.is_auth() => {
                    match bm::set_connection_error_if_token_unchanged(
                        &pool,
                        conn.id,
                        &current.token_enc,
                        &e.message(),
                    )
                    .await
                    {
                        Ok(true) => tracing::warn!(connection = %conn.id, error = %e.message(),
                            "outbound auth failure; connection errored"),
                        _ => tracing::info!(connection = %conn.id,
                            "outbound auth failure with rotated token; restarting for re-claim"),
                    }
                    break;
                }
                Err(super::sync::SyncError::LostClaim) => break,
                Err(e) => {
                    tracing::warn!(connection = %conn.id, error = %e.detail(), "outbox drain failed");
                    let _ = bm::record_sync_error(&pool, conn.id, &claimer, &e.message()).await;
                }
            }
        }

        // Import jobs next; inbound sync pauses while one runs so the single
        // rate-limit budget isn't contended (decision C). execute_job returns after
        // a bounded slice of pages, so this loop (and the drain above) keeps cycling
        // during long imports.
        match bm::next_live_job(&pool, conn.id).await {
            Ok(Some(job)) => {
                let signal = super::import::execute_job(
                    &pool,
                    &client,
                    &conn,
                    job,
                    &pepper,
                    &lost,
                    &claimer,
                    fleet.as_ref(),
                )
                .await;
                if matches!(signal, super::import::RunnerSignal::Stop) {
                    break;
                }
                continue;
            }
            Ok(None) => {}
            Err(e) => {
                tracing::warn!(connection = %conn.id, error = ?e, "job lookup failed; runner exiting");
                break;
            }
        }

        if !current.sync_enabled {
            break;
        }

        let settings = super::sync::settings_from(&current.settings);
        let now = tokio::time::Instant::now();
        let scan_due = last_scan.is_none_or(|t| now.duration_since(t) >= settings.rescan);
        let tail_due = last_tail.is_none_or(|t| now.duration_since(t) >= settings.tail);

        let tick = if scan_due {
            let result =
                super::sync::full_rescan(&pool, &client, &current, &pepper, &claimer, &lost).await;
            // A scan visits everything a tail would; advance both cadences either
            // way, so a persistently failing tick can't hot-loop against BM.
            last_scan = Some(tokio::time::Instant::now());
            last_tail = last_scan;
            Some((result.map(Some), true))
        } else if tail_due {
            let result =
                super::sync::tail_poll(&pool, &client, &current, &pepper, &claimer, tail_deep)
                    .await;
            last_tail = Some(tokio::time::Instant::now());
            Some((result.map(|()| None), false))
        } else {
            None
        };

        match tick {
            Some((Ok(scan_outcome), scan)) => {
                tail_deep = false;
                // An aborted scan (sync toggled off mid-walk) records nothing: a
                // partial scan is not a scan, and the loop exits on the next check.
                let aborted = matches!(scan_outcome, Some(super::sync::ScanOutcome::Aborted));
                if !aborted {
                    let _ = bm::record_sync_tick(&pool, conn.id, &claimer, scan).await;
                }
            }
            Some((Err(e), _)) if e.is_auth() => {
                // Same stale-token discipline as the import path: only error the
                // connection if the stored token is still the one we hold.
                match bm::set_connection_error_if_token_unchanged(
                    &pool,
                    conn.id,
                    &current.token_enc,
                    &e.message(),
                )
                .await
                {
                    Ok(true) => tracing::warn!(connection = %conn.id, error = %e.message(),
                        "sync auth failure; connection errored"),
                    _ => tracing::info!(connection = %conn.id,
                        "sync auth failure with rotated token; restarting for re-claim"),
                }
                break;
            }
            Some((Err(e), _)) => {
                tail_deep = true;
                tracing::warn!(connection = %conn.id, error = %e.detail(), "sync tick failed");
                let _ = bm::record_sync_error(&pool, conn.id, &claimer, &e.message()).await;
            }
            None => {}
        }

        tokio::time::sleep(Duration::from_secs(5)).await;
    }

    hb.abort();
    let _ = bm::release_claim(&pool, conn.id, &claimer).await;
    tracing::info!(connection = %conn.id, "BM runner exited");
}

/// Map a persisted timestamp onto the monotonic clock ("that happened N seconds
/// ago"). `None` (never ran) or a nonsensical future stamp both mean "due now".
fn instant_ago(at: Option<chrono::DateTime<chrono::Utc>>) -> Option<tokio::time::Instant> {
    let at = at?;
    let elapsed = (chrono::Utc::now() - at).to_std().ok()?;
    tokio::time::Instant::now().checked_sub(elapsed)
}

async fn heartbeat_loop(
    pool: sqlx::PgPool,
    connection_id: Uuid,
    claimer: String,
    lost: Arc<AtomicBool>,
) {
    let mut ticker = tokio::time::interval(HEARTBEAT_EVERY);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ticker.tick().await; // the claim itself stamped heartbeat_at; skip the immediate tick
    loop {
        ticker.tick().await;
        match bm::heartbeat(&pool, connection_id, &claimer).await {
            Ok(true) => {}
            Ok(false) => {
                tracing::warn!(connection = %connection_id, "BM claim taken over; stopping runner");
                lost.store(true, Ordering::Relaxed);
                return;
            }
            // A transient DB error is not a takeover: keep going, the stale window
            // (2 min) is far wider than one missed beat.
            Err(e) => tracing::warn!(connection = %connection_id, error = ?e, "heartbeat failed"),
        }
    }
}
