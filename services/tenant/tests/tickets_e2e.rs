//! End-to-end for Phase 6 PR3 (tickets, web-only): the player + operator surfaces on
//! the real router, the ban-appeal link against an in-process identity stub
//! (injectable `identity_internal_url`), player/tenant isolation, internal-note
//! exclusion, reopen-on-player-message, and the post-commit `cupboard:tickets`
//! publishes (asserted against a real Redis via `TEST_REDIS_URL` XRANGE; those
//! assertions skip-print without it, everything else still runs).
//!
//! Requires TEST_DATABASE_URL(_APP); skips (passes) when unset.

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, Request, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use cupboard_auth_core::{Claims, Keys, PlayerClaims, PlayerKeys};
use cupboard_domain::{OrgId, UserId};
use cupboard_tenant::cache::SiteCache;
use cupboard_tenant::config::Config;
use cupboard_tenant::domain::tickets;
use cupboard_tenant::http;
use cupboard_tenant::state::AppState;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::OnceCell;
use tower::util::ServiceExt;
use uuid::Uuid;

// Test-only operator Ed25519 keypair (the billing_e2e throwaway pair).
const OP_PRIV: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIKfwTrhSm/f0QxY6e5mzQ+iTAvdyp3omCt4lyOjWItDm\n-----END PRIVATE KEY-----\n";
const OP_PUB: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAyKMiwFH0hHn4HiPl8DTEq+aPzW9XyzG5v1ELTEVNsbY=\n-----END PUBLIC KEY-----\n";
// Test-only player keypair (the checkout_webhook_e2e throwaway pair), disjoint from the
// operator one.
const PL_PRIV: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIB4bpLkvqvLet9HkfrXIGKQph6XU067zAHuJxYeH1a5R\n-----END PRIVATE KEY-----\n";
const PL_PUB: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEABiCdFFe9fKX0ClAgGoy/N0wOewhkz55No6MQbFoKjtM=\n-----END PUBLIC KEY-----\n";

const INTERNAL_TOKEN: &str = "int_pr3_tickets";
const BOT_TOKEN: &str = "bot_pr4_distinct";

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
static MIGRATED: OnceCell<()> = OnceCell::const_new();

async fn setup() -> Option<(PgPool, PgPool)> {
    let owner_url = std::env::var("TEST_DATABASE_URL").ok()?;
    let app_url = std::env::var("TEST_DATABASE_URL_APP").unwrap_or_else(|_| owner_url.clone());
    let owner = cupboard_db::connect_scoped(&owner_url, 5, "tenant,public")
        .await
        .expect("owner");
    let app = cupboard_db::connect_scoped(&app_url, 5, "tenant,public")
        .await
        .expect("app");
    MIGRATED
        .get_or_init(|| async {
            sqlx::query("CREATE SCHEMA IF NOT EXISTS tenant")
                .execute(&owner)
                .await
                .expect("schema");
            MIGRATOR.run(&owner).await.expect("migrate");
        })
        .await;
    Some((owner, app))
}

// ============================ In-process identity stub ============================

#[derive(Default)]
struct IdentityStubState {
    /// Active bans keyed by `{tenant_id}|{steam_id}`.
    active: HashMap<String, Vec<Value>>,
    /// The `x-internal-token` values presented to `/internal/bans/active`.
    tokens: Vec<Option<String>>,
}

struct IdentityStub {
    base_url: String,
    state: Arc<Mutex<IdentityStubState>>,
    handle: tokio::task::JoinHandle<()>,
}

impl Drop for IdentityStub {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

impl IdentityStub {
    async fn spawn() -> Self {
        let state = Arc::new(Mutex::new(IdentityStubState::default()));
        // POST with a JSON body (not GET + query): the steam_id must never ride a URI
        // into identity's request spans.
        let router = Router::new()
            .route(
                "/internal/bans/active",
                post(
                    |State(s): State<Arc<Mutex<IdentityStubState>>>,
                     headers: HeaderMap,
                     Json(body): Json<Value>| async move {
                        let mut st = s.lock().unwrap();
                        st.tokens.push(
                            headers
                                .get("x-internal-token")
                                .and_then(|h| h.to_str().ok())
                                .map(str::to_string),
                        );
                        let key = format!(
                            "{}|{}",
                            body["tenant_id"].as_str().unwrap_or_default(),
                            body["steam_id"].as_str().unwrap_or_default()
                        );
                        let bans = st.active.get(&key).cloned().unwrap_or_default();
                        Json(json!({ "bans": bans }))
                    },
                ),
            )
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        IdentityStub {
            base_url,
            state,
            handle,
        }
    }

    fn set_active_bans(&self, tenant: Uuid, steam_id: &str, bans: Vec<Value>) {
        self.state
            .lock()
            .unwrap()
            .active
            .insert(format!("{tenant}|{steam_id}"), bans);
    }

