//! End-to-end for the Phase 7 PR2 auth-side privacy coordinator: the worker
//! (fan-out to stubbed identity/tenant walkers + the in-process auth self-walk),
//! the export bundle (gzip, one-time download), the erase dry-run/confirm/real
//! flow, walker-failure handling (terse, identifier-free errors; bounded retry on
//! transient 5xx before the job goes terminal), the operator routes (permission
//! gate, identifier shape validation, forced tenant scope, cross-org 404), the player routes
//! (self-only, ownership 404, unconfigured 503), the decision B2 auth-schema
//! oracle, and the auth self-walk scope/idempotency semantics.
//!
//! The walkers are OTHER services, so integration here stubs them: an in-process
//! axum server per service (the tenant-service stub precedent) with the config
//! URLs pointed at it, and the worker driven via its public `tick_once`.
//!
//! Requires `TEST_DATABASE_URL`; skips (passes) when unset.

use axum::body::Body;
use axum::extract::State as AxumState;
use axum::http::{header, HeaderMap as AxumHeaderMap, Request, StatusCode};
use axum::routing::post;
use axum::{Json as AxumJson, Router};
use cupboard_auth::config::Config;
use cupboard_auth::domain::players;
use cupboard_auth::domain::privacy_walk::{self, Classification, Scope, Subject, CLASSIFIED};
use cupboard_auth::http;
use cupboard_auth::privacy_worker;
use cupboard_auth::state::AppState;
use cupboard_auth_core::{Claims, Keys, PlayerClaims, PlayerKeys};
use cupboard_domain::{OrgId, UserId};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::io::Read as _;
use std::sync::{Arc, Mutex};
use tokio::sync::OnceCell;
use tower::util::ServiceExt;
use uuid::Uuid;

// The player_login keypairs: two DISTINCT Ed25519 pairs, operator vs player.
const OP_PRIV: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEII8zWErrGLQRzYyEh7F35db4ICWItzbvYdtHgBNn4Xno\n-----END PRIVATE KEY-----\n";
const OP_PUB: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA18nW4fku7YaJR/+EY40xK+IKw9I6mV3/q9M5RO5ambs=\n-----END PUBLIC KEY-----\n";
const PL_PRIV: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIB4bpLkvqvLet9HkfrXIGKQph6XU067zAHuJxYeH1a5R\n-----END PRIVATE KEY-----\n";
const PL_PUB: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEABiCdFFe9fKX0ClAgGoy/N0wOewhkz55No6MQbFoKjtM=\n-----END PUBLIC KEY-----\n";

const PEPPER: &str = "test-pepper-privacy-coordinator";
const PRIVACY_TOKEN: &str = "priv_pr2_coordinator";
const SITE_HOST: &str = "acme.sites.test";

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
static MIGRATED: OnceCell<()> = OnceCell::const_new();

// The worker claim scans queued jobs globally, so every test that enqueues or ticks
// serializes on one lock (the wave-1 privacy.rs convention).
static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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

/// Queued/running leftovers would be claimed by this test's tick; clear them.
async fn clear_claimable_jobs(owner: &PgPool) {
    sqlx::query("DELETE FROM privacy_jobs WHERE status IN ('queued', 'running')")
        .execute(owner)
        .await
        .expect("clear claimable jobs");
}

// ============================ Walker stubs ============================

#[derive(Debug, Clone)]
struct StubCall {
    path: String,
    token: Option<String>,
    body: Value,
}

#[derive(Default)]
struct StubState {
    calls: Vec<StubCall>,
    export_body: Value,
    erase_counts: Value,
    fail_status: Option<u16>,
    /// `Some(n)`: fail the next n calls then succeed; `None`: fail every call
    /// (when `fail_status` is set).
    fail_remaining: Option<u32>,
}

/// One in-process walker stub (identity or tenant): records every call and answers
/// with the configured bodies, or the configured failure status.
struct WalkerStub {
    base_url: String,
    state: Arc<Mutex<StubState>>,
}

impl WalkerStub {
    async fn spawn(export_body: Value, erase_counts: Value) -> Self {
        let state = Arc::new(Mutex::new(StubState {
            export_body,
            erase_counts,
            ..Default::default()
        }));
        let record = |st: &Arc<Mutex<StubState>>,
                      path: &str,
                      headers: &AxumHeaderMap,
                      body: Value|
         -> Option<u16> {
            let mut st = st.lock().unwrap();
            st.calls.push(StubCall {
                path: path.to_string(),
                token: headers
                    .get("x-internal-token")
                    .and_then(|h| h.to_str().ok())
                    .map(str::to_string),
                body,
            });
            match (st.fail_status, st.fail_remaining) {
                (Some(code), None) => Some(code),
                (Some(code), Some(n)) if n > 0 => {
                    st.fail_remaining = Some(n - 1);
                    Some(code)
                }
                _ => None,
            }
        };
        let router = Router::new()
            .route(
                "/internal/privacy/export",
                post(
                    move |AxumState(s): AxumState<Arc<Mutex<StubState>>>,
                          headers: AxumHeaderMap,
                          AxumJson(body): AxumJson<Value>| async move {
                        if let Some(code) = record(&s, "export", &headers, body) {
                            return (
                                StatusCode::from_u16(code).unwrap(),
                                AxumJson(json!({"error": "stub failure"})),
                            );
                        }
                        let body = s.lock().unwrap().export_body.clone();
                        (StatusCode::OK, AxumJson(body))
                    },
                ),
            )
            .route(
                "/internal/privacy/erase",
                post(
                    move |AxumState(s): AxumState<Arc<Mutex<StubState>>>,
                          headers: AxumHeaderMap,
                          AxumJson(body): AxumJson<Value>| async move {
                        if let Some(code) = record(&s, "erase", &headers, body) {
                            return (
                                StatusCode::from_u16(code).unwrap(),
                                AxumJson(json!({"error": "stub failure"})),
                            );
                        }
                        let counts = s.lock().unwrap().erase_counts.clone();
                        (StatusCode::OK, AxumJson(json!({ "counts": counts })))
                    },
                ),
            )
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        WalkerStub { base_url, state }
    }

