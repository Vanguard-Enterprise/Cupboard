//! Organization status page: public components, their live health,
//! maintenance windows, and the page's branding. One page per organization.
use crate::{
    auth::{ApiError, ApiResult, AuthSession, account, bounded, forbidden, internal, invalid},
    team,
};
use axum::{
    Json, Router,
    extract::{Path, Request, State},
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{FromRow, PgConnection, PgPool, Postgres, Transaction};
use std::time::Duration;
use tower_sessions::Session;

const MAX_COMPONENTS: usize = 50;
const MAX_WINDOW_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// Matches the machine inventory's reporting threshold.
const STALE_MS: i64 = 90_000;
const VIEW: &str = "infrastructure.view";
const MANAGE: &str = "infrastructure.manage";
const MAX_LINKS: usize = 3;
const MAX_LOGO_BYTES: usize = 256 * 1024;
const THEMES: [&str; 2] = ["dark", "light"];
const FONTS: [&str; 7] = [
    "geist",
    "inter",
    "manrope",
    "ibm-plex-sans",
    "space-grotesk",
    "source-serif",
    "jetbrains-mono",
];
const DEFAULT_ACCENT: &str = "#7cb58d";
const READ: &str = "SELECT id FROM organizations WHERE id=$1 FOR SHARE";
const WRITE: &str = "SELECT id FROM organizations WHERE id=$1 FOR NO KEY UPDATE";

pub fn routes() -> Router<PgPool> {
    Router::new()
        .route("/app-api/status-page", get(read).post(save))
        .route("/app-api/public/status/{slug}", get(public_read))
        .route("/app-api/public/status/{slug}/logo", get(public_logo))
        .route(
            "/app-api/status-page/logo",
            get(read_logo).post(upload_logo),
        )
        .route("/app-api/status-page/logo/remove", post(remove_logo))
        .route("/app-api/status-page/maintenance", post(create_maintenance))
        .route(
            "/app-api/status-page/maintenance/{id}",
            post(update_maintenance),
        )
        .route(
            "/app-api/status-page/maintenance/{id}/complete",
            post(complete_maintenance),
        )
        .route(
            "/app-api/status-page/maintenance/{id}/remove",
            post(remove_maintenance),
        )
}

#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
struct Component {
    id: String,
    name: String,
    kind: String,
    source_id: String,
    source_name: Option<String>,
    group_name: String,
    public: bool,
    health: String,
    observed_at: Option<i64>,
}
#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
struct Maintenance {
    id: String,
    title: String,
    message: String,
    starts_at: i64,
    ends_at: i64,
    completed_at: Option<i64>,
    component_ids: Value,
    created_at: i64,
}
#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
struct Source {
    id: String,
    name: String,
    kind: String,
}
/// A header link on the public page, such as a website or Discord invite.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Link {
    label: String,
    url: String,
}
/// How the public page looks. Shared by the editor and the public response.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Branding {
    theme: String,
    accent_color: String,
    font: String,
    links: Vec<Link>,
    footer_text: String,
    powered_by: bool,
    /// Changes whenever the logo is replaced, so clients can bust caches.
    logo_version: Option<i64>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusPage {
    revision: i64,
    name: String,
    slug: String,
    published: bool,
    announcement: String,
    support_url: String,
    #[serde(flatten)]
    branding: Branding,
    components: Vec<Component>,
    maintenance: Vec<Maintenance>,
    sources: Vec<Source>,
}
#[derive(FromRow)]
struct Settings {
    revision: i64,
    name: String,
    slug: String,
    published: bool,
    announcement: String,
    support_url: String,
    theme: String,
    accent_color: String,
    font: String,
    links: Value,
    footer_text: String,
    powered_by: bool,
}
const SETTINGS: &str = "SELECT revision,name,slug,published,announcement,support_url,theme,accent_color,font,links,footer_text,powered_by FROM status_pages WHERE organization_id=$1";

fn now() -> i64 {
    time::OffsetDateTime::now_utc()
        .unix_timestamp_nanos()
        .div_euclid(1_000_000) as i64
}
fn conflict() -> ApiError {
    ApiError(
        StatusCode::CONFLICT,
        "The status page changed in another session. Reload it before saving again.",
    )
}
fn not_found() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "Maintenance window not found.")
}

