//! End-to-end for PR4: a player checkout (customer upsert -> hosted checkout URL), the
//! webhook receiver (signed, deduped, applied to the entitlement ledger), and the
//! reconcile backstop. Drives the real router against the in-process PayNow stub.
//!
//! Requires TEST_DATABASE_URL(_APP); skips (passes) when unset.

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use cupboard_auth_core::{PlayerClaims, PlayerKeys};
use cupboard_domain::OrgId;
use cupboard_tenant::cache::SiteCache;
use cupboard_tenant::config::Config;
use cupboard_tenant::domain::{entitlements, store};
use cupboard_tenant::http;
use cupboard_tenant::providers::stub::PayNowStub;
use cupboard_tenant::providers::{paynow::PayNowClient, StoreProvider};
use cupboard_tenant::state::AppState;
use http_body_util::BodyExt;
use sqlx::PgPool;
use std::sync::Arc;
use tokio::sync::OnceCell;
use tower::util::ServiceExt;
use uuid::Uuid;

// Player keypair (openssl genpkey ed25519); the tenant verifies player tokens with it.
const PL_PRIV: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIB4bpLkvqvLet9HkfrXIGKQph6XU067zAHuJxYeH1a5R\n-----END PRIVATE KEY-----\n";
const PL_PUB: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEABiCdFFe9fKX0ClAgGoy/N0wOewhkz55No6MQbFoKjtM=\n-----END PUBLIC KEY-----\n";
const OP_PUB: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA18nW4fku7YaJR/+EY40xK+IKw9I6mV3/q9M5RO5ambs=\n-----END PUBLIC KEY-----\n";

const MASTER_KEY: [u8; 32] = [4u8; 32];
const STUB_API_KEY: &str = "pnapi_v1_pr4";
const STEAM_ID: &str = "76561198055500000";

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

fn state(owner: PgPool, app: PgPool, paynow_base: String) -> AppState {
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
        tenant_master_key: Some(MASTER_KEY),
        consumer_name: "pr4".into(),
        paynow_api_base: paynow_base,
        tebex_headless_base: "http://tebex.test".into(),
        tebex_plugin_base: "http://tebex.test".into(),
        internal_api_token: None,
        bot_api_token: None,
        player_jwt_public_key_pem: Some(PL_PUB.into()),
        public_webhook_base: Some("https://hooks.test".into()),
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
    };
    AppState {
        owner_pool: owner,
        app_pool: app,
        keys: Arc::new(cupboard_auth_core::Keys::verifier_from_ed_pem(OP_PUB).unwrap()),
        player_keys: Some(Arc::new(PlayerKeys::verifier_from_ed_pem(PL_PUB).unwrap())),
        cache: SiteCache::disabled(),
        site_miss_budget: Arc::new(Default::default()),
        catalog_miss_budget: Arc::new(Default::default()),
        http: reqwest::Client::new(),
        bus: None,
        verified_prices: Arc::new(Default::default()),
        config: Arc::new(config),
    }
}

fn player_token(tenant: Uuid) -> String {
    let signer = PlayerKeys::from_ed_pem(PL_PRIV, PL_PUB).unwrap();
    let claims = PlayerClaims::new(
        Uuid::new_v4(),
        OrgId(tenant),
        Some(STEAM_ID.into()),
        Uuid::new_v4(),
        900,
    );
    signer.encode(&claims).unwrap()
}

