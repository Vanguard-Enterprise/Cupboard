//! End-to-end for the Phase 7 PR2 tenant privacy walkers: the PRIVACY_TOKEN
//! credential plane (disjoint from the shared and bot tokens, both directions),
//! export/erase row selection per scope (platform vs tenant containment),
//! entitlement retention (decision B), dry-run purity, idempotent double-erase,
//! request validation, and the decision B2 schema-inventory oracle.
//!
//! Requires TEST_DATABASE_URL(_APP); skips (passes) when unset.

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use cupboard_auth_core::Keys;
use cupboard_tenant::cache::SiteCache;
use cupboard_tenant::config::Config;
use cupboard_tenant::domain::privacy::{Classification, CLASSIFIED, ERASED};
use cupboard_tenant::http;
use cupboard_tenant::state::AppState;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::sync::Arc;
use tokio::sync::OnceCell;
use tower::util::ServiceExt;
use uuid::Uuid;

// Verify-only operator key (the tickets_e2e throwaway pair; no operator tokens are
// minted here, AppState just needs a verifier).
const OP_PUB: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAyKMiwFH0hHn4HiPl8DTEq+aPzW9XyzG5v1ELTEVNsbY=\n-----END PUBLIC KEY-----\n";

const INTERNAL_TOKEN: &str = "int_pr2_privacy";
const BOT_TOKEN: &str = "bot_pr2_privacy";
const PRIVACY_TOKEN: &str = "priv_pr2_walker";

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

fn state(owner: PgPool, app: PgPool, privacy_token: Option<&str>) -> AppState {
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
        consumer_name: "pr2-privacy".into(),
        paynow_api_base: "http://paynow.test".into(),
        tebex_headless_base: "http://tebex.test".into(),
        tebex_plugin_base: "http://tebex.test".into(),
        internal_api_token: Some(INTERNAL_TOKEN.into()),
        bot_api_token: Some(BOT_TOKEN.into()),
        privacy_token: privacy_token.map(str::to_string),
        player_jwt_public_key_pem: None,
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
        identity_internal_url: "http://identity.test".into(),
        retention_tick_secs: 3600,
        retention_webhook_payload_days: 90,
        retention_audit_days: 730,
        retention_stream_days: 14,
    };
    AppState {
        owner_pool: owner,
        app_pool: app,
        keys: Arc::new(Keys::verifier_from_ed_pem(OP_PUB).unwrap()),
        player_keys: None,
        cache: SiteCache::disabled(),
        site_miss_budget: Arc::new(Default::default()),
        catalog_miss_budget: Arc::new(Default::default()),
        http: reqwest::Client::new(),
        bus: None,
        verified_prices: Arc::new(Default::default()),
        config: Arc::new(config),
    }
}