/// Lower-case letters, digits, and single hyphens, 1 to 40 characters.
pub(crate) fn valid_slug(slug: &str) -> bool {
    let bytes = slug.as_bytes();
    (1..=40).contains(&bytes.len())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
        && !slug.starts_with('-')
        && !slug.ends_with('-')
}
pub(crate) fn slugify(name: &str) -> String {
    let mut slug = String::new();
    for c in name.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            slug.push(c);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
        if slug.len() == 40 {
            break;
        }
    }
    let slug = slug.trim_end_matches('-').to_owned();
    if slug.is_empty() {
        "status".into()
    } else {
        slug
    }
}

// The page is infrastructure-facing state, so it shares the machines permissions.
async fn access<'a>(
    pool: &'a PgPool,
    auth: &AuthSession,
    session: &Session,
    headers: &HeaderMap,
    lock: &'static str,
    permission: &str,
) -> ApiResult<(Transaction<'a, Postgres>, team::Context)> {
    let user = account(auth)?;
    let org = team::organization_id(session).await?;
    if headers
        .get("x-cupboard-organization")
        .and_then(|v| v.to_str().ok())
        != Some(org.as_str())
    {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "The active organization changed. Refresh the page before managing the status page.",
        ));
    }
    let mut tx = pool.begin().await?;
    sqlx::query(lock).bind(&org).execute(&mut *tx).await?;
    let ctx = team::context_on(&mut tx, &user.id, &org).await?;
    if !ctx.permissions.iter().any(|p| p == permission) {
        return Err(forbidden());
    }
    Ok((tx, ctx))
}

async fn settings(conn: &mut PgConnection, ctx: &team::Context) -> ApiResult<Settings> {
    let row: Option<Settings> = sqlx::query_as(SETTINGS)
        .bind(&ctx.organization_id)
        .fetch_optional(&mut *conn)
        .await?;
    Ok(row.unwrap_or_else(|| Settings {
        revision: 0,
        name: ctx.organization_name.clone(),
        slug: slugify(&ctx.organization_name),
        published: false,
        announcement: String::new(),
        support_url: String::new(),
        theme: THEMES[0].into(),
        accent_color: DEFAULT_ACCENT.into(),
        font: FONTS[0].into(),
        links: Value::Array(Vec::new()),
        footer_text: String::new(),
        powered_by: true,
    }))
}
async fn branding(conn: &mut PgConnection, org: &str, settings: &Settings) -> ApiResult<Branding> {
    let logo_version =
        sqlx::query_scalar("SELECT version FROM status_page_logos WHERE organization_id=$1")
            .bind(org)
            .fetch_optional(&mut *conn)
            .await?;
    Ok(Branding {
        theme: settings.theme.clone(),
        accent_color: settings.accent_color.clone(),
        font: settings.font.clone(),
        links: serde_json::from_value(settings.links.clone()).unwrap_or_default(),
        footer_text: settings.footer_text.clone(),
        powered_by: settings.powered_by,
        logo_version,
    })
}
async fn components_of(conn: &mut PgConnection, org: &str) -> ApiResult<Vec<Component>> {
    Ok(sqlx::query_as(
        "SELECT c.id,c.name,c.kind,c.source_id,c.group_name,c.public,\
         CASE WHEN c.kind='server' THEN s.name ELSE m.name END AS source_name,\
         CASE WHEN c.kind='server' THEN CASE \
           WHEN s.id IS NULL OR s.checked_at IS NULL THEN 'unknown' \
           WHEN s.rcon_status='connected' AND s.a2s_status='connected' THEN 'operational' \
           WHEN s.rcon_status='connected' OR s.a2s_status='connected' THEN 'degraded' \
           ELSE 'down' END \
         ELSE CASE \
           WHEN m.id IS NULL OR m.agent_hash IS NULL OR m.last_seen_at IS NULL THEN 'unknown' \
           WHEN m.last_seen_at >= $2 THEN 'operational' \
           ELSE 'down' END END AS health,\
         CASE WHEN c.kind='server' THEN s.checked_at ELSE m.last_seen_at END AS observed_at \
         FROM status_page_components c \
         LEFT JOIN servers s ON c.kind='server' AND s.organization_id=c.organization_id AND s.id=c.source_id \
         LEFT JOIN machines m ON c.kind='machine' AND m.organization_id=c.organization_id AND m.id=c.source_id \
         WHERE c.organization_id=$1 ORDER BY c.position,c.id",
    )
    .bind(org)
    .bind(now() - STALE_MS)
    .fetch_all(conn)
    .await?)
}
async fn maintenance_of(conn: &mut PgConnection, org: &str) -> ApiResult<Vec<Maintenance>> {
    Ok(sqlx::query_as("SELECT id,title,message,starts_at,ends_at,completed_at,component_ids,created_at FROM status_page_maintenance WHERE organization_id=$1 ORDER BY starts_at DESC,id LIMIT 100")
        .bind(org)
        .fetch_all(conn)
        .await?)
}
async fn state(conn: &mut PgConnection, ctx: &team::Context) -> ApiResult<StatusPage> {
    let org = &ctx.organization_id;
    let settings = settings(conn, ctx).await?;
    let branding = branding(conn, org, &settings).await?;
    let components = components_of(conn, org).await?;
    let maintenance = maintenance_of(conn, org).await?;
    let sources = sqlx::query_as("SELECT id,name,kind FROM (SELECT id,name,'server' AS kind FROM servers WHERE organization_id=$1 UNION ALL SELECT id,name,'machine' FROM machines WHERE organization_id=$1) AS source ORDER BY kind,lower(name),id")
        .bind(org)
        .fetch_all(&mut *conn)
        .await?;
    Ok(StatusPage {
        revision: settings.revision,
        name: settings.name,
        slug: settings.slug,
        published: settings.published,
        announcement: settings.announcement,
        support_url: settings.support_url,
        branding,
        components,
        maintenance,
        sources,
    })
}