/// Seed a connected PayNow store (probe + sealed key) for a tenant; returns its id.
async fn seed_store(owner: &PgPool, stub: &PayNowStub, tenant: Uuid) -> Uuid {
    let mut client = PayNowClient::new(stub.base_url(), STUB_API_KEY, None::<String>);
    let info = client.probe().await.expect("probe");
    let sealed = cupboard_crypto::seal(&MASTER_KEY, STUB_API_KEY.as_bytes()).unwrap();
    // claimed_by is set so the webhook-registration fence (which requires the lease)
    // matches in this test's seed path.
    sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO store_connections \
             (tenant_id, provider, status, api_key_enc, api_key_dek, store_external_id, \
              claimed_by, heartbeat_at) \
         VALUES ($1, 'paynow', 'connected', $2, $3, $4, 'seed', now()) RETURNING id",
    )
    .bind(tenant)
    .bind(&sealed.ciphertext)
    .bind(&sealed.wrapped_dek)
    .bind(&info.external_id)
    .fetch_one(owner)
    .await
    .expect("seed store")
}

async fn send(
    st: &AppState,
    method: &str,
    path: &str,
    bearer: Option<&str>,
    headers: &[(&str, &str)],
    body: Option<Body>,
) -> (StatusCode, serde_json::Value) {
    let mut req = Request::builder().method(method).uri(path);
    if let Some(b) = bearer {
        req = req.header(header::AUTHORIZATION, format!("Bearer {b}"));
    }
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let req = req.body(body.unwrap_or_else(Body::empty)).unwrap();
    let resp = http::router(st.clone()).oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let val = if bytes.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
    };
    (status, val)
}

