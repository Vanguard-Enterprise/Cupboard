//! The retention/purge loop's Postgres side (Phase 7 decisions #3/E): boundary
//! exactness against explicit timestamps, raw-NULLed-but-hash-kept for sessions and
//! signals, idempotency (a second tick is a no-op), the per-tick row cap, and the
//! terminal BM job blob clear.
//!
//! Purge statements are table-global (no tenant filter), so every test takes
//! `PURGE_LOCK` and drains pre-existing eligible rows first; the observed counts are
//! then attributable to that test's inserts alone. Skips (passes) when
//! `TEST_DATABASE_URL` is unset.

use chrono::{DateTime, Duration, Utc};
use sqlx::PgPool;
use tokio::sync::{Mutex, OnceCell};
use uuid::Uuid;

use cupboard_identity::retention_loop::{self, Windows};

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
static MIGRATED: OnceCell<()> = OnceCell::const_new();
/// Serializes the purge-running tests (see module docs).
static PURGE_LOCK: Mutex<()> = Mutex::const_new(());

async fn setup() -> Option<PgPool> {
    let owner_url = std::env::var("TEST_DATABASE_URL").ok()?;
    let owner = cupboard_db::connect_scoped(&owner_url, 5, "identity,public")
        .await
        .expect("connect owner");
    MIGRATED
        .get_or_init(|| async {
            sqlx::query("CREATE SCHEMA IF NOT EXISTS identity")
                .execute(&owner)
                .await
                .expect("ensure schema");
            MIGRATOR.run(&owner).await.expect("migrate");
        })
        .await;
    Some(owner)
}

/// Windows wide enough that freshly-inserted rows from other test files are never
/// eligible; individual tests tighten the table under test via explicit timestamps.
fn windows() -> Windows {
    Windows {
        session_raw_days: 90,
        signal_raw_days: 90,
        chat_days: 180,
        reports_days: 365,
        name_history_days: 730,
        audit_days: 730,
        bm_job_blob_days: 30,
    }
}

/// Purge until nothing under `windows` is eligible, so the next tick's counts are
/// exactly this test's rows.
async fn drain(pool: &PgPool, windows: &Windows) {
    for _ in 0..100 {
        let counts = retention_loop::purge_pg_once(pool, windows, retention_loop::ROW_CAP).await;
        if counts.total() == 0 {
            return;
        }
    }
    panic!("purge drain did not converge");
}

async fn insert_player(pool: &PgPool) -> Uuid {
    sqlx::query_scalar("INSERT INTO players DEFAULT VALUES RETURNING id")
        .fetch_one(pool)
        .await
        .expect("insert player")
}

async fn insert_session(
    pool: &PgPool,
    tenant: Uuid,
    player: Uuid,
    last_seen_at: DateTime<Utc>,
) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO player_sessions \
             (tenant_id, server_id, player_id, connected_at, last_seen_at, ip, ip_hash, name) \
         VALUES ($1, $2, $3, $4, $4, '198.51.100.7', $5, 'PlayerName') RETURNING id",
    )
    .bind(tenant)
    .bind(Uuid::new_v4())
    .bind(player)
    .bind(last_seen_at)
    .bind(vec![7u8; 32])
    .fetch_one(pool)
    .await
    .expect("insert session")
}

async fn insert_chat(pool: &PgPool, tenant: Uuid, sent_at: DateTime<Utc>) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO chat_messages (tenant_id, server_id, message, sent_at) \
         VALUES ($1, $2, 'hello', $3) RETURNING id",
    )
    .bind(tenant)
    .bind(Uuid::new_v4())
    .bind(sent_at)
    .fetch_one(pool)
    .await
    .expect("insert chat")
}

