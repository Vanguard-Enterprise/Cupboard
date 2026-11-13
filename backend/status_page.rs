//! Organization status page: public targets (saved servers, machines, and
//! public URLs), their live health, maintenance windows, and the page's
//! branding. One page per organization. URL targets are probed by `monitor`.
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
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{FromRow, PgConnection, PgPool, Postgres, Transaction};
use std::{
    net::{IpAddr, SocketAddr},
    time::{Duration, Instant},
};
use tower_sessions::Session;

const MAX_COMPONENTS: usize = 50;
const MAX_WINDOW_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const MAX_OPEN_WINDOWS: i64 = 100;
const MAX_FINISHED_WINDOWS: i64 = 100;
/// Matches the machine inventory's reporting threshold.
const STALE_MS: i64 = 90_000;
const VIEW: &str = "infrastructure.view";
const MANAGE: &str = "infrastructure.manage";
const MAX_LINKS: usize = 3;
const MAX_LOGO_BYTES: usize = 256 * 1024;
const THEMES: [&str; 3] = ["dark", "light", "system"];
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
const ANNOUNCEMENT_ICONS: [&str; 6] = [
    "megaphone",
    "info",
    "alert",
    "wrench",
    "calendar",
    "sparkles",
];
const LOGO_ALIGNS: [&str; 3] = ["left", "center", "right"];
const LOGO_SIZES: [&str; 3] = ["small", "medium", "large"];
const ANNOUNCEMENT_TONES: [&str; 5] = ["neutral", "info", "success", "warning", "danger"];
/// URL targets are probed about once a minute; older results count as unknown.
const URL_INTERVAL_MS: i64 = 60_000;
const URL_STALE_MS: i64 = 5 * 60_000;
/// Game servers are checked about every 30 seconds. A reading older than this
/// is no longer the server's state, so it reads as unknown, not as healthy.
const SERVER_STALE_MS: i64 = 5 * 60_000;
const URL_SLOW_MS: u128 = 3_000;
const URL_PORTS: [u16; 4] = [80, 443, 8080, 8443];
const READ: &str = "SELECT id FROM organizations WHERE id=$1 FOR SHARE";
const WRITE: &str = "SELECT id FROM organizations WHERE id=$1 FOR NO KEY UPDATE";

