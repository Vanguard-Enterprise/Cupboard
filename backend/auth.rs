use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Request, State},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use axum_login::{AuthManagerLayerBuilder, AuthUser, AuthnBackend};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool};
use std::sync::{Arc, LazyLock};
use tokio::sync::Semaphore;
use tower_sessions::{Expiry, Session, SessionManagerLayer, cookie::SameSite};
use tower_sessions_sqlx_store::PostgresStore;

pub type AuthSession = axum_login::AuthSession<Backend>;
pub type ApiResult<T> = Result<T, ApiError>;
#[derive(Debug)]
pub struct ApiError(pub StatusCode, pub &'static str);
impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.1)
    }
}
impl std::error::Error for ApiError {}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error": self.1}))).into_response()
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        if error
            .as_database_error()
            .is_some_and(|e| e.is_unique_violation() || e.is_foreign_key_violation())
        {
            Self(
                StatusCode::CONFLICT,
                "These details conflict with an existing record. Refresh and try again.",
            )
        } else {
            internal()
        }
    }
}
pub fn internal() -> ApiError {
    ApiError(
        StatusCode::INTERNAL_SERVER_ERROR,
        "The request could not be completed.",
    )
}
pub fn forbidden() -> ApiError {
    ApiError(
        StatusCode::FORBIDDEN,
        "You do not have permission to perform this action.",
    )
}
pub fn invalid(message: &'static str) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message)
}
pub fn account(auth: &AuthSession) -> ApiResult<&Account> {
    auth.user
        .as_ref()
        .ok_or(ApiError(StatusCode::UNAUTHORIZED, "Sign in to continue."))
}

#[derive(Clone, FromRow, Serialize)]
pub struct Account {
    pub id: String,
    pub name: String,
    pub email: String,
    #[serde(skip)]
    password_hash: String,
}
impl std::fmt::Debug for Account {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Account")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}
impl AuthUser for Account {
    type Id = String;
    fn id(&self) -> String {
        self.id.clone()
    }
    fn session_auth_hash(&self) -> &[u8] {
        self.password_hash.as_bytes()
    }
}
#[derive(Clone)]
pub struct Backend {
    pub pool: PgPool,
}
#[derive(Deserialize)]
pub struct Credentials {
    pub email: String,
    pub password: String,
}
static PASSWORD_SLOTS: Semaphore = Semaphore::const_new(4);
static DUMMY_HASH: LazyLock<String> = LazyLock::new(|| {
    Argon2::default()
        .hash_password(
            b"not-a-real-account-password",
            &SaltString::generate(&mut OsRng),
        )
        .expect("valid Argon2 parameters")
        .to_string()
});

impl AuthnBackend for Backend {
    type User = Account;
    type Credentials = Credentials;
    type Error = ApiError;
    async fn authenticate(&self, creds: Credentials) -> ApiResult<Option<Account>> {
        let email = normalize_email(&creds.email)?;
        throttle(&self.pool, &email).await?;
        if !valid_password_length(&creds.password) {
            return Ok(None);
        }
        let user = sqlx::query_as::<_, Account>(
            "SELECT id,name,email,password_hash FROM accounts WHERE email=$1",
        )
        .bind(email)
        .fetch_optional(&self.pool)
        .await?;
        let permit = PASSWORD_SLOTS.try_acquire().map_err(|_| busy())?;
        let hash = user.as_ref().map(|u| u.password_hash.clone());
        let verified = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let hash = hash.unwrap_or_else(|| DUMMY_HASH.clone());
            PasswordHash::new(&hash).ok().is_some_and(|hash| {
                Argon2::default()
                    .verify_password(creds.password.as_bytes(), &hash)
                    .is_ok()
            })
        })
        .await
        .map_err(|_| internal())?;
        Ok(if verified { user } else { None })
    }
    async fn get_user(&self, id: &String) -> ApiResult<Option<Account>> {
        Ok(
            sqlx::query_as("SELECT id,name,email,password_hash FROM accounts WHERE id=$1")
                .bind(id)
                .fetch_optional(&self.pool)
                .await?,
        )
    }
}
fn busy() -> ApiError {
    ApiError(
        StatusCode::TOO_MANY_REQUESTS,
        "Too many attempts. Try again later.",
    )
}
pub fn normalize_email(value: &str) -> ApiResult<String> {
    let value = value.trim().to_lowercase();
    if value.len() > 254 || !email_address::EmailAddress::is_valid(&value) {
        return Err(invalid("Enter a valid email address."));
    }
    Ok(value)
}
fn valid_password_length(value: &str) -> bool {
    // Unicode scalar values: a maximum of 512 UTF-8 bytes reaches Argon2.
    (8..=128).contains(&value.chars().count())
}
pub fn bounded(value: &str, max: usize, message: &'static str) -> ApiResult<String> {
    let value = value.trim();
    // Match HTML maxLength and JavaScript string.length, both UTF-16 code units.
    if value.is_empty() || value.encode_utf16().count() > max {
        return Err(invalid(message));
    }
    Ok(value.to_owned())
}
pub fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
pub fn secret() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub async fn throttle(pool: &PgPool, email: &str) -> ApiResult<()> {
    // Shared across replicas; prune expired buckets and sessions so these tables stay bounded.
    sqlx::query("DELETE FROM auth_attempts WHERE expires_at < now()")
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM tower_sessions.session WHERE expiry_date < now()")
        .execute(pool)
        .await?;
    for (bucket, limit) in [("global".to_owned(), 1000), (digest(email), 10)] {
        let count: i32=sqlx::query_scalar("INSERT INTO auth_attempts(bucket,attempts,expires_at) VALUES($1,1,now()+interval '15 minutes') ON CONFLICT(bucket) DO UPDATE SET attempts=auth_attempts.attempts+1 RETURNING attempts").bind(bucket).fetch_one(pool).await?;
        if count > limit {
            return Err(busy());
        }
    }
    Ok(())
}