/// What visitors see: public targets by display name only, with no source
/// identifiers, plus windows that are open, upcoming, or ended within a week.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicComponent {
    id: String,
    name: String,
    group_name: String,
    health: String,
    observed_at: Option<i64>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicMaintenance {
    id: String,
    title: String,
    message: String,
    starts_at: i64,
    ends_at: i64,
    completed_at: Option<i64>,
    component_ids: Value,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicStatus {
    name: String,
    announcement: String,
    support_url: String,
    #[serde(flatten)]
    branding: Branding,
    updated_at: i64,
    components: Vec<PublicComponent>,
    maintenance: Vec<PublicMaintenance>,
}
const RECENT_WINDOW_MS: i64 = 7 * 24 * 60 * 60 * 1000;

async fn public_read(
    State(pool): State<PgPool>,
    Path(slug): Path<String>,
) -> ApiResult<Json<PublicStatus>> {
    let missing = || {
        ApiError(
            StatusCode::NOT_FOUND,
            "This status page does not exist or is not published.",
        )
    };
    if !valid_slug(&slug) {
        return Err(missing());
    }
    let mut conn = pool.acquire().await?;
    let org: String =
        sqlx::query_scalar("SELECT organization_id FROM status_pages WHERE slug=$1 AND published")
            .bind(&slug)
            .fetch_optional(&mut *conn)
            .await?
            .ok_or_else(missing)?;
    let settings: Settings = sqlx::query_as(SETTINGS)
        .bind(&org)
        .fetch_one(&mut *conn)
        .await?;
    let branding = branding(&mut conn, &org, &settings).await?;
    let now = now();
    let components = components_of(&mut conn, &org)
        .await?
        .into_iter()
        .filter(|c| c.public)
        .map(|c| PublicComponent {
            id: c.id,
            name: c.name,
            group_name: c.group_name,
            health: c.health,
            observed_at: c.observed_at,
        })
        .collect();
    let maintenance = maintenance_of(&mut conn, &org)
        .await?
        .into_iter()
        .filter(|w| w.ends_at >= now - RECENT_WINDOW_MS)
        .map(|w| PublicMaintenance {
            id: w.id,
            title: w.title,
            message: w.message,
            starts_at: w.starts_at,
            ends_at: w.ends_at,
            completed_at: w.completed_at,
            component_ids: w.component_ids,
        })
        .collect();
    Ok(Json(PublicStatus {
        name: settings.name,
        announcement: settings.announcement,
        support_url: settings.support_url,
        branding,
        updated_at: now,
        components,
        maintenance,
    }))
}

async fn read(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    headers: HeaderMap,
) -> ApiResult<Json<StatusPage>> {
    let (mut tx, ctx) = access(&pool, &auth, &session, &headers, READ, VIEW).await?;
    let page = state(&mut tx, &ctx).await?;
    tx.commit().await?;
    Ok(Json(page))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ComponentInput {
    id: Option<String>,
    name: String,
    kind: String,
    source_id: String,
    group_name: String,
    public: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SaveInput {
    revision: i64,
    name: String,
    slug: String,
    published: bool,
    announcement: String,
    support_url: String,
    theme: String,
    accent_color: String,
    font: String,
    links: Vec<Link>,
    footer_text: String,
    powered_by: bool,
    components: Vec<ComponentInput>,
}
fn text(value: &str, max: usize, message: &'static str) -> ApiResult<String> {
    let value = value.trim();
    if value.encode_utf16().count() > max || value.chars().any(|c| c.is_control() && c != '\n') {
        return Err(invalid(message));
    }
    Ok(value.to_owned())
}
fn support_url(value: &str) -> ApiResult<String> {
    if value.trim().is_empty() {
        return Ok(String::new());
    }
    https_url(
        value,
        "Enter a complete HTTPS link for support, or leave it empty.",
    )
}
fn https_url(value: &str, message: &'static str) -> ApiResult<String> {
    let value = value.trim();
    let url = reqwest::Url::parse(value).map_err(|_| invalid(message))?;
    if value.len() > 300 || url.scheme() != "https" || url.host_str().is_none() {
        return Err(invalid(message));
    }
    Ok(value.to_owned())
}

async fn save(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    headers: HeaderMap,
    input: Result<Json<SaveInput>, axum::extract::rejection::JsonRejection>,
) -> ApiResult<Json<StatusPage>> {
    let (mut tx, ctx) = access(&pool, &auth, &session, &headers, WRITE, MANAGE).await?;
    let org = ctx.organization_id.clone();
    let Json(input) = input.map_err(|_| invalid("Enter valid status page settings."))?;
    let current = settings(&mut tx, &ctx).await?;
    if current.revision != input.revision {
        return Err(conflict());
    }
    let name = bounded(&input.name, 80, "Enter a page name of 1 to 80 characters.")?;
    if name.chars().any(char::is_control) {
        return Err(invalid("Enter a page name of 1 to 80 characters."));
    }
    let slug = input.slug.trim().to_owned();
    if !valid_slug(&slug) {
        return Err(invalid(
            "Use 1 to 40 lower-case letters, digits, and hyphens for the public address.",
        ));
    }
    let announcement = text(
        &input.announcement,
        500,
        "Keep the announcement under 500 characters.",
    )?;
    let support_url = support_url(&input.support_url)?;
    if !THEMES.contains(&input.theme.as_str()) {
        return Err(invalid("Choose a dark or light theme."));
    }
    if !FONTS.contains(&input.font.as_str()) {
        return Err(invalid("Choose one of the listed fonts."));
    }
    let accent_color = input.accent_color.trim().to_ascii_lowercase();
    if !valid_color(&accent_color) {
        return Err(invalid(
            "Enter the accent color as a six-digit hex code, such as #7cb58d.",
        ));
    }
    if input.links.len() > MAX_LINKS {
        return Err(invalid("A status page can show up to 3 header links."));
    }
    let mut links = Vec::with_capacity(input.links.len());
    for link in &input.links {
        let label = bounded(&link.label, 40, "Enter a link label of 1 to 40 characters.")?;
        if label.chars().any(char::is_control) {
            return Err(invalid("Enter a link label of 1 to 40 characters."));
        }
        let url = https_url(&link.url, "Enter a complete HTTPS address for each link.")?;
        links.push(Link { label, url });
    }
    let footer_text = text(
        &input.footer_text,
        200,
        "Keep the footer text under 200 characters on one line.",
    )?;
    if footer_text.contains('\n') {
        return Err(invalid(
            "Keep the footer text under 200 characters on one line.",
        ));
    }
    if input.components.len() > MAX_COMPONENTS {
        return Err(invalid("A status page can list up to 50 components."));
    }
    let taken: Option<String> =
        sqlx::query_scalar("SELECT organization_id FROM status_pages WHERE slug=$1")
            .bind(&slug)
            .fetch_optional(&mut *tx)
            .await?;
    if taken.is_some_and(|owner| owner != org) {
        return Err(invalid(
            "That public address belongs to another status page. Choose a different one.",
        ));
    }
    let mut components = Vec::with_capacity(input.components.len());
    let mut seen = std::collections::BTreeSet::new();
    for component in &input.components {
        let name = bounded(
            &component.name,
            80,
            "Enter a component name of 1 to 80 characters.",
        )?;
        if name.chars().any(char::is_control) {
            return Err(invalid("Enter a component name of 1 to 80 characters."));
        }
        if component.kind != "server" && component.kind != "machine" {
            return Err(invalid("Choose a server or machine for each component."));
        }
        let group_name = text(
            &component.group_name,
            80,
            "Keep group names under 80 characters.",
        )?;
        if group_name.contains('\n') {
            return Err(invalid("Keep group names under 80 characters."));
        }
        if !seen.insert((component.kind.clone(), component.source_id.clone())) {
            return Err(invalid("Each server or machine can appear once."));
        }
        // Sources must belong to this organization; the lookup is the tenant check.
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM servers WHERE $1='server' AND organization_id=$2 AND id=$3) OR EXISTS(SELECT 1 FROM machines WHERE $1='machine' AND organization_id=$2 AND id=$3)",
        )
        .bind(&component.kind)
        .bind(&org)
        .bind(&component.source_id)
        .fetch_one(&mut *tx)
        .await?;
        if !exists {
            return Err(invalid(
                "A selected server or machine no longer exists. Reload and choose again.",
            ));
        }
        let id = match &component.id {
            Some(id) if uuid::Uuid::parse_str(id).is_ok() => id.clone(),
            Some(_) => return Err(invalid("Enter valid status page settings.")),
            None => uuid::Uuid::new_v4().to_string(),
        };
        components.push((id, name, group_name));
    }
    sqlx::query("INSERT INTO status_pages(organization_id,revision,name,slug,published,announcement,support_url,created_at,theme,accent_color,font,links,footer_text,powered_by) VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(organization_id) DO UPDATE SET revision=status_pages.revision+1,name=EXCLUDED.name,slug=EXCLUDED.slug,published=EXCLUDED.published,announcement=EXCLUDED.announcement,support_url=EXCLUDED.support_url,theme=EXCLUDED.theme,accent_color=EXCLUDED.accent_color,font=EXCLUDED.font,links=EXCLUDED.links,footer_text=EXCLUDED.footer_text,powered_by=EXCLUDED.powered_by")
        .bind(&org)
        .bind(&name)
        .bind(&slug)
        .bind(input.published)
        .bind(&announcement)
        .bind(&support_url)
        .bind(now())
        .bind(&input.theme)
        .bind(&accent_color)
        .bind(&input.font)
        .bind(serde_json::to_value(&links).map_err(|_| internal())?)
        .bind(&footer_text)
        .bind(input.powered_by)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM status_page_components WHERE organization_id=$1")
        .bind(&org)
        .execute(&mut *tx)
        .await?;
    for (position, (component, (id, name, group_name))) in
        input.components.iter().zip(&components).enumerate()
    {
        sqlx::query("INSERT INTO status_page_components(organization_id,id,name,kind,source_id,group_name,public,position) VALUES($1,$2,$3,$4,$5,$6,$7,$8)")
            .bind(&org)
            .bind(id)
            .bind(name)
            .bind(&component.kind)
            .bind(&component.source_id)
            .bind(group_name)
            .bind(component.public)
            .bind(position as i32)
            .execute(&mut *tx)
            .await?;
    }
    let page = state(&mut tx, &ctx).await?;
    tx.commit().await?;
    Ok(Json(page))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MaintenanceInput {
    title: String,
    message: String,
    starts_at: i64,
    ends_at: i64,
    component_ids: Vec<String>,
}
struct MaintenanceValues {
    title: String,
    message: String,
    component_ids: Value,
}
async fn maintenance_values(
    conn: &mut PgConnection,
    org: &str,
    input: &MaintenanceInput,
) -> ApiResult<MaintenanceValues> {
    let title = bounded(&input.title, 120, "Enter a title of 1 to 120 characters.")?;
    if title.chars().any(char::is_control) {
        return Err(invalid("Enter a title of 1 to 120 characters."));
    }
    let message = text(
        &input.message,
        2000,
        "Keep the message under 2,000 characters.",
    )?;
    if input.ends_at <= input.starts_at {
        return Err(invalid("The window must end after it starts."));
    }
    if input.ends_at - input.starts_at > MAX_WINDOW_MS || input.starts_at < 0 {
        return Err(invalid("A maintenance window can last up to 30 days."));
    }
    let mut ids = input.component_ids.clone();
    ids.sort();
    ids.dedup();
    let known: Vec<String> =
        sqlx::query_scalar("SELECT id FROM status_page_components WHERE organization_id=$1")
            .bind(org)
            .fetch_all(&mut *conn)
            .await?;
    if ids.iter().any(|id| !known.contains(id)) {
        return Err(invalid(
            "A selected component no longer exists. Reload and choose again.",
        ));
    }
    Ok(MaintenanceValues {
        title,
        message,
        component_ids: serde_json::to_value(ids).map_err(|_| internal())?,
    })
}

async fn create_maintenance(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    headers: HeaderMap,
    input: Result<Json<MaintenanceInput>, axum::extract::rejection::JsonRejection>,
) -> ApiResult<Json<StatusPage>> {
    let (mut tx, ctx) = access(&pool, &auth, &session, &headers, WRITE, MANAGE).await?;
    let org = ctx.organization_id.clone();
    let Json(input) = input.map_err(|_| invalid("Enter valid maintenance details."))?;
    let values = maintenance_values(&mut tx, &org, &input).await?;
    sqlx::query("INSERT INTO status_page_maintenance(organization_id,id,title,message,starts_at,ends_at,component_ids,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)")
        .bind(&org)
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&values.title)
        .bind(&values.message)
        .bind(input.starts_at)
        .bind(input.ends_at)
        .bind(&values.component_ids)
        .bind(now())
        .execute(&mut *tx)
        .await?;
    let page = state(&mut tx, &ctx).await?;
    tx.commit().await?;
    Ok(Json(page))
}

async fn update_maintenance(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    headers: HeaderMap,
    Path(id): Path<String>,
    input: Result<Json<MaintenanceInput>, axum::extract::rejection::JsonRejection>,
) -> ApiResult<Json<StatusPage>> {
    let (mut tx, ctx) = access(&pool, &auth, &session, &headers, WRITE, MANAGE).await?;
    let org = ctx.organization_id.clone();
    let Json(input) = input.map_err(|_| invalid("Enter valid maintenance details."))?;
    let values = maintenance_values(&mut tx, &org, &input).await?;
    let changed = sqlx::query("UPDATE status_page_maintenance SET title=$3,message=$4,starts_at=$5,ends_at=$6,component_ids=$7 WHERE organization_id=$1 AND id=$2 AND completed_at IS NULL")
        .bind(&org)
        .bind(&id)
        .bind(&values.title)
        .bind(&values.message)
        .bind(input.starts_at)
        .bind(input.ends_at)
        .bind(&values.component_ids)
        .execute(&mut *tx)
        .await?;
    if changed.rows_affected() == 0 {
        return Err(not_found());
    }
    let page = state(&mut tx, &ctx).await?;
    tx.commit().await?;
    Ok(Json(page))
}

async fn complete_maintenance(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<StatusPage>> {
    let (mut tx, ctx) = access(&pool, &auth, &session, &headers, WRITE, MANAGE).await?;
    let org = ctx.organization_id.clone();
    // Completing early also shortens the window so the page shows the real end.
    let changed = sqlx::query("UPDATE status_page_maintenance SET completed_at=$3,ends_at=LEAST(ends_at,GREATEST($3,starts_at+1)) WHERE organization_id=$1 AND id=$2 AND completed_at IS NULL")
        .bind(&org)
        .bind(&id)
        .bind(now())
        .execute(&mut *tx)
        .await?;
    if changed.rows_affected() == 0 {
        return Err(not_found());
    }
    let page = state(&mut tx, &ctx).await?;
    tx.commit().await?;
    Ok(Json(page))
}

async fn remove_maintenance(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<StatusPage>> {
    let (mut tx, ctx) = access(&pool, &auth, &session, &headers, WRITE, MANAGE).await?;
    let org = ctx.organization_id.clone();
    let changed =
        sqlx::query("DELETE FROM status_page_maintenance WHERE organization_id=$1 AND id=$2")
            .bind(&org)
            .bind(&id)
            .execute(&mut *tx)
            .await?;
    if changed.rows_affected() == 0 {
        return Err(not_found());
    }
    let page = state(&mut tx, &ctx).await?;
    tx.commit().await?;
    Ok(Json(page))
}

fn valid_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value[1..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn no_logo() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "This status page has no logo.")
}

async fn read_logo(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let (mut tx, ctx) = access(&pool, &auth, &session, &headers, READ, VIEW).await?;
    let data: Vec<u8> =
        sqlx::query_scalar("SELECT data FROM status_page_logos WHERE organization_id=$1")
            .bind(&ctx.organization_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(no_logo)?;
    tx.commit().await?;
    Ok(crate::logos::image_response(data))
}

/// Logos of published pages only; unpublishing hides the logo with the page.
async fn public_logo(State(pool): State<PgPool>, Path(slug): Path<String>) -> ApiResult<Response> {
    if !valid_slug(&slug) {
        return Err(no_logo());
    }
    let data: Vec<u8> = sqlx::query_scalar(
        "SELECT l.data FROM status_page_logos l JOIN status_pages p ON p.organization_id=l.organization_id WHERE p.slug=$1 AND p.published",
    )
    .bind(&slug)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(no_logo)?;
    Ok(crate::logos::image_response(data))
}

/// Logos are decoded and re-encoded as a small PNG before they are stored, so
/// no uploaded bytes or metadata reach visitors.
async fn upload_logo(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    request: Request,
) -> ApiResult<Json<StatusPage>> {
    let headers = request.headers().clone();
    // Check access before reading the body, without holding the lock while decoding.
    let (tx, _) = access(&pool, &auth, &session, &headers, READ, MANAGE).await?;
    tx.commit().await?;
    let data = tokio::time::timeout(Duration::from_secs(45), crate::logos::normalized(request))
        .await
        .map_err(|_| {
            ApiError(
                StatusCode::REQUEST_TIMEOUT,
                "Processing the logo timed out. Choose a simpler image.",
            )
        })??;
    if data.len() > MAX_LOGO_BYTES {
        return Err(invalid("Choose a simpler logo image."));
    }
    let (mut tx, ctx) = access(&pool, &auth, &session, &headers, WRITE, MANAGE).await?;
    sqlx::query("INSERT INTO status_page_logos(organization_id,version,data) VALUES($1,$2,$3) ON CONFLICT(organization_id) DO UPDATE SET version=GREATEST(EXCLUDED.version,status_page_logos.version+1),data=EXCLUDED.data")
        .bind(&ctx.organization_id)
        .bind(now())
        .bind(&data)
        .execute(&mut *tx)
        .await?;
    let page = state(&mut tx, &ctx).await?;
    tx.commit().await?;
    Ok(Json(page))
}

async fn remove_logo(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    headers: HeaderMap,
) -> ApiResult<Json<StatusPage>> {
    let (mut tx, ctx) = access(&pool, &auth, &session, &headers, WRITE, MANAGE).await?;
    sqlx::query("DELETE FROM status_page_logos WHERE organization_id=$1")
        .bind(&ctx.organization_id)
        .execute(&mut *tx)
        .await?;
    let page = state(&mut tx, &ctx).await?;
    tx.commit().await?;
    Ok(Json(page))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_are_lower_case_hyphenated_and_bounded() {
        assert_eq!(slugify("Northstar Games"), "northstar-games");
        assert_eq!(slugify("  EU / Main --  "), "eu-main");
        assert_eq!(slugify("***"), "status");
        assert_eq!(slugify(&"a".repeat(60)).len(), 40);
        assert!(valid_slug("northstar-games"));
        assert!(!valid_slug("-northstar"));
        assert!(!valid_slug("North"));
        assert!(!valid_slug(""));
        assert!(!valid_slug(&"a".repeat(41)));
    }

    #[test]
    fn accent_colors_are_lower_case_six_digit_hex() {
        assert!(valid_color("#7cb58d"));
        assert!(!valid_color("#7CB58D"));
        assert!(!valid_color("7cb58d"));
        assert!(!valid_color("#7cb58"));
        assert!(!valid_color("#7cb58g"));
        assert!(!valid_color("red"));
    }
}