#[tokio::test]
async fn boundary_inside_window_survives_outside_is_purged() {
    let Some(pool) = setup().await else { return };
    let _guard = PURGE_LOCK.lock().await;
    let windows = windows();
    drain(&pool, &windows).await;

    let tenant = Uuid::new_v4();
    let now = Utc::now();
    // Explicit boundary construction: one hour inside the 180d chat window, one hour
    // past it.
    let inside = insert_chat(
        &pool,
        tenant,
        now - Duration::days(180) + Duration::hours(1),
    )
    .await;
    let outside = insert_chat(
        &pool,
        tenant,
        now - Duration::days(180) - Duration::hours(1),
    )
    .await;

    let counts = retention_loop::purge_pg_once(&pool, &windows, retention_loop::ROW_CAP).await;
    assert_eq!(counts.chat, 1, "exactly the outside row is purged");

    let remaining: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM chat_messages WHERE tenant_id = $1")
            .bind(tenant)
            .fetch_all(&pool)
            .await
            .expect("list chat");
    assert_eq!(remaining, vec![inside], "inside row survives");
    assert!(!remaining.contains(&outside));
}

#[tokio::test]
async fn session_and_signal_raw_nulled_hash_kept() {
    let Some(pool) = setup().await else { return };
    let _guard = PURGE_LOCK.lock().await;
    let windows = windows();
    drain(&pool, &windows).await;

    let tenant = Uuid::new_v4();
    let player = insert_player(&pool).await;
    let now = Utc::now();
    let inside_at = now - Duration::days(90) + Duration::hours(1);
    let outside_at = now - Duration::days(90) - Duration::hours(1);

    let inside_session = insert_session(&pool, tenant, player, inside_at).await;
    let outside_session = insert_session(&pool, tenant, player, outside_at).await;

    let outside_signal: Uuid = sqlx::query_scalar(
        "INSERT INTO identity_signals (player_id, type, value, value_hash, last_seen_at) \
         VALUES ($1, 'ip', '198.51.100.7', $2, $3) RETURNING id",
    )
    .bind(player)
    .bind(vec![9u8; 32])
    .bind(outside_at)
    .fetch_one(&pool)
    .await
    .expect("insert signal");

    let counts = retention_loop::purge_pg_once(&pool, &windows, retention_loop::ROW_CAP).await;
    assert_eq!(counts.session_raw, 1);
    assert_eq!(counts.signal_raw, 1);

    // The outside session keeps its row and ip_hash; raw ip/name are gone.
    let (ip, name, ip_hash): (Option<String>, Option<String>, Option<Vec<u8>>) =
        sqlx::query_as("SELECT ip, name, ip_hash FROM player_sessions WHERE id = $1")
            .bind(outside_session)
            .fetch_one(&pool)
            .await
            .expect("outside session survives as a row");
    assert_eq!(ip, None);
    assert_eq!(name, None);
    assert_eq!(ip_hash, Some(vec![7u8; 32]), "ip_hash is retained");

    // The inside session is untouched.
    let (ip, name): (Option<String>, Option<String>) =
        sqlx::query_as("SELECT ip, name FROM player_sessions WHERE id = $1")
            .bind(inside_session)
            .fetch_one(&pool)
            .await
            .expect("inside session");
    assert_eq!(ip.as_deref(), Some("198.51.100.7"));
    assert_eq!(name.as_deref(), Some("PlayerName"));

    // The outside signal keeps its row and value_hash; the raw value is gone.
    let (value, value_hash): (Option<String>, Vec<u8>) =
        sqlx::query_as("SELECT value, value_hash FROM identity_signals WHERE id = $1")
            .bind(outside_signal)
            .fetch_one(&pool)
            .await
            .expect("signal survives as a row");
    assert_eq!(value, None);
    assert_eq!(value_hash, vec![9u8; 32], "value_hash is retained");
}

#[tokio::test]
async fn second_tick_is_a_noop() {
    let Some(pool) = setup().await else { return };
    let _guard = PURGE_LOCK.lock().await;
    let windows = windows();
    drain(&pool, &windows).await;

    let tenant = Uuid::new_v4();
    let player = insert_player(&pool).await;
    let now = Utc::now();
    insert_session(&pool, tenant, player, now - Duration::days(91)).await;
    insert_chat(&pool, tenant, now - Duration::days(181)).await;

    let first = retention_loop::purge_pg_once(&pool, &windows, retention_loop::ROW_CAP).await;
    assert_eq!(first.session_raw, 1);
    assert_eq!(first.chat, 1);

    // The NULLed session no longer matches (ip and name already NULL), the chat row is
    // gone: nothing left for a second tick to touch.
    let second = retention_loop::purge_pg_once(&pool, &windows, retention_loop::ROW_CAP).await;
    assert_eq!(second.total(), 0, "second tick touches nothing");
}