    fn calls(&self, path: &str) -> Vec<StubCall> {
        self.state
            .lock()
            .unwrap()
            .calls
            .iter()
            .filter(|c| c.path == path)
            .cloned()
            .collect()
    }

    fn fail_with(&self, status: u16) {
        self.state.lock().unwrap().fail_status = Some(status);
    }

    /// Fail the next `times` calls with `status`, then answer normally.
    fn fail_with_times(&self, status: u16, times: u32) {
        let mut st = self.state.lock().unwrap();
        st.fail_status = Some(status);
        st.fail_remaining = Some(times);
    }
}

// ============================ Harness ============================

fn test_state(
    owner: PgPool,
    identity_base: &str,
    tenant_base: &str,
    with_player_keys: bool,
) -> AppState {
    let config = Config {
        bind_addr: "127.0.0.1:0".into(),
        database_url: String::new(),
        database_url_app: String::new(),
        db_max_connections: 5,
        environment: "test".into(),
        otel_endpoint: None,
        jwt_private_key_pem: OP_PRIV.into(),
        jwt_public_key_pem: OP_PUB.into(),
        access_token_ttl_secs: 900,
        refresh_token_ttl_secs: 3600,
        token_pepper: PEPPER.into(),
        internal_api_token: None,
        plan_write_token: None,
        privacy_token: Some(PRIVACY_TOKEN.into()),
        identity_internal_url: identity_base.into(),
        tenant_internal_url: tenant_base.into(),
        public_base_url: "http://localhost:3000".into(),
        discord: None,
        cookie_signing_key: None,
        player: None,
        steam_web_api_key: None,
        privacy_worker_tick_secs: 15,
        retention_tick_secs: 3600,
        retention_sessions_days: 90,
        retention_invites_days: 30,
        retention_audit_days: 730,
    };
    AppState {
        owner_pool: owner.clone(),
        app_pool: owner,
        keys: Arc::new(Keys::from_ed_pem(OP_PRIV, OP_PUB).unwrap()),
        player_keys: with_player_keys
            .then(|| Arc::new(PlayerKeys::from_ed_pem(PL_PRIV, PL_PUB).unwrap())),
        config: Arc::new(config),
        http: reqwest::Client::new(),
        cookie_key: None,
    }
}

fn operator_token(org: Uuid, perms: &[&str]) -> String {
    let keys = Keys::from_ed_pem(OP_PRIV, OP_PUB).unwrap();
    let claims = Claims::new(
        UserId(Uuid::new_v4()),
        Uuid::new_v4(),
        Some(OrgId(org)),
        perms.iter().map(|p| p.to_string()).collect(),
        900,
    );
    keys.encode(&claims).unwrap()
}

fn player_token(player_id: Uuid) -> String {
    let keys = PlayerKeys::from_ed_pem(PL_PRIV, PL_PUB).unwrap();
    let claims = PlayerClaims::new(player_id, OrgId(Uuid::new_v4()), None, Uuid::new_v4(), 900);
    keys.encode(&claims).unwrap()
}

async fn send(
    state: &AppState,
    method: &str,
    path: &str,
    bearer: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let (status, _headers, bytes) = send_raw(state, method, path, bearer, body).await;
    let val = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, val)
}

async fn send_raw(
    state: &AppState,
    method: &str,
    path: &str,
    bearer: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let mut req = Request::builder().method(method).uri(path);
    if let Some(b) = bearer {
        req = req.header(header::AUTHORIZATION, format!("Bearer {b}"));
    }
    let req = match body {
        Some(j) => req
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(j.to_string()))
            .unwrap(),
        None => req.body(Body::empty()).unwrap(),
    };
    let resp = http::router(state.clone()).oneshot(req).await.unwrap();
    let status = resp.status();
    let headers = resp.headers().clone();
    let bytes = resp
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .to_vec();
    (status, headers, bytes)
}

/// Fresh, unique-per-test subject identifiers (tests share one database), shaped
/// like the real thing: a 17-digit SteamID64 and an 18-digit Discord snowflake
/// (the operator create route validates both shapes).
fn subject_ids() -> (String, String) {
    let n = Uuid::new_v4().as_u128();
    (
        format!("7656119{:010}", n % 10_000_000_000),
        format!("{:018}", n % 1_000_000_000_000_000_000),
    )
}