/// POST `path` with an arbitrary `x-internal-token` (or none) and a JSON body.
async fn send(
    st: &AppState,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(t) = token {
        req = req.header("x-internal-token", t);
    }
    let req = req
        .body(match body {
            Some(b) => Body::from(b.to_string()),
            None => Body::empty(),
        })
        .unwrap();
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

fn platform_body(steam: &str, discord: &str, pid: Uuid) -> Value {
    json!({
        "scope_kind": "platform", "tenant_id": null,
        "steam_id": steam, "discord_id": discord,
        "player_account_id": pid,
    })
}

fn tenant_body(tenant: Uuid, steam: &str, discord: &str, pid: Uuid) -> Value {
    json!({
        "scope_kind": "tenant", "tenant_id": tenant,
        "steam_id": steam, "discord_id": discord,
        "player_account_id": pid,
    })
}

/// One player's full data spread inside one tenant: a web-opened ticket (with a ban
/// snapshot) + the player's message + a staff reply, a Discord-opened ticket + a
/// relayed player message (no author_id), a checkout session, an entitlement, one
/// webhook event whose payload carries the raw steam id, and one unrelated event.
/// Plus ANOTHER player's ticket carrying player-authored and relayed messages: third
/// -party content the subject's walk must never export or erase.
struct Seeded {
    web_ticket: Uuid,
    discord_ticket: Uuid,
    other_ticket: Uuid,
    checkout: Uuid,
    entitlement: Uuid,
    webhook_event: Uuid,
    other_event: Uuid,
}

async fn seed_tenant(
    owner: &PgPool,
    tenant: Uuid,
    pid: Uuid,
    steam: &str,
    discord: &str,
) -> Seeded {
    let web_ticket: Uuid = sqlx::query_scalar(
        "INSERT INTO tickets (tenant_id, type, subject, player_account_id, ban_snapshot) \
         VALUES ($1, 'ban_appeal', 'web subject', $2, '{\"reason\":\"cheating\"}'::jsonb) \
         RETURNING id",
    )
    .bind(tenant)
    .bind(pid)
    .fetch_one(owner)
    .await
    .unwrap();
    let discord_ticket: Uuid = sqlx::query_scalar(
        "INSERT INTO tickets (tenant_id, type, subject, opener_discord_user_id) \
         VALUES ($1, 'general', 'discord subject', $2) RETURNING id",
    )
    .bind(tenant)
    .bind(discord)
    .fetch_one(owner)
    .await
    .unwrap();
    // Another player's ticket in the same tenant: its player-authored message (staff
    // -visible) and its NULL-author relayed message are THIRD-PARTY content relative
    // to the subject and must survive the subject's export/erase untouched.
    let other_pid = Uuid::new_v4();
    let other_ticket: Uuid = sqlx::query_scalar(
        "INSERT INTO tickets (tenant_id, type, subject, player_account_id) \
         VALUES ($1, 'general', 'other subject', $2) RETURNING id",
    )
    .bind(tenant)
    .bind(other_pid)
    .fetch_one(owner)
    .await
    .unwrap();
    for (ticket, kind, author, display, body, origin) in [
        (
            web_ticket,
            "player",
            Some(pid),
            steam,
            "player words",
            "web",
        ),
        (
            web_ticket,
            "staff",
            Some(Uuid::new_v4()),
            "staff-1",
            "staff words",
            "web",
        ),
        (
            discord_ticket,
            "player",
            None,
            "disc#1",
            "discord words",
            "discord",
        ),
        (
            other_ticket,
            "player",
            Some(other_pid),
            "other-1",
            "other player words",
            "web",
        ),
        (
            other_ticket,
            "player",
            None,
            "other#relay",
            "other relayed words",
            "discord",
        ),
    ] {
        sqlx::query(
            "INSERT INTO ticket_messages \
                 (ticket_id, tenant_id, author_kind, author_id, author_display, body, origin) \
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(ticket)
        .bind(tenant)
        .bind(kind)
        .bind(author)
        .bind(display)
        .bind(body)
        .bind(origin)
        .execute(owner)
        .await
        .unwrap();
    }
    let connection: Uuid = sqlx::query_scalar(
        "INSERT INTO store_connections (tenant_id, provider, store_external_id) \
         VALUES ($1, 'paynow', $2) RETURNING id",
    )
    .bind(tenant)
    .bind(Uuid::new_v4().to_string())
    .fetch_one(owner)
    .await
    .unwrap();
    let checkout: Uuid = sqlx::query_scalar(
        "INSERT INTO checkout_sessions \
             (tenant_id, connection_id, player_account_id, steam_id, product_external_id) \
         VALUES ($1, $2, $3, $4, 'prod-1') RETURNING id",
    )
    .bind(tenant)
    .bind(connection)
    .bind(pid)
    .bind(steam)
    .fetch_one(owner)
    .await
    .unwrap();
    let entitlement: Uuid = sqlx::query_scalar(
        "INSERT INTO entitlements \
             (tenant_id, connection_id, provider, external_ref, steam_id, \
              player_account_id, status, source, content_hash) \
         VALUES ($1, $2, 'paynow', $3, $4, $5, 'active', 'webhook', 'h') RETURNING id",
    )
    .bind(tenant)
    .bind(connection)
    .bind(Uuid::new_v4().to_string())
    .bind(steam)
    .bind(pid)
    .fetch_one(owner)
    .await
    .unwrap();
    let webhook_event: Uuid = sqlx::query_scalar(
        "INSERT INTO store_webhook_events (tenant_id, connection_id, provider, event_id, payload) \
         VALUES ($1, $2, 'paynow', $3, $4) RETURNING id",
    )
    .bind(tenant)
    .bind(connection)
    .bind(Uuid::new_v4().to_string())
    .bind(json!({ "order": { "customer": { "steam_id": steam } } }))
    .fetch_one(owner)
    .await
    .unwrap();
    let other_event: Uuid = sqlx::query_scalar(
        "INSERT INTO store_webhook_events (tenant_id, connection_id, provider, event_id, payload) \
         VALUES ($1, $2, 'paynow', $3, $4) RETURNING id",
    )
    .bind(tenant)
    .bind(connection)
    .bind(Uuid::new_v4().to_string())
    .bind(json!({ "order": { "customer": { "steam_id": "unrelated-subject" } } }))
    .fetch_one(owner)
    .await
    .unwrap();
    Seeded {
        web_ticket,
        discord_ticket,
        other_ticket,
        checkout,
        entitlement,
        webhook_event,
        other_event,
    }
}

/// Fresh, unique-per-test subject identifiers (tests share one database).
fn subject_ids() -> (Uuid, String, String) {
    let pid = Uuid::new_v4();
    let n = Uuid::new_v4().as_u128();
    (
        pid,
        format!("7656119{}", n % 10_000_000_000),
        format!("d{}", n % 1_000_000_000),
    )
}

async fn scalar<T>(owner: &PgPool, sql: &str, id: Uuid) -> T
where
    T: Send + Unpin + for<'r> sqlx::Decode<'r, sqlx::Postgres> + sqlx::Type<sqlx::Postgres>,
{
    sqlx::query_scalar(sql)
        .bind(id)
        .fetch_one(owner)
        .await
        .unwrap()
}

// ============================ Tests ============================

#[tokio::test]
async fn privacy_token_planes_are_disjoint_both_directions() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP privacy_token_planes...: TEST_DATABASE_URL unset");
        return;
    };
    let st = state(owner.clone(), app.clone(), Some(PRIVACY_TOKEN));
    let (pid, steam, discord) = subject_ids();
    let body = platform_body(&steam, &discord, pid);

    // No token, a wrong token, the SHARED token, and the BOT token are all 401 on
    // BOTH privacy routes (the tickets credential-plane precedent, extended).
    for path in ["/internal/privacy/export", "/internal/privacy/erase"] {
        for token in [None, Some("wrong"), Some(INTERNAL_TOKEN), Some(BOT_TOKEN)] {
            let (status, _) = send(&st, "POST", path, token, Some(body.clone())).await;
            assert_eq!(
                status,
                StatusCode::UNAUTHORIZED,
                "{token:?} must not pass on {path}"
            );
        }
        let (status, resp) = send(&st, "POST", path, Some(PRIVACY_TOKEN), Some(body.clone())).await;
        assert_eq!(status, StatusCode::OK, "privacy token on {path}: {resp}");
    }

    // The other direction: the privacy token gains nothing on the bot surface or the
    // shared internal surface.
    let (status, _) = send(
        &st,
        "GET",
        "/internal/tickets/discord/config?guild_id=g-x",
        Some(PRIVACY_TOKEN),
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "PRIVACY_TOKEN must not work on /internal/tickets/*"
    );
    let (status, _) = send(
        &st,
        "GET",
        "/internal/sites/resolve?host=any.sites.test",
        Some(PRIVACY_TOKEN),
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "PRIVACY_TOKEN must not work on shared /internal/* routes"
    );

    // Fail closed: unconfigured PRIVACY_TOKEN disables the surface entirely.
    let disabled = state(owner, app, None);
    for token in [None, Some(PRIVACY_TOKEN), Some(INTERNAL_TOKEN)] {
        let (status, _) = send(
            &disabled,
            "POST",
            "/internal/privacy/export",
            token,
            Some(body.clone()),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::SERVICE_UNAVAILABLE,
            "{token:?} on disabled"
        );
    }
}

