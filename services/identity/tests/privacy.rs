//! Integration tests for the Phase 7 PR2 privacy walkers:
//!   * `POST /internal/privacy/export`
//!   * `POST /internal/privacy/erase`
//!
//! Both ride the scoped PRIVACY_TOKEN plane (decision F), disjoint from the shared
//! INTERNAL_API_TOKEN in BOTH directions (the tickets credential-plane precedent).
//! Covered here: fail-closed token mechanics, platform-scope erase (NULL raw, keep hash,
//! ban still enforces by subject_hash), tenant-scope blast-radius containment (A2),
//! dry-run purity (D), idempotent double-erase, export shape per scope, merged-player
//! resolution, and the decision B2 schema-inventory oracle.
//!
//! Same DB conventions as `tests/internal_bans.rs`; skips (passes) when
//! `TEST_DATABASE_URL` is unset.

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use chrono::Utc;
use cupboard_auth_core::Keys;
use cupboard_crypto::hmac_sha256;
use cupboard_domain::{ObservedPlayer, RosterEvent, ServerId, TenantId};
use cupboard_identity::config::Config;
use cupboard_identity::domain::{bans, ingest, merge, privacy};
use cupboard_identity::http::router;
use cupboard_identity::state::AppState;
use http_body_util::BodyExt as _;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::sync::Arc;
use tokio::sync::OnceCell;
use tower::ServiceExt as _;
use uuid::Uuid;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
static MIGRATED: OnceCell<()> = OnceCell::const_new();

const INTERNAL_TOKEN: &str = "test-internal-token";
const PRIVACY_TOKEN: &str = "test-privacy-token";
const TEST_PEPPER: &str = "privacy-test-pepper";

const TEST_PUBLIC_PEM: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAyKMiwFH0hHn4HiPl8DTEq+aPzW9XyzG5v1ELTEVNsbY=\n-----END PUBLIC KEY-----\n";

async fn setup(internal: Option<&str>, privacy: Option<&str>) -> Option<AppState> {
    let owner_url = std::env::var("TEST_DATABASE_URL").ok()?;
    let app_url = std::env::var("TEST_DATABASE_URL_APP").unwrap_or_else(|_| owner_url.clone());

    let owner: PgPool = cupboard_db::connect_scoped(&owner_url, 5, "identity,public")
        .await
        .expect("connect owner");
    let app: PgPool = cupboard_db::connect_scoped(&app_url, 5, "identity,public")
        .await
        .expect("connect app");

    MIGRATED
        .get_or_init(|| async {
            sqlx::query("CREATE SCHEMA IF NOT EXISTS identity")
                .execute(&owner)
                .await
                .expect("ensure schema");
            MIGRATOR.run(&owner).await.expect("migrate");
        })
        .await;

    let config = Config {
        bind_addr: "0.0.0.0:0".into(),
        database_url: owner_url,
        database_url_app: app_url,
        db_max_connections: 5,
        environment: "test".into(),
        otel_endpoint: None,
        jwt_public_key_pem: TEST_PUBLIC_PEM.into(),
        value_pepper: TEST_PEPPER.into(),
        redis_url: String::new(),
        consumer_name: "identity-test".into(),
        internal_api_token: internal.map(String::from),
        privacy_token: privacy.map(String::from),
        fleet_internal_url: None,
        identity_master_key: None,
        bm_api_base: String::new(),
        retention_tick_secs: 3600,
        retention_session_raw_days: 90,
        retention_signal_raw_days: 90,
        retention_chat_days: 180,
        retention_reports_days: 365,
        retention_name_history_days: 730,
        retention_audit_days: 730,
        retention_bm_job_blob_days: 30,
        retention_stream_days: 14,
    };
    let keys = Keys::verifier_from_ed_pem(&config.jwt_public_key_pem).expect("test verifier key");

    Some(AppState {
        owner_pool: owner,
        app_pool: app,
        keys: Arc::new(keys),
        config: Arc::new(config),
    })
}

fn pepper() -> &'static [u8] {
    TEST_PEPPER.as_bytes()
}

fn fresh_steam(prefix: &str) -> String {
    format!("{prefix}{}", Utc::now().timestamp_nanos_opt().unwrap())
}

fn post(path: &str, token: Option<&str>, body: Value) -> Request<Body> {
    let mut req = Request::builder()
        .method("POST")
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(t) = token {
        req = req.header("x-internal-token", t);
    }
    req.body(Body::from(body.to_string())).unwrap()
}

