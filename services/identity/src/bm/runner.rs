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

    while !lost.load(Ordering::Relaxed) {
        match bm::next_live_job(&pool, conn.id).await {
            Ok(Some(job)) => {
                let signal = super::import::execute_job(
                    &pool, &client, &conn, job, &pepper, &lost, &claimer,
                )
                .await;
                if matches!(signal, super::import::RunnerSignal::Stop) {
                    break;
                }
            }
            Ok(None) => break,
            Err(e) => {
                tracing::warn!(connection = %conn.id, error = ?e, "job lookup failed; runner exiting");
                break;
            }
        }
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