/// One player with both identities, plus a session (ip + user_agent), a login code,
/// a link code, and a link state in the given tenant.
async fn seed_player(owner: &PgPool, steam: &str, discord: &str, tenant: Uuid) -> Uuid {
    let player =
        players::resolve_or_create(owner, "steam", steam, Some("Subject"), Some("http://a"))
            .await
            .expect("create player");
    players::link_identity(owner, player.id, "discord", discord, Some("subj#1"), None)
        .await
        .expect("link discord");
    players::create_session(
        owner,
        player.id,
        tenant,
        SITE_HOST,
        Some("test-agent"),
        Some("203.0.113.9"),
        3600,
        PEPPER.as_bytes(),
    )
    .await
    .expect("create session");
    players::issue_login_code(
        owner,
        player.id,
        OrgId(tenant),
        SITE_HOST,
        Some(steam),
        PEPPER.as_bytes(),
    )
    .await
    .expect("login code");
    players::issue_link_code(
        owner,
        player.id,
        tenant,
        SITE_HOST,
        "discord",
        discord,
        None,
        None,
        PEPPER.as_bytes(),
    )
    .await
    .expect("link code");
    players::create_link_state(
        owner,
        player.id,
        OrgId(tenant),
        SITE_HOST,
        "discord",
        PEPPER.as_bytes(),
    )
    .await
    .expect("link state");
    player.id
}

fn identity_export_stub_body() -> Value {
    json!({
        "player_ids": [Uuid::new_v4()],
        "data": { "chat_messages": [{ "message": "hi" }], "player_sessions": [] },
    })
}

fn tenant_export_stub_body() -> Value {
    json!({ "data": { "tickets": [{ "subject": "s" }], "ticket_messages": [] } })
}

async fn spawn_stubs() -> (WalkerStub, WalkerStub) {
    let identity = WalkerStub::spawn(
        identity_export_stub_body(),
        json!({ "chat_messages": 3, "player_identifiers": 1 }),
    )
    .await;
    let tenant = WalkerStub::spawn(
        tenant_export_stub_body(),
        json!({ "tickets": 2, "ticket_messages": 2, "checkout_sessions": 0,
                "store_webhook_events": 0 }),
    )
    .await;
    (identity, tenant)
}

fn gunzip_json(bytes: &[u8]) -> Value {
    let mut decoder = flate2::read::GzDecoder::new(bytes);
    let mut out = Vec::new();
    decoder.read_to_end(&mut out).expect("gunzip");
    serde_json::from_slice(&out).expect("bundle json")
}

// ============================ Tests ============================