async fn body_json(res: axum::response::Response) -> Value {
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

fn export_body(
    scope: &str,
    tenant: Option<Uuid>,
    steam: Option<&str>,
    discord: Option<&str>,
) -> Value {
    json!({
        "scope_kind": scope,
        "tenant_id": tenant.map(|t| t.to_string()),
        "steam_id": steam,
        "discord_id": discord,
    })
}

fn erase_body(
    scope: &str,
    tenant: Option<Uuid>,
    steam: Option<&str>,
    discord: Option<&str>,
    dry_run: bool,
) -> Value {
    json!({
        "scope_kind": scope,
        "tenant_id": tenant.map(|t| t.to_string()),
        "steam_id": steam,
        "discord_id": discord,
        "dry_run": dry_run,
    })
}

/// Ingest one roster sighting: creates the player, its steam identifier, ip signal,
/// name history, and an open session for (tenant, server).
async fn ingest_sighting(owner: &PgPool, tenant: Uuid, server: Uuid, steam: &str, ip: &str) {
    let ev = RosterEvent {
        server_id: ServerId(server),
        tenant_id: TenantId(tenant),
        observed_at: Utc::now(),
        players: vec![ObservedPlayer {
            steam_id: steam.into(),
            owner_steam_id: None,
            name: "subject-name".into(),
            ip: Some(ip.into()),
            eac_id: None,
            connected_seconds: 5,
        }],
    };
    ingest::ingest_roster(owner, pepper(), &ev)
        .await
        .expect("ingest");
}

async fn player_id_for(owner: &PgPool, steam: &str) -> Uuid {
    sqlx::query_scalar(
        "SELECT player_id FROM player_identifiers WHERE type = 'steam' AND value_hash = $1",
    )
    .bind(hmac_sha256(steam.as_bytes(), pepper()).to_vec())
    .fetch_one(owner)
    .await
    .expect("resolve seeded player")
}

async fn seed_discord(owner: &PgPool, player: Uuid, discord: &str) {
    sqlx::query(
        "INSERT INTO player_identifiers (player_id, type, value, value_hash) \
         VALUES ($1, 'discord', $2, $3)",
    )
    .bind(player)
    .bind(discord)
    .bind(hmac_sha256(discord.as_bytes(), pepper()).to_vec())
    .execute(owner)
    .await
    .expect("seed discord identifier");
}

/// The per-tenant moderation spread: chat, report, note, flag, a steam ban carrying the
/// raw subject_value + player_id, bm_sync_map rows for all three entity types, an outbox
/// payload and a conflict snapshot embedding the raw steam id.
async fn seed_tenant_rows(owner: &PgPool, tenant: Uuid, server: Uuid, player: Uuid, steam: &str) {
    sqlx::query(
        "INSERT INTO chat_messages (tenant_id, server_id, player_id, name, message, sent_at) \
         VALUES ($1, $2, $3, 'subject-name', 'hello world', now())",
    )
    .bind(tenant)
    .bind(server)
    .bind(player)
    .execute(owner)
    .await
    .expect("seed chat");
    sqlx::query(
        "INSERT INTO player_reports (tenant_id, server_id, reporter_player_id, reporter_name, \
         target_name, subject, message, reported_at) \
         VALUES ($1, $2, $3, 'subject-name', 'victim', 'cheating', 'aimbot', now())",
    )
    .bind(tenant)
    .bind(server)
    .bind(player)
    .execute(owner)
    .await
    .expect("seed report");
    let note_id: Uuid = sqlx::query_scalar(
        "INSERT INTO player_notes (tenant_id, player_id, body) \
         VALUES ($1, $2, 'staff note about the player') RETURNING id",
    )
    .bind(tenant)
    .bind(player)
    .fetch_one(owner)
    .await
    .expect("seed note");
    sqlx::query("INSERT INTO player_flags (tenant_id, player_id, label) VALUES ($1, $2, 'vip')")
        .bind(tenant)
        .bind(player)
        .execute(owner)
        .await
        .expect("seed flag");
    let ban_id: Uuid = sqlx::query_scalar(
        "INSERT INTO bans (tenant_id, subject_type, subject_value, subject_hash, player_id, \
         scope, reason, status) \
         VALUES ($1, 'steam', $2, $3, $4, 'network', 'cheating', 'active') RETURNING id",
    )
    .bind(tenant)
    .bind(steam)
    .bind(hmac_sha256(steam.as_bytes(), pepper()).to_vec())
    .bind(player)
    .fetch_one(owner)
    .await
    .expect("seed ban");
    for (entity, local) in [("player", player), ("note", note_id), ("ban", ban_id)] {
        sqlx::query(
            "INSERT INTO bm_sync_map (tenant_id, entity_type, external_id, local_id, meta) \
             VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(tenant)
        .bind(entity)
        .bind(format!("bm-{entity}-{local}"))
        .bind(local)
        .bind(json!({ "identifiers": [steam], "note": "bm fidelity blob" }))
        .execute(owner)
        .await
        .expect("seed bm_sync_map");
    }
    sqlx::query(
        "INSERT INTO bm_outbox (tenant_id, entity_type, local_id, op, payload) \
         VALUES ($1, 'ban', $2, 'create', $3)",
    )
    .bind(tenant)
    .bind(ban_id)
    .bind(json!({ "subject_value": steam, "reason": "cheating" }))
    .execute(owner)
    .await
    .expect("seed outbox");
    sqlx::query(
        "INSERT INTO bm_sync_conflicts (tenant_id, entity_type, external_id, local_id, \
         direction, local_snapshot, remote_snapshot) \
         VALUES ($1, 'ban', $2, $3, 'inbound', $4, '{}'::jsonb)",
    )
    .bind(tenant)
    .bind(format!("bm-conflict-{ban_id}"))
    .bind(ban_id)
    .bind(json!({ "subject_value": steam }))
    .execute(owner)
    .await
    .expect("seed conflict");
}

async fn scalar_i64(owner: &PgPool, sql: &str, bind: Uuid) -> i64 {
    sqlx::query_scalar(sql)
        .bind(bind)
        .fetch_one(owner)
        .await
        .expect("scalar")
}

#[tokio::test]
async fn privacy_token_plane_is_disjoint_and_fails_closed() {
    let Some(state) = setup(Some(INTERNAL_TOKEN), Some(PRIVACY_TOKEN)).await else {
        eprintln!("SKIP privacy_token_plane_is_disjoint_and_fails_closed: TEST_DATABASE_URL unset");
        return;
    };
    let app = router(state);
    let steam = "76561198000000001";
    let body = || export_body("platform", None, Some(steam), None);
    let ebody = || erase_body("platform", None, Some(steam), None, true);

    for (path, b) in [
        ("/internal/privacy/export", body()),
        ("/internal/privacy/erase", ebody()),
    ] {
        let res = app
            .clone()
            .oneshot(post(path, None, b.clone()))
            .await
            .unwrap();
        assert_eq!(
            res.status(),
            StatusCode::UNAUTHORIZED,
            "{path}: missing token"
        );
        let res = app
            .clone()
            .oneshot(post(path, Some("not-the-token"), b.clone()))
            .await
            .unwrap();
        assert_eq!(
            res.status(),
            StatusCode::UNAUTHORIZED,
            "{path}: wrong token"
        );
        let res = app
            .clone()
            .oneshot(post(path, Some(INTERNAL_TOKEN), b))
            .await
            .unwrap();
        assert_eq!(
            res.status(),
            StatusCode::UNAUTHORIZED,
            "{path}: the shared INTERNAL_API_TOKEN must NOT work on the privacy plane"
        );
    }

    // The other direction: PRIVACY_TOKEN gains nothing on the shared internal surface.
    let res = app
        .clone()
        .oneshot(post(
            "/internal/bans/active",
            Some(PRIVACY_TOKEN),
            json!({ "tenant_id": Uuid::new_v4().to_string(), "steam_id": steam }),
        ))
        .await
        .unwrap();
    assert_eq!(
        res.status(),
        StatusCode::UNAUTHORIZED,
        "PRIVACY_TOKEN must not work on /internal/bans/*"
    );
    let res = app
        .clone()
        .oneshot(post(
            "/internal/enforce",
            Some(PRIVACY_TOKEN),
            json!({ "tenant_id": Uuid::new_v4(), "server_id": Uuid::new_v4(), "steam_ids": [steam] }),
        ))
        .await
        .unwrap();
    assert_eq!(
        res.status(),
        StatusCode::UNAUTHORIZED,
        "PRIVACY_TOKEN must not work on /internal/enforce"
    );

    // Request validation behind the good token.
    let res = app
        .clone()
        .oneshot(post(
            "/internal/privacy/export",
            Some(PRIVACY_TOKEN),
            export_body("tenant", None, Some(steam), None),
        ))
        .await
        .unwrap();
    assert_eq!(
        res.status(),
        StatusCode::BAD_REQUEST,
        "tenant scope needs tenant_id"
    );
    let res = app
        .clone()
        .oneshot(post(
            "/internal/privacy/erase",
            Some(PRIVACY_TOKEN),
            erase_body("platform", None, None, None, true),
        ))
        .await
        .unwrap();
    assert_eq!(
        res.status(),
        StatusCode::BAD_REQUEST,
        "an identifier is required"
    );
    let res = app
        .clone()
        .oneshot(post(
            "/internal/privacy/export",
            Some(PRIVACY_TOKEN),
            export_body("everything", None, Some(steam), None),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST, "unknown scope_kind");
    // Export has NO dry_run field: deny_unknown_fields rejects it at the body.
    let mut with_dry = export_body("platform", None, Some(steam), None);
    with_dry["dry_run"] = json!(true);
    let res = app
        .clone()
        .oneshot(post(
            "/internal/privacy/export",
            Some(PRIVACY_TOKEN),
            with_dry,
        ))
        .await
        .unwrap();
    assert!(
        res.status().is_client_error(),
        "export must reject a dry_run field (deny_unknown_fields)"
    );
    // The coordinator sends ONE payload shape to both walkers: player_account_id is
    // accepted (and deliberately ignored, identity has no account concept).
    for path in ["/internal/privacy/export", "/internal/privacy/erase"] {
        let mut with_pid = if path.ends_with("erase") {
            erase_body("platform", None, Some(steam), None, true)
        } else {
            export_body("platform", None, Some(steam), None)
        };
        with_pid["player_account_id"] = json!(Uuid::new_v4().to_string());
        let res = app
            .clone()
            .oneshot(post(path, Some(PRIVACY_TOKEN), with_pid))
            .await
            .unwrap();
        assert_eq!(
            res.status(),
            StatusCode::OK,
            "{path}: player_account_id in the fan-out payload must be accepted"
        );
    }

    // Fail closed: no PRIVACY_TOKEN configured means 503 even with the right header.
    let Some(unset) = setup(Some(INTERNAL_TOKEN), None).await else {
        return;
    };
    let app = router(unset);
    for path in ["/internal/privacy/export", "/internal/privacy/erase"] {
        let b = if path.ends_with("erase") {
            ebody()
        } else {
            body()
        };
        let res = app
            .clone()
            .oneshot(post(path, Some(PRIVACY_TOKEN), b))
            .await
            .unwrap();
        assert_eq!(
            res.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "{path}: unset PRIVACY_TOKEN fails closed with 503"
        );
    }
}

#[tokio::test]
async fn platform_erase_nulls_raw_keeps_hashes_ban_still_enforces() {
    let Some(state) = setup(Some(INTERNAL_TOKEN), Some(PRIVACY_TOKEN)).await else {
        eprintln!("SKIP platform_erase_nulls_raw_keeps_hashes_ban_still_enforces: unset");
        return;
    };
    let owner = state.owner_pool.clone();
    let app = router(state);
    let tenant = Uuid::new_v4();
    let server = Uuid::new_v4();
    let steam = fresh_steam("76571");
    let discord = format!("d{}", Utc::now().timestamp_nanos_opt().unwrap());

    ingest_sighting(&owner, tenant, server, &steam, "203.0.113.20").await;
    let player = player_id_for(&owner, &steam).await;
    seed_discord(&owner, player, &discord).await;
    seed_tenant_rows(&owner, tenant, server, player, &steam).await;
    // A report NOT involving the player must stay untouched.
    sqlx::query(
        "INSERT INTO player_reports (tenant_id, server_id, reporter_name, message, reported_at) \
         VALUES ($1, $2, 'someone-else', 'unrelated', now())",
    )
    .bind(tenant)
    .bind(server)
    .execute(&owner)
    .await
    .unwrap();

    let res = app
        .clone()
        .oneshot(post(
            "/internal/privacy/erase",
            Some(PRIVACY_TOKEN),
            erase_body("platform", None, Some(&steam), Some(&discord), false),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let counts = body_json(res).await["counts"].clone();
    assert_eq!(counts["player_identifiers"], 2, "steam + discord: {counts}");
    assert_eq!(counts["identity_signals"], 1);
    assert_eq!(counts["name_history"], 1);
    assert_eq!(counts["player_sessions"], 1);
    assert_eq!(counts["chat_messages"], 1);
    assert_eq!(counts["player_reports"], 1);
    assert_eq!(counts["player_notes"], 1);
    assert_eq!(counts["player_flags"], 1);
    assert_eq!(counts["bans"], 1);
    assert_eq!(counts["bm_sync_map"], 3);
    assert_eq!(counts["bm_outbox"], 1);
    assert_eq!(counts["bm_sync_conflicts"], 1);
    assert_eq!(counts["players"], 1);

    // Raw values NULLed, hashes retained.
    let (values, hashes): (i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE value IS NOT NULL), \
                count(*) FILTER (WHERE value_hash IS NOT NULL) \
         FROM player_identifiers WHERE player_id = $1",
    )
    .bind(player)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(values, 0, "identifier raw values NULLed");
    assert_eq!(hashes, 2, "identifier hashes retained");
    let raw_signals = scalar_i64(
        &owner,
        "SELECT count(*) FROM identity_signals WHERE player_id = $1 AND value IS NOT NULL",
        player,
    )
    .await;
    assert_eq!(raw_signals, 0, "signal raw values NULLed");
    let names = scalar_i64(
        &owner,
        "SELECT count(*) FROM name_history WHERE player_id = $1",
        player,
    )
    .await;
    assert_eq!(names, 0, "name_history deleted");
    let (ip, ip_hash, sname): (Option<String>, Option<Vec<u8>>, Option<String>) =
        sqlx::query_as("SELECT ip, ip_hash, name FROM player_sessions WHERE player_id = $1")
            .bind(player)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(ip, None, "session ip NULLed");
    assert_eq!(sname, None, "session name NULLed");
    assert!(ip_hash.is_some(), "session ip_hash retained");
    let (cname, cmsg): (Option<String>, String) =
        sqlx::query_as("SELECT name, message FROM chat_messages WHERE player_id = $1")
            .bind(player)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(cname.as_deref(), Some("[erased]"));
    assert_eq!(cmsg, "[erased]");
    let report: (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = sqlx::query_as(
        "SELECT reporter_name, target_name, subject, message FROM player_reports \
         WHERE reporter_player_id = $1",
    )
    .bind(player)
    .fetch_one(&owner)
    .await
    .unwrap();
    for field in [report.0, report.1, report.2, report.3] {
        assert_eq!(
            field.as_deref(),
            Some("[erased]"),
            "all four report fields markered"
        );
    }
    let untouched: (Option<String>, Option<String>) = sqlx::query_as(
        "SELECT reporter_name, message FROM player_reports \
         WHERE tenant_id = $1 AND reporter_player_id IS NULL",
    )
    .bind(tenant)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(
        untouched.0.as_deref(),
        Some("someone-else"),
        "unrelated report untouched"
    );
    let body: String = sqlx::query_scalar("SELECT body FROM player_notes WHERE player_id = $1")
        .bind(player)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(body, "[erased]");
    let flags = scalar_i64(
        &owner,
        "SELECT count(*) FROM player_flags WHERE player_id = $1",
        player,
    )
    .await;
    assert_eq!(flags, 0, "flags deleted");

    // The ban: raw context gone, enforcement key + reason retained, still ACTIVE.
    let (sv, pid, reason, status): (Option<String>, Option<Uuid>, Option<String>, String) =
        sqlx::query_as(
            "SELECT subject_value, player_id, reason, status FROM bans WHERE subject_hash = $1",
        )
        .bind(hmac_sha256(steam.as_bytes(), pepper()).to_vec())
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(sv, None, "ban subject_value NULLed");
    assert_eq!(pid, None, "ban player_id NULLed");
    assert_eq!(
        reason.as_deref(),
        Some("cheating"),
        "reason retained (basis)"
    );
    assert_eq!(status, "active");
    // Enforcement-style lookup: the connect-time hash match still finds the ban.
    let hits = bans::enforce(
        &owner,
        pepper(),
        tenant,
        server,
        std::slice::from_ref(&steam),
    )
    .await
    .unwrap();
    assert_eq!(
        hits.len(),
        1,
        "erased player's ban still enforces by subject_hash"
    );
    assert_eq!(hits[0].steam_id, steam);

    let metas = scalar_i64(
        &owner,
        "SELECT count(*) FROM bm_sync_map WHERE tenant_id = $1 AND meta <> '{}'::jsonb",
        tenant,
    )
    .await;
    assert_eq!(metas, 0, "bm_sync_map meta scrubbed wholesale");
    let payloads = scalar_i64(
        &owner,
        "SELECT count(*) FROM bm_outbox WHERE tenant_id = $1 AND payload <> '{}'::jsonb",
        tenant,
    )
    .await;
    assert_eq!(payloads, 0, "outbox payload swept");
    let snaps = scalar_i64(
        &owner,
        "SELECT count(*) FROM bm_sync_conflicts WHERE tenant_id = $1 \
         AND (local_snapshot <> '{}'::jsonb OR remote_snapshot <> '{}'::jsonb)",
        tenant,
    )
    .await;
    assert_eq!(snaps, 0, "conflict snapshots swept");

    let status: String = sqlx::query_scalar("SELECT status FROM players WHERE id = $1")
        .bind(player)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(status, "erased", "player tombstoned");

    let audits = scalar_i64(
        &owner,
        "SELECT count(*) FROM audit_log WHERE action = 'player.erase' \
         AND tenant_id IS NULL AND target_id = $1",
        player,
    )
    .await;
    assert_eq!(audits, 1, "platform erase audited with tenant NULL");
}

#[tokio::test]
async fn tenant_scope_erase_contains_blast_radius() {
    let Some(state) = setup(Some(INTERNAL_TOKEN), Some(PRIVACY_TOKEN)).await else {
        eprintln!("SKIP tenant_scope_erase_contains_blast_radius: unset");
        return;
    };
    let owner = state.owner_pool.clone();
    let app = router(state);
    let (tenant_a, tenant_b) = (Uuid::new_v4(), Uuid::new_v4());
    let (server_a, server_b) = (Uuid::new_v4(), Uuid::new_v4());
    let steam = fresh_steam("76572");

    ingest_sighting(&owner, tenant_a, server_a, &steam, "203.0.113.30").await;
    ingest_sighting(&owner, tenant_b, server_b, &steam, "203.0.113.31").await;
    let player = player_id_for(&owner, &steam).await;
    seed_tenant_rows(&owner, tenant_a, server_a, player, &steam).await;
    seed_tenant_rows(&owner, tenant_b, server_b, player, &steam).await;

    let res = app
        .clone()
        .oneshot(post(
            "/internal/privacy/erase",
            Some(PRIVACY_TOKEN),
            erase_body("tenant", Some(tenant_a), Some(&steam), None, false),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let counts = body_json(res).await["counts"].clone();
    for global in [
        "player_identifiers",
        "identity_signals",
        "name_history",
        "players",
    ] {
        assert!(
            counts.get(global).is_none(),
            "tenant scope must not walk the global table {global}: {counts}"
        );
    }
    assert_eq!(
        counts["player_sessions"], 1,
        "only tenant A's session: {counts}"
    );
    assert_eq!(counts["chat_messages"], 1);
    assert_eq!(counts["bans"], 1);
    assert_eq!(counts["bm_sync_map"], 3);

    // Global graph untouched: raw identifier value, name history, player status.
    let raw: Option<String> = sqlx::query_scalar(
        "SELECT value FROM player_identifiers WHERE player_id = $1 AND type = 'steam'",
    )
    .bind(player)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(
        raw.as_deref(),
        Some(steam.as_str()),
        "global identifier untouched"
    );
    let names = scalar_i64(
        &owner,
        "SELECT count(*) FROM name_history WHERE player_id = $1",
        player,
    )
    .await;
    assert_eq!(names, 1, "name_history untouched");
    let signals = scalar_i64(
        &owner,
        "SELECT count(*) FROM identity_signals WHERE player_id = $1 AND value IS NOT NULL",
        player,
    )
    .await;
    assert!(signals >= 1, "signals untouched");
    let status: String = sqlx::query_scalar("SELECT status FROM players WHERE id = $1")
        .bind(player)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(status, "active", "player NOT tombstoned by tenant scope");

    // Tenant A scrubbed.
    let a_raw = scalar_i64(
        &owner,
        "SELECT count(*) FROM player_sessions WHERE tenant_id = $1 AND ip IS NOT NULL",
        tenant_a,
    )
    .await;
    assert_eq!(a_raw, 0, "tenant A session ip NULLed");
    // Tenant B fully untouched, proven by counts.
    let b_ip = scalar_i64(
        &owner,
        "SELECT count(*) FROM player_sessions WHERE tenant_id = $1 AND ip IS NOT NULL",
        tenant_b,
    )
    .await;
    assert_eq!(b_ip, 1, "tenant B session ip untouched");
    let b_chat = scalar_i64(
        &owner,
        "SELECT count(*) FROM chat_messages WHERE tenant_id = $1 AND message = 'hello world'",
        tenant_b,
    )
    .await;
    assert_eq!(b_chat, 1, "tenant B chat untouched");
    let b_ban = scalar_i64(
        &owner,
        "SELECT count(*) FROM bans WHERE tenant_id = $1 AND subject_value IS NOT NULL",
        tenant_b,
    )
    .await;
    assert_eq!(b_ban, 1, "tenant B ban raw subject untouched");
    let b_meta = scalar_i64(
        &owner,
        "SELECT count(*) FROM bm_sync_map WHERE tenant_id = $1 AND meta <> '{}'::jsonb",
        tenant_b,
    )
    .await;
    assert_eq!(b_meta, 3, "tenant B bm meta untouched");
    let b_flags = scalar_i64(
        &owner,
        "SELECT count(*) FROM player_flags WHERE tenant_id = $1",
        tenant_b,
    )
    .await;
    assert_eq!(b_flags, 1, "tenant B flag untouched");

    let audits = scalar_i64(
        &owner,
        "SELECT count(*) FROM audit_log WHERE action = 'player.erase' AND tenant_id = $1",
        tenant_a,
    )
    .await;
    assert_eq!(audits, 1, "tenant erase audited under the tenant");
}

#[tokio::test]
async fn dry_run_counts_without_writing() {
    let Some(state) = setup(Some(INTERNAL_TOKEN), Some(PRIVACY_TOKEN)).await else {
        eprintln!("SKIP dry_run_counts_without_writing: unset");
        return;
    };
    let owner = state.owner_pool.clone();
    let app = router(state);
    let tenant = Uuid::new_v4();
    let server = Uuid::new_v4();
    let steam = fresh_steam("76573");

    ingest_sighting(&owner, tenant, server, &steam, "203.0.113.40").await;
    let player = player_id_for(&owner, &steam).await;
    seed_tenant_rows(&owner, tenant, server, player, &steam).await;

    let res = app
        .clone()
        .oneshot(post(
            "/internal/privacy/erase",
            Some(PRIVACY_TOKEN),
            erase_body("platform", None, Some(&steam), None, true),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let dry = body_json(res).await["counts"].clone();
    assert_eq!(dry["player_identifiers"], 1, "{dry}");
    assert_eq!(dry["chat_messages"], 1);
    assert_eq!(dry["players"], 1);

    // Nothing written: raw values, flags, status, and the audit log are unchanged.
    let raw: Option<String> = sqlx::query_scalar(
        "SELECT value FROM player_identifiers WHERE player_id = $1 AND type = 'steam'",
    )
    .bind(player)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(
        raw.as_deref(),
        Some(steam.as_str()),
        "dry run left the raw value"
    );
    let msg: String = sqlx::query_scalar("SELECT message FROM chat_messages WHERE player_id = $1")
        .bind(player)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(msg, "hello world");
    let flags = scalar_i64(
        &owner,
        "SELECT count(*) FROM player_flags WHERE player_id = $1",
        player,
    )
    .await;
    assert_eq!(flags, 1);
    let status: String = sqlx::query_scalar("SELECT status FROM players WHERE id = $1")
        .bind(player)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(status, "active");
    let audits = scalar_i64(
        &owner,
        "SELECT count(*) FROM audit_log WHERE action = 'player.erase' AND target_id = $1",
        player,
    )
    .await;
    assert_eq!(audits, 0, "dry run writes no audit row");

    // The real run affects exactly what the dry run predicted.
    let res = app
        .clone()
        .oneshot(post(
            "/internal/privacy/erase",
            Some(PRIVACY_TOKEN),
            erase_body("platform", None, Some(&steam), None, false),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let real = body_json(res).await["counts"].clone();
    assert_eq!(real, dry, "dry-run counts equal the real run's");
}

#[tokio::test]
async fn double_erase_second_run_all_zero() {
    let Some(state) = setup(Some(INTERNAL_TOKEN), Some(PRIVACY_TOKEN)).await else {
        eprintln!("SKIP double_erase_second_run_all_zero: unset");
        return;
    };
    let owner = state.owner_pool.clone();
    let app = router(state);
    let tenant = Uuid::new_v4();
    let server = Uuid::new_v4();
    let steam = fresh_steam("76574");

    ingest_sighting(&owner, tenant, server, &steam, "203.0.113.50").await;
    let player = player_id_for(&owner, &steam).await;
    seed_tenant_rows(&owner, tenant, server, player, &steam).await;

    let erase = |b| post("/internal/privacy/erase", Some(PRIVACY_TOKEN), b);
    let res = app
        .clone()
        .oneshot(erase(erase_body(
            "platform",
            None,
            Some(&steam),
            None,
            false,
        )))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let first = body_json(res).await["counts"].clone();
    assert_eq!(first["players"], 1, "first run erases: {first}");

    // Identifier hashes survive, so the subject still resolves; every count is zero.
    let res = app
        .clone()
        .oneshot(erase(erase_body(
            "platform",
            None,
            Some(&steam),
            None,
            false,
        )))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let second = body_json(res).await["counts"].clone();
    let obj = second.as_object().expect("counts object");
    assert!(!obj.is_empty(), "second run still resolves the player");
    for (table, n) in obj {
        assert_eq!(
            n.as_i64(),
            Some(0),
            "second erase must be a no-op ({table}): {second}"
        );
    }
}

#[tokio::test]
async fn export_shape_includes_seeded_rows_per_scope() {
    let Some(state) = setup(Some(INTERNAL_TOKEN), Some(PRIVACY_TOKEN)).await else {
        eprintln!("SKIP export_shape_includes_seeded_rows_per_scope: unset");
        return;
    };
    let owner = state.owner_pool.clone();
    let app = router(state);
    let (tenant_a, tenant_b) = (Uuid::new_v4(), Uuid::new_v4());
    let (server_a, server_b) = (Uuid::new_v4(), Uuid::new_v4());
    let steam = fresh_steam("76575");
    let discord = format!("d{}", Utc::now().timestamp_nanos_opt().unwrap());

    ingest_sighting(&owner, tenant_a, server_a, &steam, "203.0.113.60").await;
    ingest_sighting(&owner, tenant_b, server_b, &steam, "203.0.113.61").await;
    let player = player_id_for(&owner, &steam).await;
    seed_discord(&owner, player, &discord).await;
    seed_tenant_rows(&owner, tenant_a, server_a, player, &steam).await;
    seed_tenant_rows(&owner, tenant_b, server_b, player, &steam).await;
    // A report where the subject is the TARGET: the reporter is a third party whose
    // name must be redacted in the subject's bundle (decision C posture).
    sqlx::query(
        "INSERT INTO player_reports (tenant_id, server_id, target_player_id, reporter_name, \
         target_name, subject, message, reported_at) \
         VALUES ($1, $2, $3, 'accuser', 'subject-name', 'griefing', 'details', now())",
    )
    .bind(tenant_a)
    .bind(server_a)
    .bind(player)
    .execute(&owner)
    .await
    .unwrap();
    let ban_a: Uuid =
        sqlx::query_scalar("SELECT id FROM bans WHERE tenant_id = $1 AND player_id = $2")
            .bind(tenant_a)
            .bind(player)
            .fetch_one(&owner)
            .await
            .unwrap();
    sqlx::query(
        "INSERT INTO ban_evasion_alerts (tenant_id, ban_id, suspect_player) VALUES ($1, $2, $3)",
    )
    .bind(tenant_a)
    .bind(ban_a)
    .bind(player)
    .execute(&owner)
    .await
    .unwrap();

    // Platform scope: the full spread, raw values included, both tenants' rows.
    let res = app
        .clone()
        .oneshot(post(
            "/internal/privacy/export",
            Some(PRIVACY_TOKEN),
            export_body("platform", None, Some(&steam), Some(&discord)),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let full = body_json(res).await;
    assert_eq!(full["player_ids"], json!([player.to_string()]));
    let data = full["data"].as_object().expect("data object");
    let rows = |t: &str| {
        data.get(t)
            .and_then(|v| v.as_array())
            .unwrap_or_else(|| panic!("expected {t} array in platform export"))
    };
    assert_eq!(rows("players").len(), 1);
    assert_eq!(rows("player_identifiers").len(), 2);
    let ident_values: Vec<&str> = rows("player_identifiers")
        .iter()
        .filter_map(|r| r["value"].as_str())
        .collect();
    assert!(ident_values.contains(&steam.as_str()), "raw steam exported");
    assert!(
        ident_values.contains(&discord.as_str()),
        "raw discord exported"
    );
    assert!(!rows("identity_signals").is_empty());
    assert_eq!(rows("name_history").len(), 1);
    assert_eq!(rows("player_sessions").len(), 2, "both tenants' sessions");
    assert_eq!(rows("chat_messages").len(), 2);
    // Opposing-party redaction: as reporter the target's name is masked, as target
    // the reporter's name is; the subject's own side always ships intact.
    let reports = rows("player_reports");
    assert_eq!(reports.len(), 3);
    for r in reports {
        if r["reporter_player_id"] == json!(player.to_string()) {
            assert_eq!(r["reporter_name"], json!("subject-name"));
            assert_eq!(
                r["target_name"],
                json!("[third party]"),
                "target name is a third party's data: {r}"
            );
        } else {
            assert_eq!(
                r["reporter_name"],
                json!("[third party]"),
                "reporter name is a third party's data: {r}"
            );
            assert_eq!(r["target_name"], json!("subject-name"));
        }
    }
    assert_eq!(rows("player_notes").len(), 2);
    assert_eq!(rows("player_flags").len(), 2);
    assert_eq!(rows("bans").len(), 2);
    assert_eq!(
        rows("bans")[0]["subject_value"],
        json!(steam),
        "raw ban subject exported"
    );
    assert_eq!(rows("ban_evasion_alerts").len(), 1);
    assert_eq!(rows("bm_sync_map").len(), 6);
    // BM sync internals ship redacted: row identity/status survive, jsonb contents do
    // not (they are Cupboard's operational records, not the subject's data).
    assert_eq!(rows("bm_outbox").len(), 2);
    for r in rows("bm_outbox") {
        assert_eq!(r["payload"], json!("[internal sync record]"));
        assert!(r["status"].is_string(), "outbox status survives redaction");
    }
    assert_eq!(rows("bm_sync_conflicts").len(), 2);
    for r in rows("bm_sync_conflicts") {
        assert_eq!(r["local_snapshot"], json!("[internal sync record]"));
        assert_eq!(r["remote_snapshot"], json!("[internal sync record]"));
    }

    // Tenant scope: no global-graph keys (decision A2), only tenant A rows.
    let res = app
        .clone()
        .oneshot(post(
            "/internal/privacy/export",
            Some(PRIVACY_TOKEN),
            export_body("tenant", Some(tenant_a), Some(&steam), Some(&discord)),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let scoped = body_json(res).await;
    assert_eq!(scoped["player_ids"], json!([player.to_string()]));
    let data = scoped["data"].as_object().expect("data object");
    for global in [
        "players",
        "player_identifiers",
        "identity_signals",
        "name_history",
    ] {
        assert!(
            data.get(global).is_none(),
            "tenant export must exclude global table {global}"
        );
    }
    let rows = |t: &str| {
        data.get(t)
            .and_then(|v| v.as_array())
            .unwrap_or_else(|| panic!("expected {t} array in tenant export"))
    };
    assert_eq!(rows("player_sessions").len(), 1, "only tenant A's session");
    assert_eq!(
        rows("player_sessions")[0]["tenant_id"],
        json!(tenant_a.to_string())
    );
    assert_eq!(rows("chat_messages").len(), 1);
    assert_eq!(rows("bans").len(), 1);
    assert_eq!(rows("bm_sync_map").len(), 3);
    assert_eq!(rows("ban_evasion_alerts").len(), 1);

    // Unknown subject: 200, no player ids, and the walk still runs (hash/value-matched
    // tables could hold rows), so every table key is present with zero rows.
    let res = app
        .clone()
        .oneshot(post(
            "/internal/privacy/export",
            Some(PRIVACY_TOKEN),
            export_body("platform", None, Some("76500000000000000"), None),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let empty = body_json(res).await;
    assert_eq!(empty["player_ids"], json!([]));
    let empty_data = empty["data"].as_object().expect("data object");
    assert!(
        !empty_data.is_empty(),
        "unknown subject still walks the tables"
    );
    for (table, rows) in empty_data {
        assert_eq!(
            rows.as_array().map(Vec::len),
            Some(0),
            "unknown subject exports no {table} rows"
        );
    }
}

#[tokio::test]
async fn merged_player_resolution_follows_merged_into() {
    let Some(state) = setup(Some(INTERNAL_TOKEN), Some(PRIVACY_TOKEN)).await else {
        eprintln!("SKIP merged_player_resolution_follows_merged_into: unset");
        return;
    };
    let owner = state.owner_pool.clone();
    let app = router(state);
    let tenant = Uuid::new_v4();
    let server = Uuid::new_v4();
    let steam_a = fresh_steam("76576");
    let steam_b = fresh_steam("76577");
    let discord = format!("d{}", Utc::now().timestamp_nanos_opt().unwrap());

    ingest_sighting(&owner, tenant, server, &steam_a, "203.0.113.70").await;
    ingest_sighting(&owner, tenant, server, &steam_b, "203.0.113.71").await;
    let a = player_id_for(&owner, &steam_a).await;
    let b = player_id_for(&owner, &steam_b).await;
    merge::merge_players(&owner, b, a, None, Some("same person"))
        .await
        .expect("merge");
    // An identifier still pointing at the tombstone (post-merge sighting shape): the
    // walk must follow merged_into and include BOTH ids.
    seed_discord(&owner, b, &discord).await;

    let res = app
        .clone()
        .oneshot(post(
            "/internal/privacy/export",
            Some(PRIVACY_TOKEN),
            export_body("platform", None, None, Some(&discord)),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let exported = body_json(res).await;
    let ids: Vec<String> = exported["player_ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    assert!(ids.contains(&a.to_string()), "survivor included: {ids:?}");
    assert!(ids.contains(&b.to_string()), "tombstone included: {ids:?}");

    let res = app
        .clone()
        .oneshot(post(
            "/internal/privacy/erase",
            Some(PRIVACY_TOKEN),
            erase_body("platform", None, None, Some(&discord), false),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let counts = body_json(res).await["counts"].clone();
    assert_eq!(
        counts["players"], 1,
        "only the active survivor tombstones: {counts}"
    );
    let (a_status, b_status): (String, String) = sqlx::query_as(
        "SELECT (SELECT status FROM players WHERE id = $1), \
                (SELECT status FROM players WHERE id = $2)",
    )
    .bind(a)
    .bind(b)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(a_status, "erased");
    assert_eq!(b_status, "merged", "merged tombstone keeps its status");
    // Both players' identifiers (incl. the survivor's steam) were scrubbed.
    let raw = scalar_i64(
        &owner,
        "SELECT count(*) FROM player_identifiers WHERE player_id = $1 AND value IS NOT NULL",
        a,
    )
    .await;
    assert_eq!(
        raw, 0,
        "survivor's identifiers scrubbed via the merged walk"
    );
}

/// Regression (adversarial-review FIX): a ban carrying subject_hash/subject_value for
/// a subject with NO player_identifiers row (player_id NULL, the BM-import/manual
/// shape) must still export and erase. The old walkers early-returned when no player
/// resolved and stranded these rows.
#[tokio::test]
async fn hash_only_ban_without_player_row_erases_and_exports() {
    let Some(state) = setup(Some(INTERNAL_TOKEN), Some(PRIVACY_TOKEN)).await else {
        eprintln!("SKIP hash_only_ban_without_player_row_erases_and_exports: unset");
        return;
    };
    let owner = state.owner_pool.clone();
    let app = router(state);
    let (tenant_a, tenant_b) = (Uuid::new_v4(), Uuid::new_v4());
    let steam = fresh_steam("76578");
    let hash = hmac_sha256(steam.as_bytes(), pepper()).to_vec();

    for tenant in [tenant_a, tenant_b] {
        sqlx::query(
            "INSERT INTO bans (tenant_id, subject_type, subject_value, subject_hash, \
             scope, reason, status) \
             VALUES ($1, 'steam', $2, $3, 'network', 'imported', 'active')",
        )
        .bind(tenant)
        .bind(&steam)
        .bind(&hash)
        .execute(&owner)
        .await
        .expect("seed hash-only ban");
    }

    // Export BEFORE erase includes the ban rows even though no player resolves.
    let res = app
        .clone()
        .oneshot(post(
            "/internal/privacy/export",
            Some(PRIVACY_TOKEN),
            export_body("platform", None, Some(&steam), None),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let full = body_json(res).await;
    assert_eq!(full["player_ids"], json!([]));
    let bans = full["data"]["bans"].as_array().expect("bans array");
    assert_eq!(bans.len(), 2, "both tenants' hash-only bans export: {full}");
    assert_eq!(bans[0]["subject_value"], json!(steam));

    // Tenant scope sees only that tenant's ban.
    let res = app
        .clone()
        .oneshot(post(
            "/internal/privacy/export",
            Some(PRIVACY_TOKEN),
            export_body("tenant", Some(tenant_a), Some(&steam), None),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let scoped = body_json(res).await;
    let bans = scoped["data"]["bans"].as_array().expect("bans array");
    assert_eq!(bans.len(), 1);
    assert_eq!(bans[0]["tenant_id"], json!(tenant_a.to_string()));

    // Tenant-scope erase: A's raw subject scrubbed via the hash arm, B untouched.
    let res = app
        .clone()
        .oneshot(post(
            "/internal/privacy/erase",
            Some(PRIVACY_TOKEN),
            erase_body("tenant", Some(tenant_a), Some(&steam), None, false),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let counts = body_json(res).await["counts"].clone();
    assert_eq!(
        counts["bans"], 1,
        "tenant A's hash-only ban swept: {counts}"
    );
    let (a_value, a_hash): (Option<String>, Option<Vec<u8>>) =
        sqlx::query_as("SELECT subject_value, subject_hash FROM bans WHERE tenant_id = $1")
            .bind(tenant_a)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(a_value, None, "subject_value NULLed");
    assert_eq!(
        a_hash,
        Some(hash.clone()),
        "subject_hash intact (still enforces)"
    );
    let b_value: Option<String> =
        sqlx::query_scalar("SELECT subject_value FROM bans WHERE tenant_id = $1")
            .bind(tenant_b)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(
        b_value.as_deref(),
        Some(steam.as_str()),
        "tenant B untouched"
    );

    // Platform erase sweeps the remaining tenant B row.
    let res = app
        .clone()
        .oneshot(post(
            "/internal/privacy/erase",
            Some(PRIVACY_TOKEN),
            erase_body("platform", None, Some(&steam), None, false),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let counts = body_json(res).await["counts"].clone();
    assert_eq!(counts["bans"], 1, "only tenant B's row was left: {counts}");
    let (b_value, b_hash): (Option<String>, Option<Vec<u8>>) =
        sqlx::query_as("SELECT subject_value, subject_hash FROM bans WHERE tenant_id = $1")
            .bind(tenant_b)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(b_value, None);
    assert_eq!(b_hash, Some(hash));

    // A truly unknown subject changes nothing and writes NO audit row (no noise).
    let ghost_tenant = Uuid::new_v4();
    let res = app
        .clone()
        .oneshot(post(
            "/internal/privacy/erase",
            Some(PRIVACY_TOKEN),
            erase_body(
                "tenant",
                Some(ghost_tenant),
                Some(&fresh_steam("76579")),
                None,
                false,
            ),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let counts = body_json(res).await["counts"].clone();
    for (table, n) in counts.as_object().expect("counts object") {
        assert_eq!(n.as_i64(), Some(0), "unknown subject: zero {table} rows");
    }
    let audits = scalar_i64(
        &owner,
        "SELECT count(*) FROM audit_log WHERE action = 'player.erase' AND tenant_id = $1",
        ghost_tenant,
    )
    .await;
    assert_eq!(
        audits, 0,
        "all-zero unknown-subject erase writes no audit row"
    );
}

/// Regression (adversarial-review FIX): a NON-terminal bm_outbox row whose payload is
/// swept must land in 'abandoned' with an explanatory last_error (leaving it pending
/// with an empty payload would have the drain settle it as a noisy 'failed');
/// terminal rows keep their status and just lose the payload.
#[tokio::test]
async fn outbox_sweep_abandons_nonterminal_rows_keeps_terminal_status() {
    let Some(state) = setup(Some(INTERNAL_TOKEN), Some(PRIVACY_TOKEN)).await else {
        eprintln!("SKIP outbox_sweep_abandons_nonterminal_rows_keeps_terminal_status: unset");
        return;
    };
    let owner = state.owner_pool.clone();
    let app = router(state);
    let tenant = Uuid::new_v4();
    let steam = fresh_steam("76580");
    let (pending_id, done_id) = (Uuid::new_v4(), Uuid::new_v4());

    for (local, status) in [(pending_id, "pending"), (done_id, "done")] {
        sqlx::query(
            "INSERT INTO bm_outbox (tenant_id, entity_type, local_id, op, payload, status) \
             VALUES ($1, 'ban', $2, 'create', $3, $4)",
        )
        .bind(tenant)
        .bind(local)
        .bind(json!({ "subject_value": steam, "reason": "cheating" }))
        .bind(status)
        .execute(&owner)
        .await
        .expect("seed outbox row");
    }

    let res = app
        .clone()
        .oneshot(post(
            "/internal/privacy/erase",
            Some(PRIVACY_TOKEN),
            erase_body("platform", None, Some(&steam), None, false),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let counts = body_json(res).await["counts"].clone();
    assert_eq!(counts["bm_outbox"], 2, "{counts}");

    let row = |local: Uuid| {
        let owner = owner.clone();
        async move {
            sqlx::query_as::<_, (String, Option<String>, Value)>(
                "SELECT status, last_error, payload FROM bm_outbox WHERE local_id = $1",
            )
            .bind(local)
            .fetch_one(&owner)
            .await
            .expect("outbox row")
        }
    };
    let (status, last_error, payload) = row(pending_id).await;
    assert_eq!(status, "abandoned", "non-terminal row abandoned");
    assert_eq!(
        last_error.as_deref(),
        Some("payload swept by privacy erasure")
    );
    assert_eq!(payload, json!({}), "payload swept");
    let (status, last_error, payload) = row(done_id).await;
    assert_eq!(status, "done", "terminal row keeps its status");
    assert_eq!(last_error, None);
    assert_eq!(payload, json!({}), "payload still swept");
}

#[tokio::test]
async fn schema_inventory_oracle_covers_every_table() {
    let Some(state) = setup(None, None).await else {
        eprintln!("SKIP schema_inventory_oracle_covers_every_table: TEST_DATABASE_URL unset");
        return;
    };
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT table_name FROM information_schema.tables \
         WHERE table_schema = 'identity' AND table_type = 'BASE TABLE' ORDER BY table_name",
    )
    .fetch_all(&state.owner_pool)
    .await
    .expect("inventory");
    assert!(!tables.is_empty(), "identity schema has tables");
    let unclassified: Vec<&String> = tables
        .iter()
        .filter(|t| {
            !privacy::CLASSIFIED
                .iter()
                .any(|(name, _)| *name == t.as_str())
        })
        .collect();
    assert!(
        unclassified.is_empty(),
        "every identity table must take a privacy stance in privacy::CLASSIFIED \
         (decision B2); unclassified: {unclassified:?}"
    );
}