    fn tokens(&self) -> Vec<Option<String>> {
        self.state.lock().unwrap().tokens.clone()
    }
}

// ============================ Harness ============================

async fn state(owner: PgPool, app: PgPool, identity_base: &str) -> AppState {
    // A real bus when TEST_REDIS_URL is set (publish assertions run), else None (the
    // decision-G path: everything works without Redis).
    let bus = match std::env::var("TEST_REDIS_URL") {
        Ok(url) => Some(cupboard_bus::Bus::connect(&url).await.expect("bus")),
        Err(_) => None,
    };
    let config = Config {
        bind_addr: "127.0.0.1:0".into(),
        database_url: String::new(),
        database_url_app: String::new(),
        db_max_connections: 5,
        environment: "test".into(),
        otel_endpoint: None,
        jwt_public_key_pem: OP_PUB.into(),
        redis_url: None,
        sites_suffix: "sites.test".into(),
        tenant_master_key: None,
        consumer_name: "pr3".into(),
        paynow_api_base: "http://paynow.test".into(),
        tebex_headless_base: "http://tebex.test".into(),
        tebex_plugin_base: "http://tebex.test".into(),
        internal_api_token: Some(INTERNAL_TOKEN.into()),
        bot_api_token: Some(BOT_TOKEN.into()),
        player_jwt_public_key_pem: Some(PL_PUB.into()),
        public_webhook_base: None,
        edge_hostname: None,
        cert_namespace: "cupboard-web".into(),
        cert_issuer: "letsencrypt-http01".into(),
        web_service_name: "cupboard-web".into(),
        web_service_port: 3000,
        ingress_class: "traefik-external".into(),
        stripe_secret_key: None,
        stripe_webhook_secret: None,
        stripe_price_team: None,
        stripe_price_enterprise: None,
        stripe_price_custom_design: None,
        stripe_api_base: "http://stripe.test".into(),
        auth_internal_url: "http://auth.test".into(),
        plan_write_token: None,
        identity_internal_url: identity_base.to_string(),
    };
    AppState {
        owner_pool: owner,
        app_pool: app,
        keys: Arc::new(Keys::verifier_from_ed_pem(OP_PUB).unwrap()),
        player_keys: Some(Arc::new(PlayerKeys::verifier_from_ed_pem(PL_PUB).unwrap())),
        cache: SiteCache::disabled(),
        site_miss_budget: Arc::new(Default::default()),
        catalog_miss_budget: Arc::new(Default::default()),
        http: reqwest::Client::new(),
        bus,
        verified_prices: Arc::new(Default::default()),
        config: Arc::new(config),
    }
}

fn operator_bearer(tenant: Uuid, perms: &[&str]) -> String {
    let signer = Keys::from_ed_pem(OP_PRIV, OP_PUB).unwrap();
    let claims = Claims::new(
        UserId(Uuid::new_v4()),
        Uuid::new_v4(),
        Some(OrgId(tenant)),
        perms.iter().map(|p| p.to_string()).collect(),
        300,
    );
    format!("Bearer {}", signer.encode(&claims).unwrap())
}

fn player_bearer(tenant: Uuid, account: Uuid, steam_id: Option<&str>) -> String {
    let signer = PlayerKeys::from_ed_pem(PL_PRIV, PL_PUB).unwrap();
    let claims = PlayerClaims::new(
        account,
        OrgId(tenant),
        steam_id.map(str::to_string),
        Uuid::new_v4(),
        900,
    );
    format!("Bearer {}", signer.encode(&claims).unwrap())
}

async fn send(
    st: &AppState,
    method: &str,
    path: &str,
    auth: &str,
    body: Option<String>,
) -> (StatusCode, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header(header::AUTHORIZATION, auth);
    let req = match body {
        Some(b) => req
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(b))
            .unwrap(),
        None => {
            if method == "POST" {
                req = req.header(header::CONTENT_TYPE, "application/json");
            }
            req.body(Body::empty()).unwrap()
        }
    };
    let resp = http::router(st.clone()).oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let val = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, val)
}

