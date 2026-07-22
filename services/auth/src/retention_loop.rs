//! The Phase 7 retention/purge loop (decisions #3 + E): an hourly tick on the owner
//! pool, per-table cutoffs from config, capped deletes so a backlog drains over several
//! ticks instead of becoming one vacuum storm. Only rows the cutoff CLEARLY covers are
//! touched (anchor timestamp present and strictly past the cutoff); everything else
//! waits for a later tick. No supervisor machinery, the `billing_loop` shape: each tick
//! runs in its own task so a panic is absorbed and the loop keeps ticking, and every
//! failure logs and continues.

use crate::config::Config;
use crate::domain::players::NONCE_RETENTION_SECS;
use chrono::{DateTime, Duration, Utc};
use sqlx::PgPool;
use std::sync::Arc;
use std::time::Duration as StdDuration;
use tracing::Instrument as _;

/// Per-table per-tick row cap: bounded work per tick, a backlog drains across ticks.
pub const PURGE_ROW_CAP: i64 = 10_000;

/// The per-table retention windows, split from [`Config`] so tests can drive
/// [`purge_once`] directly without assembling a full service config.
#[derive(Debug, Clone, Copy)]
pub struct RetentionWindows {
    /// Days past end-of-life (expiry or revocation) before `sessions` and
    /// `player_sessions` rows are purged. The rows carry ip + user_agent, the PII
    /// motivation (decision #3).
    pub sessions_days: i64,
    /// Days past terminal status before `invites` rows are purged (they hold
    /// third-party emails of people who may never have accepted).
    pub invites_days: i64,
    /// Days before `audit_log` rows are purged (2y default; legal obligation +
    /// legitimate interest, stated on the disclosure page).
    pub audit_days: i64,
}

impl RetentionWindows {
    pub fn from_config(config: &Config) -> Self {
        Self {
            sessions_days: config.retention_sessions_days,
            invites_days: config.retention_invites_days,
            audit_days: config.retention_audit_days,
        }
    }
}

/// Per-table purged-row counts for one tick (logged each tick; asserted by tests).
#[derive(Debug, Default, Clone, Copy)]
pub struct PurgeCounts {
    pub sessions: u64,
    pub player_sessions: u64,
    pub invites: u64,
    pub player_login_codes: u64,
    pub player_link_codes: u64,
    pub player_link_states: u64,
    pub openid_replay: u64,
    pub audit_log: u64,
}

/// Run until aborted. Always-on: needs only the owner pool (all purged tables are
/// either global or system-scoped, and the owner role bypasses RLS on `invites` and
/// `audit_log`).
pub async fn run(owner_pool: PgPool, config: Arc<Config>) {
    tracing::info!(
        tick_secs = config.retention_tick_secs,
        sessions_days = config.retention_sessions_days,
        invites_days = config.retention_invites_days,
        audit_days = config.retention_audit_days,
        "retention purge loop started"
    );
    let mut ticker = tokio::time::interval(StdDuration::from_secs(config.retention_tick_secs));
    loop {
        ticker.tick().await;
        // Each tick runs in its own task so a panic anywhere inside it is absorbed as a
        // JoinError and the loop keeps ticking (the billing_loop pattern). Errors inside
        // the tick log and return, never propagate.
        let tick = {
            let pool = owner_pool.clone();
            let windows = RetentionWindows::from_config(&config);
            tokio::spawn(async move {
                purge_once(&pool, windows, PURGE_ROW_CAP)
                    .instrument(tracing::info_span!("retention_purge"))
                    .await;
            })
        };
        if let Err(e) = tick.await {
            tracing::error!(error = %e, "retention purge tick crashed; the loop continues");
        }
    }
}

// Operator sessions: purged once 90d past end-of-life, whether that end was expiry or
// revocation. `expires_at` is NOT NULL; `revoked_at < cutoff` already implies NOT NULL
// but the guard is kept explicit (the "clearly covered" convention).
const SESSIONS_SQL: &str = "DELETE FROM sessions WHERE id IN (\
     SELECT id FROM sessions \
     WHERE expires_at < $1 OR (revoked_at IS NOT NULL AND revoked_at < $1) \
     LIMIT $2)";

// Player sessions: same semantics as operator sessions (migration 0003 mirrors 0001).
const PLAYER_SESSIONS_SQL: &str = "DELETE FROM player_sessions WHERE id IN (\
     SELECT id FROM player_sessions \
     WHERE expires_at < $1 OR (revoked_at IS NOT NULL AND revoked_at < $1) \
     LIMIT $2)";

