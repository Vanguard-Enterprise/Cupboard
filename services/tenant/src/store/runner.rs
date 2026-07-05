//! One runner per claimed store connection. Decrypts the credential once, then loops:
//! reload a fresh connection row (operator changes apply within seconds), run a catalog
//! sync when due, heartbeat in the background. Exits (releasing the claim) whenever the
//! lease, the credential, or the connected status changes underneath it.
//!
//! Fencing discipline (BM runner): every persistent write is guarded by BOTH the lease
//! (`claimed_by`) and the exact credential ciphertext this runner decrypted, so a
//! runner racing an operator reconnect can neither error the fresh connection nor land
//! a snapshot fetched with the stale key.

use crate::cache::{CacheKey, SiteCache};
use crate::domain::store::{self, StoreConnection};
use crate::providers::paynow::PayNowClient;
use crate::providers::{ProviderError, ProviderKind, StoreProvider};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// How often the runner re-reads its row and checks for due work.
const LOOP_TICK: Duration = Duration::from_secs(5);
const HEARTBEAT_EVERY: Duration = Duration::from_secs(30);

pub async fn run(
    pool: sqlx::PgPool,
    cache: SiteCache,
    conn: StoreConnection,
    master_key: [u8; 32],
    paynow_base: String,
    claimer: String,
) {
    let connection_id = conn.id;
    let tenant_id = conn.tenant_id;

    // Decrypt once; the ciphertext doubles as the write fence for this runner's life.
    let (Some(key_enc), Some(key_dek)) = (conn.api_key_enc.clone(), conn.api_key_dek.clone())
    else {
        // Disconnected between claim and start; nothing to run.
        let _ = store::release_claim(&pool, connection_id, &claimer).await;
        return;
    };
    let envelope = cupboard_crypto::Envelope {
        wrapped_dek: key_dek,
        ciphertext: key_enc.clone(),
    };
    let api_key = match cupboard_crypto::open(&master_key, &envelope) {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(s) => s,
            Err(_) => {
                tracing::error!(connection = %connection_id, "stored API key is not UTF-8");
                let _ = store::mark_error_fenced(
                    &pool,
                    connection_id,
                    &claimer,
                    &key_enc,
                    "stored credential is corrupt; reconnect the store",
                )
                .await;
                let _ = store::release_claim(&pool, connection_id, &claimer).await;
                return;
            }
        },
        Err(e) => {
            tracing::error!(connection = %connection_id, error = %e, "credential unseal failed");
            let _ = store::mark_error_fenced(
                &pool,
                connection_id,
                &claimer,
                &key_enc,
                "credential cannot be decrypted (master key rotated?); reconnect the store",
            )
            .await;
            let _ = store::release_claim(&pool, connection_id, &claimer).await;
            return;
        }
    };

    let Ok(provider) = conn.provider.parse::<ProviderKind>() else {
        tracing::error!(connection = %connection_id, provider = %conn.provider, "unknown provider");
        let _ = store::release_claim(&pool, connection_id, &claimer).await;
        return;
    };
    let client = match provider {
        ProviderKind::PayNow => {
            PayNowClient::new(paynow_base, api_key, Some(conn.store_external_id.clone()))
        }
        ProviderKind::Tebex => {
            // PR6; the connect endpoint refuses tebex rows until then.
            tracing::error!(connection = %connection_id, "tebex runner not implemented yet");
            let _ = store::release_claim(&pool, connection_id, &claimer).await;
            return;
        }
    };

    // Background heartbeat; flips `lost` when a takeover is detected.
    let lost = Arc::new(AtomicBool::new(false));
    let hb = {
        let pool = pool.clone();
        let claimer = claimer.clone();
        let lost = lost.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(HEARTBEAT_EVERY);
            ticker.tick().await; // immediate first tick is a no-op; claim just set it
            loop {
                ticker.tick().await;
                match store::heartbeat(&pool, connection_id, &claimer).await {
                    Ok(true) => {}
                    Ok(false) => {
                        lost.store(true, Ordering::Relaxed);
                        return;
                    }
                    Err(e) => {
                        tracing::warn!(connection = %connection_id, error = ?e, "heartbeat failed");
                    }
                }
            }
        })
    };

    let mut ticker = tokio::time::interval(LOOP_TICK);
    loop {
        ticker.tick().await;
        if lost.load(Ordering::Relaxed) {
            tracing::info!(connection = %connection_id, "claim taken over; runner exiting");
            hb.abort();
            return; // no release: someone else owns the row now
        }

        // Fresh row each tick: disconnects, reconnects, and Sync-now apply in seconds.
        let current = match store::load_fresh(&pool, connection_id).await {
            Ok(Some(c)) => c,
            Ok(None) => break, // row deleted
            Err(e) => {
                tracing::warn!(connection = %connection_id, error = ?e, "reload failed");
                continue;
            }
        };
        if current.claimed_by.as_deref() != Some(claimer.as_str())
            || current.status != "connected"
            || current.api_key_enc.as_deref() != Some(key_enc.as_slice())
        {
            // Lease lost, operator disconnect, or credential rotation: a new claim (and
            // a new runner with the fresh key) takes it from here.
            break;
        }

        if current.next_catalog_sync_at <= chrono::Utc::now() {
            sync_catalog(
                &pool, &cache, &current, &client, &claimer, &key_enc, tenant_id,
            )
            .await;
        }
    }

    hb.abort();
    let _ = store::release_claim(&pool, connection_id, &claimer).await;
    tracing::info!(connection = %connection_id, "store runner stopped");
}

