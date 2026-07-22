//! Integration test for Phase 5 PR3 player login: the one-time-code handoff and player
//! session lifecycle driven through the real router, plus the security-critical proof
//! that operator and player tokens are mutually rejected. The Steam OpenID callback
//! itself needs Steam's `check_authentication` (network), so this seeds the player +
//! login code via the domain layer (exactly what a verified callback would produce) and
//! exercises everything downstream of that.
//!
//! Requires `TEST_DATABASE_URL`(_APP); skips (passes) when unset.

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use cupboard_auth_core::{Keys, PlayerKeys};
use cupboard_domain::OrgId;
use http_body_util::BodyExt;
use sqlx::PgPool;
use std::sync::Arc;
use tokio::sync::OnceCell;
use tower::util::ServiceExt;
use uuid::Uuid;

use cupboard_auth::config::{Config, PlayerAuthConfig};
use cupboard_auth::domain::players;
use cupboard_auth::http;
use cupboard_auth::state::AppState;

// Two DISTINCT Ed25519 keypairs (openssl genpkey): operator vs player. Their disjointness
// is the security boundary this test asserts end to end.
const OP_PRIV: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEII8zWErrGLQRzYyEh7F35db4ICWItzbvYdtHgBNn4Xno\n-----END PRIVATE KEY-----\n";
const OP_PUB: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA18nW4fku7YaJR/+EY40xK+IKw9I6mV3/q9M5RO5ambs=\n-----END PUBLIC KEY-----\n";
const PL_PRIV: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIB4bpLkvqvLet9HkfrXIGKQph6XU067zAHuJxYeH1a5R\n-----END PRIVATE KEY-----\n";
const PL_PUB: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEABiCdFFe9fKX0ClAgGoy/N0wOewhkz55No6MQbFoKjtM=\n-----END PUBLIC KEY-----\n";

const PEPPER: &str = "test-pepper-player-login";
const SITE_HOST: &str = "acme.sites.test";

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
static MIGRATED: OnceCell<()> = OnceCell::const_new();

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

fn test_state(owner: PgPool) -> AppState {
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
        privacy_token: None,
        identity_internal_url: "http://127.0.0.1:8083".into(),
        public_base_url: "http://localhost:3000".into(),
        discord: None,
        cookie_signing_key: None,
        player: Some(PlayerAuthConfig {
            jwt_private_key_pem: PL_PRIV.into(),
            jwt_public_key_pem: PL_PUB.into(),
            callback_base_url: "https://cupboard-login.test".into(),
            // The exchange/me/refresh/logout tests seed the login code directly (the
            // Steam callback, which is what calls the tenant service, needs network);
            // these fields are unused on those paths.
            tenant_internal_url: "http://tenant.invalid".into(),
            internal_api_token: "test-internal-token".into(),
        }),
        steam_web_api_key: None,
        retention_tick_secs: 3600,
        retention_sessions_days: 90,
        retention_invites_days: 30,
        retention_audit_days: 730,
    };
    AppState {
        owner_pool: owner.clone(),
        app_pool: owner,
        keys: Arc::new(Keys::from_ed_pem(OP_PRIV, OP_PUB).unwrap()),
        player_keys: Some(Arc::new(PlayerKeys::from_ed_pem(PL_PRIV, PL_PUB).unwrap())),
        config: Arc::new(config),
        http: reqwest::Client::new(),
        cookie_key: None,
    }
}

async fn send(
    state: &AppState,
    method: &str,
    path: &str,
    bearer: Option<&str>,
    body: Option<serde_json::Value>,
) -> (StatusCode, serde_json::Value) {
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
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let val = if bytes.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
    };
    (status, val)
}

/// Produce a player + one-time login code as a verified Steam callback would.
async fn seed_login_code(owner: &PgPool, steam_id: &str) -> (Uuid, Uuid, String) {
    let tenant = Uuid::new_v4();
    let player = players::resolve_or_create(owner, "steam", steam_id, Some("Tester"), None)
        .await
        .expect("resolve player");
    let code = players::issue_login_code(
        owner,
        player.id,
        OrgId(tenant),
        SITE_HOST,
        Some(steam_id),
        PEPPER.as_bytes(),
    )
    .await
    .expect("issue code");
    (player.id, tenant, code)
}

