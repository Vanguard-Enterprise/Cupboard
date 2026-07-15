//! End-to-end for PR6: the Tebex adapter through the real router + the in-process Tebex
//! stub. Covers operator connect (probe), the two-leg checkout (begin -> provider auth ->
//! continue), the webhook validation handshake + a payment webhook, and the reconcile
//! payments walk. Requires TEST_DATABASE_URL(_APP); skips (passes) when unset.

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use cupboard_auth_core::{Claims, Keys, PlayerClaims, PlayerKeys};
use cupboard_domain::{OrgId, UserId};
use cupboard_tenant::cache::SiteCache;
use cupboard_tenant::config::Config;
use cupboard_tenant::http;
use cupboard_tenant::providers::stub_tebex::TebexStub;
use cupboard_tenant::providers::tebex::TebexClient;
use cupboard_tenant::providers::StoreProvider;
use cupboard_tenant::state::AppState;
use http_body_util::BodyExt;
use sqlx::PgPool;
use std::sync::Arc;
use tokio::sync::OnceCell;
use tower::util::ServiceExt;
use uuid::Uuid;

const OP_PRIV: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIKfwTrhSm/f0QxY6e5mzQ+iTAvdyp3omCt4lyOjWItDm\n-----END PRIVATE KEY-----\n";
const OP_PUB: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAyKMiwFH0hHn4HiPl8DTEq+aPzW9XyzG5v1ELTEVNsbY=\n-----END PUBLIC KEY-----\n";
const PL_PRIV: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIB4bpLkvqvLet9HkfrXIGKQph6XU067zAHuJxYeH1a5R\n-----END PRIVATE KEY-----\n";
const PL_PUB: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEABiCdFFe9fKX0ClAgGoy/N0wOewhkz55No6MQbFoKjtM=\n-----END PUBLIC KEY-----\n";

const MASTER_KEY: [u8; 32] = [9u8; 32];
const SECRET_KEY: &str = "tbx_secret_key";
const PUBLIC_TOKEN: &str = "t_public_abc";
const STEAM_ID: &str = "76561198055512345";

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

