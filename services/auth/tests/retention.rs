//! Integration tests for the Phase 7 retention/purge loop (`retention_loop::purge_once`):
//! boundary exactness against explicitly constructed timestamps, terminal-vs-pending
//! invite handling, idempotency (a second tick is a no-op), and the per-tick row cap.
//!
//! Requires a Postgres reachable via `TEST_DATABASE_URL` (owner role; the loop runs on
//! the owner pool). Skips (passes) when unset, so `cargo test` stays green where no
//! database is provisioned; CI sets it to run for real.

use chrono::{DateTime, Duration, Utc};
use cupboard_auth::retention_loop::{self, PurgeCounts, RetentionWindows};
use sqlx::PgPool;
use tokio::sync::OnceCell;
use uuid::Uuid;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

// Tests run in parallel against one shared DB; migrate exactly once across them all.
static MIGRATED: OnceCell<()> = OnceCell::const_new();

// `purge_once` sweeps globally, so the tests in this file serialize on one lock: a
// concurrent purge from a sibling test would otherwise eat rows this one is counting.
// Other test binaries only create rows with fresh/future timestamps, which no window
// here covers, so cross-binary parallelism stays safe.
static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Connect the owner pool and ensure the schema is migrated once. Returns `None` (skip)
/// when no test database is configured.
async fn setup() -> Option<PgPool> {
    let owner_url = std::env::var("TEST_DATABASE_URL").ok()?;
    let owner = cupboard_db::connect_scoped(&owner_url, 5, "auth,public")
        .await
        .expect("connect owner");
    MIGRATED
        .get_or_init(|| async {
            sqlx::query("CREATE SCHEMA IF NOT EXISTS auth")
                .execute(&owner)
                .await
                .expect("ensure schema");
            MIGRATOR.run(&owner).await.expect("migrate");
        })
        .await;
    Some(owner)
}

/// The production default windows (decision #3).
fn windows() -> RetentionWindows {
    RetentionWindows {
        sessions_days: 90,
        invites_days: 30,
        audit_days: 730,
    }
}

fn total(c: &PurgeCounts) -> u64 {
    c.sessions
        + c.player_sessions
        + c.invites
        + c.player_login_codes
        + c.player_link_codes
        + c.player_link_states
        + c.openid_replay
        + c.audit_log
}

/// Purge with the full cap until nothing is purgeable, clearing leftovers from earlier
/// runs (kept-side boundary rows age into their windows between runs).
async fn drain(owner: &PgPool) {
    for _ in 0..20 {
        let counts =
            retention_loop::purge_once(owner, windows(), retention_loop::PURGE_ROW_CAP).await;
        if total(&counts) == 0 {
            return;
        }
    }
    panic!("could not drain the purgeable backlog in 20 capped ticks");
}

async fn seed_user(owner: &PgPool) -> Uuid {
    sqlx::query_scalar("INSERT INTO users (display_name) VALUES ('retention test') RETURNING id")
        .fetch_one(owner)
        .await
        .expect("insert user")
}

async fn seed_player(owner: &PgPool) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO player_accounts (display_name) VALUES ('retention test') RETURNING id",
    )
    .fetch_one(owner)
    .await
    .expect("insert player account")
}

async fn seed_org(owner: &PgPool) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO organizations (name, slug) VALUES ('Retention Org', 'ret-'||gen_random_uuid()) RETURNING id",
    )
    .fetch_one(owner)
    .await
    .expect("insert org")
}

async fn insert_session(
    owner: &PgPool,
    user_id: Uuid,
    expires_at: DateTime<Utc>,
    revoked_at: Option<DateTime<Utc>>,
) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO sessions (user_id, refresh_token_hash, expires_at, revoked_at) \
         VALUES ($1, gen_random_bytes(32), $2, $3) RETURNING id",
    )
    .bind(user_id)
    .bind(expires_at)
    .bind(revoked_at)
    .fetch_one(owner)
    .await
    .expect("insert session")
}