#[tokio::test]
async fn otc_exchange_me_refresh_logout_flow() {
    let Some(owner) = setup().await else {
        eprintln!("SKIP otc_exchange_me_refresh_logout_flow: TEST_DATABASE_URL unset");
        return;
    };
    let state = test_state(owner.clone());
    let steam_id = format!("7656119{:010}", rand_suffix());
    let (player_id, tenant, code) = seed_login_code(&owner, &steam_id).await;

    // Exchange the code for a session.
    let (status, body) = send(
        &state,
        "POST",
        "/auth/player/exchange",
        None,
        Some(serde_json::json!({ "code": code, "site_host": SITE_HOST })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "exchange failed: {body}");
    let access = body["access_token"].as_str().unwrap().to_string();
    let refresh = body["refresh_token"].as_str().unwrap().to_string();
    assert_eq!(
        body["player"]["id"].as_str().unwrap(),
        player_id.to_string()
    );

    // The same code cannot be redeemed twice (single-use).
    let (status, _) = send(
        &state,
        "POST",
        "/auth/player/exchange",
        None,
        Some(serde_json::json!({ "code": code, "site_host": SITE_HOST })),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "code must be single-use");

    // /auth/player/me returns the profile + the tenant + steam id from the token.
    let (status, body) = send(&state, "GET", "/auth/player/me", Some(&access), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["player"]["steam_id"].as_str().unwrap(), steam_id);
    assert_eq!(
        body["player"]["tenant"].as_str().unwrap(),
        tenant.to_string()
    );

    // Refresh mints a new access token.
    let (status, body) = send(
        &state,
        "POST",
        "/auth/player/refresh",
        None,
        Some(serde_json::json!({ "refresh_token": refresh })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["access_token"].as_str().is_some());

    // Logout revokes the session; refresh then fails.
    let (status, _) = send(
        &state,
        "POST",
        "/auth/player/logout",
        None,
        Some(serde_json::json!({ "refresh_token": refresh })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = send(
        &state,
        "POST",
        "/auth/player/refresh",
        None,
        Some(serde_json::json!({ "refresh_token": refresh })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "revoked session cannot refresh"
    );
}

#[tokio::test]
async fn login_code_is_host_bound() {
    let Some(owner) = setup().await else {
        eprintln!("SKIP login_code_is_host_bound: TEST_DATABASE_URL unset");
        return;
    };
    let state = test_state(owner.clone());
    let steam_id = format!("7656119{:010}", rand_suffix());
    let (_player, _tenant, code) = seed_login_code(&owner, &steam_id).await;

    // Redeeming for a DIFFERENT host must fail even with the right code.
    let (status, _) = send(
        &state,
        "POST",
        "/auth/player/exchange",
        None,
        Some(serde_json::json!({ "code": code, "site_host": "evil.sites.test" })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "code is bound to its host"
    );
}

#[tokio::test]
async fn operator_and_player_tokens_are_mutually_rejected() {
    let Some(owner) = setup().await else {
        eprintln!("SKIP operator_and_player_tokens_are_mutually_rejected: TEST_DATABASE_URL unset");
        return;
    };
    let state = test_state(owner.clone());
    let steam_id = format!("7656119{:010}", rand_suffix());
    let (_player, _tenant, code) = seed_login_code(&owner, &steam_id).await;

    // Mint a real player token via exchange.
    let (_s, body) = send(
        &state,
        "POST",
        "/auth/player/exchange",
        None,
        Some(serde_json::json!({ "code": code, "site_host": SITE_HOST })),
    )
    .await;
    let player_token = body["access_token"].as_str().unwrap().to_string();

    // A player token must NOT be accepted by the operator surface (/auth/me).
    let (status, _) = send(&state, "GET", "/auth/me", Some(&player_token), None).await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "operator endpoint must reject a player token"
    );

    // An operator token (signed with the operator key) must NOT be accepted by the
    // player surface (/auth/player/me).
    let op_signer = Keys::from_ed_pem(OP_PRIV, OP_PUB).unwrap();
    let op_claims = cupboard_auth_core::Claims::new(
        cupboard_domain::UserId(Uuid::new_v4()),
        Uuid::new_v4(),
        Some(OrgId(Uuid::new_v4())),
        vec![],
        900,
    );
    let op_token = op_signer.encode(&op_claims).unwrap();
    let (status, _) = send(&state, "GET", "/auth/player/me", Some(&op_token), None).await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "player endpoint must reject an operator token"
    );
}

/// PR7 player Discord link: the single-use link-state and the link-identity rules
/// (idempotent re-link, global uniqueness per provider) at the domain layer.
#[tokio::test]
async fn discord_link_state_and_identity_rules() {
    let Some(owner) = setup().await else {
        eprintln!("SKIP discord_link_state_and_identity_rules: TEST_DATABASE_URL unset");
        return;
    };
    let pepper = PEPPER.as_bytes();
    let steam_id = format!("7656119{}", rand_suffix());
    let player = players::resolve_or_create(&owner, "steam", &steam_id, Some("P"), None)
        .await
        .unwrap();
    let tenant = OrgId(Uuid::new_v4());

    // Link-state is single-use.
    let st = players::create_link_state(&owner, player.id, tenant, SITE_HOST, "discord", pepper)
        .await
        .unwrap();
    let redeemed = players::redeem_link_state(&owner, &st, "discord", pepper)
        .await
        .unwrap();
    assert_eq!(redeemed.player_account_id, player.id);
    assert_eq!(redeemed.site_host, SITE_HOST);
    assert!(
        players::redeem_link_state(&owner, &st, "discord", pepper)
            .await
            .is_err(),
        "a link-state must not be redeemable twice"
    );

    // Linking Discord is idempotent for the same id (no duplicate identity row)...
    let discord_a = format!("d{}", rand_suffix());
    players::link_identity(&owner, player.id, "discord", &discord_a, Some("a"), None)
        .await
        .unwrap();
    players::link_identity(&owner, player.id, "discord", &discord_a, Some("a2"), None)
        .await
        .unwrap();
    // ...and re-linking a DIFFERENT Discord REPLACES the prior one (one per provider).
    let discord_b = format!("d{}", rand_suffix());
    players::link_identity(&owner, player.id, "discord", &discord_b, Some("b"), None)
        .await
        .unwrap();
    let identities = players::list_identities(&owner, player.id).await.unwrap();
    assert!(identities
        .iter()
        .any(|(p, s, _)| p == "steam" && s == &steam_id));
    let discord: Vec<_> = identities
        .iter()
        .filter(|(p, _, _)| p == "discord")
        .collect();
    assert_eq!(discord.len(), 1, "exactly one Discord identity per account");
    assert_eq!(
        discord[0].1, discord_b,
        "the newest link replaces the prior"
    );

    // The current Discord id cannot be linked to a DIFFERENT player (global uniqueness),
    // and the map to Conflict is race-safe (atomic upsert, no raw 23505 -> 500).
    let other = players::resolve_or_create(
        &owner,
        "steam",
        &format!("7656119{}", rand_suffix()),
        None,
        None,
    )
    .await
    .unwrap();
    let err = players::link_identity(&owner, other.id, "discord", &discord_b, None, None)
        .await
        .unwrap_err();
    assert!(
        matches!(err, cupboard_auth::error::AppError::Conflict(_)),
        "a Discord id already linked elsewhere must conflict"
    );

    // The one-time link code (the CSRF-fix handoff) is single-use and carries the identity.
    let code = players::issue_link_code(
        &owner,
        player.id,
        tenant.0,
        SITE_HOST,
        "discord",
        &discord_b,
        Some("b"),
        None,
        pepper,
    )
    .await
    .unwrap();
    let rc = players::redeem_link_code(&owner, &code, pepper)
        .await
        .unwrap();
    assert_eq!(rc.player_account_id, player.id);
    assert_eq!(rc.subject, discord_b);
    assert_eq!(rc.tenant_id, tenant.0);
    assert!(
        players::redeem_link_code(&owner, &code, pepper)
            .await
            .is_err(),
        "a link code must not be redeemable twice"
    );
}

// A cheap unique-ish suffix without pulling `rand` into the test (Uuid is already a dep).
fn rand_suffix() -> u64 {
    let u = Uuid::new_v4().as_u128();
    (u as u64) % 10_000_000_000
}