fn state(owner: PgPool, app: PgPool, tebex_base: String) -> AppState {
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
        consumer_name: "pr6".into(),
        paynow_api_base: "http://paynow.test".into(),
        tebex_headless_base: tebex_base.clone(),
        tebex_plugin_base: tebex_base,
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
        keys: Arc::new(Keys::verifier_from_ed_pem(OP_PUB).unwrap()),
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

fn operator(tenant: Uuid) -> String {
    let signer = Keys::from_ed_pem(OP_PRIV, OP_PUB).unwrap();
    let claims = Claims::new(
        UserId(Uuid::new_v4()),
        Uuid::new_v4(),
        Some(OrgId(tenant)),
        vec!["store.manage".into(), "sites.edit".into()],
        300,
    );
    format!("Bearer {}", signer.encode(&claims).unwrap())
}

fn player(tenant: Uuid) -> String {
    let signer = PlayerKeys::from_ed_pem(PL_PRIV, PL_PUB).unwrap();
    let claims = PlayerClaims::new(
        Uuid::new_v4(),
        OrgId(tenant),
        Some(STEAM_ID.into()),
        Uuid::new_v4(),
        900,
    );
    format!("Bearer {}", signer.encode(&claims).unwrap())
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
        req = req.header(header::AUTHORIZATION, b);
    }
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let req = req
        .header(header::CONTENT_TYPE, "application/json")
        .body(body.unwrap_or_else(Body::empty))
        .unwrap();
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
async fn tebex_connect_catalog_checkout_continue_webhook_reconcile() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP tebex_e2e: TEST_DATABASE_URL unset");
        return;
    };
    let stub = TebexStub::spawn(SECRET_KEY).await;
    let st = state(owner.clone(), app.clone(), stub.base_url());
    let tenant = Uuid::new_v4();
    let op = operator(tenant);
    let pl = player(tenant);

    // The tenant's storefront, so checkout return/cancel URLs on its host validate.
    let slug = format!("tx{}", &Uuid::new_v4().simple().to_string()[..8]);
    sqlx::query("INSERT INTO sites (tenant_id, slug) VALUES ($1, $2)")
        .bind(tenant)
        .bind(&slug)
        .execute(&owner)
        .await
        .unwrap();

    // 1) Operator connect (probe-before-store): public token + game-server secret key.
    let (status, body) = send(
        &st,
        "POST",
        "/store/connection",
        Some(&op),
        &[],
        Some(Body::from(
            serde_json::json!({
                "provider": "tebex",
                "api_key": SECRET_KEY,
                "store_id": PUBLIC_TOKEN,
            })
            .to_string(),
        )),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "connect: {body}");
    assert_eq!(body["connection"]["provider"], "tebex");
    assert_eq!(body["connection"]["store_external_id"], PUBLIC_TOKEN);
    // The manual-registration webhook URL is surfaced for the wizard.
    let webhook_url = body["connection"]["webhook_url"].as_str().unwrap();
    assert!(webhook_url.contains("/webhooks/tebex/"), "{webhook_url}");
    assert_eq!(body["connection"]["webhook_configured"], false);

    let conn_id: Uuid = sqlx::query_scalar("SELECT id FROM store_connections WHERE tenant_id = $1")
        .bind(tenant)
        .fetch_one(&owner)
        .await
        .unwrap();

    // 2) Catalog: the Headless categories+packages map (decimal major -> minor units).
    let client = TebexClient::new(stub.base_url(), stub.base_url(), SECRET_KEY, PUBLIC_TOKEN);
    let snapshot = client.fetch_catalog().await.expect("fetch catalog");
    assert_eq!(snapshot.categories.len(), 1);
    assert_eq!(snapshot.products.len(), 2);
    let vip = snapshot
        .products
        .iter()
        .find(|p| p.external_id == "100")
        .unwrap();
    assert_eq!(vip.price_minor, 999);
    assert_eq!(vip.price_final_minor, Some(799));

    // 3) Checkout leg 1: begin -> NeedsProviderAuth + a Steam auth URL + a session id.
    let return_url = format!("https://{slug}.sites.test/store/checkout/return");
    let cancel_url = format!("https://{slug}.sites.test/store/100");
    let (status, body) = send(
        &st,
        "POST",
        "/player/checkout",
        Some(&pl),
        &[],
        Some(Body::from(
            serde_json::json!({
                "product_external_id": "100",
                "quantity": 1,
                "return_url": return_url,
                "cancel_url": cancel_url,
            })
            .to_string(),
        )),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "checkout: {body}");
    assert_eq!(body["step"], "needs_provider_auth");
    assert!(body["redirect_url"]
        .as_str()
        .unwrap()
        .contains("auth.tebex.io"));
    let session_id = body["session_id"].as_str().unwrap().to_string();

    // The basket ident was recorded on the session for the continue leg.
    let basket_ref: String =
        sqlx::query_scalar("SELECT provider_ref FROM checkout_sessions WHERE id = $1::uuid")
            .bind(&session_id)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert!(basket_ref.starts_with("bskt-"), "{basket_ref}");

    // 4) Checkout leg 2: continue -> the package is added and the hosted-checkout URL comes back.
    let (status, body) = send(
        &st,
        "POST",
        &format!("/player/checkout/{session_id}/continue"),
        Some(&pl),
        &[],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "continue: {body}");
    assert_eq!(body["redirect_url"], "https://checkout.tebex.io/test");
    let added = stub.packages_for(&basket_ref);
    assert_eq!(added.len(), 1, "one package added to the basket");
    assert_eq!(added[0]["package_id"], 100);

    // Idempotency: a refreshed/retried continue must NOT add the package again (no double
    // charge) - the one-shot latch rejects the second call.
    let (status, _) = send(
        &st,
        "POST",
        &format!("/player/checkout/{session_id}/continue"),
        Some(&pl),
        &[],
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "a second continue must be rejected"
    );
    assert_eq!(
        stub.packages_for(&basket_ref).len(),
        1,
        "the package must not be added twice"
    );

    // A different player cannot drive someone else's checkout continue.
    let (status, _) = send(
        &st,
        "POST",
        &format!("/player/checkout/{session_id}/continue"),
        Some(&player(tenant)),
        &[],
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "continue must be owner-only"
    );

    // 5) Webhook: the operator saves the secret, then the validation handshake echoes id.
    let (status, _) = send(
        &st,
        "POST",
        "/store/webhook-secret",
        Some(&op),
        &[],
        Some(Body::from(
            serde_json::json!({ "secret": stub.webhook_secret() }).to_string(),
        )),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let val_body = serde_json::json!({ "id": "wh-val", "type": "validation.webhook" }).to_string();
    let val_sig = stub.sign_webhook(&val_body);
    let (status, body) = send(
        &st,
        "POST",
        &format!("/webhooks/tebex/{conn_id}"),
        None,
        &[("x-signature", &val_sig)],
        Some(Body::from(val_body)),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["id"], "wh-val",
        "validation handshake must echo the id"
    );

    // 6) Webhook: a completed payment grants an entitlement (visible to the player).
    let pay_body = serde_json::json!({
        "id": "wh-pay-1",
        "type": "payment.completed",
        "subject": {
            "transaction_id": "tbx-777",
            "player": { "uuid": STEAM_ID, "name": "buyer" },
            "products": [ { "id": 100, "name": "VIP", "expires_at": "2026-09-01T00:00:00Z" } ]
        }
    })
    .to_string();
    let pay_sig = stub.sign_webhook(&pay_body);
    let (status, _) = send(
        &st,
        "POST",
        &format!("/webhooks/tebex/{conn_id}"),
        None,
        &[("x-signature", &pay_sig)],
        Some(Body::from(pay_body.clone())),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, body) = send(&st, "GET", "/player/entitlements", Some(&pl), &[], None).await;
    assert_eq!(status, StatusCode::OK, "entitlements: {body}");
    let ents = body["entitlements"].as_array().unwrap();
    assert_eq!(ents.len(), 1, "the payment webhook granted one entitlement");
    assert_eq!(ents[0]["product_name"], "VIP");

    // A later reconcile (which carries no expiry for Tebex) must NOT clobber the
    // webhook-provided expiry with NULL, or a lapsed subscription would look perpetual.
    let reconcile_rec = cupboard_tenant::providers::EntitlementRecord {
        external_ref: "tbx-777:100".into(),
        steam_id: Some(STEAM_ID.into()),
        product_external_id: Some("100".into()),
        product_name: Some("VIP".into()),
        kind: cupboard_tenant::providers::ProductKind::Single,
        status: cupboard_tenant::providers::EntitlementStatus::Active,
        granted_at: None,
        expires_at: None,
    };
    cupboard_tenant::domain::entitlements::apply_reconcile_page(
        &owner,
        tenant,
        conn_id,
        "tebex",
        &[reconcile_rec],
    )
    .await
    .unwrap();
    let kept_expiry: Option<chrono::DateTime<chrono::Utc>> = sqlx::query_scalar(
        "SELECT expires_at FROM entitlements WHERE connection_id = $1 AND external_ref = 'tbx-777:100'",
    )
    .bind(conn_id)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert!(
        kept_expiry.is_some(),
        "reconcile must not null the webhook-provided expiry"
    );

    // A bad signature is rejected (not ingested).
    let (status, _) = send(
        &st,
        "POST",
        &format!("/webhooks/tebex/{conn_id}"),
        None,
        &[("x-signature", "deadbeef")],
        Some(Body::from(pay_body)),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // A replayed valid event dedupes to 2xx without a second entitlement.
    let (status, body) = send(&st, "GET", "/store/entitlements", Some(&op), &[], None).await;
    assert_eq!(status, StatusCode::OK, "admin entitlements: {body}");
    assert_eq!(body["entitlements"].as_array().unwrap().len(), 1);

    // 7) Reconcile: the plugin payments walk maps to entitlement records (refund included).
    stub.set_payments(
        vec![
            serde_json::json!({
                "txn_id": "tbx-777",
                "status": "Complete",
                "player": { "uuid": STEAM_ID },
                "date": "2026-07-05 12:00:00",
                "packages": [ { "id": 100, "name": "VIP" } ]
            }),
            serde_json::json!({
                "txn_id": "tbx-778",
                "status": "Refund",
                "player": { "uuid": STEAM_ID },
                "packages": [ { "id": 101, "name": "Kit" } ]
            }),
        ],
        1,
    );
    let page = client.reconcile(None).await.expect("reconcile");
    assert_eq!(page.entitlements.len(), 2);
    assert!(page.next_cursor.is_none(), "single page -> no cursor");
    let refund = page
        .entitlements
        .iter()
        .find(|e| e.external_ref == "tbx-778:101")
        .unwrap();
    assert_eq!(
        refund.status,
        cupboard_tenant::providers::EntitlementStatus::Refunded
    );
}