pub fn routes() -> Router<PgPool> {
    Router::new()
        .route("/app-api/status-page", get(read).post(save))
        .route("/app-api/public/status/{slug}", get(public_read))
        .route("/app-api/public/status/{slug}/logo", get(public_logo))
        .route(
            "/app-api/public/status/{slug}/components/{id}/history",
            get(public_history),
        )
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
    tag_id: String,
    /// The tag's current name; empty when ungrouped or the tag was deleted.
    group_name: String,
    public: bool,
    health: String,
    observed_at: Option<i64>,
    /// The last URL probe in words, for operators only.
    detail: Option<String>,
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
    /// Machine tag ids, used to suggest a group.
    tags: Value,
}
/// A tag from the organization's machine tag catalog; targets group under them.
#[derive(Serialize, Deserialize, Clone)]
struct Tag {
    id: String,
    name: String,
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
    /// The top bar's title; empty shows the page name.
    header_title: String,
    /// When false and a logo exists, the logo stands in for the title.
    show_name: bool,
    /// Where the logo and title sit in the top bar.
    logo_align: String,
    /// How large the logo is when it stands in for the title.
    logo_size: String,
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
    announcement_icon: String,
    announcement_tone: String,
    support_url: String,
    #[serde(flatten)]
    branding: Branding,
    components: Vec<Component>,
    maintenance: Vec<Maintenance>,
    sources: Vec<Source>,
    tags: Vec<Tag>,
}
#[derive(FromRow)]
struct Settings {
    revision: i64,
    name: String,
    slug: String,
    published: bool,
    announcement: String,
    announcement_icon: String,
    announcement_tone: String,
    support_url: String,
    theme: String,
    accent_color: String,
    font: String,
    links: Value,
    footer_text: String,
    powered_by: bool,
    show_name: bool,
    header_title: String,
    logo_align: String,
    logo_size: String,
}
const SETTINGS: &str = "SELECT revision,name,slug,published,announcement,announcement_icon,announcement_tone,support_url,theme,accent_color,font,links,footer_text,powered_by,show_name,header_title,logo_align,logo_size FROM status_pages WHERE organization_id=$1";

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
        announcement_icon: ANNOUNCEMENT_ICONS[0].into(),
        announcement_tone: ANNOUNCEMENT_TONES[0].into(),
        support_url: String::new(),
        theme: THEMES[0].into(),
        accent_color: DEFAULT_ACCENT.into(),
        font: FONTS[0].into(),
        links: Value::Array(Vec::new()),
        footer_text: String::new(),
        powered_by: true,
        show_name: true,
        header_title: String::new(),
        logo_align: LOGO_ALIGNS[0].into(),
        logo_size: LOGO_SIZES[1].into(),
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
        header_title: settings.header_title.clone(),
        show_name: settings.show_name,
        logo_align: settings.logo_align.clone(),
        logo_size: settings.logo_size.clone(),
        logo_version,
    })
}
async fn components_of(conn: &mut PgConnection, org: &str) -> ApiResult<Vec<Component>> {
    Ok(sqlx::query_as(
        "SELECT c.id,c.name,c.kind,c.source_id,c.tag_id,c.public,\
         COALESCE((SELECT t->>'name' FROM machine_tag_catalogs mc, jsonb_array_elements(mc.tags) t \
           WHERE mc.organization_id=c.organization_id AND t->>'id'=c.tag_id AND c.tag_id<>'' LIMIT 1),'') AS group_name,\
         CASE c.kind WHEN 'server' THEN s.name WHEN 'machine' THEN m.name ELSE c.source_id END AS source_name,\
         CASE c.kind WHEN 'server' THEN CASE \
           WHEN s.id IS NULL OR s.checked_at IS NULL OR s.checked_at < $4 THEN 'unknown' \
           WHEN s.rcon_status='connected' AND s.a2s_status='connected' THEN 'operational' \
           WHEN s.rcon_status='connected' OR s.a2s_status='connected' THEN 'degraded' \
           ELSE 'down' END \
         WHEN 'machine' THEN CASE \
           WHEN m.id IS NULL OR m.agent_hash IS NULL OR m.last_seen_at IS NULL THEN 'unknown' \
           WHEN m.last_seen_at >= $2 THEN 'operational' \
           ELSE 'down' END \
         ELSE CASE \
           WHEN u.checked_at IS NULL OR u.checked_at < $3 THEN 'unknown' \
           WHEN u.result='up' THEN 'operational' \
           WHEN u.result='slow' THEN 'degraded' \
           ELSE 'down' END END AS health,\
         CASE c.kind WHEN 'server' THEN s.checked_at WHEN 'machine' THEN m.last_seen_at ELSE u.checked_at END AS observed_at,\
         CASE WHEN u.checked_at IS NULL THEN NULL \
           WHEN u.error IS NOT NULL THEN u.error \
           ELSE format('HTTP %s in %s ms', u.status_code, u.latency_ms) END AS detail \
         FROM status_page_components c \
         LEFT JOIN servers s ON c.kind='server' AND s.organization_id=c.organization_id AND s.id=c.source_id \
         LEFT JOIN machines m ON c.kind='machine' AND m.organization_id=c.organization_id AND m.id=c.source_id \
         LEFT JOIN status_page_url_checks u ON c.kind='url' AND u.organization_id=c.organization_id AND u.component_id=c.id AND u.url=c.source_id \
         WHERE c.organization_id=$1 ORDER BY c.position,c.id",
    )
    .bind(org)
    .bind(now() - STALE_MS)
    .bind(now() - URL_STALE_MS)
    .bind(now() - SERVER_STALE_MS)
    .fetch_all(conn)
    .await?)
}
/// The machine tag catalog, created with its defaults on first use like the
/// machines page does.
async fn tags_of(conn: &mut PgConnection, org: &str) -> ApiResult<Vec<Tag>> {
    sqlx::query(
        "INSERT INTO machine_tag_catalogs(organization_id) VALUES($1) ON CONFLICT DO NOTHING",
    )
    .bind(org)
    .execute(&mut *conn)
    .await?;
    let value: Value =
        sqlx::query_scalar("SELECT tags FROM machine_tag_catalogs WHERE organization_id=$1")
            .bind(org)
            .fetch_one(&mut *conn)
            .await?;
    serde_json::from_value(value).map_err(|_| internal())
}
/// Every open or upcoming window, plus the most recent finished ones. Open
/// windows are never cut by the history limit, so active maintenance always
/// reaches the page; creation keeps their number bounded.
async fn maintenance_of(
    conn: &mut PgConnection,
    org: &str,
    now: i64,
) -> ApiResult<Vec<Maintenance>> {
    Ok(sqlx::query_as(
        "(SELECT id,title,message,starts_at,ends_at,completed_at,component_ids,created_at FROM status_page_maintenance \
           WHERE organization_id=$1 AND completed_at IS NULL AND ends_at>$2) \
         UNION ALL \
         (SELECT id,title,message,starts_at,ends_at,completed_at,component_ids,created_at FROM status_page_maintenance \
           WHERE organization_id=$1 AND (completed_at IS NOT NULL OR ends_at<=$2) \
           ORDER BY starts_at DESC,id LIMIT $3) \
         ORDER BY starts_at DESC,id",
    )
    .bind(org)
    .bind(now)
    .bind(MAX_FINISHED_WINDOWS)
    .fetch_all(conn)
    .await?)
}
async fn state(conn: &mut PgConnection, ctx: &team::Context) -> ApiResult<StatusPage> {
    let org = &ctx.organization_id;
    let settings = settings(conn, ctx).await?;
    let branding = branding(conn, org, &settings).await?;
    let components = components_of(conn, org).await?;
    let maintenance = maintenance_of(conn, org, now()).await?;
    let sources = sqlx::query_as("SELECT id,name,kind,tags FROM (SELECT id,name,'server' AS kind,'[]'::jsonb AS tags FROM servers WHERE organization_id=$1 UNION ALL SELECT id,name,'machine',tags FROM machines WHERE organization_id=$1) AS source ORDER BY kind,lower(name),id")
        .bind(org)
        .fetch_all(&mut *conn)
        .await?;
    let tags = tags_of(conn, org).await?;
    Ok(StatusPage {
        revision: settings.revision,
        name: settings.name,
        slug: settings.slug,
        published: settings.published,
        announcement: settings.announcement,
        announcement_icon: settings.announcement_icon,
        announcement_tone: settings.announcement_tone,
        support_url: settings.support_url,
        branding,
        components,
        maintenance,
        sources,
        tags,
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
    announcement_icon: String,
    announcement_tone: String,
    support_url: String,
    #[serde(flatten)]
    branding: Branding,
    updated_at: i64,
    components: Vec<PublicComponent>,
    maintenance: Vec<PublicMaintenance>,
}
const RECENT_WINDOW_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// Maintenance visitors may see: open, upcoming, or ended within a week, and
/// touching at least one public target (an empty list means every target).
/// Hidden target ids are removed, and a window that only affects hidden or
/// removed targets is not published at all, so it cannot reveal them. The
/// settings preview applies the same rule (`publicMaintenance` in
/// `src/lib/status-page.ts`).
fn public_windows(
    windows: Vec<Maintenance>,
    public_ids: &[&str],
    now: i64,
) -> Vec<PublicMaintenance> {
    windows
        .into_iter()
        .filter_map(|w| {
            let ended = w.completed_at.map_or(w.ends_at, |at| at.min(w.ends_at));
            if ended < now - RECENT_WINDOW_MS {
                return None;
            }
            let ids: Vec<String> = w
                .component_ids
                .as_array()
                .map(|ids| {
                    ids.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let visible: Vec<String> = ids
                .iter()
                .filter(|id| public_ids.contains(&id.as_str()))
                .cloned()
                .collect();
            if !ids.is_empty() && visible.is_empty() {
                return None;
            }
            Some(PublicMaintenance {
                id: w.id,
                title: w.title,
                message: w.message,
                starts_at: w.starts_at,
                ends_at: w.ends_at,
                completed_at: w.completed_at,
                component_ids: Value::from(visible),
            })
        })
        .collect()
}

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
    let components: Vec<PublicComponent> = components_of(&mut conn, &org)
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
    let public_ids: Vec<&str> = components.iter().map(|c| c.id.as_str()).collect();
    let maintenance = public_windows(
        maintenance_of(&mut conn, &org, now).await?,
        &public_ids,
        now,
    );
    Ok(Json(PublicStatus {
        name: settings.name,
        announcement: settings.announcement,
        announcement_icon: settings.announcement_icon,
        announcement_tone: settings.announcement_tone,
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
    tag_id: String,
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
    announcement_icon: String,
    announcement_tone: String,
    support_url: String,
    theme: String,
    accent_color: String,
    font: String,
    links: Vec<Link>,
    footer_text: String,
    powered_by: bool,
    show_name: bool,
    header_title: String,
    logo_align: String,
    logo_size: String,
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
    let header_title = text(
        &input.header_title,
        80,
        "Keep the title under 80 characters on one line.",
    )?;
    if header_title.contains('\n') {
        return Err(invalid("Keep the title under 80 characters on one line."));
    }
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
    if !LOGO_ALIGNS.contains(&input.logo_align.as_str()) {
        return Err(invalid("Place the logo on the left, center, or right."));
    }
    if !LOGO_SIZES.contains(&input.logo_size.as_str()) {
        return Err(invalid("Choose a small, medium, or large logo."));
    }
    if !ANNOUNCEMENT_ICONS.contains(&input.announcement_icon.as_str()) {
        return Err(invalid("Choose one of the listed announcement icons."));
    }
    if !ANNOUNCEMENT_TONES.contains(&input.announcement_tone.as_str()) {
        return Err(invalid("Choose one of the listed announcement colors."));
    }
    let support_url = support_url(&input.support_url)?;
    if !THEMES.contains(&input.theme.as_str()) {
        return Err(invalid("Choose a dark, light, or system theme."));
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
    let tags = tags_of(&mut tx, &org).await?;
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
        let source_id = match component.kind.as_str() {
            "url" => target_url(&component.source_id)?,
            "server" | "machine" => {
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
                component.source_id.clone()
            }
            _ => {
                return Err(invalid(
                    "Choose a URL, machine, or game server for each target.",
                ));
            }
        };
        if !seen.insert((component.kind.clone(), source_id.clone())) {
            return Err(invalid(
                "Each URL, machine, or game server can appear once.",
            ));
        }
        if !component.tag_id.is_empty() && !tags.iter().any(|t| t.id == component.tag_id) {
            return Err(invalid(
                "A selected tag no longer exists. Reload and choose again.",
            ));
        }
        let id = match &component.id {
            Some(id) if uuid::Uuid::parse_str(id).is_ok() => id.clone(),
            Some(_) => return Err(invalid("Enter valid status page settings.")),
            None => uuid::Uuid::new_v4().to_string(),
        };
        components.push((id, name, source_id));
    }
    sqlx::query("INSERT INTO status_pages(organization_id,revision,name,slug,published,announcement,support_url,created_at,theme,accent_color,font,links,footer_text,powered_by,show_name,announcement_icon,announcement_tone,header_title,logo_align,logo_size) VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) ON CONFLICT(organization_id) DO UPDATE SET header_title=EXCLUDED.header_title,logo_align=EXCLUDED.logo_align,logo_size=EXCLUDED.logo_size, revision=status_pages.revision+1,name=EXCLUDED.name,slug=EXCLUDED.slug,published=EXCLUDED.published,announcement=EXCLUDED.announcement,announcement_icon=EXCLUDED.announcement_icon,announcement_tone=EXCLUDED.announcement_tone,support_url=EXCLUDED.support_url,theme=EXCLUDED.theme,accent_color=EXCLUDED.accent_color,font=EXCLUDED.font,links=EXCLUDED.links,footer_text=EXCLUDED.footer_text,powered_by=EXCLUDED.powered_by,show_name=EXCLUDED.show_name")
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
        .bind(input.show_name)
        .bind(&input.announcement_icon)
        .bind(&input.announcement_tone)
        .bind(&header_title)
        .bind(&input.logo_align)
        .bind(&input.logo_size)
        .execute(&mut *tx)
        .await?;
    // History follows a target's id; a target that is removed or now watches
    // something else starts over.
    let before: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT id,kind,source_id FROM status_page_components WHERE organization_id=$1",
    )
    .bind(&org)
    .fetch_all(&mut *tx)
    .await?;
    let restarted: Vec<String> = before
        .into_iter()
        .filter(|(id, kind, source)| {
            !input
                .components
                .iter()
                .zip(&components)
                .any(|(c, (new_id, _, new_source))| {
                    new_id == id && &c.kind == kind && new_source == source
                })
        })
        .map(|(id, _, _)| id)
        .collect();
    forget_history(&mut tx, &org, &restarted).await?;
    sqlx::query("DELETE FROM status_page_components WHERE organization_id=$1")
        .bind(&org)
        .execute(&mut *tx)
        .await?;
    for (position, (component, (id, name, source_id))) in
        input.components.iter().zip(&components).enumerate()
    {
        sqlx::query("INSERT INTO status_page_components(organization_id,id,name,kind,source_id,tag_id,public,position) VALUES($1,$2,$3,$4,$5,$6,$7,$8)")
            .bind(&org)
            .bind(id)
            .bind(name)
            .bind(&component.kind)
            .bind(source_id)
            .bind(&component.tag_id)
            .bind(component.public)
            .bind(position as i32)
            .execute(&mut *tx)
            .await?;
    }
    // Keep results for unchanged URLs; new or edited URLs are probed right away.
    sqlx::query("DELETE FROM status_page_url_checks u WHERE organization_id=$1 AND NOT EXISTS (SELECT 1 FROM status_page_components c WHERE c.organization_id=u.organization_id AND c.id=u.component_id AND c.kind='url' AND c.source_id=u.url)")
        .bind(&org)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO status_page_url_checks(organization_id,component_id,url) SELECT organization_id,id,source_id FROM status_page_components WHERE organization_id=$1 AND kind='url' ON CONFLICT DO NOTHING")
        .bind(&org)
        .execute(&mut *tx)
        .await?;
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
/// Checks a window being created (`id` is `None`) or edited.
async fn maintenance_values(
    conn: &mut PgConnection,
    org: &str,
    id: Option<&str>,
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
    let now = now();
    if input.ends_at > now {
        // Every open window is always listed, so their number is bounded here.
        // Editing a window that is already open never adds one.
        let (others, already_open): (i64, bool) = sqlx::query_as(
            "SELECT count(*) FILTER (WHERE id IS DISTINCT FROM $3),COALESCE(bool_or(id=$3),false) FROM status_page_maintenance WHERE organization_id=$1 AND completed_at IS NULL AND ends_at>$2",
        )
        .bind(org)
        .bind(now)
        .bind(id)
        .fetch_one(&mut *conn)
        .await?;
        if !already_open && others >= MAX_OPEN_WINDOWS {
            return Err(invalid(
                "A status page can hold up to 100 open or upcoming maintenance windows.",
            ));
        }
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
    let values = maintenance_values(&mut tx, &org, None, &input).await?;
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
    let values = maintenance_values(&mut tx, &org, Some(&id), &input).await?;
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

/// The page revision a logo write expects. Logo writes are page edits: they
/// check and advance the same revision as a save, so two editors can't
/// replace or remove each other's logo silently.
fn logo_revision(headers: &HeaderMap) -> ApiResult<i64> {
    headers
        .get("x-cupboard-logo-revision")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<i64>().ok())
        .ok_or_else(|| invalid("Reload the status page before changing the logo."))
}
/// Checks the expected revision under the caller's lock. A page that was never
/// saved has no row (and no slug) yet, so its first write must be a page save.
async fn check_logo_revision(
    conn: &mut PgConnection,
    ctx: &team::Context,
    expected: i64,
) -> ApiResult<()> {
    let current = settings(conn, ctx).await?.revision;
    if current == 0 {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Save the status page before changing its logo.",
        ));
    }
    if current != expected {
        return Err(conflict());
    }
    Ok(())
}
/// Drops the targets that show a server or machine being removed. The page
/// revision moves when any were dropped, so an editor still holding them is
/// asked to reload instead of saving a source that no longer exists. Callers
/// hold at least a share lock on the organization row, which a page save's
/// update lock waits for.
pub(crate) async fn forget_source(
    conn: &mut PgConnection,
    org: &str,
    kind: &str,
    source_id: &str,
) -> ApiResult<()> {
    let dropped = sqlx::query(
        "DELETE FROM status_page_components WHERE organization_id=$1 AND kind=$2 AND source_id=$3",
    )
    .bind(org)
    .bind(kind)
    .bind(source_id)
    .execute(&mut *conn)
    .await?;
    if dropped.rows_affected() > 0 {
        advance_revision(conn, org).await?;
    }
    Ok(())
}
/// Ungroups targets whose machine tag was deleted, so saving the page never
/// resubmits a group that no longer exists.
pub(crate) async fn forget_group(
    conn: &mut PgConnection,
    org: &str,
    tag_id: &str,
) -> ApiResult<()> {
    let cleared = sqlx::query(
        "UPDATE status_page_components SET tag_id='' WHERE organization_id=$1 AND tag_id=$2",
    )
    .bind(org)
    .bind(tag_id)
    .execute(&mut *conn)
    .await?;
    if cleared.rows_affected() > 0 {
        advance_revision(conn, org).await?;
    }
    Ok(())
}
async fn advance_revision(conn: &mut PgConnection, org: &str) -> ApiResult<()> {
    sqlx::query("UPDATE status_pages SET revision=revision+1 WHERE organization_id=$1")
        .bind(org)
        .execute(conn)
        .await?;
    Ok(())
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
    // Check access and the revision before reading the body, without holding
    // the lock while decoding; both are checked again before the write.
    let (mut tx, ctx) = access(&pool, &auth, &session, &headers, READ, MANAGE).await?;
    let revision = logo_revision(&headers)?;
    check_logo_revision(&mut tx, &ctx, revision).await?;
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
    check_logo_revision(&mut tx, &ctx, revision).await?;
    sqlx::query("INSERT INTO status_page_logos(organization_id,version,data) VALUES($1,$2,$3) ON CONFLICT(organization_id) DO UPDATE SET version=GREATEST(EXCLUDED.version,status_page_logos.version+1),data=EXCLUDED.data")
        .bind(&ctx.organization_id)
        .bind(now())
        .bind(&data)
        .execute(&mut *tx)
        .await?;
    advance_revision(&mut tx, &ctx.organization_id).await?;
    let page = state(&mut tx, &ctx).await?;
    tx.commit().await?;
    Ok(Json(page))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoveLogoInput {
    revision: i64,
}
async fn remove_logo(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    headers: HeaderMap,
    input: Result<Json<RemoveLogoInput>, axum::extract::rejection::JsonRejection>,
) -> ApiResult<Json<StatusPage>> {
    let (mut tx, ctx) = access(&pool, &auth, &session, &headers, WRITE, MANAGE).await?;
    let Json(input) =
        input.map_err(|_| invalid("Reload the status page before changing the logo."))?;
    check_logo_revision(&mut tx, &ctx, input.revision).await?;
    let removed = sqlx::query("DELETE FROM status_page_logos WHERE organization_id=$1")
        .bind(&ctx.organization_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if removed > 0 {
        advance_revision(&mut tx, &ctx.organization_id).await?;
    }
    let page = state(&mut tx, &ctx).await?;
    tx.commit().await?;
    Ok(Json(page))
}

/// A URL target: http or https on a web port, without credentials, naming a
/// public host. Resolved addresses are checked again before every probe.
fn target_url(value: &str) -> ApiResult<String> {
    let message = "Enter a complete http or https address on port 80, 443, 8080, or 8443.";
    let value = value.trim();
    let url = Url::parse(value).map_err(|_| invalid(message))?;
    if value.len() > 300
        || !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || !url
            .port_or_known_default()
            .is_some_and(|port| URL_PORTS.contains(&port))
    {
        return Err(invalid(message));
    }
    let restricted =
        || invalid("Use a public address. Private and local networks cannot be checked.");
    let host = url.host_str().ok_or_else(|| invalid(message))?;
    match host.trim_matches(['[', ']']).parse::<IpAddr>() {
        Ok(ip) if !crate::pelican::public_ip(ip) => return Err(restricted()),
        Ok(_) => {}
        Err(_) => {
            let host = host.trim_end_matches('.').to_ascii_lowercase();
            if !host.contains('.')
                || [".localhost", ".local", ".internal", ".lan", ".home.arpa"]
                    .iter()
                    .any(|suffix| host.ends_with(suffix))
            {
                return Err(restricted());
            }
        }
    }
    Ok(url.to_string())
}

struct Probe {
    result: &'static str,
    status_code: Option<i32>,
    latency_ms: Option<i32>,
    error: Option<&'static str>,
}

/// One GET without following redirects. Every resolved address must pass
/// `allows`, and the connection is pinned to those addresses so a second DNS
/// answer cannot reach a private network.
async fn probe(value: &str, allows: fn(IpAddr) -> bool) -> Probe {
    let down = |error| Probe {
        result: "down",
        status_code: None,
        latency_ms: None,
        error: Some(error),
    };
    let Ok(url) = Url::parse(value) else {
        return down("The address is invalid.");
    };
    let (Some(host), Some(port)) = (url.host_str(), url.port_or_known_default()) else {
        return down("The address is invalid.");
    };
    let host = host.trim_matches(['[', ']']);
    let addresses: Vec<SocketAddr> = match tokio::time::timeout(
        Duration::from_secs(5),
        tokio::net::lookup_host((host, port)),
    )
    .await
    {
        Ok(Ok(addresses)) => addresses.collect(),
        _ => return down("The hostname did not resolve."),
    };
    if addresses.is_empty() || addresses.iter().any(|a| !allows(a.ip())) {
        return down("The address resolves to a private or reserved network.");
    }
    let Ok(client) = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(host, &addresses)
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .user_agent("Cupboard status check")
        .build()
    else {
        return down("The check could not start.");
    };
    let started = Instant::now();
    match client.get(url).send().await {
        Ok(response) => {
            let elapsed = started.elapsed().as_millis();
            let code = response.status().as_u16();
            // The body is never read; only reachability and status matter.
            drop(response);
            Probe {
                result: if code >= 400 {
                    "down"
                } else if elapsed >= URL_SLOW_MS {
                    "slow"
                } else {
                    "up"
                },
                status_code: Some(i32::from(code)),
                latency_ms: Some(elapsed.min(i32::MAX as u128) as i32),
                error: None,
            }
        }
        Err(error) if error.is_timeout() => down("The request timed out."),
        Err(error) if error.is_connect() => down("The connection failed."),
        Err(_) => down("The request failed."),
    }
}

/// Probe URL targets and sample history independently of browser sessions.
/// Claimed rows move their next run forward first, so replicas never do the
/// same work at once. The two run side by side: a backlog of slow URL probes
/// never holds back the minute samples of every other target.
pub async fn monitor(pool: PgPool) {
    let probes = async {
        loop {
            loop {
                match check_due(&pool, crate::pelican::public_ip).await {
                    Ok(true) => continue,
                    Ok(false) => break,
                    Err(_) => {
                        eprintln!("Status page URL checks failed; retrying shortly.");
                        break;
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    };
    let samples = async {
        loop {
            loop {
                match sample_due(&pool).await {
                    Ok(true) => continue,
                    Ok(false) => break,
                    Err(_) => {
                        eprintln!("Status page history sampling failed; retrying shortly.");
                        break;
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    };
    tokio::join!(probes, samples);
}

pub(crate) async fn check_due(pool: &PgPool, allows: fn(IpAddr) -> bool) -> ApiResult<bool> {
    let claimed: Vec<(String, String, String)> = sqlx::query_as(
        "UPDATE status_page_url_checks SET next_check_at=$1+$2 WHERE (organization_id,component_id) IN (SELECT organization_id,component_id FROM status_page_url_checks WHERE next_check_at<=$1 ORDER BY next_check_at LIMIT 10 FOR UPDATE SKIP LOCKED) RETURNING organization_id,component_id,url",
    )
    .bind(now())
    .bind(URL_INTERVAL_MS)
    .fetch_all(pool)
    .await?;
    if claimed.is_empty() {
        return Ok(false);
    }
    let results =
        futures_util::future::join_all(claimed.into_iter().map(|(org, id, url)| async move {
            let probe = probe(&url, allows).await;
            (org, id, url, probe)
        }))
        .await;
    for (org, id, url, probe) in results {
        // A result only lands if the target still watches the same address.
        // Like a sample, it waits for a save in progress, so a response time
        // never lands under a target the save just re-pointed.
        let at = now();
        let mut tx = pool.begin().await?;
        sqlx::query("SELECT 1 FROM status_pages WHERE organization_id=$1 FOR SHARE")
            .bind(&org)
            .execute(&mut *tx)
            .await?;
        let landed = sqlx::query("UPDATE status_page_url_checks SET checked_at=$4,result=$5,status_code=$6,latency_ms=$7,error=$8 WHERE organization_id=$1 AND component_id=$2 AND url=$3")
            .bind(&org)
            .bind(&id)
            .bind(&url)
            .bind(at)
            .bind(probe.result)
            .bind(probe.status_code)
            .bind(probe.latency_ms)
            .bind(probe.error)
            .execute(&mut *tx)
            .await?
            .rows_affected()
            > 0;
        if let (true, Some(latency)) = (landed, probe.latency_ms) {
            sqlx::query("INSERT INTO status_page_health_hours(organization_id,component_id,hour,latency_total,latency_count) VALUES($1,$2,$3,$4,1) ON CONFLICT(organization_id,component_id,hour) DO UPDATE SET latency_total=status_page_health_hours.latency_total+EXCLUDED.latency_total,latency_count=status_page_health_hours.latency_count+1")
                .bind(&org)
                .bind(&id)
                .bind(at.div_euclid(HOUR_MS) * HOUR_MS)
                .bind(i64::from(latency))
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
    }
    Ok(true)
}

/* ---------------- History ---------------- */

/// Every target's state is recorded about once a minute, into hourly counts.
const SAMPLE_MS: i64 = 60_000;
const HOUR_MS: i64 = 60 * 60 * 1000;
const DAY_MS: i64 = 24 * HOUR_MS;
/// History is kept, and shown, for this many days.
const HISTORY_DAYS: i64 = 90;
const MAX_INCIDENTS: i64 = 10;
const STATES: [&str; 5] = ["operational", "degraded", "down", "maintenance", "unknown"];

/// The state a sample records: open maintenance covering the target wins, so
/// planned work never counts as an outage.
fn sampled_state<'a>(health: &'a str, id: &str, windows: &[Value]) -> &'a str {
    let covered = windows.iter().any(|ids| {
        ids.as_array()
            .is_some_and(|ids| ids.is_empty() || ids.iter().any(|v| v.as_str() == Some(id)))
    });
    if covered {
        "maintenance"
    } else if STATES.contains(&health) {
        health
    } else {
        "unknown"
    }
}

/// Removes the history of targets that were removed or now watch another source.
async fn forget_history(conn: &mut PgConnection, org: &str, ids: &[String]) -> ApiResult<()> {
    if ids.is_empty() {
        return Ok(());
    }
    for table in ["status_page_health_hours", "status_page_incidents"] {
        sqlx::query(&format!(
            "DELETE FROM {table} WHERE organization_id=$1 AND component_id=ANY($2)"
        ))
        .bind(org)
        .bind(ids)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

/// Records one sample for each page that is due. Pages are claimed by moving
/// their sample time first, so replicas never record the same minute twice.
pub(crate) async fn sample_due(pool: &PgPool) -> ApiResult<bool> {
    let now = now();
    let claimed: Vec<(String, i64)> = sqlx::query_as(
        "WITH due AS (SELECT organization_id,sampled_at FROM status_pages WHERE sampled_at<=$1-$2 ORDER BY sampled_at LIMIT 20 FOR UPDATE SKIP LOCKED) \
         UPDATE status_pages p SET sampled_at=$1 FROM due WHERE p.organization_id=due.organization_id RETURNING p.organization_id,due.sampled_at",
    )
    .bind(now)
    .bind(SAMPLE_MS)
    .fetch_all(pool)
    .await?;
    if claimed.is_empty() {
        return Ok(false);
    }
    // Each page is already claimed for this minute, so one failing page must
    // not cost the others their sample.
    let mut failed = false;
    for (org, previous) in claimed {
        let prune = previous.div_euclid(HOUR_MS) != now.div_euclid(HOUR_MS);
        if sample(pool, &org, now, prune).await.is_err() {
            failed = true;
        }
    }
    if failed {
        eprintln!("A status page's history sample failed; it is retried next minute.");
    }
    Ok(true)
}

async fn sample(pool: &PgPool, org: &str, now: i64, prune: bool) -> ApiResult<()> {
    let mut tx = pool.begin().await?;
    // Waits for a save in progress, which takes this row first: the sample
    // then sees its targets, and never writes an old source's state under a
    // target id whose history the save just cleared.
    sqlx::query("SELECT 1 FROM status_pages WHERE organization_id=$1 FOR SHARE")
        .bind(org)
        .execute(&mut *tx)
        .await?;
    let components = components_of(&mut tx, org).await?;
    let windows: Vec<Value> = sqlx::query_scalar(
        "SELECT component_ids FROM status_page_maintenance WHERE organization_id=$1 AND completed_at IS NULL AND starts_at<=$2 AND ends_at>$2",
    )
    .bind(org)
    .bind(now)
    .fetch_all(&mut *tx)
    .await?;
    let ids: Vec<String> = components.iter().map(|c| c.id.clone()).collect();
    let states: Vec<String> = components
        .iter()
        .map(|c| sampled_state(&c.health, &c.id, &windows).to_owned())
        .collect();
    sqlx::query(
        "INSERT INTO status_page_health_hours(organization_id,component_id,hour,operational,degraded,down,maintenance,unknown) \
         SELECT $1,x.id,$2,(x.s='operational')::int,(x.s='degraded')::int,(x.s='down')::int,(x.s='maintenance')::int,(x.s='unknown')::int \
         FROM unnest($3::text[],$4::text[]) AS x(id,s) \
         ON CONFLICT(organization_id,component_id,hour) DO UPDATE SET \
         operational=status_page_health_hours.operational+EXCLUDED.operational,\
         degraded=status_page_health_hours.degraded+EXCLUDED.degraded,\
         down=status_page_health_hours.down+EXCLUDED.down,\
         maintenance=status_page_health_hours.maintenance+EXCLUDED.maintenance,\
         unknown=status_page_health_hours.unknown+EXCLUDED.unknown",
    )
    .bind(org)
    .bind(now.div_euclid(HOUR_MS) * HOUR_MS)
    .bind(&ids)
    .bind(&states)
    .execute(&mut *tx)
    .await?;
    // A problem opens an incident, or deepens the open one; recovery closes
    // it. Unknown and maintenance samples leave it as it is.
    sqlx::query(
        "INSERT INTO status_page_incidents(organization_id,component_id,started_at,worst) \
         SELECT $1,x.id,$2,x.s FROM unnest($3::text[],$4::text[]) AS x(id,s) WHERE x.s IN ('degraded','down') \
         ON CONFLICT(organization_id,component_id) WHERE ended_at IS NULL DO UPDATE SET \
         worst=CASE WHEN EXCLUDED.worst='down' THEN 'down' ELSE status_page_incidents.worst END",
    )
    .bind(org)
    .bind(now)
    .bind(&ids)
    .bind(&states)
    .execute(&mut *tx)
    .await?;
    let recovered: Vec<String> = ids
        .iter()
        .zip(&states)
        .filter(|(_, s)| *s == "operational")
        .map(|(id, _)| id.clone())
        .collect();
    sqlx::query("UPDATE status_page_incidents SET ended_at=$2 WHERE organization_id=$1 AND ended_at IS NULL AND component_id=ANY($3)")
        .bind(org)
        .bind(now)
        .bind(&recovered)
        .execute(&mut *tx)
        .await?;
    if prune {
        let oldest = now - HISTORY_DAYS * DAY_MS;
        sqlx::query("DELETE FROM status_page_health_hours h WHERE organization_id=$1 AND (hour<$2 OR NOT EXISTS (SELECT 1 FROM status_page_components c WHERE c.organization_id=h.organization_id AND c.id=h.component_id))")
            .bind(org)
            .bind(oldest)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM status_page_incidents i WHERE organization_id=$1 AND (COALESCE(ended_at,$3)<$2 OR NOT EXISTS (SELECT 1 FROM status_page_components c WHERE c.organization_id=i.organization_id AND c.id=i.component_id))")
            .bind(org)
            .bind(oldest)
            .bind(now)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Minute samples per state over one hour or one UTC day, with the mean URL
/// response time in that span when one was measured.
#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
struct HealthBucket {
    start: i64,
    operational: i64,
    degraded: i64,
    down: i64,
    maintenance: i64,
    unknown: i64,
    latency_ms: Option<i64>,
    /// How many response times `latency_ms` averages.
    latency_count: i64,
}
#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
struct Incident {
    started_at: i64,
    ended_at: Option<i64>,
    worst: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct History {
    now: i64,
    /// The last 24 hours, oldest first; hours without samples are absent.
    hours: Vec<HealthBucket>,
    /// The last 90 UTC days, oldest first; days without samples are absent.
    days: Vec<HealthBucket>,
    /// The most recent incidents, newest first.
    incidents: Vec<Incident>,
}

/// One target's history. Callers have already checked that `component` is a
/// target of `org` the caller may see.
async fn history_of(
    conn: &mut PgConnection,
    org: &str,
    component: &str,
    now: i64,
) -> ApiResult<History> {
    const COUNTS: &str = "sum(operational)::bigint AS operational,sum(degraded)::bigint AS degraded,sum(down)::bigint AS down,sum(maintenance)::bigint AS maintenance,sum(unknown)::bigint AS unknown,CASE WHEN sum(latency_count)>0 THEN (sum(latency_total)/sum(latency_count))::bigint END AS latency_ms,sum(latency_count)::bigint AS latency_count";
    let this_hour = now.div_euclid(HOUR_MS) * HOUR_MS;
    let hours = sqlx::query_as(&format!(
        "SELECT hour AS start,{COUNTS} FROM status_page_health_hours WHERE organization_id=$1 AND component_id=$2 AND hour>$3 GROUP BY hour ORDER BY hour"
    ))
    .bind(org)
    .bind(component)
    .bind(this_hour - DAY_MS)
    .fetch_all(&mut *conn)
    .await?;
    let today = now.div_euclid(DAY_MS) * DAY_MS;
    let days = sqlx::query_as(&format!(
        "SELECT (hour/{DAY_MS})*{DAY_MS} AS start,{COUNTS} FROM status_page_health_hours WHERE organization_id=$1 AND component_id=$2 AND hour>=$3 GROUP BY 1 ORDER BY 1"
    ))
    .bind(org)
    .bind(component)
    // Today and the 89 whole days before it.
    .bind(today - (HISTORY_DAYS - 1) * DAY_MS)
    .fetch_all(&mut *conn)
    .await?;
    let incidents = sqlx::query_as(
        "SELECT started_at,ended_at,worst FROM status_page_incidents WHERE organization_id=$1 AND component_id=$2 AND COALESCE(ended_at,$3)>$4 ORDER BY started_at DESC LIMIT $5",
    )
    .bind(org)
    .bind(component)
    .bind(now)
    .bind(now - HISTORY_DAYS * DAY_MS)
    .bind(MAX_INCIDENTS)
    .fetch_all(&mut *conn)
    .await?;
    Ok(History {
        now,
        hours,
        days,
        incidents,
    })
}

/// A public target's history on a published page. Hidden targets, and
/// targets of other pages, are not found.
async fn public_history(
    State(pool): State<PgPool>,
    Path((slug, id)): Path<(String, String)>,
) -> ApiResult<Json<History>> {
    let missing = || ApiError(StatusCode::NOT_FOUND, "This service has no public history.");
    if !valid_slug(&slug) || uuid::Uuid::parse_str(&id).is_err() {
        return Err(missing());
    }
    let mut conn = pool.acquire().await?;
    let org: String = sqlx::query_scalar(
        "SELECT p.organization_id FROM status_pages p JOIN status_page_components c ON c.organization_id=p.organization_id \
         WHERE p.slug=$1 AND p.published AND c.id=$2 AND c.public",
    )
    .bind(&slug)
    .bind(&id)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(missing)?;
    Ok(Json(history_of(&mut conn, &org, &id, now()).await?))
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
    fn url_targets_must_be_public_web_addresses() {
        assert_eq!(
            target_url(" https://status.example.com ").unwrap(),
            "https://status.example.com/"
        );
        assert!(target_url("http://example.com:8080/health").is_ok());
        for value in [
            "ftp://example.com",
            "https://user:pass@example.com",
            "https://example.com:22",
            "https://localhost",
            "https://intranet",
            "https://db.internal",
            "http://127.0.0.1",
            "http://10.0.0.5",
            "http://100.107.41.153",
            "http://169.254.169.254/latest/meta-data",
            "http://[::1]",
            "http://[fd00::1]",
            "example.com",
        ] {
            assert!(target_url(value).is_err(), "{value}");
        }
    }

    #[tokio::test]
    async fn probes_report_status_latency_and_refuse_private_networks() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = axum::Router::new()
            .route("/up", axum::routing::get(|| async { "ok" }))
            .route(
                "/moved",
                axum::routing::get(|| async {
                    axum::response::Redirect::temporary("http://169.254.169.254/")
                }),
            )
            .route(
                "/broken",
                axum::routing::get(|| async { StatusCode::SERVICE_UNAVAILABLE }),
            );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let allow_all: fn(IpAddr) -> bool = |_| true;
        let up = probe(&format!("http://{address}/up"), allow_all).await;
        assert_eq!((up.result, up.status_code), ("up", Some(200)));
        assert!(up.latency_ms.is_some() && up.error.is_none());
        // Redirects are reported, never followed.
        let moved = probe(&format!("http://{address}/moved"), allow_all).await;
        assert_eq!((moved.result, moved.status_code), ("up", Some(307)));
        let broken = probe(&format!("http://{address}/broken"), allow_all).await;
        assert_eq!((broken.result, broken.status_code), ("down", Some(503)));
        let blocked = probe(&format!("http://{address}/up"), crate::pelican::public_ip).await;
        assert_eq!(blocked.result, "down");
        assert_eq!(blocked.status_code, None);
        assert_eq!(
            blocked.error,
            Some("The address resolves to a private or reserved network.")
        );
        server.abort();
    }

    #[test]
    fn public_maintenance_never_reveals_hidden_targets() {
        let now = 10 * RECENT_WINDOW_MS;
        let window = |id: &str, ids: Value, ends_at: i64, completed_at: Option<i64>| Maintenance {
            id: id.to_owned(),
            title: id.to_owned(),
            message: String::new(),
            starts_at: ends_at - 3_600_000,
            ends_at,
            completed_at,
            component_ids: ids,
            created_at: 0,
        };
        let shown = public_windows(
            vec![
                window("everything", serde_json::json!([]), now + 1, None),
                window("mixed", serde_json::json!(["eu", "hidden"]), now + 1, None),
                window("hidden-only", serde_json::json!(["hidden"]), now + 1, None),
                window("removed", serde_json::json!(["deleted"]), now + 1, None),
                window(
                    "old",
                    serde_json::json!(["eu"]),
                    now - RECENT_WINDOW_MS - 1,
                    None,
                ),
                window(
                    "completed-long-ago",
                    serde_json::json!(["eu"]),
                    now + 1,
                    Some(now - RECENT_WINDOW_MS - 1),
                ),
                window(
                    "last-week",
                    serde_json::json!(["eu"]),
                    now - RECENT_WINDOW_MS,
                    None,
                ),
            ],
            &["eu", "us"],
            now,
        );
        let ids: Vec<&str> = shown.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids, ["everything", "mixed", "last-week"]);
        assert_eq!(shown[0].component_ids, serde_json::json!([]));
        assert_eq!(shown[1].component_ids, serde_json::json!(["eu"]));
        let body = serde_json::to_string(&shown).unwrap();
        assert!(!body.contains("hidden") && !body.contains("deleted"));
    }

    #[test]
    fn samples_record_maintenance_over_the_target_health() {
        let all = serde_json::json!([]);
        let eu = serde_json::json!(["eu"]);
        assert_eq!(sampled_state("down", "eu", &[]), "down");
        assert_eq!(sampled_state("down", "eu", &[all]), "maintenance");
        assert_eq!(
            sampled_state("down", "eu", std::slice::from_ref(&eu)),
            "maintenance"
        );
        assert_eq!(sampled_state("degraded", "us", &[eu]), "degraded");
        assert_eq!(sampled_state("anything", "us", &[]), "unknown");
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