#[tokio::test]
async fn export_includes_seeded_rows_per_scope() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP export_includes_seeded_rows...: TEST_DATABASE_URL unset");
        return;
    };
    let st = state(owner.clone(), app, Some(PRIVACY_TOKEN));
    let tenant_a = Uuid::new_v4();
    let tenant_b = Uuid::new_v4();
    let (pid, steam, discord) = subject_ids();
    let a = seed_tenant(&owner, tenant_a, pid, &steam, &discord).await;
    let _b = seed_tenant(&owner, tenant_b, pid, &steam, &discord).await;

    // Platform scope spans both tenants. Identifiers arrive whitespace-padded here:
    // the walker must trim before matching (the coordinator payload mirror of
    // identity's parse_subject), so the counts below prove the trim.
    let (status, resp) = send(
        &st,
        "POST",
        "/internal/privacy/export",
        Some(PRIVACY_TOKEN),
        Some(json!({
            "scope_kind": "platform", "tenant_id": null,
            "steam_id": format!("  {steam} "),
            "discord_id": format!(" {discord}\t"),
            "player_account_id": pid,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "platform export: {resp}");
    let data = &resp["data"];
    assert_eq!(data["tickets"].as_array().unwrap().len(), 4);
    assert_eq!(data["ticket_messages"].as_array().unwrap().len(), 4);
    assert_eq!(data["checkout_sessions"].as_array().unwrap().len(), 2);
    assert_eq!(data["entitlements"].as_array().unwrap().len(), 2);
    assert_eq!(data["store_webhook_events"].as_array().unwrap().len(), 2);
    // Player-authored rows only, and only the value-matched payload sweep.
    let text = data.to_string();
    assert!(
        !text.contains("staff words"),
        "staff replies are the org's record"
    );
    assert!(
        !text.contains("unrelated-subject"),
        "unmatched payloads stay out"
    );
    // Third-party content (another player's ticket and its messages, including its
    // NULL-author relayed row) must never ship in the subject's Art. 15 bundle.
    for third_party in ["other subject", "other player words", "other relayed words"] {
        assert!(
            !text.contains(third_party),
            "third-party content must not export: {third_party}"
        );
    }
    assert!(
        data["tickets"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["id"] == json!(a.web_ticket.to_string())),
        "the web ticket must be exported"
    );

    // Tenant scope: tenant A only, proven per row.
    let (status, resp) = send(
        &st,
        "POST",
        "/internal/privacy/export",
        Some(PRIVACY_TOKEN),
        Some(json!({
            "scope_kind": "tenant", "tenant_id": tenant_a, "steam_id": steam,
            "discord_id": discord, "player_account_id": pid,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "tenant export: {resp}");
    let data = &resp["data"];
    assert_eq!(data["tickets"].as_array().unwrap().len(), 2);
    assert_eq!(data["ticket_messages"].as_array().unwrap().len(), 2);
    assert_eq!(data["checkout_sessions"].as_array().unwrap().len(), 1);
    assert_eq!(data["entitlements"].as_array().unwrap().len(), 1);
    assert_eq!(data["store_webhook_events"].as_array().unwrap().len(), 1);
    for (_, rows) in data.as_object().unwrap() {
        for row in rows.as_array().unwrap() {
            assert_eq!(
                row["tenant_id"],
                json!(tenant_a.to_string()),
                "a tenant-scope export must never carry another tenant's row: {row}"
            );
        }
    }
}

#[tokio::test]
async fn tenant_scope_erase_touches_zero_other_tenant_rows() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP tenant_scope_erase...: TEST_DATABASE_URL unset");
        return;
    };
    let st = state(owner.clone(), app, Some(PRIVACY_TOKEN));
    let tenant_a = Uuid::new_v4();
    let tenant_b = Uuid::new_v4();
    let (pid, steam, discord) = subject_ids();
    let a = seed_tenant(&owner, tenant_a, pid, &steam, &discord).await;
    let b = seed_tenant(&owner, tenant_b, pid, &steam, &discord).await;

    let (status, resp) = send(
        &st,
        "POST",
        "/internal/privacy/erase",
        Some(PRIVACY_TOKEN),
        Some(tenant_body(tenant_a, &steam, &discord, pid)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "erase: {resp}");
    assert_eq!(
        resp["counts"],
        json!({
            "tickets": 2, "ticket_messages": 2,
            "checkout_sessions": 1, "store_webhook_events": 1,
        }),
        "tenant-scope counts must cover exactly tenant A's player rows"
    );
    assert!(
        resp["counts"].get("entitlements").is_none(),
        "erasure never reports entitlements (decision B)"
    );

    // Tenant A: erased per decision B.
    let subject: String = scalar(
        &owner,
        "SELECT subject FROM tickets WHERE id = $1",
        a.web_ticket,
    )
    .await;
    assert_eq!(subject, ERASED);
    let opener: Option<String> = scalar(
        &owner,
        "SELECT opener_discord_user_id FROM tickets WHERE id = $1",
        a.discord_ticket,
    )
    .await;
    assert_eq!(opener, None);
    let snapshot: Option<Value> = scalar(
        &owner,
        "SELECT ban_snapshot FROM tickets WHERE id = $1",
        a.web_ticket,
    )
    .await;
    assert_eq!(snapshot, None, "ban_snapshot must be NULLed");
    let bodies: Vec<(Uuid, String, String, String)> = sqlx::query_as(
        "SELECT ticket_id, author_kind, author_display, body FROM ticket_messages \
         WHERE tenant_id = $1 ORDER BY id",
    )
    .bind(tenant_a)
    .fetch_all(&owner)
    .await
    .unwrap();
    for (ticket, kind, display, body) in &bodies {
        let subjects_own = *ticket != a.other_ticket && kind == "player";
        if subjects_own {
            assert_eq!((display.as_str(), body.as_str()), (ERASED, ERASED));
        } else {
            assert_ne!(
                body.as_str(),
                ERASED,
                "staff replies and other players' messages survive erasure"
            );
        }
    }
    // The third-party rows in another player's ticket survive verbatim, including the
    // NULL-author relayed one (the ticket-membership arm is subject's-own-tickets only).
    let other_intact: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM ticket_messages WHERE ticket_id = $1 \
         AND body IN ('other player words', 'other relayed words')",
    )
    .bind(a.other_ticket)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(
        other_intact, 2,
        "another player's ticket messages must survive"
    );
    let other_subject: String = scalar(
        &owner,
        "SELECT subject FROM tickets WHERE id = $1",
        a.other_ticket,
    )
    .await;
    assert_eq!(other_subject, "other subject");
    let checkout_steam: Option<String> = scalar(
        &owner,
        "SELECT steam_id FROM checkout_sessions WHERE id = $1",
        a.checkout,
    )
    .await;
    assert_eq!(
        checkout_steam, None,
        "checkout steam_id is NULLed (nullable per 0003)"
    );
    let payload: Option<Value> = scalar(
        &owner,
        "SELECT payload FROM store_webhook_events WHERE id = $1",
        a.webhook_event,
    )
    .await;
    assert_eq!(payload, None, "matched webhook payload is NULLed");
    let other: Option<Value> = scalar(
        &owner,
        "SELECT payload FROM store_webhook_events WHERE id = $1",
        a.other_event,
    )
    .await;
    assert!(other.is_some(), "unmatched payloads survive");

    // Tenant B: byte-for-byte untouched.
    let subject: String = scalar(
        &owner,
        "SELECT subject FROM tickets WHERE id = $1",
        b.web_ticket,
    )
    .await;
    assert_eq!(subject, "web subject");
    let opener: Option<String> = scalar(
        &owner,
        "SELECT opener_discord_user_id FROM tickets WHERE id = $1",
        b.discord_ticket,
    )
    .await;
    assert_eq!(opener.as_deref(), Some(discord.as_str()));
    let intact: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM ticket_messages WHERE tenant_id = $1 AND body IN \
             ('player words', 'staff words', 'discord words')",
    )
    .bind(tenant_b)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(intact, 3, "tenant B's messages must be untouched");
    let checkout_steam: Option<String> = scalar(
        &owner,
        "SELECT steam_id FROM checkout_sessions WHERE id = $1",
        b.checkout,
    )
    .await;
    assert_eq!(checkout_steam.as_deref(), Some(steam.as_str()));
    let payload: Option<Value> = scalar(
        &owner,
        "SELECT payload FROM store_webhook_events WHERE id = $1",
        b.webhook_event,
    )
    .await;
    assert!(payload.is_some(), "tenant B's payload must survive");

    // One audit row for tenant A. Metadata carries scope + counts ONLY: no raw
    // identifiers and no identifier digests either (steam64/snowflake spaces are
    // enumerable, so an unsalted hash is reversible and would re-hold what the
    // erasure just scrubbed).
    let audits: Vec<(Option<Uuid>, Value)> = sqlx::query_as(
        "SELECT tenant_id, metadata FROM audit_log WHERE action = 'player.erase' \
         AND target_id = $1",
    )
    .bind(pid)
    .fetch_all(&owner)
    .await
    .unwrap();
    assert_eq!(audits.len(), 1);
    assert_eq!(audits[0].0, Some(tenant_a));
    assert_eq!(audits[0].1["scope"], "tenant");
    assert!(
        !audits[0].1.to_string().contains(&steam) && !audits[0].1.to_string().contains(&discord),
        "audit metadata must never carry raw identifiers: {}",
        audits[0].1
    );
    let keys: Vec<&String> = audits[0].1.as_object().unwrap().keys().collect();
    assert!(
        !keys.iter().any(|k| k.contains("hash")),
        "audit metadata must not carry identifier hashes either: {keys:?}"
    );
    assert!(audits[0].1["counts"].is_object(), "per-table counts kept");
}

#[tokio::test]
async fn entitlements_survive_platform_erasure_with_steam_id_intact() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP entitlements_survive...: TEST_DATABASE_URL unset");
        return;
    };
    let st = state(owner.clone(), app, Some(PRIVACY_TOKEN));
    let tenant_a = Uuid::new_v4();
    let tenant_b = Uuid::new_v4();
    let (pid, steam, discord) = subject_ids();
    let a = seed_tenant(&owner, tenant_a, pid, &steam, &discord).await;
    let b = seed_tenant(&owner, tenant_b, pid, &steam, &discord).await;

    let (status, resp) = send(
        &st,
        "POST",
        "/internal/privacy/erase",
        Some(PRIVACY_TOKEN),
        Some(platform_body(&steam, &discord, pid)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "platform erase: {resp}");
    assert_eq!(
        resp["counts"],
        json!({
            "tickets": 4, "ticket_messages": 4,
            "checkout_sessions": 2, "store_webhook_events": 2,
        }),
        "platform scope spans both tenants"
    );

    // Decision B: the entitlement rows keep their raw steam_id in BOTH tenants.
    for ent in [a.entitlement, b.entitlement] {
        let (ent_steam, ent_status): (Option<String>, String) =
            sqlx::query_as("SELECT steam_id, status FROM entitlements WHERE id = $1")
                .bind(ent)
                .fetch_one(&owner)
                .await
                .unwrap();
        assert_eq!(
            ent_steam.as_deref(),
            Some(steam.as_str()),
            "entitlements.steam_id is retained (proof-of-purchase, decision B)"
        );
        assert_eq!(ent_status, "active", "grant enforcement survives erasure");
    }

    // Platform-scope audit: one NULL-tenant row (the platform action shape).
    let audits: Vec<(Option<Uuid>, Value)> = sqlx::query_as(
        "SELECT tenant_id, metadata FROM audit_log WHERE action = 'player.erase' \
         AND target_id = $1",
    )
    .bind(pid)
    .fetch_all(&owner)
    .await
    .unwrap();
    assert_eq!(audits.len(), 1);
    assert_eq!(
        audits[0].0, None,
        "platform scope audits with a NULL tenant"
    );
    assert_eq!(audits[0].1["scope"], "platform");
}

#[tokio::test]
async fn dry_run_writes_nothing() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP dry_run_writes_nothing: TEST_DATABASE_URL unset");
        return;
    };
    let st = state(owner.clone(), app, Some(PRIVACY_TOKEN));
    let tenant = Uuid::new_v4();
    let (pid, steam, discord) = subject_ids();
    let s = seed_tenant(&owner, tenant, pid, &steam, &discord).await;

    let mut dry = platform_body(&steam, &discord, pid);
    dry["dry_run"] = json!(true);
    let (status, resp) = send(
        &st,
        "POST",
        "/internal/privacy/erase",
        Some(PRIVACY_TOKEN),
        Some(dry),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "dry run: {resp}");
    let dry_counts = resp["counts"].clone();
    assert_eq!(
        dry_counts,
        json!({
            "tickets": 2, "ticket_messages": 2,
            "checkout_sessions": 1, "store_webhook_events": 1,
        }),
        "dry-run counts are the would-be-affected rows"
    );

    // Nothing changed and nothing was audited.
    let subject: String = scalar(
        &owner,
        "SELECT subject FROM tickets WHERE id = $1",
        s.web_ticket,
    )
    .await;
    assert_eq!(subject, "web subject");
    let intact: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM ticket_messages WHERE tenant_id = $1 AND body IN \
             ('player words', 'staff words', 'discord words')",
    )
    .bind(tenant)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(intact, 3, "a dry run must not touch message bodies");
    let checkout_steam: Option<String> = scalar(
        &owner,
        "SELECT steam_id FROM checkout_sessions WHERE id = $1",
        s.checkout,
    )
    .await;
    assert_eq!(checkout_steam.as_deref(), Some(steam.as_str()));
    let payload: Option<Value> = scalar(
        &owner,
        "SELECT payload FROM store_webhook_events WHERE id = $1",
        s.webhook_event,
    )
    .await;
    assert!(payload.is_some(), "a dry run must not NULL payloads");
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE action = 'player.erase' AND target_id = $1",
    )
    .bind(pid)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(audits, 0, "a dry run writes NOTHING, audit included");

    // The real run affects exactly what the dry run predicted.
    let (status, resp) = send(
        &st,
        "POST",
        "/internal/privacy/erase",
        Some(PRIVACY_TOKEN),
        Some(platform_body(&steam, &discord, pid)),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        resp["counts"], dry_counts,
        "dry-run counts must match the real walk"
    );
}

