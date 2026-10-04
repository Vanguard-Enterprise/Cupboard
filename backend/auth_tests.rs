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
async fn switching_organizations_reloads_permissions_and_rejects_revoked_membership() {
    let pool = connect(&std::env::var("CUPBOARD_TEST_DATABASE_URL").unwrap())
        .await
        .unwrap();
    let app = router_with_auth(pool.clone(), AuthConfig::default());
    let mut owner = Client::new(&app);
    let mut member = Client::new(&app);
    let suffix = uuid::Uuid::new_v4();
    let member_email = format!("switch-member-{suffix}@example.com");
    owner
        .signup(&format!("switch-owner-{suffix}@example.com"))
        .await;
    owner.create_organization().await;
    let shared = owner.request("GET", "auth/me", json!(null)).await.1["organization"]["id"].clone();
    let viewer = owner.create_role("Viewer", &["servers.view"]).await;
    member.signup(&member_email).await;
    member.create_organization().await;
    let identity = member.request("GET", "auth/me", json!(null)).await.1;
    let personal = identity["organization"]["id"].clone();
    let account_id = identity["user"]["id"].as_str().unwrap();
    let personal_team = member.team().await;

    // The data-access boundary rejects a nonmember without relying on a route check.
    let mut conn = pool.acquire().await.unwrap();
    let denied = crate::team::context_on(&mut conn, account_id, shared.as_str().unwrap()).await;
    assert_eq!(denied.err().unwrap().0, StatusCode::FORBIDDEN);
    drop(conn);

    let (status, invitation) = owner.change(json!({"kind":"invite","user":{"id":"ignored","name":"Member","email":member_email,"roleIds":[viewer["id"]],"status":"invited","lastActiveAt":null}})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        member
            .request(
                "POST",
                "invitations/accept",
                json!({"token":invitation["invitationToken"]})
            )
            .await
            .0,
        StatusCode::OK
    );
    let identity = member.request("GET", "auth/me", json!(null)).await.1;
    assert_eq!(identity["organization"]["id"], shared);
    assert_eq!(identity["organizations"].as_array().unwrap().len(), 2);
    assert_eq!(identity["permissions"], json!(["servers.view"]));
    let membership_id = identity["membershipId"].clone();
    assert_eq!(
        member.request("GET", "team", json!(null)).await.0,
        StatusCode::FORBIDDEN
    );

    for _ in 0..2 {
        assert_eq!(
            member
                .request("POST", "auth/organization", json!({"id":personal}))
                .await
                .0,
            StatusCode::OK
        );
        assert_eq!(member.team().await, personal_team);
        assert_eq!(
            member
                .request("POST", "auth/organization", json!({"id":shared}))
                .await
                .0,
            StatusCode::OK
        );
        assert_eq!(
            member.request("GET", "auth/me", json!(null)).await.1["permissions"],
            json!(["servers.view"])
        );
        assert_eq!(
            member.request("GET", "team", json!(null)).await.0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(member.request("POST", "team", json!({"revision":personal_team["revision"],"change":{"kind":"deleteRole","id":viewer["id"]}})).await.0, StatusCode::FORBIDDEN);
    }

    assert_eq!(
        owner
            .change(json!({"kind":"removeUser","id":membership_id}))
            .await
            .0,
        StatusCode::OK
    );
    let mut conn = pool.acquire().await.unwrap();
    let denied = crate::team::context_on(&mut conn, account_id, shared.as_str().unwrap()).await;
    assert_eq!(denied.err().unwrap().0, StatusCode::FORBIDDEN);
    drop(conn);
    assert_eq!(
        member.request("GET", "servers", json!(null)).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        member
            .request("POST", "auth/organization", json!({"id":shared}))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        member
            .request("POST", "auth/organization", json!({"id":personal}))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(member.team().await, personal_team);
    pool.close().await;
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

#[tokio::test]
async fn server_inventory_permissions_isolation_and_secret_storage() {
    let pool = connect(&std::env::var("CUPBOARD_TEST_DATABASE_URL").unwrap())
        .await
        .unwrap();
    let app = router_with_auth(
        pool.clone(),
        AuthConfig {
            secure_cookies: false,
            ..Default::default()
        },
    )
    .layer(axum::Extension(
        crate::servers::SecretKey::parse(&"ab".repeat(32)).unwrap(),
    ));
    let mut owner = Client::new(&app);
    let mut other = Client::new(&app);
    let mut anonymous = Client::new(&app);
    let suffix = uuid::Uuid::new_v4();
    assert_eq!(
        anonymous.request("GET", "servers", json!(null)).await.0,
        StatusCode::UNAUTHORIZED
    );
    owner
        .signup(&format!("server-owner-{suffix}@example.com"))
        .await;
    assert_eq!(
        owner.request("GET", "servers", json!(null)).await.0,
        StatusCode::FORBIDDEN
    );
    owner.create_organization().await;
    other
        .signup(&format!("server-other-{suffix}@example.com"))
        .await;
    other.create_organization().await;
    let input = json!({"name":" Main server ","rconHost":"127.0.0.1","rconPort":28016,"rconPassword":"rcon-secret-never-returned","a2sHost":"rust.example.com","a2sPort":28017});
    let (status, created) = owner.request("POST", "servers", input.clone()).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["name"], "Main server");
    assert!(!created.to_string().contains("secret"));
    let (_, listed) = owner.request("GET", "servers", json!(null)).await;
    assert_eq!(listed, json!([created.clone()]));
    let reconnected = connect(&std::env::var("CUPBOARD_TEST_DATABASE_URL").unwrap())
        .await
        .unwrap();
    let mut restarted = Client::new(&router_with_auth(
        reconnected.clone(),
        AuthConfig {
            secure_cookies: false,
            ..Default::default()
        },
    ));
    restarted.cookie = owner.cookie.clone();
    assert_eq!(
        restarted.request("GET", "servers", json!(null)).await.1,
        json!([created.clone()])
    );
    reconnected.close().await;
    assert!(!listed.to_string().contains("secret"));
    let (status, listed) = other.request("GET", "servers", json!(null)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed, json!([]));
    let encrypted: Vec<u8> =
        sqlx::query_scalar("SELECT rcon_password_encrypted FROM servers WHERE id=$1")
            .bind(created["id"].as_str().unwrap())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        !encrypted
            .windows(b"rcon-secret-never-returned".len())
            .any(|w| w == b"rcon-secret-never-returned")
    );
    let mut invalid = input.clone();
    invalid["rconHost"] = json!("https://bad:123");
    invalid["rconPort"] = json!(0);
    invalid["rconPassword"] = json!("");
    let (status, response) = owner.request("POST", "servers", invalid).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(response["fields"]["rconHost"].is_string());
    assert!(response["fields"]["rconPort"].is_string());
    assert!(response["fields"]["rconPassword"].is_string());
    let (status, response) = owner
        .request(
            "POST",
            "servers",
            json!({"organizationId":"spoofed","name":"test"}),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(!response.to_string().contains("rcon-secret"));
    // Removing role permissions applies to existing sessions immediately.
    let org: String = sqlx::query_scalar("SELECT organization_id FROM servers WHERE id=$1")
        .bind(created["id"].as_str().unwrap())
        .fetch_one(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE organizations SET owner_account_id=(SELECT account_id FROM organization_members WHERE organization_id<>$1 LIMIT 1) WHERE id=$1").bind(&org).execute(&pool).await.unwrap();
    sqlx::query("UPDATE organization_roles SET permissions=ARRAY['servers.view']::text[] WHERE organization_id=$1").bind(&org).execute(&pool).await.unwrap();
    assert_eq!(
        owner.request("GET", "servers", json!(null)).await.0,
        StatusCode::OK
    );
    assert_eq!(
        owner.request("POST", "servers", input.clone()).await.0,
        StatusCode::FORBIDDEN
    );
    sqlx::query(
        "UPDATE organization_roles SET permissions=ARRAY[]::text[] WHERE organization_id=$1",
    )
    .bind(&org)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        owner.request("GET", "servers", json!(null)).await.0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn connection_checks_are_authorized_scoped_persisted_and_redacted() {
    let url = std::env::var("CUPBOARD_TEST_DATABASE_URL").unwrap();
    let pool = connect(&url).await.unwrap();
    let app = router_with_auth(
        pool.clone(),
        AuthConfig {
            secure_cookies: false,
            ..Default::default()
        },
    )
    .layer(axum::Extension(
        crate::servers::SecretKey::parse(&"cd".repeat(32)).unwrap(),
    ));
    let mut owner = Client::new(&app);
    let mut other = Client::new(&app);
    let mut anonymous = Client::new(&app);
    let suffix = uuid::Uuid::new_v4();
    owner
        .signup(&format!("check-owner-{suffix}@example.com"))
        .await;
    owner.create_organization().await;
    other
        .signup(&format!("check-other-{suffix}@example.com"))
        .await;
    other.create_organization().await;
    let (rcon_port, a2s_port, task) = crate::connectivity::tests::success_servers().await;
    let (status, created) = owner.request("POST", "servers", json!({"name":"Connectivity test","rconHost":"127.0.0.1","rconPort":rcon_port,"rconPassword":"check-secret","a2sHost":"127.0.0.1","a2sPort":a2s_port})).await;
    assert_eq!(status, StatusCode::OK);
    assert!(created["checkedAt"].is_null());
    let id = created["id"].as_str().unwrap();
    let path = format!("servers/{id}/check");
    assert_eq!(
        anonymous.request("POST", &path, json!({})).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        other.request("POST", &path, json!({})).await.0,
        StatusCode::NOT_FOUND
    );
    // An in-progress check must not be duplicated by a second caller/process.
    let mut lock = pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 6))")
        .bind(id)
        .execute(&mut *lock)
        .await
        .unwrap();
    assert_eq!(
        owner.request("POST", &path, json!({})).await.0,
        StatusCode::CONFLICT
    );
    lock.rollback().await.unwrap();
    let (status, checked) = owner.request("POST", &path, json!({})).await;
    assert_eq!(status, StatusCode::OK, "{checked}");
    assert_eq!(checked["rconStatus"], "connected");
    assert_eq!(checked["a2sStatus"], "connected");
    assert!(checked["checkedAt"].as_i64().unwrap() > 0);
    assert!(!checked.to_string().contains("check-secret"));
    assert_eq!(checked["players"], 0);
    assert_eq!(checked["playersSource"], "rcon");
    assert!(checked["playersAt"].as_i64().unwrap() > 0);
    let (status, health) = owner.request("GET", "servers/health", json!(null)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(health["servers"], json!([checked]));
    assert!(!health.to_string().contains("check-secret"));
    assert_eq!(
        other.request("GET", "servers/health", json!(null)).await.1["servers"],
        json!([])
    );
    assert_eq!(
        anonymous
            .request("GET", "servers/health", json!(null))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    task.await.unwrap();
    let reconnected = connect(&url).await.unwrap();
    let mut restarted = Client::new(&router_with_auth(
        reconnected.clone(),
        AuthConfig {
            secure_cookies: false,
            ..Default::default()
        },
    ));
    restarted.cookie = owner.cookie.clone();
    assert_eq!(
        restarted.request("GET", "servers", json!(null)).await.1,
        json!([checked])
    );
    reconnected.close().await;
    // Corrupt ciphertext must become a safe saved failure, never a panic.
    sqlx::query(
        "UPDATE servers SET rcon_password_encrypted=$2,a2s_host='169.254.169.254' WHERE id=$1",
    )
    .bind(id)
    .bind(vec![0u8; 32])
    .execute(&pool)
    .await
    .unwrap();
    let (status, failed) = owner.request("POST", &path, json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(failed["rconStatus"], "invalid_configuration");
    assert_eq!(failed["a2sStatus"], "invalid_configuration");
    assert!(!failed.to_string().contains("check-secret"));
    assert_eq!(failed["players"], checked["players"]);
    assert_eq!(failed["playersAt"], checked["playersAt"]);
    assert_eq!(
        owner.request("GET", "servers", json!(null)).await.1,
        json!([failed])
    );
    let org: String = sqlx::query_scalar("SELECT organization_id FROM servers WHERE id=$1")
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE organizations SET owner_account_id=(SELECT account_id FROM organization_members WHERE organization_id<>$1 LIMIT 1) WHERE id=$1").bind(&org).execute(&pool).await.unwrap();
    sqlx::query("UPDATE organization_roles SET permissions=ARRAY['servers.view']::text[] WHERE organization_id=$1").bind(&org).execute(&pool).await.unwrap();
    assert_eq!(
        owner.request("POST", &path, json!({})).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        owner.request("GET", "servers", json!(null)).await.0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn health_monitor_persists_observations_and_respects_freshness_and_tenant_scope() {
    let url = std::env::var("CUPBOARD_TEST_DATABASE_URL").unwrap();
    let pool = connect(&url).await.unwrap();
    let key = crate::servers::SecretKey::parse(&"ef".repeat(32)).unwrap();
    let app = router_with_auth(
        pool.clone(),
        AuthConfig {
            secure_cookies: false,
            ..Default::default()
        },
    )
    .layer(axum::Extension(key.clone()));
    let mut owner = Client::new(&app);
    owner
        .signup(&format!("health-{}@example.com", uuid::Uuid::new_v4()))
        .await;
    owner.create_organization().await;
    let (rp, ap, task) = crate::connectivity::tests::success_servers_with_players(321).await;
    let (_, server) = owner.request("POST", "servers", json!({"name":"Monitored Rust","rconHost":"127.0.0.1","rconPort":rp,"rconPassword":"monitor-secret","a2sHost":"127.0.0.1","a2sPort":ap})).await;
    let id = server["id"].as_str().unwrap();
    let org: String = sqlx::query_scalar("SELECT organization_id FROM servers WHERE id=$1")
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
    crate::servers::poll_server(&pool, &key, "wrong-tenant", id)
        .await
        .unwrap();
    assert!(
        owner.request("GET", "servers/health", json!(null)).await.1["servers"][0]["checkedAt"]
            .is_null()
    );
    crate::servers::poll_server(&pool, &key, &org, id)
        .await
        .unwrap();
    task.await.unwrap();
    let first = owner.request("GET", "servers/health", json!(null)).await.1;
    assert_eq!(first["servers"][0]["players"], 321);
    assert_eq!(first["servers"][0]["rconStatus"], "connected");
    crate::servers::poll_server(&pool, &key, &org, id)
        .await
        .unwrap();
    assert_eq!(
        first,
        owner.request("GET", "servers/health", json!(null)).await.1
    );
    // A failed RCON connection falls back to the responding A2S count.
    let udp = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let port = udp.local_addr().unwrap().port();
    let responder = tokio::spawn(async move {
        let (_, peer) = udp.recv_from(&mut [0; 1024]).await.unwrap();
        let packet =
            b"\xff\xff\xff\xffI\x11Rust\0Map\0rust\0Rust\0\x60\x09\x4d\x64\x00dl\x00\x01version\0";
        udp.send_to(packet, peer).await.unwrap();
    });
    sqlx::query(
        "UPDATE servers SET checked_at=1,rcon_host='169.254.169.254',a2s_port=$2 WHERE id=$1",
    )
    .bind(id)
    .bind(i32::from(port))
    .execute(&pool)
    .await
    .unwrap();
    // A concurrent manual check or replica owns the same advisory lock.
    let mut lock = pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 6))")
        .bind(id)
        .execute(&mut *lock)
        .await
        .unwrap();
    crate::servers::poll_server(&pool, &key, &org, id)
        .await
        .unwrap();
    let locked = owner.request("GET", "servers/health", json!(null)).await.1;
    assert_eq!(locked["servers"][0]["checkedAt"], 1);
    lock.rollback().await.unwrap();
    crate::servers::poll_server(&pool, &key, &org, id)
        .await
        .unwrap();
    responder.await.unwrap();
    let fallback = owner.request("GET", "servers/health", json!(null)).await.1;
    assert_eq!(fallback["servers"][0]["players"], 77);
    assert_eq!(fallback["servers"][0]["playersSource"], "a2s");
    assert_eq!(
        fallback["servers"][0]["rconStatus"],
        "invalid_configuration"
    );
    assert_eq!(fallback["servers"][0]["a2sStatus"], "connected");
    // View-only membership can read observations; removing that permission denies it.
    sqlx::query("UPDATE organizations SET owner_account_id=(SELECT id FROM accounts WHERE id<>organizations.owner_account_id LIMIT 1) WHERE id=$1")
        .bind(&org)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE organization_roles SET permissions=ARRAY['servers.view']::text[] WHERE organization_id=$1").bind(&org).execute(&pool).await.unwrap();
    assert_eq!(
        owner.request("GET", "servers/health", json!(null)).await.0,
        StatusCode::OK
    );
    sqlx::query(
        "UPDATE organization_roles SET permissions=ARRAY[]::text[] WHERE organization_id=$1",
    )
    .bind(&org)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        owner.request("GET", "servers/health", json!(null)).await.0,
        StatusCode::FORBIDDEN
    );
}

impl Client {
    async fn file_json(&self, path: &str, org: &str, body: Value) -> axum::response::Response {
        self.app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/app-api/{path}"))
                    .header("origin", "http://localhost:5173")
                    .header("x-cupboard-request", "1")
                    .header("x-cupboard-organization", org)
                    .header("content-type", "application/json")
                    .header("cookie", &self.cookie)
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap()
    }
    async fn file_action(&self, path: &str, org: &str, body: Value) -> (StatusCode, Value) {
        let response = self.file_json(path, org, body).await;
        let status = response.status();
        let value = serde_json::from_slice(&to_bytes(response.into_body(), 100_000).await.unwrap())
            .unwrap();
        (status, value)
    }
    async fn file_request(
        &self,
        method: &str,
        path: &str,
        org: &str,
        name: &str,
        bytes: Vec<u8>,
    ) -> axum::response::Response {
        self.app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(format!("/app-api/{path}"))
                    .header("origin", "http://localhost:5173")
                    .header("x-cupboard-request", "1")
                    .header("x-cupboard-organization", org)
                    .header("x-cupboard-filename", name)
                    .header("content-type", "application/octet-stream")
                    .header("cookie", &self.cookie)
                    .body(Body::from(bytes))
                    .unwrap(),
            )
            .await
            .unwrap()
    }
}

#[tokio::test]
async fn files_persist_in_s3_and_enforce_membership_permissions_and_safe_downloads() {
    use crate::storage::FileStore;
    use object_store::{ObjectStoreExt, aws::AmazonS3Builder};
    let pool = connect(&std::env::var("CUPBOARD_TEST_DATABASE_URL").unwrap())
        .await
        .unwrap();
    let endpoint =
        std::env::var("CUPBOARD_TEST_S3_ENDPOINT").expect("Use npm run check to start isolated S3");
    let storage = FileStore(std::sync::Arc::new(
        AmazonS3Builder::new()
            .with_bucket_name("cupboard-test")
            .with_region("us-east-1")
            .with_endpoint(&endpoint)
            .with_allow_http(true)
            .with_access_key_id("cupboard-test")
            .with_secret_access_key("cupboard-storage-test-only")
            .build()
            .unwrap(),
    ));
    let app = router_with_auth(
        pool.clone(),
        AuthConfig {
            secure_cookies: false,
            ..Default::default()
        },
    )
    .layer(axum::Extension(storage.clone()));
    let mut owner = Client::new(&app);
    let mut other = Client::new(&app);
    let suffix = uuid::Uuid::new_v4();
    owner.signup(&format!("files-{suffix}@example.com")).await;
    owner.create_organization().await;
    other
        .signup(&format!("files-other-{suffix}@example.com"))
        .await;
    other.create_organization().await;
    let identity = owner.request("GET", "auth/me", json!(null)).await.1;
    let org = identity["organization"]["id"].as_str().unwrap();
    let other_identity = other.request("GET", "auth/me", json!(null)).await.1;
    let other_org = other_identity["organization"]["id"].as_str().unwrap();
    let anonymous = Client::new(&app);
    assert_eq!(
        anonymous
            .file_request("GET", "files", org, "", vec![])
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        owner
            .file_request("POST", "files", other_org, "wrong.txt", vec![1])
            .await
            .status(),
        StatusCode::CONFLICT
    );
    for name in [
        "..",
        "%2Fetc%2Fpasswd",
        "bad%0D%0Aheader",
        "%FF",
        "path%5Cname",
    ] {
        assert_eq!(
            owner
                .file_request("POST", "files", org, name, vec![1])
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        owner
            .file_request(
                "POST",
                "files",
                org,
                "large.bin",
                vec![0; crate::files::MAX_FILE_SIZE + 1]
            )
            .await
            .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    // Larger than the ordinary JSON request limit; includes binary and active HTML content.
    let content = [
        b"<script>alert('download only')</script>".to_vec(),
        vec![0xff; 70_000],
    ]
    .concat();
    let response = owner
        .file_request("POST", "files", org, "caf%C3%A9.html", content.clone())
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let file: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    let id = file["id"].as_str().unwrap();
    assert_eq!(file["name"], "café.html");
    assert!(!file.to_string().contains("cupboard-storage-test-only"));
    assert!(file.get("key").is_none());
    let path = object_store::path::Path::from(format!("organizations/{org}/files/{id}"));
    assert_eq!(
        storage
            .0
            .get(&path)
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap()
            .as_ref(),
        content
    );
    // Cleanup must not remove a published file.
    crate::files::remove(&pool, &storage, org, id)
        .await
        .unwrap();
    assert!(storage.0.get(&path).await.is_ok());
    // Rebuild the router to check the persisted session, metadata, and S3 bytes.
    owner.app = router_with_auth(
        pool.clone(),
        AuthConfig {
            secure_cookies: false,
            ..Default::default()
        },
    )
    .layer(axum::Extension(storage.clone()));
    let downloaded = owner
        .file_request("GET", &format!("files/{id}"), org, "", vec![])
        .await;
    assert_eq!(downloaded.status(), StatusCode::OK);
    assert_eq!(
        downloaded.headers()[header::CONTENT_TYPE],
        "application/octet-stream"
    );
    assert_eq!(downloaded.headers()["x-content-type-options"], "nosniff");
    assert_eq!(downloaded.headers()[header::CACHE_CONTROL], "no-store");
    assert!(
        downloaded.headers()[header::CONTENT_DISPOSITION]
            .to_str()
            .unwrap()
            .contains("filename*=UTF-8''caf%C3%A9%2Ehtml")
    );
    assert_eq!(
        to_bytes(downloaded.into_body(), 100_000)
            .await
            .unwrap()
            .as_ref(),
        content
    );
    for (method, route) in [
        ("GET", format!("files/{id}")),
        ("POST", format!("files/{id}/delete")),
    ] {
        assert_eq!(
            other
                .file_request(method, &route, other_org, "", vec![])
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
    }
    let list = other
        .file_request("GET", "files", other_org, "", vec![])
        .await;
    assert_eq!(&to_bytes(list.into_body(), 4096).await.unwrap()[..], b"[]");
    let (status, folder) = owner
        .file_action("files/folders", org, json!({"name":"Configs"}))
        .await;
    assert_eq!(status, StatusCode::OK);
    let folder_id = folder["id"].as_str().unwrap();
    let (status, nested) = owner
        .file_action(
            "files/folders",
            org,
            json!({"name":"Nested","parentId":folder_id}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let nested_id = nested["id"].as_str().unwrap();
    assert_eq!(
        owner
            .file_action(
                &format!("files/{id}/move"),
                org,
                json!({"parentId":nested_id})
            )
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        owner
            .file_action(
                &format!("files/{folder_id}/move"),
                org,
                json!({"parentId":nested_id})
            )
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        owner
            .file_action("files/folders", org, json!({"name":"../bad"}))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        other
            .file_action(
                "files/folders",
                other_org,
                json!({"name":"Intruder","parentId":folder_id})
            )
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    for (action, body) in [
        ("rename", json!({"name":"stolen"})),
        ("move", json!({"parentId":null})),
        ("copy", json!({"parentId":null})),
        ("share", json!({"days":7})),
        ("share/revoke", json!({})),
    ] {
        assert_eq!(
            other
                .file_action(&format!("files/{id}/{action}"), other_org, body)
                .await
                .0,
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(
        owner
            .file_action(
                &format!("files/{id}/rename"),
                org,
                json!({"name":"renamed.html"})
            )
            .await
            .0,
        StatusCode::OK
    );
    let (status, copied) = owner
        .file_action(
            &format!("files/{folder_id}/copy"),
            org,
            json!({"parentId":null}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let copies = copied.as_array().unwrap();
    assert_eq!(copies.len(), 3);
    let copied_file = copies.iter().find(|f| f["isFolder"] == false).unwrap()["id"]
        .as_str()
        .unwrap();
    let response = owner
        .file_request("GET", &format!("files/{copied_file}"), org, "", vec![])
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        to_bytes(response.into_body(), 100_000)
            .await
            .unwrap()
            .as_ref(),
        content
    );
    let copied_root = copies[0]["id"].as_str().unwrap();
    assert_eq!(
        owner
            .file_action(&format!("files/{copied_root}/delete"), org, json!({}))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        owner
            .file_request("GET", &format!("files/{copied_file}"), org, "", vec![])
            .await
            .status(),
        StatusCode::NOT_FOUND
    );

    let (status, share) = owner
        .file_action(&format!("files/{id}/share"), org, json!({"days":7}))
        .await;
    assert_eq!(status, StatusCode::OK);
    let token = share["token"].as_str().unwrap();
    let stored: String = sqlx::query_scalar(
        "SELECT token_hash FROM organization_file_shares WHERE organization_id=$1 AND file_id=$2",
    )
    .bind(org)
    .bind(id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(stored != token && stored == crate::auth::digest(token));
    let response = anonymous
        .file_json("public-files/download", "", json!({"token":token}))
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()[header::CONTENT_TYPE],
        "application/octet-stream"
    );
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(
        to_bytes(response.into_body(), 100_000)
            .await
            .unwrap()
            .as_ref(),
        content
    );
    let (_, replacement) = owner
        .file_action(&format!("files/{id}/share"), org, json!({"days":1}))
        .await;
    assert_eq!(
        anonymous
            .file_json("public-files/download", "", json!({"token":token}))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    let token = replacement["token"].as_str().unwrap();
    sqlx::query(
        "UPDATE organization_file_shares SET expires_at=0 WHERE organization_id=$1 AND file_id=$2",
    )
    .bind(org)
    .bind(id)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        anonymous
            .file_json("public-files/download", "", json!({"token":token}))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    let (_, replacement) = owner
        .file_action(&format!("files/{id}/share"), org, json!({"days":30}))
        .await;
    assert_eq!(
        owner
            .file_action(&format!("files/{id}/share/revoke"), org, json!({}))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        anonymous
            .file_json(
                "public-files/download",
                "",
                json!({"token":replacement["token"]})
            )
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        owner
            .file_action(&format!("files/{folder_id}/share"), org, json!({"days":7}))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        owner
            .file_action(&format!("files/{id}/share"), org, json!({"days":365}))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    // An active member without organization management cannot read or mutate files.
    let account = other_identity["user"]["id"].as_str().unwrap();
    let member = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO organization_members(organization_id,id,account_id,name,email,status) VALUES($1,$2,$3,'Member',$4,'active')")
        .bind(org).bind(&member).bind(account).bind(format!("files-other-{suffix}@example.com")).execute(&pool).await.unwrap();
    assert_eq!(
        other
            .request("POST", "auth/organization", json!({"id":org}))
            .await
            .0,
        StatusCode::OK
    );
    for (method, route) in [
        ("GET", "files".into()),
        ("POST", "files".into()),
        ("GET", format!("files/{id}")),
        ("POST", format!("files/{id}/delete")),
    ] {
        assert_eq!(
            other
                .file_request(method, &route, org, "no.txt", vec![1])
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
    }
    for (route, body) in [
        ("files/folders".to_owned(), json!({"name":"Forbidden"})),
        (format!("files/{id}/rename"), json!({"name":"Forbidden"})),
        (format!("files/{id}/copy"), json!({"parentId":null})),
        (format!("files/{id}/move"), json!({"parentId":null})),
        (format!("files/{id}/share"), json!({"days":7})),
        (format!("files/{id}/share/revoke"), json!({})),
    ] {
        assert_eq!(
            other.file_action(&route, org, body).await.0,
            StatusCode::FORBIDDEN
        );
    }
    sqlx::query("INSERT INTO organization_member_roles(organization_id,member_id,role_id) SELECT $1,$2,id FROM organization_roles WHERE organization_id=$1 AND name='Administrator'")
        .bind(org).bind(&member).execute(&pool).await.unwrap();
    assert_eq!(
        other
            .file_request("GET", "files", org, "", vec![])
            .await
            .status(),
        StatusCode::OK
    );
    sqlx::query(
        "UPDATE organization_members SET status='suspended' WHERE organization_id=$1 AND id=$2",
    )
    .bind(org)
    .bind(&member)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        other
            .file_request("GET", "files", org, "", vec![])
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    let response = owner
        .file_request("POST", &format!("files/{id}/delete"), org, "", vec![])
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(matches!(
        storage.0.get(&path).await,
        Err(object_store::Error::NotFound { .. })
    ));
    assert_eq!(
        owner
            .file_request("GET", &format!("files/{id}"), org, "", vec![])
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    // Wrong provider credentials are redacted and leave a durable cleanup record.
    let bad = FileStore(std::sync::Arc::new(
        AmazonS3Builder::new()
            .with_bucket_name("cupboard-test")
            .with_region("us-east-1")
            .with_endpoint(endpoint)
            .with_allow_http(true)
            .with_access_key_id("private-access-key")
            .with_secret_access_key("private-secret-key")
            .build()
            .unwrap(),
    ));
    owner.app = router_with_auth(
        pool.clone(),
        AuthConfig {
            secure_cookies: false,
            ..Default::default()
        },
    )
    .layer(axum::Extension(bad.clone()));
    let failed = owner
        .file_request("POST", "files", org, "failed.bin", vec![1])
        .await;
    assert_eq!(failed.status(), StatusCode::SERVICE_UNAVAILABLE);
    let message = to_bytes(failed.into_body(), 4096).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&message).unwrap()["error"],
        "File storage is unavailable. Try again shortly."
    );
    let pending: String = sqlx::query_scalar(
        "SELECT id FROM organization_files WHERE organization_id=$1 AND NOT ready",
    )
    .bind(org)
    .fetch_one(&pool)
    .await
    .unwrap();
    // Simulate a crash after S3 accepted bytes but before publication, then reclaim the record.
    let pending_path =
        object_store::path::Path::from(format!("organizations/{org}/files/{pending}"));
    storage.0.put(&pending_path, vec![1].into()).await.unwrap();
    assert!(
        crate::files::remove(&pool, &bad, org, &pending)
            .await
            .is_err()
    );
    let retained: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM organization_files WHERE organization_id=$1 AND id=$2 AND NOT ready)").bind(org).bind(&pending).fetch_one(&pool).await.unwrap();
    assert!(retained);
    crate::files::remove(&pool, &storage, org, &pending)
        .await
        .unwrap();
    assert!(matches!(
        storage.0.get(&pending_path).await,
        Err(object_store::Error::NotFound { .. })
    ));
    pool.close().await;
}