#[derive(Clone)]
pub struct AuthConfig {
    pub origins: Vec<String>,
    pub secure_cookies: bool,
}
impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            origins: vec!["http://localhost:5173".into()],
            secure_cookies: true,
        }
    }
}
pub fn routes(pool: PgPool, config: AuthConfig) -> Router {
    let store = PostgresStore::new(pool.clone());
    let sessions = SessionManagerLayer::new(store)
        .with_name("cupboard_session")
        .with_http_only(true)
        .with_secure(config.secure_cookies)
        .with_same_site(SameSite::Lax)
        .with_expiry(Expiry::OnSessionEnd);
    let backend = Backend { pool: pool.clone() };
    Router::new()
        .route("/app-api/auth/signup", post(signup))
        .route("/app-api/auth/login", post(login))
        .route("/app-api/auth/logout", post(logout))
        .route("/app-api/auth/me", get(me))
        .route("/app-api/auth/organization", post(switch_organization))
        .merge(crate::team::routes())
        .merge(crate::servers::routes())
        .merge(crate::files::routes())
        .with_state(pool)
        .layer(AuthManagerLayerBuilder::new(backend, sessions).build())
        .layer(middleware::from_fn_with_state(
            Arc::new(config.origins),
            guard,
        ))
        .layer(DefaultBodyLimit::max(64 * 1024))
}
async fn guard(State(origins): State<Arc<Vec<String>>>, request: Request, next: Next) -> Response {
    if !matches!(
        *request.method(),
        axum::http::Method::GET | axum::http::Method::HEAD
    ) {
        let origin = request
            .headers()
            .get(header::ORIGIN)
            .and_then(|v| v.to_str().ok());
        let marker = request
            .headers()
            .get("x-cupboard-request")
            .and_then(|v| v.to_str().ok());
        if !origin.is_some_and(|o| origins.iter().any(|allowed| allowed == o))
            || marker != Some("1")
        {
            return forbidden().into_response();
        }
    }
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}
#[derive(Deserialize)]
struct Signup {
    name: String,
    email: String,
    password: String,
}
async fn signup(
    State(pool): State<PgPool>,
    mut auth: AuthSession,
    session: Session,
    Json(input): Json<Signup>,
) -> ApiResult<Json<Value>> {
    let email = normalize_email(&input.email)?;
    throttle(&pool, &email).await?;
    let name = bounded(&input.name, 100, "Enter a name of at most 100 characters.")?;
    if !valid_password_length(&input.password) {
        return Err(invalid("Use a password of 8 to 128 characters."));
    }
    let permit = PASSWORD_SLOTS.try_acquire().map_err(|_| busy())?;
    let hash = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        Argon2::default()
            .hash_password(input.password.as_bytes(), &SaltString::generate(&mut OsRng))
            .map(|h| h.to_string())
            .map_err(|_| internal())
    })
    .await
    .map_err(|_| internal())??;
    let user = Account {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        email,
        password_hash: hash,
    };
    let mut tx = pool.begin().await?;
    sqlx::query(
        "INSERT INTO accounts(id,name,email,password_hash,last_login_at) VALUES($1,$2,$3,$4,now())",
    )
    .bind(&user.id)
    .bind(&user.name)
    .bind(&user.email)
    .bind(&user.password_hash)
    .execute(&mut *tx)
    .await
    .map_err(|_| {
        ApiError(
            StatusCode::CONFLICT,
            "Unable to create an account with these details.",
        )
    })?;
    tx.commit().await?;
    establish(&mut auth, &session, &user, None).await?;
    Ok(Json(json!({"ok":true})))
}
async fn establish(
    auth: &mut AuthSession,
    session: &Session,
    user: &Account,
    organization: Option<&str>,
) -> ApiResult<()> {
    // Rotate even when switching from an already authenticated account.
    session.cycle_id().await.map_err(|_| internal())?;
    auth.login(user).await.map_err(|_| internal())?;
    if let Some(organization) = organization {
        session
            .insert("organization_id", organization)
            .await
            .map_err(|_| internal())?;
    } else {
        session
            .remove::<String>("organization_id")
            .await
            .map_err(|_| internal())?;
    }
    session.set_expiry(Some(Expiry::AtDateTime(
        time::OffsetDateTime::now_utc() + time::Duration::hours(12),
    )));
    Ok(())
}
async fn login(
    State(pool): State<PgPool>,
    mut auth: AuthSession,
    session: Session,
    Json(input): Json<Credentials>,
) -> ApiResult<Json<Value>> {
    let user = auth
        .authenticate(input)
        .await
        .map_err(|error| match error {
            axum_login::Error::Backend(error) => error,
            _ => internal(),
        })?
        .ok_or(ApiError(
            StatusCode::UNAUTHORIZED,
            "Email or password is incorrect.",
        ))?;
    let organization:Option<String>=sqlx::query_scalar("SELECT organization_id FROM organization_members WHERE account_id=$1 AND status='active' ORDER BY organization_id LIMIT 1").bind(&user.id).fetch_optional(&pool).await?;
    sqlx::query("UPDATE accounts SET last_login_at=now() WHERE id=$1")
        .bind(&user.id)
        .execute(&pool)
        .await?;
    establish(&mut auth, &session, &user, organization.as_deref()).await?;
    Ok(Json(json!({"ok":true})))
}
async fn logout(mut auth: AuthSession) -> ApiResult<Json<Value>> {
    auth.logout().await.map_err(|_| internal())?;
    Ok(Json(json!({"ok":true})))
}
async fn me(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
) -> ApiResult<Json<Value>> {
    let user = account(&auth)?;
    let organizations:Vec<(String,String)>=sqlx::query_as("SELECT o.id,o.name FROM organizations o JOIN organization_members m ON m.organization_id=o.id WHERE m.account_id=$1 AND m.status='active' ORDER BY o.name").bind(&user.id).fetch_all(&pool).await?;
    let selected: Option<String> = session
        .get("organization_id")
        .await
        .map_err(|_| internal())?;
    let active = selected
        .filter(|id| organizations.iter().any(|(org, _)| org == id))
        .or_else(|| organizations.first().map(|(id, _)| id.clone()));
    let context = if let Some(id) = active {
        session
            .insert("organization_id", &id)
            .await
            .map_err(|_| internal())?;
        Some(crate::team::context(&pool, user, &session).await?)
    } else {
        session
            .remove::<String>("organization_id")
            .await
            .map_err(|_| internal())?;
        None
    };
    Ok(Json(json!({
        "user": user,
        "organization": context.as_ref().map(|c|json!({"id":c.organization_id,"name":c.organization_name})),
        "membershipId": context.as_ref().map(|c|&c.member_id),
        "permissions": context.as_ref().map(|c|c.permissions.clone()).unwrap_or_default(),
        "organizations": organizations.into_iter().map(|(id,name)|json!({"id":id,"name":name})).collect::<Vec<_>>()
    })))
}
#[derive(Deserialize)]
struct SwitchOrganization {
    id: String,
}
async fn switch_organization(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    Json(input): Json<SwitchOrganization>,
) -> ApiResult<Json<Value>> {
    let user = account(&auth)?;
    let member:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM organization_members WHERE account_id=$1 AND organization_id=$2 AND status='active')").bind(&user.id).bind(&input.id).fetch_one(&pool).await?;
    if !member {
        return Err(forbidden());
    }
    session
        .insert("organization_id", &input.id)
        .await
        .map_err(|_| internal())?;
    Ok(Json(json!({"ok":true})))
}

#[cfg(test)]
mod text_tests {
    use super::{bounded, valid_password_length};

    #[test]
    fn password_limits_count_unicode_characters() {
        for character in ["a", "界", "😀"] {
            for length in [0, 4, 7, 8, 100, 128, 129] {
                assert_eq!(
                    valid_password_length(&character.repeat(length)),
                    (8..=128).contains(&length)
                );
            }
        }
    }

    #[test]
    fn text_limits_match_browser_utf16_lengths() {
        for (character, limit) in [("界", 100), ("é", 100), ("😀", 50)] {
            let accepted = character.repeat(limit);
            assert_eq!(
                bounded(&format!("  {accepted}  "), 100, "Too long").unwrap(),
                accepted
            );
            assert!(bounded(&character.repeat(limit + 1), 100, "Too long").is_err());
        }
        assert!(bounded("  ", 100, "Required").is_err());
    }
}