#[tokio::test]
async fn double_erase_second_run_is_all_zero() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP double_erase...: TEST_DATABASE_URL unset");
        return;
    };
    let st = state(owner.clone(), app, Some(PRIVACY_TOKEN));
    let tenant = Uuid::new_v4();
    let (pid, steam, discord) = subject_ids();
    seed_tenant(&owner, tenant, pid, &steam, &discord).await;

    let (status, first) = send(
        &st,
        "POST",
        "/internal/privacy/erase",
        Some(PRIVACY_TOKEN),
        Some(platform_body(&steam, &discord, pid)),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["counts"]["tickets"], 2, "first run erases: {first}");

    let (status, second) = send(
        &st,
        "POST",
        "/internal/privacy/erase",
        Some(PRIVACY_TOKEN),
        Some(platform_body(&steam, &discord, pid)),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        second["counts"],
        json!({
            "tickets": 0, "ticket_messages": 0,
            "checkout_sessions": 0, "store_webhook_events": 0,
        }),
        "a re-run is a guarded no-op"
    );
}

#[tokio::test]
async fn request_validation_rejects_bad_scope_and_missing_identifiers() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP request_validation...: TEST_DATABASE_URL unset");
        return;
    };
    let st = state(owner, app, Some(PRIVACY_TOKEN));
    let (pid, steam, discord) = subject_ids();

    // Unknown scope_kind.
    let mut body = platform_body(&steam, &discord, pid);
    body["scope_kind"] = json!("org");
    let (status, _) = send(
        &st,
        "POST",
        "/internal/privacy/export",
        Some(PRIVACY_TOKEN),
        Some(body),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Tenant scope without tenant_id.
    let mut body = platform_body(&steam, &discord, pid);
    body["scope_kind"] = json!("tenant");
    let (status, _) = send(
        &st,
        "POST",
        "/internal/privacy/erase",
        Some(PRIVACY_TOKEN),
        Some(body),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // No identifiers at all.
    let body = json!({
        "scope_kind": "platform", "tenant_id": null,
        "steam_id": null, "discord_id": null, "player_account_id": null,
    });
    let (status, _) = send(
        &st,
        "POST",
        "/internal/privacy/export",
        Some(PRIVACY_TOKEN),
        Some(body),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // All-whitespace identifiers trim away to nothing: still a 400.
    let body = json!({
        "scope_kind": "platform", "tenant_id": null,
        "steam_id": "   ", "discord_id": "\t ", "player_account_id": null,
    });
    let (status, _) = send(
        &st,
        "POST",
        "/internal/privacy/erase",
        Some(PRIVACY_TOKEN),
        Some(body),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // deny_unknown_fields: dry_run does not exist on export, and typos never pass
    // silently on a privacy surface.
    let mut body = platform_body(&steam, &discord, pid);
    body["dry_run"] = json!(true);
    let (status, _) = send(
        &st,
        "POST",
        "/internal/privacy/export",
        Some(PRIVACY_TOKEN),
        Some(body),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let mut body = platform_body(&steam, &discord, pid);
    body["scope"] = json!("platform");
    let (status, _) = send(
        &st,
        "POST",
        "/internal/privacy/erase",
        Some(PRIVACY_TOKEN),
        Some(body),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

/// Decision B2: every tenant-schema table must hold an explicit privacy stance. A
/// migration adding a table without classifying it fails here; a stale entry for a
/// dropped table fails too.
#[tokio::test]
async fn every_tenant_table_is_classified() {
    let Some((owner, _app)) = setup().await else {
        eprintln!("SKIP every_tenant_table_is_classified: TEST_DATABASE_URL unset");
        return;
    };
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT table_name::text FROM information_schema.tables \
         WHERE table_schema = 'tenant' AND table_type = 'BASE TABLE'",
    )
    .fetch_all(&owner)
    .await
    .unwrap();
    assert!(!tables.is_empty(), "the tenant schema must exist");

    for table in &tables {
        assert!(
            CLASSIFIED.iter().any(|(name, _)| name == table),
            "UNCLASSIFIED tenant table `{table}`: every table must be classified \
             Walked / NoPlayerData / RetainedWithBasis in domain::privacy::CLASSIFIED \
             (decision B2), and the walkers updated if it holds player data"
        );
    }
    for (name, _) in CLASSIFIED {
        assert!(
            tables.iter().any(|t| t == name),
            "stale CLASSIFIED entry `{name}`: no such table in the tenant schema"
        );
    }
    // The pinned stances the walk depends on.
    let stance = |n: &str| CLASSIFIED.iter().find(|(name, _)| *name == n).unwrap().1;
    assert_eq!(stance("entitlements"), Classification::RetainedWithBasis);
    assert_eq!(stance("tickets"), Classification::Walked);
    assert_eq!(stance("ticket_messages"), Classification::Walked);
    assert_eq!(stance("checkout_sessions"), Classification::Walked);
    assert_eq!(stance("store_webhook_events"), Classification::Walked);
}