async fn insert_player_session(
    owner: &PgPool,
    player_id: Uuid,
    expires_at: DateTime<Utc>,
    revoked_at: Option<DateTime<Utc>>,
) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO player_sessions \
         (player_account_id, tenant_id, site_host, refresh_token_hash, expires_at, revoked_at) \
         VALUES ($1, gen_random_uuid(), 'retention.test', gen_random_bytes(32), $2, $3) \
         RETURNING id",
    )
    .bind(player_id)
    .bind(expires_at)
    .bind(revoked_at)
    .fetch_one(owner)
    .await
    .expect("insert player session")
}

async fn insert_invite(
    owner: &PgPool,
    org_id: Uuid,
    status: &str,
    expires_at: DateTime<Utc>,
    accepted_at: Option<DateTime<Utc>>,
) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO invites (organization_id, email, token_hash, status, expires_at, accepted_at) \
         VALUES ($1, 'retention-test@example.com', gen_random_bytes(32), $2, $3, $4) RETURNING id",
    )
    .bind(org_id)
    .bind(status)
    .bind(expires_at)
    .bind(accepted_at)
    .fetch_one(owner)
    .await
    .expect("insert invite")
}

async fn insert_login_code(owner: &PgPool, player_id: Uuid, expires_at: DateTime<Utc>) -> Vec<u8> {
    sqlx::query_scalar(
        "INSERT INTO player_login_codes (code_hash, player_account_id, tenant_id, site_host, expires_at) \
         VALUES (gen_random_bytes(32), $1, gen_random_uuid(), 'retention.test', $2) RETURNING code_hash",
    )
    .bind(player_id)
    .bind(expires_at)
    .fetch_one(owner)
    .await
    .expect("insert login code")
}

async fn insert_nonce(owner: &PgPool, seen_at: DateTime<Utc>) -> Vec<u8> {
    sqlx::query_scalar(
        "INSERT INTO openid_replay (nonce_hash, seen_at) \
         VALUES (gen_random_bytes(32), $1) RETURNING nonce_hash",
    )
    .bind(seen_at)
    .fetch_one(owner)
    .await
    .expect("insert nonce")
}

async fn insert_audit(owner: &PgPool, action: &str, created_at: DateTime<Utc>) -> Uuid {
    sqlx::query_scalar("INSERT INTO audit_log (action, created_at) VALUES ($1, $2) RETURNING id")
        .bind(action)
        .bind(created_at)
        .fetch_one(owner)
        .await
        .expect("insert audit row")
}

/// Does a row with this uuid id still exist in `table`?
async fn exists(owner: &PgPool, table: &str, id: Uuid) -> bool {
    let sql = format!("SELECT count(*) FROM {table} WHERE id = $1");
    let n: i64 = sqlx::query_scalar(&sql)
        .bind(id)
        .fetch_one(owner)
        .await
        .expect("existence query");
    n > 0
}

/// Does a row with this bytea primary key still exist?
async fn exists_hash(owner: &PgPool, table: &str, pk: &str, hash: &[u8]) -> bool {
    let sql = format!("SELECT count(*) FROM {table} WHERE {pk} = $1");
    let n: i64 = sqlx::query_scalar(&sql)
        .bind(hash)
        .fetch_one(owner)
        .await
        .expect("existence query");
    n > 0
}