#[tokio::test]
async fn checkout_then_webhook_then_reconcile() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP checkout_then_webhook_then_reconcile: TEST_DATABASE_URL unset");
        return;
    };
    let stub = PayNowStub::spawn(STUB_API_KEY).await;
    let st = state(owner.clone(), app.clone(), stub.base_url());
    let tenant = Uuid::new_v4();
    let conn_id = seed_store(&owner, &stub, tenant).await;
    let token = player_token(tenant);

    // The tenant's storefront, so checkout return/cancel URLs on its host validate.
    let host_slug = format!("cx{}", &Uuid::new_v4().simple().to_string()[..8]);
    sqlx::query("INSERT INTO sites (tenant_id, slug) VALUES ($1, $2)")
        .bind(tenant)
        .bind(&host_slug)
        .execute(&owner)
        .await
        .unwrap();
    let store_host = format!("{host_slug}.sites.test");

    // 1. Checkout: player -> hosted checkout URL, and a customer is upserted at PayNow.
    let (status, body) = send(
        &st,
        "POST",
        "/player/checkout",
        Some(&token),
        &[("content-type", "application/json")],
        Some(Body::from(
            serde_json::json!({
                "product_external_id": "p_vip",
                "quantity": 1,
                "return_url": format!("https://{store_host}/store/checkout/return"),
                "cancel_url": format!("https://{store_host}/store/p_vip")
            })
            .to_string(),
        )),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "checkout failed: {body}");
    assert!(body["redirect_url"]
        .as_str()
        .unwrap()
        .contains("pay.paynow.gg"));
    assert_eq!(stub.customers().len(), 1, "a customer was upserted");
    assert_eq!(stub.customers()[0]["steam_id"], STEAM_ID);

    // An operator token must NOT be accepted on a player route (belt-and-braces; the key
    // separation is proven in auth-core, this checks the tenant verifier is wired).
    let op = "not.a.valid.player.token";
    let (status, _) = send(&st, "GET", "/player/entitlements", Some(op), &[], None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // 2. Register a webhook via the runner path so the receiver has a secret to verify
    // against (mirrors what the store runner does on its first tick).
    let client = PayNowClient::new(
        stub.base_url(),
        STUB_API_KEY,
        Some(store_ext(&owner, conn_id).await),
    );
    let reg = client
        .register_webhook(&format!("https://hooks.test/webhooks/paynow/{conn_id}"))
        .await
        .expect("register")
        .expect("paynow supports registration");
    let sealed = cupboard_crypto::seal(&MASTER_KEY, reg.signing_secret.as_bytes()).unwrap();
    store::save_webhook_registration(
        &owner,
        conn_id,
        "seed",
        &store_key(&owner, conn_id).await,
        &sealed.ciphertext,
        &sealed.wrapped_dek,
        &reg.external_id,
    )
    .await
    .expect("save webhook reg");
    // The seed used claimer 'seed' + the real key fence; verify it landed.
    assert!(store::load_fresh(&owner, conn_id)
        .await
        .unwrap()
        .unwrap()
        .webhook_external_id
        .is_some());

    // 3. Deliver a signed webhook (delivery-item added) -> entitlement ledger.
    let ts = chrono::Utc::now().timestamp_millis().to_string();
    let event_body = serde_json::json!({
        "event_type": "ON_DELIVERY_ITEM_ADDED",
        "event_id": "evt_1",
        "body": {
            "id": "di_100",
            "state": "active",
            "product": {"id": "p_vip", "name": "VIP Rank"},
            "customer": {"steam_id": STEAM_ID},
            "active_at": "2026-07-05T12:00:00Z"
        }
    })
    .to_string();
    let sig = stub.sign_webhook(&ts, &event_body);
    let (status, _) = send(
        &st,
        "POST",
        &format!("/webhooks/paynow/{conn_id}"),
        None,
        &[
            ("content-type", "application/json"),
            ("paynow-signature", &sig),
            ("paynow-timestamp", &ts),
        ],
        Some(Body::from(event_body.clone())),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "webhook must be accepted");

    // The player now sees the entitlement.
    let (status, body) = send(&st, "GET", "/player/entitlements", Some(&token), &[], None).await;
    assert_eq!(status, StatusCode::OK);
    let ents = body["entitlements"].as_array().unwrap();
    assert_eq!(ents.len(), 1);
    assert_eq!(ents[0]["product_name"], "VIP Rank");

    // Replayed webhook (same event_id) is a dedup'd no-op, still 2xx.
    let (status, _) = send(
        &st,
        "POST",
        &format!("/webhooks/paynow/{conn_id}"),
        None,
        &[
            ("content-type", "application/json"),
            ("paynow-signature", &sig),
            ("paynow-timestamp", &ts),
        ],
        Some(Body::from(event_body.clone())),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let events: i64 =
        sqlx::query_scalar("SELECT count(*) FROM store_webhook_events WHERE connection_id = $1")
            .bind(conn_id)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(events, 1, "replay must not create a second event row");

    // A bad signature is rejected.
    let (status, _) = send(
        &st,
        "POST",
        &format!("/webhooks/paynow/{conn_id}"),
        None,
        &[
            ("content-type", "application/json"),
            ("paynow-signature", "wrong"),
            ("paynow-timestamp", &ts),
        ],
        Some(Body::from(event_body)),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // 4. Reconcile backstop: the provider reports the item as revoked; a reconcile page
    // converges the ledger (provider-wins), even though no webhook was sent for it.
    stub.set_delivery_items(vec![serde_json::json!({
        "id": "di_100",
        "state": "revoked",
        "product": {"id": "p_vip", "name": "VIP Rank"},
        "customer": {"steam_id": STEAM_ID}
    })]);
    let page = client.reconcile(None).await.expect("reconcile");
    entitlements::apply_reconcile_page(&owner, tenant, conn_id, "paynow", &page.entitlements)
        .await
        .expect("apply reconcile");
    // No longer active -> the player's active list is empty.
    let (_s, body) = send(&st, "GET", "/player/entitlements", Some(&token), &[], None).await;
    assert!(
        body["entitlements"].as_array().unwrap().is_empty(),
        "revoked entitlement drops out"
    );
    let revoked: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM entitlements WHERE connection_id = $1 AND status = 'revoked'",
    )
    .bind(conn_id)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(revoked, 1, "reconcile converged the ledger to revoked");

    // 5. Terminal-status guard: a LAGGING reconcile that still reports the item active
    // (provider eventual consistency) must NOT resurrect the revoked entitlement.
    stub.set_delivery_items(vec![serde_json::json!({
        "id": "di_100",
        "state": "active",
        "product": {"id": "p_vip", "name": "VIP Rank"},
        "customer": {"steam_id": STEAM_ID}
    })]);
    let page = client.reconcile(None).await.expect("reconcile2");
    entitlements::apply_reconcile_page(&owner, tenant, conn_id, "paynow", &page.entitlements)
        .await
        .expect("apply reconcile2");
    let still_revoked: String =
        sqlx::query_scalar("SELECT status FROM entitlements WHERE connection_id = $1")
            .bind(conn_id)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(
        still_revoked, "revoked",
        "a stale reconcile must not resurrect a revoked entitlement to active"
    );

    // 6. Absent-sweep: grant a fresh entitlement via webhook, then a COMPLETE reconcile
    // that no longer lists it (provider dropped it) expires it.
    let ts2 = chrono::Utc::now().timestamp_millis().to_string();
    let body2 = serde_json::json!({
        "event_type": "ON_DELIVERY_ITEM_ADDED",
        "event_id": "evt_2",
        "body": {
            "id": "di_200", "state": "active",
            "product": {"id": "p_gold", "name": "Gold"},
            "customer": {"steam_id": STEAM_ID}
        }
    })
    .to_string();
    let sig2 = stub.sign_webhook(&ts2, &body2);
    let (s, _) = send(
        &st,
        "POST",
        &format!("/webhooks/paynow/{conn_id}"),
        None,
        &[
            ("content-type", "application/json"),
            ("paynow-signature", &sig2),
            ("paynow-timestamp", &ts2),
        ],
        Some(Body::from(body2)),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    // Provider now returns an EMPTY delivery list (di_200 dropped entirely).
    stub.set_delivery_items(vec![]);
    let page = client.reconcile(None).await.expect("reconcile3");
    let seen: Vec<String> = page
        .entitlements
        .iter()
        .map(|e| e.external_ref.clone())
        .collect();
    entitlements::apply_reconcile_page(&owner, tenant, conn_id, "paynow", &page.entitlements)
        .await
        .expect("apply3");
    let expired = entitlements::sweep_absent_actives(&owner, conn_id, &seen)
        .await
        .expect("sweep");
    assert_eq!(
        expired, 1,
        "an entitlement absent from a complete reconcile is expired"
    );
    let gold_status: String = sqlx::query_scalar(
        "SELECT status FROM entitlements WHERE connection_id = $1 AND external_ref = 'di_200'",
    )
    .bind(conn_id)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(gold_status, "expired");

    // 7. Checkout URL validation: a return_url on a host NOT owned by this tenant is
    // rejected (open-redirect guard); a plain http URL is rejected (must be https).
    let (status, _) = send(
        &st,
        "POST",
        "/player/checkout",
        Some(&token),
        &[("content-type", "application/json")],
        Some(Body::from(
            serde_json::json!({
                "product_external_id": "p_vip", "quantity": 1,
                "return_url": "https://attacker.example/phish",
                "cancel_url": format!("https://{store_host}/store")
            })
            .to_string(),
        )),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "foreign return_url must be rejected"
    );

    let (status, _) = send(
        &st,
        "POST",
        "/player/checkout",
        Some(&token),
        &[("content-type", "application/json")],
        Some(Body::from(
            serde_json::json!({
                "product_external_id": "p_vip", "quantity": 1,
                "return_url": format!("http://{store_host}/store/checkout/return"),
                "cancel_url": format!("https://{store_host}/store")
            })
            .to_string(),
        )),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "http (non-https) return_url must be rejected"
    );
}

async fn store_ext(owner: &PgPool, conn_id: Uuid) -> String {
    store::load_fresh(owner, conn_id)
        .await
        .unwrap()
        .unwrap()
        .store_external_id
}

async fn store_key(owner: &PgPool, conn_id: Uuid) -> Vec<u8> {
    store::load_fresh(owner, conn_id)
        .await
        .unwrap()
        .unwrap()
        .api_key_enc
        .unwrap()
}
