use crate::{auth::AuthConfig, connect, router_with_auth};
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use serde_json::{Value, json};
use tower::ServiceExt;

struct Client {
    app: Router,
    cookie: String,
}
impl Client {
    fn new(app: &Router) -> Self {
        Self {
            app: app.clone(),
            cookie: String::new(),
        }
    }
    async fn request(&mut self, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(format!("/app-api/{path}"))
            .header("origin", "http://localhost:5173")
            .header("x-cupboard-request", "1")
            .header("content-type", "application/json");
        if !self.cookie.is_empty() {
            request = request.header("cookie", &self.cookie);
        }
        let response = self
            .app
            .clone()
            .oneshot(request.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        if let Some(cookie) = response.headers().get(header::SET_COOKIE) {
            let cookie = cookie.to_str().unwrap();
            if !cookie.starts_with("cupboard_session=;") {
                assert!(cookie.contains("HttpOnly"));
                assert!(cookie.contains("SameSite=Lax"));
            }
            self.cookie = cookie.split(';').next().unwrap().to_owned();
        }
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-store"
        );
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 100_000).await.unwrap();
        let value = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| panic!("unexpected non-JSON response: {status}"));
        (status, value)
    }
    async fn signup(&mut self, email: &str) {
        let (status,value)=self.request("POST","auth/signup",json!({"name":"Test operator","email":email,"password":"a sufficiently long test password"})).await;
        assert_eq!(status, StatusCode::OK, "{value}");
    }
    async fn create_organization(&mut self) {
        let (status, value) = self
            .request("POST", "organizations", json!({"name":"Test organization"}))
            .await;
        assert_eq!(status, StatusCode::OK, "{value}");
    }
    async fn create_role(&mut self, name: &str, permissions: &[&str]) -> Value {
        let (status, response) = self.change(json!({"kind":"createRole","role":{"id":"new","name":name,"description":"","permissions":permissions,"system":false,"position":0}})).await;
        assert_eq!(status, StatusCode::OK, "{response}");
        response["team"]["roles"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["name"] == name)
            .unwrap()
            .clone()
    }
    async fn team(&mut self) -> Value {
        let (status, value) = self.request("GET", "team", json!(null)).await;
        assert_eq!(status, StatusCode::OK, "{value}");
        value
    }
    async fn change(&mut self, change: Value) -> (StatusCode, Value) {
        let revision = self.team().await["revision"].clone();
        self.request("POST", "team", json!({"revision":revision,"change":change}))
            .await
    }
}
#[tokio::test]
async fn accounts_sessions_membership_roles_and_tenant_isolation() {
    let pool = connect(&std::env::var("CUPBOARD_TEST_DATABASE_URL").unwrap())
        .await
        .unwrap();
    let config = AuthConfig {
        secure_cookies: false,
        ..Default::default()
    };
    let app = router_with_auth(pool.clone(), config.clone());
    let mut alice = Client::new(&app);
    let mut bob = Client::new(&app);
    let mut stranger = Client::new(&app);
    let suffix = uuid::Uuid::new_v4();
    let alice_email = format!("alice-{suffix}@example.com");
    let bob_email = format!("bob-{suffix}@example.com");
    let stranger_email = format!("stranger-{suffix}@example.com");
    assert_eq!(
        alice.request("GET", "team", json!(null)).await.0,
        StatusCode::UNAUTHORIZED
    );
    alice.signup(&alice_email).await;
    alice.create_organization().await;
    let viewer = alice.create_role("Viewer", &["servers.view"]).await;
    bob.signup(&bob_email).await;
    bob.create_organization().await;
    stranger.signup(&stranger_email).await;
    let identity = alice.request("GET", "auth/me", json!(null)).await.1;
    let org = identity["organization"]["id"].clone();
    assert!(!identity.to_string().contains("password"));
    assert!(
        identity["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p == "organization.manage")
    );
    let owner_id = alice.team().await["currentUserId"].clone();
    assert_eq!(
        bob.request("POST", "auth/organization", json!({"id":org}))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let role = json!({"id":"client-placeholder","name":"Support","description":"Support staff","permissions":["servers.view"],"system":false,"position":0});
    let (status, created) = alice.change(json!({"kind":"createRole","role":role})).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let custom = created["team"]["roles"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == "Support")
        .unwrap()
        .clone();
    assert_eq!(
        bob.change(json!({"kind":"deleteRole","id":custom["id"]}))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        bob.change(json!({"kind":"removeUser","id":owner_id}))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let mut owner_role = alice.team().await["roles"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == "owner")
        .unwrap()
        .clone();
    owner_role["permissions"] = json!([]);
    assert_eq!(
        alice
            .change(json!({"kind":"updateRole","role":owner_role}))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        alice
            .change(json!({"kind":"removeUser","id":owner_id}))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let (status,invite)=alice.change(json!({"kind":"invite","user":{"id":"ignored","name":"Bob","email":bob_email,"roleIds":[viewer["id"]],"status":"invited","lastActiveAt":null}})).await;
    assert_eq!(status, StatusCode::OK, "{invite}");
    let token = invite["invitationToken"].as_str().unwrap();
    assert_eq!(token.len(), 64);
    assert!(!invite["team"].to_string().contains(token));
    assert_eq!(
        stranger
            .request("POST", "invitations/accept", json!({"token":token}))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        bob.request("POST", "invitations/accept", json!({"token":token}))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        bob.request("POST", "invitations/accept", json!({"token":token}))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        bob.request("GET", "team", json!(null)).await.0,
        StatusCode::FORBIDDEN
    );
    let identity = bob.request("GET", "auth/me", json!(null)).await.1;
    assert_eq!(identity["organization"]["id"], org);
    assert_eq!(identity["permissions"], json!(["servers.view"]));
    let mut member = alice.team().await["users"]
        .as_array()
        .unwrap()
        .iter()
        .find(|u| u["email"] == bob_email)
        .unwrap()
        .clone();
    member["roleIds"] = json!(["administrator"]);
    assert_eq!(
        alice
            .change(json!({"kind":"updateUser","user":member}))
            .await
            .0,
        StatusCode::OK
    );
    // Changes affect an existing session immediately.
    assert_eq!(
        bob.request("GET", "team", json!(null)).await.0,
        StatusCode::OK
    );
    let elevated = json!({"id":"new","name":"Escalated","description":"","permissions":["billing.manage"],"system":false,"position":0});
    assert_eq!(
        bob.change(json!({"kind":"createRole","role":elevated}))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        bob.change(json!({"kind":"removeUser","id":owner_id}))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let mut own_role = bob.team().await["roles"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == "administrator")
        .unwrap()
        .clone();
    own_role["description"] = json!("Changed");
    assert_eq!(
        bob.change(json!({"kind":"updateRole","role":own_role}))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    // Concurrent snapshots cannot silently overwrite one another.
    let stale = alice.team().await;
    let mut updated = custom.clone();
    updated["description"] = json!("Updated");
    assert_eq!(
        alice
            .change(json!({"kind":"updateRole","role":updated}))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(alice.request("POST","team",json!({"revision":stale["revision"],"change":{"kind":"deleteRole","id":custom["id"]}})).await.0,StatusCode::CONFLICT);
    // Tenant/member status, not just a valid cookie, controls access.
    member["status"] = json!("suspended");
    assert_eq!(
        alice
            .change(json!({"kind":"updateUser","user":member}))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        bob.request("GET", "team", json!(null)).await.0,
        StatusCode::FORBIDDEN
    );
    member["status"] = json!("active");
    assert_eq!(
        alice
            .change(json!({"kind":"updateUser","user":member}))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        alice
            .change(json!({"kind":"removeUser","id":member["id"]}))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        bob.request("GET", "team", json!(null)).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        alice
            .change(json!({"kind":"deleteRole","id":custom["id"]}))
            .await
            .0,
        StatusCode::OK
    );
    // Expiration is enforced in storage, and invited rows cannot be activated by an admin.
    let (_, expired_invite) = alice.change(json!({"kind":"invite","user":{"id":"ignored","name":"Stranger","email":stranger_email,"roleIds":[viewer["id"]],"status":"invited","lastActiveAt":null}})).await;
    let mut pending = expired_invite["team"]["users"]
        .as_array()
        .unwrap()
        .iter()
        .find(|u| u["email"] == stranger_email)
        .unwrap()
        .clone();
    pending["status"] = json!("active");
    assert_eq!(
        alice
            .change(json!({"kind":"updateUser","user":pending}))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    sqlx::query("UPDATE organization_members SET invitation_expires_at=now()-interval '1 second' WHERE id=$1").bind(pending["id"].as_str().unwrap()).execute(&pool).await.unwrap();
    assert_eq!(
        stranger
            .request(
                "POST",
                "invitations/accept",
                json!({"token":expired_invite["invitationToken"]})
            )
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    // Re-authenticating rotates the old session, including an already logged-in session.
    let previous_cookie = alice.cookie.clone();
    assert_eq!(
        alice
            .request(
                "POST",
                "auth/login",
                json!({"email":alice_email,"password":"a sufficiently long test password"})
            )
            .await
            .0,
        StatusCode::OK
    );
    assert_ne!(alice.cookie, previous_cookie);
    let mut previous = Client {
        app: app.clone(),
        cookie: previous_cookie,
    };
    assert_eq!(
        previous.request("GET", "auth/me", json!(null)).await.0,
        StatusCode::UNAUTHORIZED
    );
    // Sessions survive an application restart, and secrets never appear in team responses.
    alice.app = router_with_auth(pool.clone(), config);
    let team = alice.team().await;
    assert!(!team.to_string().contains("password"));
    assert!(!team.to_string().contains("invitationHash"));
    let stored: String = sqlx::query_scalar("SELECT password_hash FROM accounts WHERE email=$1")
        .bind(&alice_email)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(stored.starts_with("$argon2id$"));
    assert!(!stored.contains("a sufficiently long test password"));
    let old_cookie = alice.cookie.clone();
    assert_eq!(
        alice.request("POST", "auth/logout", json!({})).await.0,
        StatusCode::OK
    );
    alice.cookie = old_cookie;
    assert_eq!(
        alice.request("GET", "auth/me", json!(null)).await.0,
        StatusCode::UNAUTHORIZED
    );
    let (status, result) = alice
        .request(
            "POST",
            "auth/login",
            json!({"email":alice_email,"password":"wrong"}),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(result["error"], "Email or password is incorrect.");
    assert_eq!(
        alice
            .request(
                "POST",
                "auth/login",
                json!({"email":alice_email,"password":"a sufficiently long test password"})
            )
            .await
            .0,
        StatusCode::OK
    );
    let id = alice.cookie.split('=').nth(1).unwrap();
    sqlx::query(
        "UPDATE tower_sessions.session SET expiry_date=now()-interval '1 second' WHERE id=$1",
    )
    .bind(id)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        alice.request("GET", "auth/me", json!(null)).await.0,
        StatusCode::UNAUTHORIZED
    );
    // Fixed-window limits apply to nonexistent accounts too.
    let unknown = format!("unknown-{suffix}@example.com");
    for _ in 0..10 {
        assert_eq!(
            alice
                .request(
                    "POST",
                    "auth/login",
                    json!({"email":unknown,"password":"wrong"})
                )
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        alice
            .request(
                "POST",
                "auth/login",
                json!({"email":unknown,"password":"wrong"})
            )
            .await
            .0,
        StatusCode::TOO_MANY_REQUESTS
    );
    pool.close().await;
}

#[tokio::test]
async fn unsafe_requests_require_an_allowed_origin_and_custom_header() {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://unused:unused@localhost/unused")
        .unwrap();
    let app = router_with_auth(pool, AuthConfig::default());
    for (origin, marker) in [
        ("https://evil.example", Some("1")),
        ("http://localhost:5173", None),
    ] {
        let mut request = Request::builder()
            .method("POST")
            .uri("/app-api/auth/login")
            .header("origin", origin)
            .header("content-type", "application/json");
        if let Some(marker) = marker {
            request = request.header("x-cupboard-request", marker);
        }
        let response = app
            .clone()
            .oneshot(request.body(Body::from("{}")).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
}

#[tokio::test]
async fn accounts_can_have_no_memberships_and_create_or_join_later() {
    let pool = connect(&std::env::var("CUPBOARD_TEST_DATABASE_URL").unwrap())
        .await
        .unwrap();
    let app = router_with_auth(
        pool.clone(),
        AuthConfig {
            secure_cookies: false,
            ..Default::default()
        },
    );
    let mut owner = Client::new(&app);
    assert_eq!(
        owner
            .request("POST", "organizations", json!({"name":"Denied"}))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let email = format!("independent-{}@example.com", uuid::Uuid::new_v4());
    owner.signup(&email).await;
    let (status, identity) = owner.request("GET", "auth/me", json!(null)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(identity["organization"].is_null());
    assert!(identity["membershipId"].is_null());
    assert_eq!(identity["organizations"], json!([]));
    assert_eq!(identity["permissions"], json!([]));
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM organization_members WHERE account_id=$1")
            .bind(identity["user"]["id"].as_str().unwrap())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
    assert_eq!(
        owner.request("GET", "team", json!(null)).await.0,
        StatusCode::FORBIDDEN
    );
    owner.request("POST", "auth/logout", json!({})).await;
    assert_eq!(
        owner
            .request(
                "POST",
                "auth/login",
                json!({"email":email,"password":"a sufficiently long test password"})
            )
            .await
            .0,
        StatusCode::OK
    );
    assert!(owner.request("GET", "auth/me", json!(null)).await.1["organization"].is_null());
    assert_eq!(
        owner
            .request("POST", "organizations", json!({"name":"  "}))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    owner.create_organization().await;
    let viewer = owner.create_role("Viewer", &["servers.view"]).await;
    let identity = owner.request("GET", "auth/me", json!(null)).await.1;
    assert_eq!(identity["organizations"].as_array().unwrap().len(), 1);
    assert_eq!(owner.team().await["users"][0]["roleIds"], json!(["owner"]));
    let mut invited = Client::new(&app);
    let invited_email = format!("invited-only-{}@example.com", uuid::Uuid::new_v4());
    invited.signup(&invited_email).await;
    let (_,response)=owner.change(json!({"kind":"invite","user":{"id":"ignored","name":"Invited","email":invited_email,"roleIds":[viewer["id"]],"status":"invited","lastActiveAt":null}})).await;
    assert_eq!(
        invited
            .request(
                "POST",
                "invitations/accept",
                json!({"token":response["invitationToken"]})
            )
            .await
            .0,
        StatusCode::OK
    );
    let identity = invited.request("GET", "auth/me", json!(null)).await.1;
    assert_eq!(identity["organizations"].as_array().unwrap().len(), 1);
    assert_eq!(identity["permissions"], json!(["servers.view"]));
    let id = identity["membershipId"].clone();
    let mut member = owner.team().await["users"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == id)
        .unwrap()
        .clone();
    member["status"] = json!("suspended");
    assert_eq!(
        owner
            .change(json!({"kind":"updateUser","user":member}))
            .await
            .0,
        StatusCode::OK
    );
    let (status, identity) = invited.request("GET", "auth/me", json!(null)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(identity["organization"].is_null());
    assert_eq!(
        invited.request("GET", "team", json!(null)).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        owner.change(json!({"kind":"removeUser","id":id})).await.0,
        StatusCode::OK
    );
    let (status, identity) = invited.request("GET", "auth/me", json!(null)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(identity["organizations"], json!([]));
    invited.create_organization().await;
    assert_eq!(
        invited.team().await["users"][0]["roleIds"],
        json!(["owner"])
    );
    pool.close().await;
}

#[tokio::test]
async fn signup_password_minimum_is_eight_characters() {
    let pool = connect(&std::env::var("CUPBOARD_TEST_DATABASE_URL").unwrap())
        .await
        .unwrap();
    let app = router_with_auth(
        pool,
        AuthConfig {
            secure_cookies: false,
            ..Default::default()
        },
    );
    let mut client = Client::new(&app);
    let email = format!("password-boundary-{}@example.com", uuid::Uuid::new_v4());
    let (status, body) = client
        .request(
            "POST",
            "auth/signup",
            json!({"name":"Operator","email":email,"password":"1234567"}),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "Use a password of 8 to 128 characters.");
    let (status, _) = client
        .request(
            "POST",
            "auth/signup",
            json!({"name":"Operator","email":email,"password":"12345678"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    client.request("POST", "auth/logout", json!({})).await;
    let (status, _) = client
        .request(
            "POST",
            "auth/login",
            json!({"email":email,"password":"12345678"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    for (index, password) in ["😀".repeat(8), "界".repeat(100), "😀".repeat(128)]
        .into_iter()
        .enumerate()
    {
        let unicode_email = format!("unicode-{index}-{email}");
        let (status, _) = client
            .request(
                "POST",
                "auth/signup",
                json!({"name":"Operator", "email":unicode_email,"password":password}),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        client.request("POST", "auth/logout", json!({})).await;
        let (status, _) = client
            .request(
                "POST",
                "auth/login",
                json!({"email":unicode_email,"password":password}),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
    }
    for password in ["😀".repeat(4), "界".repeat(129)] {
        let (status, _) = client
            .request(
                "POST",
                "auth/signup",
                json!({"name":"Operator", "email":format!("invalid-{email}"),"password":password}),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _) = client
            .request(
                "POST",
                "auth/login",
                json!({"email":email,"password":password}),
            )
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
}

#[tokio::test]
async fn ranked_multiple_roles_protect_the_exclusive_owner() {
    let pool = connect(&std::env::var("CUPBOARD_TEST_DATABASE_URL").unwrap())
        .await
        .unwrap();
    let app = router_with_auth(
        pool.clone(),
        AuthConfig {
            secure_cookies: false,
            ..Default::default()
        },
    );
    let mut owner = Client::new(&app);
    let mut admin = Client::new(&app);
    let mut manager = Client::new(&app);
    let mut reader = Client::new(&app);
    let suffix = uuid::Uuid::new_v4();
    let owner_email = format!("rank-owner-{suffix}@example.com");
    let admin_email = format!("rank-admin-{suffix}@example.com");
    let manager_email = format!("rank-manager-{suffix}@example.com");
    let reader_email = format!("rank-reader-{suffix}@example.com");
    owner.signup(&owner_email).await;
    owner.create_organization().await;
    let initial = owner.team().await;
    assert_eq!(initial["roles"].as_array().unwrap().len(), 2);
    assert_eq!(initial["roles"][0]["id"], "owner");
    assert_eq!(initial["roles"][1]["id"], "administrator");
    assert_eq!(
        initial["roles"][0]["permissions"],
        initial["roles"][1]["permissions"]
    );
    assert_eq!(
        initial["roles"][0]["permissions"].as_array().unwrap().len(),
        crate::team::PERMISSIONS.len()
    );
    let owner_member = initial["users"][0].clone();
    let owner_invitation = json!({"kind":"invite","user":{"id":"new","name":"No second owner","email":admin_email,"roleIds":["owner"],"status":"invited","lastActiveAt":null}});
    assert_eq!(
        owner.change(owner_invitation.clone()).await.0,
        StatusCode::FORBIDDEN
    );
    let mut demoted_owner = owner_member.clone();
    demoted_owner["roleIds"] = json!(["administrator"]);
    assert_eq!(
        owner
            .change(json!({"kind":"updateUser","user":demoted_owner}))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let lead = owner
        .create_role("Lead", &["organization.manage", "servers.view"])
        .await;
    let read = owner.create_role("Read", &["servers.view"]).await;
    let billing = owner.create_role("Billing", &["billing.manage"]).await;
    for (client, email, ids) in [
        (&mut admin, &admin_email, json!(["administrator"])),
        (
            &mut manager,
            &manager_email,
            json!([lead["id"], billing["id"]]),
        ),
        (&mut reader, &reader_email, json!([read["id"]])),
    ] {
        client.signup(email).await;
        let (status, invitation) = owner.change(json!({"kind":"invite","user":{"id":"new","name":"Member","email":email,"roleIds":ids,"status":"invited","lastActiveAt":null}})).await;
        assert_eq!(status, StatusCode::OK, "{invitation}");
        assert_eq!(
            client
                .request(
                    "POST",
                    "invitations/accept",
                    json!({"token":invitation["invitationToken"]})
                )
                .await
                .0,
            StatusCode::OK
        );
    }
    let identity = admin.request("GET", "auth/me", json!(null)).await.1;
    assert_eq!(
        identity["permissions"].as_array().unwrap().len(),
        crate::team::PERMISSIONS.len()
    );
    assert_eq!(
        admin.change(owner_invitation).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(admin.change(json!({"kind":"invite","user":{"id":"new","name":"Peer","email":format!("peer-{suffix}@example.com"),"roleIds":["administrator"],"status":"invited","lastActiveAt":null}})).await.0,StatusCode::FORBIDDEN);
    for actor in [&mut admin, &mut manager] {
        assert_eq!(
            actor
                .change(json!({"kind":"removeUser","id":owner_member["id"]}))
                .await
                .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            actor
                .change(json!({"kind":"updateUser","user":demoted_owner}))
                .await
                .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            actor
                .change(json!({"kind":"updateRole","role":initial["roles"][1]}))
                .await
                .0,
            StatusCode::FORBIDDEN
        );
    }
    let perms = manager.request("GET", "auth/me", json!(null)).await.1["permissions"].clone();
    let permissions = perms.as_array().unwrap();
    assert_eq!(permissions.len(), 3);
    for permission in ["organization.manage", "servers.view", "billing.manage"] {
        assert!(permissions.contains(&json!(permission)));
    }
    let mut updated = read.clone();
    updated["description"] = json!("Allowed below highest role");
    assert_eq!(
        manager
            .change(json!({"kind":"updateRole","role":updated}))
            .await
            .0,
        StatusCode::OK
    );
    updated["permissions"] = json!(["servers.manage"]);
    assert_eq!(
        manager
            .change(json!({"kind":"updateRole","role":updated}))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        manager
            .change(json!({"kind":"updateRole","role":lead}))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let reader_member = owner.team().await["users"]
        .as_array()
        .unwrap()
        .iter()
        .find(|u| u["email"] == reader_email)
        .unwrap()
        .clone();
    let mut promoted = reader_member.clone();
    promoted["roleIds"] = json!([read["id"], billing["id"]]);
    assert_eq!(
        owner
            .change(json!({"kind":"updateUser","user":promoted}))
            .await
            .0,
        StatusCode::OK
    );
    let perms = reader.request("GET", "auth/me", json!(null)).await.1["permissions"].clone();
    assert_eq!(perms.as_array().unwrap().len(), 2);
    promoted["roleIds"] = json!([read["id"], "owner"]);
    assert_eq!(
        owner
            .change(json!({"kind":"updateUser","user":promoted}))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    promoted["roleIds"] = json!([read["id"], read["id"]]);
    assert_eq!(
        owner
            .change(json!({"kind":"updateUser","user":promoted}))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    promoted["roleIds"] = json!([read["id"]]);
    assert_eq!(
        owner
            .change(json!({"kind":"updateUser","user":promoted}))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        reader.request("GET", "auth/me", json!(null)).await.1["permissions"],
        json!(["servers.view"])
    );
    let ids = json!([
        "owner",
        "administrator",
        read["id"],
        lead["id"],
        billing["id"]
    ]);
    assert_eq!(
        manager
            .change(json!({"kind":"reorderRoles","ids":ids}))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(owner.change(json!({"kind":"reorderRoles","ids":["administrator","owner",lead["id"],read["id"],billing["id"]]})).await.0,StatusCode::BAD_REQUEST);
    let (status, reordered) = owner.change(json!({"kind":"reorderRoles","ids":ids})).await;
    assert_eq!(status, StatusCode::OK, "{reordered}");
    assert_eq!(reordered["team"]["roles"][2]["id"], read["id"]);
    // The same session must honor the new hierarchy immediately.
    assert_eq!(
        manager
            .change(json!({"kind":"removeUser","id":reader_member["id"]}))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let mut above = reordered["team"]["roles"][2].clone();
    above["description"] = json!("Denied above highest role");
    assert_eq!(
        manager
            .change(json!({"kind":"updateRole","role":above}))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    // A custom role from another tenant cannot be assigned or placed in this hierarchy.
    let mut outsider = Client::new(&app);
    outsider
        .signup(&format!("rank-outsider-{suffix}@example.com"))
        .await;
    outsider.create_organization().await;
    let foreign = outsider.create_role("Foreign", &["servers.view"]).await;
    promoted["roleIds"] = json!([foreign["id"]]);
    assert_eq!(
        owner
            .change(json!({"kind":"updateUser","user":promoted}))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(owner.change(json!({"kind":"reorderRoles","ids":["owner","administrator",foreign["id"],lead["id"],billing["id"]]})).await.0,StatusCode::BAD_REQUEST);
    let current = owner.team().await;
    assert_eq!(
        current["users"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|u| u["roleIds"].as_array().unwrap().contains(&json!("owner")))
            .count(),
        1
    );
    pool.close().await;
}

#[tokio::test]
async fn role_migration_preserves_existing_memberships() {
    let pool = connect(&std::env::var("CUPBOARD_TEST_DATABASE_URL").unwrap())
        .await
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    let schema = format!("migration_{}", uuid::Uuid::new_v4().simple());
    sqlx::raw_sql(&format!(
        "CREATE SCHEMA {schema}; SET LOCAL search_path TO {schema};"
    ))
    .execute(&mut *tx)
    .await
    .unwrap();
    let old_schema = include_str!("migrations/202609210001_accounts_and_roles.sql")
        .replace("CREATE SCHEMA tower_sessions;", "")
        .replace("tower_sessions.session", "test_sessions");
    sqlx::raw_sql(&old_schema).execute(&mut *tx).await.unwrap();
    sqlx::raw_sql("INSERT INTO accounts(id,name,email,password_hash) VALUES('owner-account','Owner','owner@example.com','unused'),('member-account','Member','member@example.com','unused');
        INSERT INTO organizations(id,name) VALUES('org','Existing');
        INSERT INTO organization_roles(organization_id,id,name,description,permissions,system) VALUES('org','owner','Owner','',ARRAY['organization.manage'],true),('org','administrator','Administrator','',ARRAY['organization.manage'],true),('org','operator','Operator','',ARRAY['servers.view'],true),('org','viewer','Viewer','',ARRAY['servers.view'],true);
        INSERT INTO organization_members(id,organization_id,account_id,name,email,role_id,status) VALUES('owner-member','org','owner-account','Owner','owner@example.com','owner','active'),('member','org','member-account','Member','member@example.com','operator','active');").execute(&mut *tx).await.unwrap();
    sqlx::raw_sql(include_str!("migrations/202609210002_role_hierarchy.sql"))
        .execute(&mut *tx)
        .await
        .unwrap();
    let owner: String =
        sqlx::query_scalar("SELECT owner_account_id FROM organizations WHERE id='org'")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(owner, "owner-account");
    let assignments: Vec<(String, String)> = sqlx::query_as(
        "SELECT member_id,role_id FROM organization_member_roles ORDER BY member_id",
    )
    .fetch_all(&mut *tx)
    .await
    .unwrap();
    assert_eq!(
        assignments,
        vec![
            ("member".into(), "operator".into()),
            ("owner-member".into(), "owner".into())
        ]
    );
    let roles: Vec<(String, bool)> =
        sqlx::query_as("SELECT id,system FROM organization_roles ORDER BY position")
            .fetch_all(&mut *tx)
            .await
            .unwrap();
    assert_eq!(
        roles,
        vec![
            ("owner".into(), true),
            ("administrator".into(), true),
            ("operator".into(), false),
            ("viewer".into(), false)
        ]
    );
    let admin_permissions: Vec<String> =
        sqlx::query_scalar("SELECT permissions FROM organization_roles WHERE id='administrator'")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(admin_permissions.len(), crate::team::PERMISSIONS.len());
    // Roll back the isolated schema, leaving other concurrently running tests untouched.
    tx.rollback().await.unwrap();
    pool.close().await;
}