async fn sync_catalog(
    pool: &sqlx::PgPool,
    cache: &SiteCache,
    conn: &StoreConnection,
    client: &PayNowClient,
    claimer: &str,
    key_fence: &[u8],
    tenant_id: uuid::Uuid,
) {
    match client.fetch_catalog().await {
        Ok(snapshot) => {
            match store::apply_catalog(pool, conn, claimer, key_fence, &snapshot).await {
                Ok((written, deleted)) => {
                    tracing::info!(
                        connection = %conn.id,
                        products = snapshot.products.len(),
                        categories = snapshot.categories.len(),
                        written,
                        soft_deleted = deleted,
                        "catalog synced"
                    );
                    cache.invalidate(&[CacheKey::Catalog(tenant_id)]).await;
                }
                Err(e) => {
                    // Lease/fence loss rolls the snapshot back; anything else is a DB
                    // error worth surfacing.
                    tracing::warn!(connection = %conn.id, error = ?e, "catalog apply failed");
                }
            }
        }
        Err(ProviderError::Auth(e)) => {
            tracing::warn!(connection = %conn.id, error = %e, "provider rejected credentials");
            let errored = store::mark_error_fenced(
                pool,
                conn.id,
                claimer,
                key_fence,
                "the provider rejected the API key; reconnect the store with a valid key",
            )
            .await;
            // status='error' hides the public catalog; drop the cached copy eagerly
            // like the disconnect handler does.
            if matches!(errored, Ok(true)) {
                cache.invalidate(&[CacheKey::Catalog(tenant_id)]).await;
            }
        }
        Err(ProviderError::Transient(e)) => {
            tracing::warn!(connection = %conn.id, error = %e, "catalog sync transient failure");
            let _ = store::defer_sync_fenced(
                pool,
                conn.id,
                claimer,
                key_fence,
                &format!("catalog sync failed (retrying): {e}"),
                true,
            )
            .await;
        }
        Err(ProviderError::Rejected(e)) => {
            tracing::warn!(connection = %conn.id, error = %e, "catalog sync rejected");
            let _ = store::defer_sync_fenced(
                pool,
                conn.id,
                claimer,
                key_fence,
                &format!("catalog sync rejected by the provider: {e}"),
                false,
            )
            .await;
        }
    }
}