#[tokio::test]
async fn operator_export_flow_bundle_downloadable_exactly_once() {
    let Some(owner) = setup().await else {
        eprintln!("SKIP operator_export_flow...: TEST_DATABASE_URL unset");
        return;
    };
    let _guard = LOCK.lock().await;
    clear_claimable_jobs(&owner).await;
    let (identity, tenant_stub) = spawn_stubs().await;
    let st = test_state(
        owner.clone(),
        &identity.base_url,
        &tenant_stub.base_url,
        true,
    );
    let org = Uuid::new_v4();
    let (steam, discord) = subject_ids();
    let account = seed_player(&owner, &steam, &discord, org).await;
    let token = operator_token(org, &["players.erase"]);

    // Create names the subject by steam id ONLY: discord + account id must be
    // resolved server-side for the fan-out.
    let (status, job) = send(
        &st,
        "POST",
        "/auth/privacy/jobs",
        Some(&token),
        Some(json!({ "kind": "export", "steam_id": steam })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "create: {job}");
    assert_eq!(job["kind"], "export");
    assert_eq!(
        job["scope_kind"], "tenant",
        "operator jobs are tenant-scoped"
    );
    assert_eq!(
        job["tenant_id"],
        json!(org.to_string()),
        "scope org from claims"
    );
    assert_eq!(job["requested_via"], "operator");
    assert_eq!(job["status"], "queued");
    assert!(
        job.get("bundle").is_none(),
        "job JSON never carries the bundle"
    );
    let job_id: Uuid = job["id"].as_str().unwrap().parse().unwrap();

    let processed = privacy_worker::tick_once(&owner, &st.http, &st.config).await;
    assert_eq!(processed, 1, "the tick must process exactly this job");

    // Both walkers were called with the scoped token and the full resolved subject.
    for stub in [&identity, &tenant_stub] {
        let calls = stub.calls("export");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].token.as_deref(), Some(PRIVACY_TOKEN));
        assert_eq!(calls[0].body["scope_kind"], "tenant");
        assert_eq!(calls[0].body["tenant_id"], json!(org.to_string()));
        assert_eq!(calls[0].body["steam_id"], json!(steam));
        assert_eq!(
            calls[0].body["discord_id"],
            json!(discord),
            "discord must be resolved server-side from the linked identities"
        );
        assert_eq!(
            calls[0].body["player_account_id"],
            json!(account.to_string())
        );
    }

    // Completed, with per-service per-table row counts.
    let (status, job) = send(
        &st,
        "GET",
        &format!("/auth/privacy/jobs/{job_id}"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(job["status"], "completed", "job: {job}");
    let counts = &job["result_counts"];
    assert_eq!(counts["identity"]["chat_messages"], 1);
    assert_eq!(counts["tenant"]["tickets"], 1);
    assert_eq!(
        counts["auth"]["player_sessions"], 1,
        "the auth self-walk (tenant scope) counts the org's session"
    );

    // One-time download: gzip with the three service keys, walker bodies AS-IS.
    let (status, headers, bytes) = send_raw(
        &st,
        "GET",
        &format!("/auth/privacy/jobs/{job_id}/download"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers.get(header::CONTENT_TYPE).unwrap(),
        "application/gzip"
    );
    assert_eq!(
        headers.get(header::CONTENT_DISPOSITION).unwrap(),
        &format!("attachment; filename=\"privacy-export-{job_id}.json.gz\"")
    );
    let bundle = gunzip_json(&bytes);
    assert_eq!(
        bundle["identity"]["data"]["chat_messages"][0]["message"],
        "hi"
    );
    assert_eq!(bundle["tenant"]["data"]["tickets"][0]["subject"], "s");
    assert_eq!(
        bundle["auth"]["player_sessions"].as_array().unwrap().len(),
        1,
        "tenant-scope auth export ships the org's session rows: {bundle}"
    );
    assert!(
        bundle["auth"].get("player_identities").is_none(),
        "tenant scope excludes the global identity rows (decision A2)"
    );

    // The second take gets 410 Gone.
    let (status, _, _) = send_raw(
        &st,
        "GET",
        &format!("/auth/privacy/jobs/{job_id}/download"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::GONE, "the bundle is one-time");
}

#[tokio::test]
async fn player_erase_flow_dry_run_confirm_real_run() {
    let Some(owner) = setup().await else {
        eprintln!("SKIP player_erase_flow...: TEST_DATABASE_URL unset");
        return;
    };
    let _guard = LOCK.lock().await;
    clear_claimable_jobs(&owner).await;
    let (identity, tenant_stub) = spawn_stubs().await;
    let st = test_state(
        owner.clone(),
        &identity.base_url,
        &tenant_stub.base_url,
        true,
    );
    let tenant = Uuid::new_v4();
    let (steam, discord) = subject_ids();
    let account = seed_player(&owner, &steam, &discord, tenant).await;
    let token = player_token(account);

    // Self-serve erase; the body (with someone else's steam id) is IGNORED: the
    // subject is the verified claims sub only.
    let (status, job) = send(
        &st,
        "POST",
        "/auth/player/privacy/erase",
        Some(&token),
        Some(json!({ "steam_id": "76561198999999999", "tenant_id": tenant })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "create: {job}");
    assert_eq!(job["scope_kind"], "platform");
    assert_eq!(job["requested_via"], "player");
    assert_eq!(job["player_account_id"], json!(account.to_string()));
    assert_eq!(
        job["steam_id"],
        Value::Null,
        "body subject fields are ignored"
    );
    let job_id: Uuid = job["id"].as_str().unwrap().parse().unwrap();

    // Pass 1: dry run everywhere, parked awaiting_confirm with merged counts.
    assert_eq!(
        privacy_worker::tick_once(&owner, &st.http, &st.config).await,
        1
    );
    let (_, job) = send(
        &st,
        "GET",
        &format!("/auth/player/privacy/jobs/{job_id}"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(job["status"], "awaiting_confirm", "job: {job}");
    let dry = &job["dry_run_counts"];
    assert_eq!(dry["identity"]["chat_messages"], 3);
    assert_eq!(dry["tenant"]["tickets"], 2);
    assert_eq!(
        dry["auth"]["player_identities"], 2,
        "steam + discord identities"
    );
    assert_eq!(dry["auth"]["player_accounts"], 1);
    assert_eq!(dry["auth"]["player_sessions"], 1);
    for stub in [&identity, &tenant_stub] {
        let calls = stub.calls("erase");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].body["dry_run"], json!(true), "pass 1 is a dry run");
        assert_eq!(calls[0].body["scope_kind"], "platform");
        assert_eq!(
            calls[0].body["steam_id"],
            json!(steam),
            "resolved server-side"
        );
    }
    // The dry pass wrote nothing on the auth side.
    let identities: i64 =
        sqlx::query_scalar("SELECT count(*) FROM player_identities WHERE player_account_id = $1")
            .bind(account)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(identities, 2, "dry run must not delete identities");

    // Confirm re-queues; an immediate second confirm conflicts (status guard).
    let (status, confirmed) = send(
        &st,
        "POST",
        &format!("/auth/player/privacy/jobs/{job_id}/confirm"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "confirm: {confirmed}");
    assert_eq!(confirmed["status"], "queued");
    let (status, _) = send(
        &st,
        "POST",
        &format!("/auth/player/privacy/jobs/{job_id}/confirm"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "double confirm must 409");

    // Pass 2: the real run.
    assert_eq!(
        privacy_worker::tick_once(&owner, &st.http, &st.config).await,
        1
    );
    let (_, job) = send(
        &st,
        "GET",
        &format!("/auth/player/privacy/jobs/{job_id}"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(job["status"], "completed", "job: {job}");
    assert_eq!(job["result_counts"]["auth"]["player_identities"], 2);
    for stub in [&identity, &tenant_stub] {
        let calls = stub.calls("erase");
        assert_eq!(calls.len(), 2);
        assert_eq!(
            calls[1].body["dry_run"],
            json!(false),
            "pass 2 runs for real"
        );
    }

    // Decision B auth semantics: identities deleted, display/avatar NULLed,
    // sessions revoked AND scrubbed, code/state rows swept.
    let identities: i64 =
        sqlx::query_scalar("SELECT count(*) FROM player_identities WHERE player_account_id = $1")
            .bind(account)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(identities, 0, "identities are deleted");
    let (display, avatar): (Option<String>, Option<String>) =
        sqlx::query_as("SELECT display_name, avatar_url FROM player_accounts WHERE id = $1")
            .bind(account)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!((display, avatar), (None, None), "account profile is NULLed");
    type SessionRow = (
        Option<chrono::DateTime<chrono::Utc>>,
        Option<String>,
        Option<String>,
    );
    let sessions: Vec<SessionRow> = sqlx::query_as(
        "SELECT revoked_at, ip, user_agent FROM player_sessions WHERE player_account_id = $1",
    )
    .bind(account)
    .fetch_all(&owner)
    .await
    .unwrap();
    assert!(!sessions.is_empty());
    for (revoked_at, ip, user_agent) in sessions {
        assert!(revoked_at.is_some(), "sessions are revoked");
        assert_eq!((ip, user_agent), (None, None), "sessions are scrubbed");
    }
    for table in [
        "player_login_codes",
        "player_link_codes",
        "player_link_states",
    ] {
        let left: i64 = sqlx::query_scalar(&format!(
            "SELECT count(*) FROM {table} WHERE player_account_id = $1"
        ))
        .bind(account)
        .fetch_one(&owner)
        .await
        .unwrap();
        assert_eq!(left, 0, "{table} rows are swept");
    }
}

#[tokio::test]
async fn walker_persistent_failure_fails_job_after_three_attempts_with_terse_error() {
    let Some(owner) = setup().await else {
        eprintln!("SKIP walker_persistent_failure...: TEST_DATABASE_URL unset");
        return;
    };
    let _guard = LOCK.lock().await;
    clear_claimable_jobs(&owner).await;
    let (identity, tenant_stub) = spawn_stubs().await;
    identity.fail_with(500);
    let st = test_state(
        owner.clone(),
        &identity.base_url,
        &tenant_stub.base_url,
        true,
    );
    let org = Uuid::new_v4();
    let (steam, discord) = subject_ids();
    seed_player(&owner, &steam, &discord, org).await;
    let token = operator_token(org, &["players.erase"]);

    let (status, job) = send(
        &st,
        "POST",
        "/auth/privacy/jobs",
        Some(&token),
        Some(json!({ "kind": "export", "steam_id": steam })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let job_id: Uuid = job["id"].as_str().unwrap().parse().unwrap();

    // A 5xx is transient: the first two failures requeue (bumping attempts) and the
    // drain loop re-claims within the tick, so the always-failing walker is tried 3
    // times in total before the job goes terminal.
    assert_eq!(
        privacy_worker::tick_once(&owner, &st.http, &st.config).await,
        3,
        "initial attempt + 2 bounded retries, all in one tick"
    );
    assert_eq!(identity.calls("export").len(), 3);
    let (_, job) = send(
        &st,
        "GET",
        &format!("/auth/privacy/jobs/{job_id}"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(job["status"], "failed", "job: {job}");
    assert_eq!(job["attempts"], 2, "both retries were spent");
    let error = job["error"].as_str().unwrap();
    assert_eq!(error, "identity export returned status 500");
    assert!(
        !error.contains(&steam) && !error.contains(&discord),
        "the stored error must never carry raw identifiers: {error}"
    );

    // A later tick finds nothing to do: the failed job is terminal, not requeued.
    assert_eq!(
        privacy_worker::tick_once(&owner, &st.http, &st.config).await,
        0
    );
}

#[tokio::test]
async fn walker_transient_failure_retries_then_succeeds() {
    let Some(owner) = setup().await else {
        eprintln!("SKIP walker_transient_failure_retries...: TEST_DATABASE_URL unset");
        return;
    };
    let _guard = LOCK.lock().await;
    clear_claimable_jobs(&owner).await;
    let (identity, tenant_stub) = spawn_stubs().await;
    // The identity walker 500s twice, then recovers: the bounded retry (walkers are
    // idempotent, decision D(5)) must carry the job to completion.
    identity.fail_with_times(500, 2);
    let st = test_state(
        owner.clone(),
        &identity.base_url,
        &tenant_stub.base_url,
        true,
    );
    let org = Uuid::new_v4();
    let (steam, discord) = subject_ids();
    seed_player(&owner, &steam, &discord, org).await;
    let token = operator_token(org, &["players.erase"]);

    let (status, job) = send(
        &st,
        "POST",
        "/auth/privacy/jobs",
        Some(&token),
        Some(json!({ "kind": "export", "steam_id": steam })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let job_id: Uuid = job["id"].as_str().unwrap().parse().unwrap();

    assert_eq!(
        privacy_worker::tick_once(&owner, &st.http, &st.config).await,
        3,
        "two failed attempts requeue and the third completes, all in one tick"
    );
    assert_eq!(identity.calls("export").len(), 3, "500, 500, then 200");
    let (_, job) = send(
        &st,
        "GET",
        &format!("/auth/privacy/jobs/{job_id}"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(job["status"], "completed", "job: {job}");
    assert_eq!(job["attempts"], 2);
    assert_eq!(job["error"], Value::Null, "no error survives a recovery");
    assert_eq!(job["result_counts"]["tenant"]["tickets"], 1);

    // The bundle from the successful pass downloads normally.
    let (status, _, bytes) = send_raw(
        &st,
        "GET",
        &format!("/auth/privacy/jobs/{job_id}/download"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let bundle = gunzip_json(&bytes);
    assert_eq!(bundle["tenant"]["data"]["tickets"][0]["subject"], "s");
}

#[tokio::test]
async fn operator_routes_gate_permission_scope_and_org() {
    let Some(owner) = setup().await else {
        eprintln!("SKIP operator_routes_gate...: TEST_DATABASE_URL unset");
        return;
    };
    let _guard = LOCK.lock().await;
    let (identity, tenant_stub) = spawn_stubs().await;
    let st = test_state(
        owner.clone(),
        &identity.base_url,
        &tenant_stub.base_url,
        true,
    );
    let org_a = Uuid::new_v4();
    let org_b = Uuid::new_v4();
    let (steam, _) = subject_ids();

    // Missing players.erase: 403 on every operator route.
    let ungated = operator_token(org_a, &["players.view"]);
    for (method, path) in [
        ("POST", "/auth/privacy/jobs".to_string()),
        ("GET", "/auth/privacy/jobs".to_string()),
        ("GET", format!("/auth/privacy/jobs/{}", Uuid::new_v4())),
        (
            "POST",
            format!("/auth/privacy/jobs/{}/confirm", Uuid::new_v4()),
        ),
        (
            "GET",
            format!("/auth/privacy/jobs/{}/download", Uuid::new_v4()),
        ),
    ] {
        let body = (method == "POST" && path == "/auth/privacy/jobs")
            .then(|| json!({ "kind": "export", "steam_id": steam }));
        let (status, _) = send(&st, method, &path, Some(&ungated), body).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path} must 403");
    }

    // Bad shapes: unknown kind, no subject at all.
    let gated_a = operator_token(org_a, &["players.erase"]);
    let (status, _) = send(
        &st,
        "POST",
        "/auth/privacy/jobs",
        Some(&gated_a),
        Some(json!({ "kind": "purge", "steam_id": steam })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = send(
        &st,
        "POST",
        "/auth/privacy/jobs",
        Some(&gated_a),
        Some(json!({ "kind": "export", "steam_id": "   " })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "whitespace subject is absent"
    );

    // Identifier shape validation: steam must be exactly 17 ASCII digits, discord
    // 15-21 ASCII digits; anything else is a 400, not a garbage fan-out.
    for bad in [
        json!({ "kind": "export", "steam_id": "7656119800000000" }), // 16 digits
        json!({ "kind": "export", "steam_id": "765611980000000012" }), // 18 digits
        json!({ "kind": "export", "steam_id": "7656119800000000x" }), // non-digit
        json!({ "kind": "export", "discord_id": "12345678901234" }), // 14 digits
        json!({ "kind": "export", "discord_id": "1234567890123456789012" }), // 22 digits
        json!({ "kind": "export", "discord_id": "1234567890123456a" }), // non-digit
    ] {
        let (status, body) = send(
            &st,
            "POST",
            "/auth/privacy/jobs",
            Some(&gated_a),
            Some(bad.clone()),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "malformed identifier must 400: {bad}"
        );
        let message = body["message"].as_str().unwrap_or_default();
        assert!(
            message.contains("digit"),
            "the 400 must say what shape is expected: {body}"
        );
    }

    // The scope is NEVER client-supplied: tenant_id/scope_kind in the body are
    // rejected outright (deny_unknown_fields), not silently accepted.
    for field in ["tenant_id", "scope_kind"] {
        let mut body = json!({ "kind": "export", "steam_id": steam });
        body[field] = json!(org_b.to_string());
        let (status, _) = send(
            &st,
            "POST",
            "/auth/privacy/jobs",
            Some(&gated_a),
            Some(body),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "a body {field} must be rejected"
        );
    }

    // A well-formed create lands scoped to the claims org.
    let (status, job) = send(
        &st,
        "POST",
        "/auth/privacy/jobs",
        Some(&gated_a),
        Some(json!({ "kind": "export", "steam_id": steam })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(job["tenant_id"], json!(org_a.to_string()));
    let job_id: Uuid = job["id"].as_str().unwrap().parse().unwrap();

    // Org A sees it in the listing; org B sees neither the listing entry nor the job.
    let (status, listed) = send(&st, "GET", "/auth/privacy/jobs", Some(&gated_a), None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        listed
            .as_array()
            .unwrap()
            .iter()
            .any(|j| j["id"] == json!(job_id.to_string())),
        "org A must list its own job"
    );
    let gated_b = operator_token(org_b, &["players.erase"]);
    let (_, listed_b) = send(&st, "GET", "/auth/privacy/jobs", Some(&gated_b), None).await;
    assert!(
        !listed_b
            .as_array()
            .unwrap()
            .iter()
            .any(|j| j["id"] == json!(job_id.to_string())),
        "org B must not list org A's job"
    );
    for (method, path) in [
        ("GET", format!("/auth/privacy/jobs/{job_id}")),
        ("POST", format!("/auth/privacy/jobs/{job_id}/confirm")),
        ("GET", format!("/auth/privacy/jobs/{job_id}/download")),
    ] {
        let (status, _) = send(&st, method, &path, Some(&gated_b), None).await;
        assert_eq!(
            status,
            StatusCode::NOT_FOUND,
            "cross-org {method} {path} must 404"
        );
    }

    // For the rightful org the queued job's download is 410 (no bundle yet): the
    // org check runs first and cross-org stays a 404, never an existence oracle.
    let (status, _) = send(
        &st,
        "GET",
        &format!("/auth/privacy/jobs/{job_id}/download"),
        Some(&gated_a),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::GONE);

    sqlx::query("DELETE FROM privacy_jobs WHERE id = $1")
        .bind(job_id)
        .execute(&owner)
        .await
        .expect("cleanup");
}

#[tokio::test]
async fn player_routes_are_self_only_and_503_when_unconfigured() {
    let Some(owner) = setup().await else {
        eprintln!("SKIP player_routes_are_self_only...: TEST_DATABASE_URL unset");
        return;
    };
    let _guard = LOCK.lock().await;
    let (identity, tenant_stub) = spawn_stubs().await;

    // Unconfigured player auth: every player privacy route is 503.
    let unconfigured = test_state(
        owner.clone(),
        &identity.base_url,
        &tenant_stub.base_url,
        false,
    );
    let (a_steam, a_discord) = subject_ids();
    let tenant = Uuid::new_v4();
    let player_a = seed_player(&owner, &a_steam, &a_discord, tenant).await;
    let token_a = player_token(player_a);
    for (method, path) in [
        ("POST", "/auth/player/privacy/export".to_string()),
        ("POST", "/auth/player/privacy/erase".to_string()),
        ("GET", "/auth/player/privacy/jobs".to_string()),
        (
            "GET",
            format!("/auth/player/privacy/jobs/{}", Uuid::new_v4()),
        ),
    ] {
        let (status, _) = send(&unconfigured, method, &path, Some(&token_a), None).await;
        assert_eq!(
            status,
            StatusCode::SERVICE_UNAVAILABLE,
            "{method} {path} must 503"
        );
    }

    let st = test_state(
        owner.clone(),
        &identity.base_url,
        &tenant_stub.base_url,
        true,
    );

    // An operator token is rejected by the player keypair.
    let op = operator_token(tenant, &["players.erase"]);
    let (status, _) = send(&st, "GET", "/auth/player/privacy/jobs", Some(&op), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Player A creates a self job; it is platform-scoped and self-subject.
    let (status, job) = send(
        &st,
        "POST",
        "/auth/player/privacy/export",
        Some(&token_a),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "create: {job}");
    assert_eq!(job["player_account_id"], json!(player_a.to_string()));
    assert_eq!(job["scope_kind"], "platform");
    let job_id: Uuid = job["id"].as_str().unwrap().parse().unwrap();
    let (_, listed) = send(
        &st,
        "GET",
        "/auth/player/privacy/jobs",
        Some(&token_a),
        None,
    )
    .await;
    assert!(listed
        .as_array()
        .unwrap()
        .iter()
        .any(|j| j["id"] == json!(job_id.to_string())));

    // Player B never sees player A's job.
    let (b_steam, b_discord) = subject_ids();
    let player_b = seed_player(&owner, &b_steam, &b_discord, tenant).await;
    let token_b = player_token(player_b);
    for (method, path) in [
        ("GET", format!("/auth/player/privacy/jobs/{job_id}")),
        (
            "POST",
            format!("/auth/player/privacy/jobs/{job_id}/confirm"),
        ),
        (
            "GET",
            format!("/auth/player/privacy/jobs/{job_id}/download"),
        ),
    ] {
        let (status, _) = send(&st, method, &path, Some(&token_b), None).await;
        assert_eq!(
            status,
            StatusCode::NOT_FOUND,
            "{method} {path} must 404 for player B"
        );
    }
    let (_, listed_b) = send(
        &st,
        "GET",
        "/auth/player/privacy/jobs",
        Some(&token_b),
        None,
    )
    .await;
    assert!(listed_b.as_array().unwrap().is_empty());

    // An OPERATOR-requested job about player A is invisible on the player surface
    // (requested_via must be 'player').
    let (status, op_job) = send(
        &st,
        "POST",
        "/auth/privacy/jobs",
        Some(&op),
        Some(json!({ "kind": "export", "player_account_id": player_a })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let op_job_id = op_job["id"].as_str().unwrap();
    let (status, _) = send(
        &st,
        "GET",
        &format!("/auth/player/privacy/jobs/{op_job_id}"),
        Some(&token_a),
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "operator jobs never surface on the player routes"
    );

    sqlx::query("DELETE FROM privacy_jobs WHERE id IN ($1, $2::uuid)")
        .bind(job_id)
        .bind(Uuid::parse_str(op_job_id).unwrap())
        .execute(&owner)
        .await
        .expect("cleanup");
}

/// Decision B2: every auth-schema table must hold an explicit privacy stance; a
/// migration adding a table without classifying it fails here, as does a stale
/// entry for a dropped table.
#[tokio::test]
async fn every_auth_table_is_classified() {
    let Some(owner) = setup().await else {
        eprintln!("SKIP every_auth_table_is_classified: TEST_DATABASE_URL unset");
        return;
    };
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT table_name::text FROM information_schema.tables \
         WHERE table_schema = 'auth' AND table_type = 'BASE TABLE'",
    )
    .fetch_all(&owner)
    .await
    .unwrap();
    assert!(!tables.is_empty(), "the auth schema must exist");

    for table in &tables {
        assert!(
            CLASSIFIED.iter().any(|(name, _)| name == table),
            "UNCLASSIFIED auth table `{table}`: every table must be classified \
             Walked / NoPlayerData / RetainedWithBasis in domain::privacy_walk::CLASSIFIED \
             (decision B2), and the walk updated if it holds player data"
        );
    }
    for (name, _) in CLASSIFIED {
        assert!(
            tables.iter().any(|t| t == name),
            "stale CLASSIFIED entry `{name}`: no such table in the auth schema"
        );
    }
    // The pinned stances the walk depends on.
    let stance = |n: &str| CLASSIFIED.iter().find(|(name, _)| *name == n).unwrap().1;
    assert_eq!(stance("player_accounts"), Classification::Walked);
    assert_eq!(stance("player_identities"), Classification::Walked);
    assert_eq!(stance("player_sessions"), Classification::Walked);
    assert_eq!(stance("users"), Classification::NoPlayerData);
    assert_eq!(stance("audit_log"), Classification::RetainedWithBasis);
    assert_eq!(stance("privacy_jobs"), Classification::RetainedWithBasis);
}

#[tokio::test]
async fn auth_walk_scope_containment_and_idempotency() {
    let Some(owner) = setup().await else {
        eprintln!("SKIP auth_walk_scope...: TEST_DATABASE_URL unset");
        return;
    };
    let tenant_a = Uuid::new_v4();
    let tenant_b = Uuid::new_v4();
    let (steam, discord) = subject_ids();
    let account = seed_player(&owner, &steam, &discord, tenant_a).await;
    // A second session (with PII) plus codes in tenant B.
    players::create_session(
        &owner,
        account,
        tenant_b,
        "other.sites.test",
        Some("agent-b"),
        Some("198.51.100.7"),
        3600,
        PEPPER.as_bytes(),
    )
    .await
    .unwrap();
    players::issue_login_code(
        &owner,
        account,
        OrgId(tenant_b),
        "other.sites.test",
        Some(&steam),
        PEPPER.as_bytes(),
    )
    .await
    .unwrap();
    let subject = Subject {
        steam_id: Some(steam.clone()),
        discord_id: None,
        player_account_id: None,
    };

    // Platform export: all three keys, raw session PII included.
    let data = privacy_walk::export(&owner, Scope::Platform, &subject)
        .await
        .unwrap();
    assert_eq!(data["player_accounts"].as_array().unwrap().len(), 1);
    assert_eq!(data["player_identities"].as_array().unwrap().len(), 2);
    assert_eq!(data["player_sessions"].as_array().unwrap().len(), 2);
    assert!(
        data["player_sessions"].to_string().contains("203.0.113.9"),
        "export ships the raw ip (the access right covers everything held)"
    );

    // Tenant-scope export: sessions only, that tenant's rows only.
    let data = privacy_walk::export(&owner, Scope::Tenant(tenant_a), &subject)
        .await
        .unwrap();
    assert!(data.get("player_accounts").is_none());
    assert!(data.get("player_identities").is_none());
    let sessions = data["player_sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["tenant_id"], json!(tenant_a.to_string()));

    // Tenant-scope erase: global rows untouched, tenant B's session untouched.
    let counts = privacy_walk::erase(&owner, Scope::Tenant(tenant_a), &subject, false)
        .await
        .unwrap();
    assert_eq!(
        (counts.player_accounts, counts.player_identities),
        (0, 0),
        "tenant scope never touches the global person graph (decision A2)"
    );
    assert_eq!(counts.player_sessions, 1);
    assert_eq!(counts.player_login_codes, 1);
    let identities: i64 =
        sqlx::query_scalar("SELECT count(*) FROM player_identities WHERE player_account_id = $1")
            .bind(account)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(identities, 2, "identities survive a tenant-scoped erasure");
    let b_ip: Option<String> = sqlx::query_scalar(
        "SELECT ip FROM player_sessions WHERE player_account_id = $1 AND tenant_id = $2",
    )
    .bind(account)
    .bind(tenant_b)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(
        b_ip.as_deref(),
        Some("198.51.100.7"),
        "tenant B is untouched"
    );

    // Platform dry run: counts the remaining blast radius, writes nothing.
    let dry = privacy_walk::erase(&owner, Scope::Platform, &subject, true)
        .await
        .unwrap();
    assert_eq!(dry.player_identities, 2);
    assert_eq!(dry.player_accounts, 1);
    assert_eq!(
        dry.player_sessions, 1,
        "only tenant B's session still has PII"
    );
    let display: Option<String> =
        sqlx::query_scalar("SELECT display_name FROM player_accounts WHERE id = $1")
            .bind(account)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert!(display.is_some(), "a dry run writes nothing");
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE action = 'player.erase' AND target_id = $1",
    )
    .bind(account)
    .fetch_one(&owner)
    .await
    .unwrap();
    // One audit row exists from the real tenant-scope erase above; the dry run must
    // not have added another.
    assert_eq!(audits, 1, "a dry run writes NOTHING, audit included");

    // Platform real run, then the idempotent re-run counts zero everywhere.
    let real = privacy_walk::erase(&owner, Scope::Platform, &subject, false)
        .await
        .unwrap();
    assert_eq!(real.player_identities, 2);
    assert_eq!(real.player_accounts, 1);
    // Resolution now needs the account id: the identities were just deleted.
    let by_account = Subject {
        steam_id: None,
        discord_id: None,
        player_account_id: Some(account),
    };
    let again = privacy_walk::erase(&owner, Scope::Platform, &by_account, false)
        .await
        .unwrap();
    assert_eq!(
        (
            again.player_accounts,
            again.player_identities,
            again.player_sessions,
            again.player_login_codes,
            again.player_link_codes,
            again.player_link_states,
        ),
        (0, 0, 0, 0, 0, 0),
        "a re-run is a guarded no-op"
    );

    // The real-run audit rows carry no raw identifiers.
    let metadatas: Vec<Value> = sqlx::query_scalar(
        "SELECT metadata FROM audit_log WHERE action = 'player.erase' AND target_id = $1",
    )
    .bind(account)
    .fetch_all(&owner)
    .await
    .unwrap();
    assert!(!metadatas.is_empty());
    for m in metadatas {
        let text = m.to_string();
        assert!(
            !text.contains(&steam) && !text.contains(&discord),
            "audit metadata must never carry raw identifiers: {text}"
        );
    }
}