/// Open a general ticket as `player`; returns the ticket id.
async fn open_ticket(st: &AppState, player_auth: &str, subject: &str, body: &str) -> Uuid {
    let (status, resp) = send(
        st,
        "POST",
        "/player/tickets",
        player_auth,
        Some(json!({"type": "general", "subject": subject, "body": body}).to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "open ticket failed: {resp}");
    resp["ticket"]["id"].as_str().unwrap().parse().unwrap()
}

/// Every entry on `cupboard:tickets` whose payload belongs to `tenant` (tenants are
/// unique per test, so concurrent tests never bleed into each other's assertions).
/// Also asserts the bus envelope: exactly one `data` field per entry.
async fn stream_events_for(redis_url: &str, tenant: Uuid) -> Vec<Value> {
    let client = redis::Client::open(redis_url).expect("redis client");
    let mut conn = client
        .get_multiplexed_async_connection()
        .await
        .expect("redis conn");
    let reply: redis::streams::StreamRangeReply =
        redis::AsyncCommands::xrange_all(&mut conn, "cupboard:tickets")
            .await
            .expect("xrange");
    reply
        .ids
        .iter()
        .filter_map(|entry| {
            let json: String = entry.get("data")?;
            let v: Value = serde_json::from_str(&json).ok()?;
            if v["tenant_id"] == json!(tenant.to_string()) {
                assert_eq!(
                    entry.map.len(),
                    1,
                    "a stream entry must carry the single `data` field envelope"
                );
                Some(v)
            } else {
                None
            }
        })
        .collect()
}

fn redis_url_or_skip(test: &str) -> Option<String> {
    match std::env::var("TEST_REDIS_URL") {
        Ok(url) => Some(url),
        Err(_) => {
            eprintln!("SKIP {test} (stream assertions): TEST_REDIS_URL unset");
            None
        }
    }
}

// ============================ Tests ============================

#[tokio::test]
async fn players_are_isolated_and_operators_need_support_respond() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP players_are_isolated...: TEST_DATABASE_URL unset");
        return;
    };
    let identity = IdentityStub::spawn().await;
    let st = state(owner, app, &identity.base_url).await;
    let tenant = Uuid::new_v4();
    let player_x = player_bearer(tenant, Uuid::new_v4(), Some("76561198000000001"));
    let player_y = player_bearer(tenant, Uuid::new_v4(), Some("76561198000000002"));

    let ticket = open_ticket(&st, &player_x, "cannot connect", "help please").await;

    // Owner sees it; the list carries the contract fields.
    let (status, body) = send(&st, "GET", "/player/tickets", &player_x, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["tickets"].as_array().unwrap().len(), 1);
    assert_eq!(body["tickets"][0]["type"], "general");
    assert_eq!(body["tickets"][0]["status"], "open");
    assert!(body["tickets"][0]["last_message_at"].is_string());

    // Player Y, SAME tenant: the ticket does not exist for them (list empty, get 404).
    let (status, body) = send(&st, "GET", "/player/tickets", &player_y, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["tickets"].as_array().unwrap().len(), 0);
    let (status, _) = send(
        &st,
        "GET",
        &format!("/player/tickets/{ticket}"),
        &player_y,
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "player Y must not read player X's ticket"
    );
    let (status, _) = send(
        &st,
        "POST",
        &format!("/player/tickets/{ticket}/messages"),
        &player_y,
        Some(json!({"body": "hijack"}).to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // A different tenant's operator cannot see it either (RLS through the router).
    let foreign_op = operator_bearer(Uuid::new_v4(), &["support.respond"]);
    let (status, _) = send(&st, "GET", &format!("/tickets/{ticket}"), &foreign_op, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // The right tenant's operator: list + detail + filters; support.respond enforced.
    let op = operator_bearer(tenant, &["support.respond"]);
    let (status, body) = send(&st, "GET", "/tickets", &op, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["tickets"].as_array().unwrap().len(), 1);
    let (status, body) = send(&st, "GET", "/tickets?status=closed", &op, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["tickets"].as_array().unwrap().len(), 0, "filtered out");
    let (status, _) = send(&st, "GET", "/tickets?status=bogus", &op, None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, body) = send(&st, "GET", &format!("/tickets/{ticket}"), &op, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["messages"].as_array().unwrap().len(), 1);
    assert_eq!(body["messages"][0]["author_kind"], "player");

    let weak_op = operator_bearer(tenant, &["sites.edit"]);
    let (status, _) = send(&st, "GET", "/tickets", &weak_op, None).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "support.respond is required");

    // Assign + status round out the operator surface (204s; no-op status is silent).
    let assignee = Uuid::new_v4();
    let (status, _) = send(
        &st,
        "POST",
        &format!("/tickets/{ticket}/assign"),
        &op,
        Some(json!({"assignee_user_id": assignee}).to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = send(
        &st,
        "POST",
        &format!("/tickets/{ticket}/status"),
        &op,
        Some(json!({"status": "open"}).to_string()),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "no-op status is a silent 204"
    );
    let (status, body) = send(&st, "GET", &format!("/tickets/{ticket}"), &op, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["ticket"]["assignee_user_id"],
        json!(assignee.to_string())
    );
}

#[tokio::test]
async fn internal_notes_never_reach_players_or_the_stream() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP internal_notes...: TEST_DATABASE_URL unset");
        return;
    };
    let identity = IdentityStub::spawn().await;
    let st = state(owner, app, &identity.base_url).await;
    let tenant = Uuid::new_v4();
    let account = Uuid::new_v4();
    let player = player_bearer(tenant, account, Some("76561198000000010"));
    let op = operator_bearer(tenant, &["support.respond"]);

    let ticket = open_ticket(&st, &player, "appeal my mute", "opening body").await;

    // Staff internal note + a public staff reply.
    let (status, note) = send(
        &st,
        "POST",
        &format!("/tickets/{ticket}/messages"),
        &op,
        Some(json!({"body": "INTERNAL: probably a repeat offender", "internal": true}).to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "note failed: {note}");
    assert_eq!(note["message"]["internal"], true);
    let (status, _) = send(
        &st,
        "POST",
        &format!("/tickets/{ticket}/messages"),
        &op,
        Some(json!({"body": "we are looking into it", "internal": false}).to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    // Operator detail sees all three messages; the player GET excludes the note.
    let (_, staff_view) = send(&st, "GET", &format!("/tickets/{ticket}"), &op, None).await;
    assert_eq!(staff_view["messages"].as_array().unwrap().len(), 3);
    let (status, player_view) = send(
        &st,
        "GET",
        &format!("/player/tickets/{ticket}"),
        &player,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let bodies: Vec<&str> = player_view["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["body"].as_str().unwrap())
        .collect();
    assert_eq!(bodies, vec!["opening body", "we are looking into it"]);
    assert!(
        !player_view.to_string().contains("INTERNAL:"),
        "the internal note must never appear anywhere in the player response"
    );

    // Stream side (the plan's named assertion): the note never published.
    let Some(url) = redis_url_or_skip("internal_notes_never_reach_players_or_the_stream") else {
        return;
    };
    let events = stream_events_for(&url, tenant).await;
    assert!(
        events
            .iter()
            .all(|e| e["body"].as_str().is_none_or(|b| !b.contains("INTERNAL:"))),
        "an internal note must never reach cupboard:tickets: {events:?}"
    );
    // The public reply DID publish (the guard drops notes, not staff replies).
    assert!(
        events.iter().any(|e| e["kind"] == "ticket.message"
            && e["body"] == "we are looking into it"
            && e["author_kind"] == "staff"),
        "the public staff reply must publish: {events:?}"
    );
}

#[tokio::test]
async fn ban_appeal_requires_owning_the_ban_and_snapshots_it() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP ban_appeal_requires...: TEST_DATABASE_URL unset");
        return;
    };
    let identity = IdentityStub::spawn().await;
    let st = state(owner.clone(), app, &identity.base_url).await;
    let tenant = Uuid::new_v4();
    let steam = "76561198000000042";
    let player = player_bearer(tenant, Uuid::new_v4(), Some(steam));

    let ban_id = Uuid::new_v4();
    identity.set_active_bans(
        tenant,
        steam,
        vec![json!({
            "id": ban_id.to_string(),
            "subject_type": "steam_id",
            "subject_value": steam,
            "reason": "cheating",
            "status": "active",
            "issued_at": "2026-07-01T00:00:00Z",
            "expires_at": null,
            "revoked_at": null
        })],
    );

    // A ban the player does NOT hold: 403, nothing stored.
    let foreign = Uuid::new_v4();
    let (status, body) = send(
        &st,
        "POST",
        "/player/tickets",
        &player,
        Some(
            json!({"type": "ban_appeal", "subject": "appeal", "body": "not me", "ban_id": foreign})
                .to_string(),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "foreign ban_id: {body}");

    // ban_id is required for appeals.
    let (status, _) = send(
        &st,
        "POST",
        "/player/tickets",
        &player,
        Some(json!({"type": "ban_appeal", "subject": "appeal", "body": "no ban"}).to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // The player's own active ban: 201, snapshot denormalized from identity's response.
    let (status, body) = send(
        &st,
        "POST",
        "/player/tickets",
        &player,
        Some(
            json!({"type": "ban_appeal", "subject": "please unban", "body": "sorry",
                   "ban_id": ban_id})
            .to_string(),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "own ban appeal: {body}");
    assert_eq!(body["ticket"]["ban_id"], json!(ban_id.to_string()));
    assert_eq!(body["ticket"]["ban_snapshot"]["reason"], "cheating");
    let snapshot: Option<Value> =
        sqlx::query_scalar("SELECT ban_snapshot FROM tickets WHERE id = $1")
            .bind(
                body["ticket"]["id"]
                    .as_str()
                    .unwrap()
                    .parse::<Uuid>()
                    .unwrap(),
            )
            .fetch_one(&owner)
            .await
            .unwrap();
    let snapshot = snapshot.expect("snapshot stored");
    assert_eq!(snapshot["subject_value"], steam);
    assert_eq!(snapshot["status"], "active");

    // The outbound credential is the shared INTERNAL_API_TOKEN.
    assert!(
        identity
            .tokens()
            .iter()
            .all(|t| t.as_deref() == Some(INTERNAL_TOKEN)),
        "every identity call must carry x-internal-token"
    );

    // A second appeal while the first is open: the partial unique index surfaces as 409.
    let (status, body) = send(
        &st,
        "POST",
        "/player/tickets",
        &player,
        Some(
            json!({"type": "ban_appeal", "subject": "again", "body": "still sorry",
                   "ban_id": ban_id})
            .to_string(),
        ),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "duplicate open appeal: {body}"
    );
    assert_eq!(body["error"], "conflict");

    // The appeal picker endpoint relays identity's list; no steam id = empty, no call.
    let (status, body) = send(&st, "GET", "/player/bans/active", &player, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["bans"][0]["id"], json!(ban_id.to_string()));
    let no_steam = player_bearer(tenant, Uuid::new_v4(), None);
    let (status, body) = send(&st, "GET", "/player/bans/active", &no_steam, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["bans"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn stream_publishes_created_and_message_but_never_discord_origin() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP stream_publishes...: TEST_DATABASE_URL unset");
        return;
    };
    let Some(url) =
        redis_url_or_skip("stream_publishes_created_and_message_but_never_discord_origin")
    else {
        return;
    };
    let identity = IdentityStub::spawn().await;
    let st = state(owner.clone(), app, &identity.base_url).await;
    let tenant = Uuid::new_v4();
    let steam = "76561198000000077";
    let player = player_bearer(tenant, Uuid::new_v4(), Some(steam));

    let ticket = open_ticket(&st, &player, "sync me", "first body").await;
    let (status, _) = send(
        &st,
        "POST",
        &format!("/player/tickets/{ticket}/messages"),
        &player,
        Some(json!({"body": "follow-up"}).to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    let events = stream_events_for(&url, tenant).await;
    let created: Vec<&Value> = events
        .iter()
        .filter(|e| e["kind"] == "ticket.created")
        .collect();
    assert_eq!(created.len(), 1, "one ticket.created: {events:?}");
    assert_eq!(created[0]["ticket_id"], json!(ticket.to_string()));
    assert_eq!(created[0]["ticket_type"], "general");
    assert_eq!(created[0]["subject"], "sync me");
    assert_eq!(created[0]["opener_display"], steam);
    let messages: Vec<&Value> = events
        .iter()
        .filter(|e| e["kind"] == "ticket.message")
        .collect();
    assert_eq!(
        messages.len(),
        1,
        "only the follow-up publishes a message event (create relays via the bot's \
         backfill): {events:?}"
    );
    assert_eq!(messages[0]["body"], "follow-up");
    assert_eq!(messages[0]["author_kind"], "player");
    assert_eq!(messages[0]["origin"], "web");

    // Echo-guard (decision F): a message that ARRIVED from Discord (inserted directly,
    // as the PR5 internal route will) must never publish, even when the helper is
    // invoked for it. The guard lives in publish_event itself.
    let discord_msg: tickets::TicketMessage = sqlx::query_as(
        "INSERT INTO ticket_messages \
             (ticket_id, tenant_id, author_kind, author_display, body, origin, \
              discord_message_id) \
         VALUES ($1, $2, 'staff', 'mod#1234', 'from discord', 'discord', '9990001') \
         RETURNING id, author_kind, author_id, author_display, body, internal, origin, \
                   created_at",
    )
    .bind(ticket)
    .bind(tenant)
    .fetch_one(&owner)
    .await
    .unwrap();
    tickets::publish_event(
        &st.bus,
        tickets::message_event(tenant, ticket, &discord_msg),
        discord_msg.internal,
    )
    .await;

    let events = stream_events_for(&url, tenant).await;
    assert!(
        events
            .iter()
            .all(|e| e["origin"] != "discord" && e["body"] != "from discord"),
        "origin='discord' must never publish: {events:?}"
    );
}

#[tokio::test]
async fn player_message_reopens_resolved_ticket() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP player_message_reopens...: TEST_DATABASE_URL unset");
        return;
    };
    let identity = IdentityStub::spawn().await;
    let st = state(owner.clone(), app, &identity.base_url).await;
    let tenant = Uuid::new_v4();
    let player = player_bearer(tenant, Uuid::new_v4(), Some("76561198000000099"));
    let op = operator_bearer(tenant, &["support.respond"]);

    let ticket = open_ticket(&st, &player, "solved?", "it broke").await;
    let (status, _) = send(
        &st,
        "POST",
        &format!("/tickets/{ticket}/status"),
        &op,
        Some(json!({"status": "resolved"}).to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // The player comes back: the ticket reopens.
    let (status, _) = send(
        &st,
        "POST",
        &format!("/player/tickets/{ticket}/messages"),
        &player,
        Some(json!({"body": "it broke again"}).to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let db_status: String = sqlx::query_scalar("SELECT status FROM tickets WHERE id = $1")
        .bind(ticket)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(db_status, "open", "a player message must reopen the ticket");

    // Stream side: resolved then open both announced.
    let Some(url) = redis_url_or_skip("player_message_reopens_resolved_ticket") else {
        return;
    };
    let statuses: Vec<String> = stream_events_for(&url, tenant)
        .await
        .iter()
        .filter(|e| e["kind"] == "ticket.status")
        .map(|e| e["status"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        statuses,
        vec!["resolved".to_string(), "open".to_string()],
        "both transitions publish ticket.status"
    );
}

#[tokio::test]
async fn internal_note_does_not_move_player_visible_timestamps() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP internal_note_does_not_move...: TEST_DATABASE_URL unset");
        return;
    };
    let identity = IdentityStub::spawn().await;
    let st = state(owner, app, &identity.base_url).await;
    let tenant = Uuid::new_v4();
    let player = player_bearer(tenant, Uuid::new_v4(), Some("76561198000000123"));
    let op = operator_bearer(tenant, &["support.respond"]);

    let ticket = open_ticket(&st, &player, "quiet ticket", "opening body").await;
    let (_, before) = send(&st, "GET", "/player/tickets", &player, None).await;
    let before = before["tickets"][0].clone();

    // An internal note must not move anything the player can see: not the list row's
    // updated_at (the insert skips the touch), not last_message_at (the player-facing
    // subquery filters internal), not the detail's updated_at.
    let (status, _) = send(
        &st,
        "POST",
        &format!("/tickets/{ticket}/messages"),
        &op,
        Some(json!({"body": "note to self", "internal": true}).to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (_, after) = send(&st, "GET", "/player/tickets", &player, None).await;
    let after = after["tickets"][0].clone();
    assert_eq!(
        before["updated_at"], after["updated_at"],
        "an internal note must not bump the player-visible updated_at"
    );
    assert_eq!(
        before["last_message_at"], after["last_message_at"],
        "an internal note must not bump the player-visible last_message_at"
    );

    // A PUBLIC staff reply does move both (the guard is note-specific).
    let (status, _) = send(
        &st,
        "POST",
        &format!("/tickets/{ticket}/messages"),
        &op,
        Some(json!({"body": "public reply", "internal": false}).to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (_, replied) = send(&st, "GET", "/player/tickets", &player, None).await;
    assert_ne!(
        after["last_message_at"], replied["tickets"][0]["last_message_at"],
        "a public reply must move last_message_at"
    );

    // The operator list still sees note activity via its own unfiltered subquery.
    let (_, staff_list) = send(&st, "GET", "/tickets", &op, None).await;
    assert!(staff_list["tickets"][0]["last_message_at"].is_string());
}

#[tokio::test]
async fn sibling_open_appeal_blocks_reopen_without_losing_the_message() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP sibling_open_appeal...: TEST_DATABASE_URL unset");
        return;
    };
    let identity = IdentityStub::spawn().await;
    let st = state(owner.clone(), app, &identity.base_url).await;
    let tenant = Uuid::new_v4();
    let steam = "76561198000000200";
    let account = Uuid::new_v4();
    let player = player_bearer(tenant, account, Some(steam));
    let op = operator_bearer(tenant, &["support.respond"]);

    let ban_id = Uuid::new_v4();
    identity.set_active_bans(
        tenant,
        steam,
        vec![json!({
            "id": ban_id.to_string(),
            "subject_type": "steam_id", "subject_value": steam,
            "reason": "raiding spawn", "status": "active",
            "issued_at": "2026-07-01T00:00:00Z", "expires_at": null, "revoked_at": null
        })],
    );
    let open_appeal = |subject: &'static str| {
        let st = st.clone();
        let player = player.clone();
        async move {
            send(
                &st,
                "POST",
                "/player/tickets",
                &player,
                Some(
                    json!({"type": "ban_appeal", "subject": subject, "body": "please",
                           "ban_id": ban_id})
                    .to_string(),
                ),
            )
            .await
        }
    };

    // First appeal opened, then resolved; a second appeal is now legitimate.
    let (status, first) = open_appeal("first appeal").await;
    assert_eq!(status, StatusCode::CREATED, "first appeal: {first}");
    let first_id: Uuid = first["ticket"]["id"].as_str().unwrap().parse().unwrap();
    let (status, _) = send(
        &st,
        "POST",
        &format!("/tickets/{first_id}/status"),
        &op,
        Some(json!({"status": "resolved"}).to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, second) = open_appeal("second appeal").await;
    assert_eq!(status, StatusCode::CREATED, "second appeal: {second}");

    // Operator reopening the RESOLVED first appeal now collides with the open sibling:
    // a friendly 409, never a 500.
    let (status, body) = send(
        &st,
        "POST",
        &format!("/tickets/{first_id}/status"),
        &op,
        Some(json!({"status": "open"}).to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "operator reopen: {body}");
    assert_eq!(body["error"], "conflict");

    // A player message on the resolved first appeal SKIPS the reopen (the sibling
    // already covers the open state) but the message itself must land.
    let (status, body) = send(
        &st,
        "POST",
        &format!("/player/tickets/{first_id}/messages"),
        &player,
        Some(json!({"body": "adding context to the old appeal"}).to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "player message: {body}");
    let db_status: String = sqlx::query_scalar("SELECT status FROM tickets WHERE id = $1")
        .bind(first_id)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(
        db_status, "resolved",
        "the skipped reopen leaves it resolved"
    );
    let (_, detail) = send(
        &st,
        "GET",
        &format!("/player/tickets/{first_id}"),
        &player,
        None,
    )
    .await;
    assert_eq!(
        detail["messages"].as_array().unwrap().len(),
        2,
        "the message must land even though the reopen was skipped"
    );

    // Stream side: the first appeal announced resolved, but never a (skipped) open.
    let Some(url) =
        redis_url_or_skip("sibling_open_appeal_blocks_reopen_without_losing_the_message")
    else {
        return;
    };
    let first_statuses: Vec<String> = stream_events_for(&url, tenant)
        .await
        .iter()
        .filter(|e| e["kind"] == "ticket.status" && e["ticket_id"] == json!(first_id.to_string()))
        .map(|e| e["status"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        first_statuses,
        vec!["resolved".to_string()],
        "a skipped reopen must not publish ticket.status"
    );
}

// ============================ Discord bind (PR4) ============================

/// POST the internal bind route with an arbitrary `x-internal-token` (or none).
async fn send_bind(st: &AppState, token: Option<&str>, body: Value) -> (StatusCode, Value) {
    let mut req = Request::builder()
        .method("POST")
        .uri("/internal/tickets/discord/bind")
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(t) = token {
        req = req.header("x-internal-token", t);
    }
    let req = req.body(Body::from(body.to_string())).unwrap();
    let resp = http::router(st.clone()).oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let val = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, val)
}

/// Mint a bind code as `op`; returns (plaintext, expires_at).
async fn mint_code(st: &AppState, op: &str) -> (String, String) {
    let (status, body) = send(st, "POST", "/tickets/discord/bind-code", op, None).await;
    assert_eq!(status, StatusCode::CREATED, "mint: {body}");
    (
        body["code"].as_str().unwrap().to_string(),
        body["expires_at"].as_str().unwrap().to_string(),
    )
}

fn bind_body(code: &str, guild: &str, channel: &str) -> Value {
    json!({ "code": code, "guild_id": guild, "tickets_channel_id": channel,
            "staff_role_id": "role-1" })
}

#[tokio::test]
async fn bind_code_lifecycle_and_credential_planes() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP bind_code_lifecycle...: TEST_DATABASE_URL unset");
        return;
    };
    let identity = IdentityStub::spawn().await;
    let st = state(owner.clone(), app, &identity.base_url).await;
    let tenant = Uuid::new_v4();
    let op = operator_bearer(tenant, &["support.respond"]);
    let guild = format!("g{}", Uuid::new_v4().simple());

    // Mint requires support.respond.
    let weak = operator_bearer(tenant, &["sites.edit"]);
    let (status, _) = send(&st, "POST", "/tickets/discord/bind-code", &weak, None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Unlinked status before any bind.
    let (status, body) = send(&st, "GET", "/tickets/discord", &op, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["linked"], false);

    // Mint: 201 with plaintext + expiry; only the sha256 is stored.
    let (code, expires_at) = mint_code(&st, &op).await;
    assert!(chrono::DateTime::parse_from_rfc3339(&expires_at).is_ok());
    let stored: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM ticket_bind_codes WHERE tenant_id = $1 AND code_hash = $2",
    )
    .bind(tenant)
    .bind(cupboard_crypto::sha256(code.as_bytes()).to_vec())
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(stored, 1, "the stored hash must be the unkeyed sha256");

    // Credential planes are disjoint: no token, a wrong token, and the SHARED
    // INTERNAL_API_TOKEN are all 401 on the bot route.
    let (status, _) = send_bind(&st, None, bind_body(&code, &guild, "chan-1")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = send_bind(&st, Some("wrong"), bind_body(&code, &guild, "chan-1")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = send_bind(
        &st,
        Some(INTERNAL_TOKEN),
        bind_body(&code, &guild, "chan-1"),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "the shared internal token must NOT work on /internal/tickets/* (decision E \
         disjointness both ways)"
    );

    // ...and the other half of decision E: the BOT token gains nothing on the SHARED
    // internal surface (a compromised bot cannot reach /internal/sites/resolve).
    let req = Request::builder()
        .method("GET")
        .uri("/internal/sites/resolve?host=any.sites.test")
        .header("x-internal-token", BOT_TOKEN)
        .body(Body::empty())
        .unwrap();
    let resp = http::router(st.clone()).oneshot(req).await.unwrap();
    assert_eq!(
        resp.status(),
        StatusCode::UNAUTHORIZED,
        "BOT_API_TOKEN must not work on shared /internal/* routes"
    );

    // The real bot token binds; the code works exactly once.
    let (status, body) = send_bind(&st, Some(BOT_TOKEN), bind_body(&code, &guild, "chan-1")).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "bind: {body}");
    let (status, _) = send_bind(&st, Some(BOT_TOKEN), bind_body(&code, &guild, "chan-1")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "a code is single-use");

    // Status reflects the link.
    let (status, body) = send(&st, "GET", "/tickets/discord", &op, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["linked"], true);
    assert_eq!(body["guild_id"], json!(guild));
    assert_eq!(body["tickets_channel_id"], "chan-1");
    assert_eq!(body["staff_role_id"], "role-1");
    assert!(body["linked_at"].is_string());

    // Minting again replaces the outstanding code: the OLD code dies, the new works.
    let (old_code, _) = mint_code(&st, &op).await;
    let (new_code, _) = mint_code(&st, &op).await;
    let (status, _) = send_bind(&st, Some(BOT_TOKEN), bind_body(&old_code, &guild, "chan-2")).await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "mint replaces older codes"
    );
    // Same-tenant rebind (same guild, new channel) replaces the config row.
    let (status, _) = send_bind(&st, Some(BOT_TOKEN), bind_body(&new_code, &guild, "chan-2")).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, body) = send(&st, "GET", "/tickets/discord", &op, None).await;
    assert_eq!(
        body["tickets_channel_id"], "chan-2",
        "rebind replaces the row"
    );

    // Expired code: minted, forcibly expired, rejected with the same generic 401.
    let (expired_code, _) = mint_code(&st, &op).await;
    sqlx::query(
        "UPDATE ticket_bind_codes SET expires_at = now() - interval '1 minute' \
                 WHERE tenant_id = $1",
    )
    .bind(tenant)
    .execute(&owner)
    .await
    .unwrap();
    let (status, body) = send_bind(
        &st,
        Some(BOT_TOKEN),
        bind_body(&expired_code, &guild, "chan-3"),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "expired code: {body}");

    // Audit rows for mints and binds.
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE tenant_id = $1 AND action IN \
             ('tickets.discord_bind_code_created', 'tickets.discord_linked')",
    )
    .bind(tenant)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(audits, 6, "four mints + two binds");
}

#[tokio::test]
async fn guild_bound_elsewhere_is_a_conflict_for_another_tenant() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP guild_bound_elsewhere...: TEST_DATABASE_URL unset");
        return;
    };
    let identity = IdentityStub::spawn().await;
    let st = state(owner, app, &identity.base_url).await;
    let tenant_a = Uuid::new_v4();
    let tenant_b = Uuid::new_v4();
    let guild = format!("g{}", Uuid::new_v4().simple());

    let (code_a, _) = mint_code(&st, &operator_bearer(tenant_a, &["support.respond"])).await;
    let (status, _) = send_bind(&st, Some(BOT_TOKEN), bind_body(&code_a, &guild, "a-chan")).await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // Tenant B's valid code + tenant A's guild: 409 (one guild binds one tenant,
    // resolved server-side, never trusted from the bot payload).
    let (code_b, _) = mint_code(&st, &operator_bearer(tenant_b, &["support.respond"])).await;
    let (status, body) =
        send_bind(&st, Some(BOT_TOKEN), bind_body(&code_b, &guild, "b-chan")).await;
    assert_eq!(status, StatusCode::CONFLICT, "cross-tenant guild: {body}");
    assert_eq!(body["error"], "conflict");

    // The conflict rolled the whole bind back, so B's code SURVIVES: the operator can
    // retry against the right guild without re-minting.
    let other_guild = format!("g{}", Uuid::new_v4().simple());
    let (status, _) = send_bind(
        &st,
        Some(BOT_TOKEN),
        bind_body(&code_b, &other_guild, "b-chan"),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "a 409 must not consume the code"
    );
}