#[tokio::test]
async fn purge_boundary_exactness() {
    let Some(owner) = setup().await else {
        eprintln!("SKIP purge_boundary_exactness: TEST_DATABASE_URL unset");
        return;
    };
    let _guard = LOCK.lock().await;

    let now = Utc::now();
    let hour = Duration::hours(1);
    // Session window: 90d past end-of-life. One hour inside survives; one hour past goes.
    let inside = now - Duration::days(90) + hour;
    let past = now - Duration::days(90) - hour;

    let user = seed_user(&owner).await;
    let s_keep = insert_session(&owner, user, inside, None).await;
    let s_purge = insert_session(&owner, user, past, None).await;
    // Revoked but unexpired sessions anchor on revoked_at.
    let s_rev_keep = insert_session(&owner, user, now + Duration::days(1), Some(inside)).await;
    let s_rev_purge = insert_session(&owner, user, now + Duration::days(1), Some(past)).await;

    let player = seed_player(&owner).await;
    let ps_keep = insert_player_session(&owner, player, inside, None).await;
    let ps_purge = insert_player_session(&owner, player, past, None).await;
    let ps_rev_purge =
        insert_player_session(&owner, player, now + Duration::days(1), Some(past)).await;

    // Continuous sweeps: login codes at expiry, replay nonces at the 1h nonce window.
    let code_keep = insert_login_code(&owner, player, now + hour).await;
    let code_purge = insert_login_code(&owner, player, now - hour).await;
    let nonce_keep = insert_nonce(&owner, now - Duration::minutes(30)).await;
    let nonce_purge = insert_nonce(&owner, now - Duration::hours(2)).await;

    // Audit window: 730d.
    let audit_keep = insert_audit(&owner, "retention-test", now - Duration::days(730) + hour).await;
    let audit_purge =
        insert_audit(&owner, "retention-test", now - Duration::days(730) - hour).await;

    retention_loop::purge_once(&owner, windows(), retention_loop::PURGE_ROW_CAP).await;

    assert!(
        exists(&owner, "sessions", s_keep).await,
        "1h inside the session window must survive"
    );
    assert!(
        !exists(&owner, "sessions", s_purge).await,
        "1h past the session window must purge"
    );
    assert!(
        exists(&owner, "sessions", s_rev_keep).await,
        "recently revoked session must survive"
    );
    assert!(
        !exists(&owner, "sessions", s_rev_purge).await,
        "long-revoked session must purge"
    );

    assert!(exists(&owner, "player_sessions", ps_keep).await);
    assert!(!exists(&owner, "player_sessions", ps_purge).await);
    assert!(!exists(&owner, "player_sessions", ps_rev_purge).await);

    assert!(exists_hash(&owner, "player_login_codes", "code_hash", &code_keep).await);
    assert!(!exists_hash(&owner, "player_login_codes", "code_hash", &code_purge).await);
    assert!(exists_hash(&owner, "openid_replay", "nonce_hash", &nonce_keep).await);
    assert!(!exists_hash(&owner, "openid_replay", "nonce_hash", &nonce_purge).await);

    assert!(
        exists(&owner, "audit_log", audit_keep).await,
        "1h inside the audit window must survive"
    );
    assert!(
        !exists(&owner, "audit_log", audit_purge).await,
        "1h past the audit window must purge"
    );
}

#[tokio::test]
async fn pending_invites_survive_terminal_ones_purge() {
    let Some(owner) = setup().await else {
        eprintln!("SKIP pending_invites_survive_terminal_ones_purge: TEST_DATABASE_URL unset");
        return;
    };
    let _guard = LOCK.lock().await;

    let now = Utc::now();
    let org = seed_org(&owner).await;

    // Live pending invite: never touched.
    let pending_live = insert_invite(&owner, org, "pending", now + Duration::days(7), None).await;
    // Pending but expired in fact: purged once 30d past expiry, kept before that.
    let pending_old = insert_invite(&owner, org, "pending", now - Duration::days(31), None).await;
    let pending_recent =
        insert_invite(&owner, org, "pending", now - Duration::days(29), None).await;
    // Accepted: anchored on accepted_at.
    let accepted_old = insert_invite(
        &owner,
        org,
        "accepted",
        now + Duration::days(7),
        Some(now - Duration::days(31)),
    )
    .await;
    let accepted_recent = insert_invite(
        &owner,
        org,
        "accepted",
        now + Duration::days(7),
        Some(now - Duration::days(29)),
    )
    .await;
    // Revoked/expired: anchored on expires_at (no timestamp of their own).
    let revoked_old = insert_invite(&owner, org, "revoked", now - Duration::days(31), None).await;
    let revoked_recent = insert_invite(&owner, org, "revoked", now - Duration::days(1), None).await;
    let expired_old = insert_invite(&owner, org, "expired", now - Duration::days(31), None).await;

    retention_loop::purge_once(&owner, windows(), retention_loop::PURGE_ROW_CAP).await;

    assert!(
        exists(&owner, "invites", pending_live).await,
        "live pending invite must survive"
    );
    assert!(
        !exists(&owner, "invites", pending_old).await,
        "long-expired pending invite must purge"
    );
    assert!(
        exists(&owner, "invites", pending_recent).await,
        "recently expired pending invite must survive"
    );
    assert!(
        !exists(&owner, "invites", accepted_old).await,
        "old accepted invite must purge"
    );
    assert!(
        exists(&owner, "invites", accepted_recent).await,
        "recent accepted invite must survive"
    );
    assert!(
        !exists(&owner, "invites", revoked_old).await,
        "long-expired revoked invite must purge"
    );
    assert!(
        exists(&owner, "invites", revoked_recent).await,
        "recently expired revoked invite must survive"
    );
    assert!(
        !exists(&owner, "invites", expired_old).await,
        "old expired invite must purge"
    );
}

