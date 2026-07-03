//! One runner per claimed BM connection: decrypts the token, owns the rate-limited
//! client, heartbeats the lease, and executes live import jobs to completion.

use crate::domain::bm;
use cupboard_bmapi::BmClient;
use cupboard_crypto::Envelope;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;

const HEARTBEAT_EVERY: Duration = Duration::from_secs(30);

pub async fn run(
    pool: sqlx::PgPool,
    conn: bm::BmConnection,
    master_key: [u8; 32],
    bm_api_base: String,
    claimer: String,
    pepper: Vec<u8>,
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

    let mut last_tail: Option<tokio::time::Instant> = None;
    let mut last_scan: Option<tokio::time::Instant> = None;

    while !lost.load(Ordering::Relaxed) {
        // Import jobs take precedence; sync pauses while one runs so the single
        // rate-limit budget isn't contended (decision C).
        match bm::next_live_job(&pool, conn.id).await {
            Ok(Some(job)) => {
                let signal = super::import::execute_job(
                    &pool, &client, &conn, job, &pepper, &lost, &claimer,
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
        if !current.sync_enabled {
            break;
        }
        if current.token_enc != conn.token_enc {
            tracing::info!(connection = %conn.id, "token rotated; runner restarts for a fresh client");
            break;
        }

        let settings = super::sync::settings_from(&current.settings);
        let now = tokio::time::Instant::now();
        let scan_due = last_scan.is_none_or(|t| now.duration_since(t) >= settings.rescan);
        let tail_due = last_tail.is_none_or(|t| now.duration_since(t) >= settings.tail);

        let tick = if scan_due {
            let result = super::sync::full_rescan(&pool, &client, &current, &pepper, &lost).await;
            // A scan visits everything a tail would; advance both cadences either
            // way, so a persistently failing tick can't hot-loop against BM.
            last_scan = Some(tokio::time::Instant::now());
            last_tail = last_scan;
            Some((result, true))
        } else if tail_due {
            let result = super::sync::tail_poll(&pool, &client, &current, &pepper).await;
            last_tail = Some(tokio::time::Instant::now());
            Some((result, false))
        } else {
            None
        };

        match tick {
            Some((Ok(()), scan)) => {
                let _ = bm::record_sync_tick(&pool, conn.id, &claimer, scan).await;
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