// Invites: purge terminal rows 30d past their terminal anchor. Accepted rows anchor on
// `accepted_at`. Revoked/expired rows have no timestamp of their own, so `expires_at`
// is the anchor: past it the token was unusable regardless, so `expires_at < cutoff`
// clearly covers them. A pending row past `expires_at` is expired in fact (accept
// checks `expires_at`; nothing flips the status today), so it anchors the same way.
// Pending, non-expired invites are untouched.
const INVITES_SQL: &str = "DELETE FROM invites WHERE id IN (\
     SELECT id FROM invites \
     WHERE (status = 'accepted' AND accepted_at IS NOT NULL AND accepted_at < $1) \
        OR (status IN ('revoked', 'expired', 'pending') AND expires_at < $1) \
     LIMIT $2)";

// Short-TTL one-time codes: continuous sweep of expired rows. The happy path consumes
// them via DELETE ... RETURNING; this catches the stragglers that were never redeemed.
const LOGIN_CODES_SQL: &str = "DELETE FROM player_login_codes WHERE code_hash IN (\
     SELECT code_hash FROM player_login_codes WHERE expires_at < $1 LIMIT $2)";
const LINK_CODES_SQL: &str = "DELETE FROM player_link_codes WHERE code_hash IN (\
     SELECT code_hash FROM player_link_codes WHERE expires_at < $1 LIMIT $2)";
const LINK_STATES_SQL: &str = "DELETE FROM player_link_states WHERE state_hash IN (\
     SELECT state_hash FROM player_link_states WHERE expires_at < $1 LIMIT $2)";

// Steam OpenID replay nonces: `record_nonce` already prunes opportunistically on login,
// but that only runs when logins happen; sweeping here makes the bound unconditional.
const OPENID_REPLAY_SQL: &str = "DELETE FROM openid_replay WHERE nonce_hash IN (\
     SELECT nonce_hash FROM openid_replay WHERE seen_at < $1 LIMIT $2)";

const AUDIT_LOG_SQL: &str = "DELETE FROM audit_log WHERE id IN (\
     SELECT id FROM audit_log WHERE created_at < $1 LIMIT $2)";

/// One purge tick. Public so tests drive it directly with a small cap. Tables are
/// independent: a failure on one logs and the rest still run.
pub async fn purge_once(pool: &PgPool, windows: RetentionWindows, cap: i64) -> PurgeCounts {
    let now = Utc::now();
    let session_cutoff = now - Duration::days(windows.sessions_days);
    let invite_cutoff = now - Duration::days(windows.invites_days);
    let audit_cutoff = now - Duration::days(windows.audit_days);
    let nonce_cutoff = now - Duration::seconds(NONCE_RETENTION_SECS);

    let counts = PurgeCounts {
        sessions: purge_capped(pool, "sessions", SESSIONS_SQL, session_cutoff, cap).await,
        player_sessions: purge_capped(
            pool,
            "player_sessions",
            PLAYER_SESSIONS_SQL,
            session_cutoff,
            cap,
        )
        .await,
        invites: purge_capped(pool, "invites", INVITES_SQL, invite_cutoff, cap).await,
        player_login_codes: purge_capped(pool, "player_login_codes", LOGIN_CODES_SQL, now, cap)
            .await,
        player_link_codes: purge_capped(pool, "player_link_codes", LINK_CODES_SQL, now, cap).await,
        player_link_states: purge_capped(pool, "player_link_states", LINK_STATES_SQL, now, cap)
            .await,
        openid_replay: purge_capped(pool, "openid_replay", OPENID_REPLAY_SQL, nonce_cutoff, cap)
            .await,
        audit_log: purge_capped(pool, "audit_log", AUDIT_LOG_SQL, audit_cutoff, cap).await,
    };
    tracing::info!(
        sessions = counts.sessions,
        player_sessions = counts.player_sessions,
        invites = counts.invites,
        player_login_codes = counts.player_login_codes,
        player_link_codes = counts.player_link_codes,
        player_link_states = counts.player_link_states,
        openid_replay = counts.openid_replay,
        audit_log = counts.audit_log,
        "retention purge tick done"
    );
    counts
}

/// Run one capped delete; returns rows purged. Failures log and count as zero so the
/// remaining tables still get their sweep this tick.
async fn purge_capped(
    pool: &PgPool,
    table: &'static str,
    sql: &'static str,
    cutoff: DateTime<Utc>,
    cap: i64,
) -> u64 {
    match sqlx::query(sql).bind(cutoff).bind(cap).execute(pool).await {
        Ok(res) => res.rows_affected(),
        Err(e) => {
            tracing::warn!(table, error = ?e, "retention purge failed; continuing");
            0
        }
    }
}