#[tokio::test]
async fn second_tick_is_a_noop() {
    let Some(owner) = setup().await else {
        eprintln!("SKIP second_tick_is_a_noop: TEST_DATABASE_URL unset");
        return;
    };
    let _guard = LOCK.lock().await;
    drain(&owner).await;

    let now = Utc::now();
    let user = seed_user(&owner).await;
    let player = seed_player(&owner).await;
    let org = seed_org(&owner).await;

    // One purgeable row per representative table, plus one survivor.
    insert_session(&owner, user, now - Duration::days(91), None).await;
    let survivor = insert_session(&owner, user, now + Duration::days(1), None).await;
    insert_invite(
        &owner,
        org,
        "accepted",
        now + Duration::days(7),
        Some(now - Duration::days(31)),
    )
    .await;
    insert_login_code(&owner, player, now - Duration::hours(1)).await;
    insert_audit(&owner, "retention-test", now - Duration::days(731)).await;

    let first = retention_loop::purge_once(&owner, windows(), retention_loop::PURGE_ROW_CAP).await;
    assert_eq!(first.sessions, 1);
    assert_eq!(first.invites, 1);
    assert_eq!(first.player_login_codes, 1);
    assert_eq!(first.audit_log, 1);

    // The second tick over the same state purges nothing anywhere.
    let second = retention_loop::purge_once(&owner, windows(), retention_loop::PURGE_ROW_CAP).await;
    assert_eq!(
        total(&second),
        0,
        "second tick must be a no-op, got {second:?}"
    );
    assert!(
        exists(&owner, "sessions", survivor).await,
        "survivor must outlive both ticks"
    );
}

#[tokio::test]
async fn row_cap_is_respected() {
    let Some(owner) = setup().await else {
        eprintln!("SKIP row_cap_is_respected: TEST_DATABASE_URL unset");
        return;
    };
    let _guard = LOCK.lock().await;

    // Clear any backdated audit leftovers so the counts below are exact.
    sqlx::query("DELETE FROM audit_log WHERE created_at < now() - interval '365 days'")
        .execute(&owner)
        .await
        .expect("clear old audit rows");

    let now = Utc::now();
    for _ in 0..5 {
        insert_audit(&owner, "retention-cap-test", now - Duration::days(800)).await;
    }
    let remaining = || async {
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM audit_log WHERE action = 'retention-cap-test'",
        )
        .fetch_one(&owner)
        .await
        .expect("count tagged rows")
    };

    // 5 purgeable rows, cap 2: exactly 2 per tick until the backlog drains.
    let c1 = retention_loop::purge_once(&owner, windows(), 2).await;
    assert_eq!(c1.audit_log, 2);
    assert_eq!(remaining().await, 3);
    let c2 = retention_loop::purge_once(&owner, windows(), 2).await;
    assert_eq!(c2.audit_log, 2);
    assert_eq!(remaining().await, 1);
    let c3 = retention_loop::purge_once(&owner, windows(), 2).await;
    assert_eq!(c3.audit_log, 1);
    assert_eq!(remaining().await, 0);
}
