//! Dashboard read queries over the tenant's observed players. All run on the app pool
//! inside a tenant-bound transaction, so RLS on `player_sessions` scopes visibility to the
//! tenant; the global `players`/identifier/name tables are read-only reference data.

use crate::error::AppError;
use chrono::{DateTime, Utc};
use cupboard_domain::TenantId;
use sqlx::PgPool;
use uuid::Uuid;

/// One row in the tenant's player roster: the player plus their latest session.
#[derive(Debug, sqlx::FromRow, serde::Serialize)]
pub struct PlayerRow {
    pub player_id: Uuid,
    pub display_id: i64,
    pub name: Option<String>,
    pub ip: Option<String>,
    pub online: bool,
    pub server_id: Uuid,
    pub connected_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
}

/// Players this tenant has observed, most-recently-active first, each with its latest
/// session. `include_ip=false` (caller lacks `players.view_pii`) nulls the IP.
pub async fn list(
    app_pool: &PgPool,
    tenant: TenantId,
    include_ip: bool,
) -> Result<Vec<PlayerRow>, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    // DISTINCT ON picks each player's most-recent session; re-sort by activity after.
    let mut rows = sqlx::query_as::<_, PlayerRow>(
        "SELECT DISTINCT ON (p.id) \
             p.id AS player_id, p.display_id, s.name, s.ip, \
             (s.disconnected_at IS NULL) AS online, \
             s.server_id, s.connected_at, s.last_seen_at \
         FROM player_sessions s JOIN players p ON p.id = s.player_id \
         ORDER BY p.id, s.connected_at DESC LIMIT 1000",
    )
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;

    rows.sort_by_key(|r| std::cmp::Reverse(r.last_seen_at));
    if !include_ip {
        for r in &mut rows {
            r.ip = None;
        }
    }
    Ok(rows)
}

#[derive(Debug, sqlx::FromRow, serde::Serialize)]
pub struct PlayerHeader {
    pub id: Uuid,
    pub display_id: i64,
    pub status: String,
    pub first_seen_at: Option<DateTime<Utc>>,
    pub last_seen_at: Option<DateTime<Utc>>,
}

#[derive(Debug, sqlx::FromRow, serde::Serialize)]
pub struct IdentifierRow {
    // Column is `type` (a SQL keyword); map both the DB column and the JSON key.
    #[sqlx(rename = "type")]
    #[serde(rename = "type")]
    pub kind: String,
    pub value: Option<String>,
    pub last_seen_at: DateTime<Utc>,
}

#[derive(Debug, sqlx::FromRow, serde::Serialize)]
pub struct NameRow {
    pub name: Option<String>,
    pub last_seen_at: DateTime<Utc>,
}

#[derive(Debug, sqlx::FromRow, serde::Serialize)]
pub struct SessionRow {
    pub server_id: Uuid,
    pub name: Option<String>,
    pub ip: Option<String>,
    pub connected_at: DateTime<Utc>,
    pub disconnected_at: Option<DateTime<Utc>>,
}

/// Whether this tenant has ever observed `player_id` (has a session for them, under RLS).
/// Used to authorize tenant-initiated operations on global players (e.g. merge), so a
/// tenant can't act on players it has never seen.
pub async fn tenant_has_seen(
    app_pool: &PgPool,
    tenant: TenantId,
    player_id: Uuid,
) -> Result<bool, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let seen: Option<i32> =
        sqlx::query_scalar("SELECT 1 FROM player_sessions WHERE player_id = $1 LIMIT 1")
            .bind(player_id)
            .fetch_optional(&mut *tx)
            .await?;
    tx.commit().await?;
    Ok(seen.is_some())
}

#[derive(Debug, sqlx::FromRow, serde::Serialize)]
pub struct LinkRow {
    pub other_player_id: Uuid,
    pub other_display_id: i64,
    pub confidence: f32,
    /// The shared-signals JSON, as text (sqlx `json` feature isn't enabled).
    pub signals: String,
}

#[derive(Debug, serde::Serialize)]
pub struct PlayerProfile {
    pub player: PlayerHeader,
    pub identifiers: Vec<IdentifierRow>,
    pub names: Vec<NameRow>,
    pub recent_sessions: Vec<SessionRow>,
    pub links: Vec<LinkRow>,
}

/// Full profile for one player, but only if this tenant has actually observed them (they
/// have at least one session visible under RLS) — otherwise 404, so a tenant can't probe
/// the global graph for players they've never seen.
pub async fn profile(
    app_pool: &PgPool,
    tenant: TenantId,
    player_id: Uuid,
    include_ip: bool,
) -> Result<PlayerProfile, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;

    let recent_sessions = sqlx::query_as::<_, SessionRow>(
        "SELECT server_id, name, ip, connected_at, disconnected_at \
         FROM player_sessions WHERE player_id = $1 \
         ORDER BY connected_at DESC LIMIT 50",
    )
    .bind(player_id)
    .fetch_all(&mut *tx)
    .await?;

    if recent_sessions.is_empty() {
        tx.commit().await?;
        return Err(AppError::NotFound("player not found".into()));
    }

    let player = sqlx::query_as::<_, PlayerHeader>(
        "SELECT id, display_id, status, first_seen_at, last_seen_at FROM players WHERE id = $1",
    )
    .bind(player_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::NotFound("player not found".into()))?;

    let identifiers = sqlx::query_as::<_, IdentifierRow>(
        "SELECT type, value, last_seen_at FROM player_identifiers WHERE player_id = $1 \
         ORDER BY type",
    )
    .bind(player_id)
    .fetch_all(&mut *tx)
    .await?;

    let names = sqlx::query_as::<_, NameRow>(
        "SELECT name, last_seen_at FROM name_history WHERE player_id = $1 \
         ORDER BY last_seen_at DESC LIMIT 25",
    )
    .bind(player_id)
    .fetch_all(&mut *tx)
    .await?;

    // Global auto-links (advisory alt graph). Read-only reference data.
    let links = sqlx::query_as::<_, LinkRow>(
        "SELECT (CASE WHEN pl.player_a = $1 THEN pl.player_b ELSE pl.player_a END) \
                 AS other_player_id, \
                op.display_id AS other_display_id, pl.confidence, pl.signals::text AS signals \
         FROM player_links pl \
         JOIN players op ON op.id = (CASE WHEN pl.player_a = $1 THEN pl.player_b ELSE pl.player_a END) \
         WHERE pl.player_a = $1 OR pl.player_b = $1 \
         ORDER BY pl.confidence DESC LIMIT 50",
    )
    .bind(player_id)
    .fetch_all(&mut *tx)
    .await?;

    tx.commit().await?;

    let mut profile = PlayerProfile {
        player,
        identifiers,
        names,
        recent_sessions,
        links,
    };
    if !include_ip {
        for s in &mut profile.recent_sessions {
            s.ip = None;
        }
    }
    Ok(profile)
}