#[tokio::test]
async fn row_cap_bounds_each_tick() {
    let Some(pool) = setup().await else { return };
    let _guard = PURGE_LOCK.lock().await;
    let windows = windows();
    drain(&pool, &windows).await;

    let tenant = Uuid::new_v4();
    let old = Utc::now() - Duration::days(200);
    for _ in 0..5 {
        insert_chat(&pool, tenant, old).await;
    }

    let capped = retention_loop::purge_pg_once(&pool, &windows, 2).await;
    assert_eq!(capped.chat, 2, "the cap bounds one tick's work");
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM chat_messages WHERE tenant_id = $1")
        .bind(tenant)
        .fetch_one(&pool)
        .await
        .expect("count chat");
    assert_eq!(left, 3);

    // The remainder is picked up by later ticks.
    let rest = retention_loop::purge_pg_once(&pool, &windows, 10).await;
    assert_eq!(rest.chat, 3);
}

#[tokio::test]
async fn terminal_bm_job_blobs_cleared_row_kept() {
    let Some(pool) = setup().await else { return };
    let _guard = PURGE_LOCK.lock().await;
    let windows = windows();
    drain(&pool, &windows).await;

    let tenant = Uuid::new_v4();
    let connection: Uuid = sqlx::query_scalar(
        "INSERT INTO bm_connections (tenant_id, bm_org_id, token_enc, token_dek) \
         VALUES ($1, 'org-1', $2, $2) RETURNING id",
    )
    .bind(tenant)
    .bind(vec![0u8; 8])
    .fetch_one(&pool)
    .await
    .expect("insert connection");

    let insert_job = |status: &'static str, finished_at: DateTime<Utc>| {
        let pool = pool.clone();
        async move {
            sqlx::query_scalar::<_, Uuid>(
                "INSERT INTO bm_import_jobs \
                     (tenant_id, connection_id, status, cursor, phase_counts, finished_at) \
                 VALUES ($1, $2, $3, '{\"phase\": \"bans\"}', '{\"bans\": 4}', $4) \
                 RETURNING id",
            )
            .bind(tenant)
            .bind(connection)
            .bind(status)
            .bind(finished_at)
            .fetch_one(&pool)
            .await
            .expect("insert job")
        }
    };
    let now = Utc::now();
    let old_done = insert_job("completed", now - Duration::days(31)).await;
    let recent_done = insert_job("completed", now - Duration::days(29)).await;
    // Non-terminal: never touched regardless of age (only one live job per connection).
    let old_running = insert_job("running", now - Duration::days(31)).await;

    let counts = retention_loop::purge_pg_once(&pool, &windows, retention_loop::ROW_CAP).await;
    assert_eq!(
        counts.bm_job_blobs, 1,
        "only the old terminal job is cleared"
    );

    let blob = |id: Uuid| {
        let pool = pool.clone();
        async move {
            sqlx::query_as::<_, (String, serde_json::Value, serde_json::Value)>(
                "SELECT status, cursor, phase_counts FROM bm_import_jobs WHERE id = $1",
            )
            .bind(id)
            .fetch_one(&pool)
            .await
            .expect("job row kept")
        }
    };
    let (status, cursor, phase_counts) = blob(old_done).await;
    assert_eq!(status, "completed", "the row itself is kept");
    assert_eq!(cursor, serde_json::json!({}));
    assert_eq!(phase_counts, serde_json::json!({}));

    let (_, cursor, _) = blob(recent_done).await;
    assert_eq!(cursor, serde_json::json!({"phase": "bans"}));
    let (_, cursor, _) = blob(old_running).await;
    assert_eq!(cursor, serde_json::json!({"phase": "bans"}));
}
