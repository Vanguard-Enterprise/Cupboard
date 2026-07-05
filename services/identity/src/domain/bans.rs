//! Ban data access: staff CRUD on the app pool (RLS-scoped) and the connect-time
//! enforcement lookup on the owner pool (cross-tenant path used by the Collector).
//!
//! Bans are identifier-level: `subject_hash = HMAC(subject_value, pepper)` is the durable
//! enforcement key. Matching is by hash, so a Steam ID observed in a roster hashes to the
//! same key a Steam ban was stored under.

use crate::error::AppError;
use chrono::{DateTime, Utc};
use cupboard_crypto::hmac_sha256;
use cupboard_domain::TenantId;
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, sqlx::FromRow, serde::Serialize)]
pub struct Ban {
    pub id: Uuid,
    pub subject_type: String,
    pub subject_value: Option<String>,
    pub player_id: Option<Uuid>,
    pub scope: String,
    pub server_id: Option<Uuid>,
    pub reason: Option<String>,
    pub issued_by: Option<Uuid>,
    pub issued_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
    pub status: String,
    pub revoked_at: Option<DateTime<Utc>>,
    pub revoke_reason: Option<String>,
    pub origin: String,
}

const COLS: &str = "id, subject_type, subject_value, player_id, scope, server_id, reason, \
     issued_by, issued_at, expires_at, status, revoked_at, revoke_reason, origin";

pub struct NewBan {
    pub subject_type: String,
    pub subject_value: String,
    pub player_id: Option<Uuid>,
    pub scope: String,
    pub server_id: Option<Uuid>,
    pub reason: Option<String>,
    pub issued_by: Uuid,
    pub expires_at: Option<DateTime<Utc>>,
}

pub async fn create(
    app_pool: &PgPool,
    tenant: TenantId,
    pepper: &[u8],
    input: NewBan,
) -> Result<Ban, AppError> {
    let subject_hash = hmac_sha256(input.subject_value.as_bytes(), pepper).to_vec();

    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;

    // If the caller didn't attach a player, resolve one from the banned identifier so
    // evasion detection can link this ban to the player's alts.
    let player_id = match input.player_id {
        Some(p) => Some(p),
        None => {
            sqlx::query_scalar::<_, Uuid>(
                "SELECT player_id FROM player_identifiers WHERE type = $1 AND value_hash = $2",
            )
            .bind(&input.subject_type)
            .bind(&subject_hash)
            .fetch_optional(&mut *tx)
            .await?
        }
    };

    let ban = sqlx::query_as::<_, Ban>(&format!(
        "INSERT INTO bans \
         (tenant_id, subject_type, subject_value, subject_hash, player_id, scope, server_id, \
          reason, issued_by, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING {COLS}"
    ))
    .bind(tenant.0)
    .bind(&input.subject_type)
    .bind(&input.subject_value)
    .bind(&subject_hash)
    .bind(player_id)
    .bind(&input.scope)
    .bind(input.server_id)
    .bind(&input.reason)
    .bind(input.issued_by)
    .bind(input.expires_at)
    .fetch_one(&mut *tx)
    .await?;

    crate::domain::audit::record_in_tx(
        &mut tx,
        Some(tenant.0),
        Some(input.issued_by),
        "ban.create",
        Some("ban"),
        Some(ban.id),
        Some(serde_json::json!({ "subject_type": ban.subject_type, "scope": ban.scope })),
    )
    .await?;

    // Outbound BM sync (Phase 4 decision J): the push op rides this tx so it can
    // neither be lost nor observed before the ban commits. No-op when the tenant has
    // no outbound sync.
    crate::domain::bm::enqueue_outbound_create(&mut tx, tenant, &ban).await?;

    tx.commit().await?;
    Ok(ban)
}

pub async fn list(app_pool: &PgPool, tenant: TenantId) -> Result<Vec<Ban>, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    // Active first, then most-recent.
    let bans = sqlx::query_as::<_, Ban>(&format!(
        "SELECT {COLS} FROM bans ORDER BY (status = 'active') DESC, issued_at DESC LIMIT 200"
    ))
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(bans)
}

/// Revoke an active ban. Returns `None` if it doesn't exist (RLS) or isn't active.
pub async fn revoke(
    app_pool: &PgPool,
    tenant: TenantId,
    id: Uuid,
    revoked_by: Uuid,
    reason: Option<&str>,
) -> Result<Option<Ban>, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let ban = sqlx::query_as::<_, Ban>(&format!(
        "UPDATE bans SET status = 'revoked', revoked_by = $2, revoked_at = now(), \
         revoke_reason = $3 WHERE id = $1 AND status = 'active' RETURNING {COLS}"
    ))
    .bind(id)
    .bind(revoked_by)
    .bind(reason)
    .fetch_optional(&mut *tx)
    .await?;

    if let Some(ref b) = ban {
        crate::domain::audit::record_in_tx(
            &mut tx,
            Some(tenant.0),
            Some(revoked_by),
            "ban.revoke",
            Some("ban"),
            Some(b.id),
            None,
        )
        .await?;
        // Outbound BM sync: the unban push rides this tx (decision J). Applies to
        // imported bans too; the drain resolves the BM id through the sync map.
        crate::domain::bm::enqueue_outbound_delete(&mut tx, tenant, b.id).await?;
    }

    tx.commit().await?;
    Ok(ban)
}

/// A steam identifier matched against an active ban, with its reason (for the kick msg).
#[derive(Debug, serde::Serialize)]
pub struct EnforcementHit {
    pub steam_id: String,
    pub reason: Option<String>,
}

/// Which of `steam_ids` are currently banned on this tenant for `server_id` (network-scope
/// bans always apply; server-scope only on their server). Runs on the owner pool
/// (RLS-exempt) filtering `tenant_id` explicitly — the Collector isn't a tenant principal.
///
/// Matching is `(subject_type, subject_hash)`, never hash alone: since Phase 4 widened
/// subject types (imported `name`/`ip`/... bans), the hash space is no longer type-pure.
/// A name ban whose value happens to be a 17-digit string must not match that Steam ID.
pub async fn enforce(
    owner_pool: &PgPool,
    pepper: &[u8],
    tenant_id: Uuid,
    server_id: Uuid,
    steam_ids: &[String],
) -> Result<Vec<EnforcementHit>, AppError> {
    if steam_ids.is_empty() {
        return Ok(Vec::new());
    }
    // hash -> steam_id so we can map matches back.
    let mut by_hash: std::collections::HashMap<Vec<u8>, &String> = std::collections::HashMap::new();
    let mut hashes: Vec<Vec<u8>> = Vec::with_capacity(steam_ids.len());
    for sid in steam_ids {
        let h = hmac_sha256(sid.as_bytes(), pepper).to_vec();
        by_hash.insert(h.clone(), sid);
        hashes.push(h);
    }

    let rows: Vec<(Vec<u8>, Option<String>)> = sqlx::query_as(
        // DISTINCT ON needs a matching leading ORDER BY; issued_at DESC makes the reason
        // deterministic (the most recent applicable ban wins) rather than arbitrary.
        "SELECT DISTINCT ON (subject_hash) subject_hash, reason FROM bans \
         WHERE tenant_id = $1 AND status = 'active' \
           AND subject_type = 'steam' \
           AND (expires_at IS NULL OR expires_at > now()) \
           AND (scope = 'network' OR (scope = 'server' AND server_id = $2)) \
           AND subject_hash = ANY($3) \
         ORDER BY subject_hash, issued_at DESC",
    )
    .bind(tenant_id)
    .bind(server_id)
    .bind(&hashes)
    .fetch_all(owner_pool)
    .await?;

    Ok(rows
        .into_iter()
        .filter_map(|(hash, reason)| {
            by_hash.get(&hash).map(|sid| EnforcementHit {
                steam_id: (*sid).clone(),
                reason,
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, Utc};
    use tokio::sync::OnceCell;

    static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
    static MIGRATED: OnceCell<()> = OnceCell::const_new();

    async fn setup() -> Option<PgPool> {
        let url = std::env::var("TEST_DATABASE_URL").ok()?;
        let pool = cupboard_db::connect_scoped(&url, 5, "identity,public")
            .await
            .expect("connect");
        MIGRATED
            .get_or_init(|| async {
                sqlx::query("CREATE SCHEMA IF NOT EXISTS identity")
                    .execute(&pool)
                    .await
                    .expect("schema");
                MIGRATOR.run(&pool).await.expect("migrate");
            })
            .await;
        Some(pool)
    }

    fn new_ban(subject: &str, scope: &str, server: Option<Uuid>) -> NewBan {
        NewBan {
            subject_type: "steam".into(),
            subject_value: subject.into(),
            player_id: None,
            scope: scope.into(),
            server_id: server,
            reason: Some("cheating".into()),
            issued_by: Uuid::new_v4(),
            expires_at: None,
        }
    }

    #[tokio::test]
    async fn create_enforce_revoke_cycle() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP create_enforce_revoke_cycle: TEST_DATABASE_URL unset");
            return;
        };
        let pepper = b"ban-pepper";
        let tenant = TenantId(Uuid::new_v4());
        let server = Uuid::new_v4();
        // Owner pool doubles as the app pool here (RLS-exempt; tenant_id set explicitly).
        let ban = create(
            &pool,
            tenant,
            pepper,
            new_ban("STEAM_BANNED", "network", None),
        )
        .await
        .expect("create");

        // Enforcement matches the banned id, ignores an innocent one.
        let hits = enforce(
            &pool,
            pepper,
            tenant.0,
            server,
            &["STEAM_BANNED".into(), "STEAM_OK".into()],
        )
        .await
        .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].steam_id, "STEAM_BANNED");
        assert_eq!(hits[0].reason.as_deref(), Some("cheating"));

        // After revoke, no longer enforced.
        revoke(
            &pool,
            tenant,
            ban.id,
            Uuid::new_v4(),
            Some("appeal granted"),
        )
        .await
        .unwrap()
        .expect("revoked");
        let hits = enforce(&pool, pepper, tenant.0, server, &["STEAM_BANNED".into()])
            .await
            .unwrap();
        assert!(hits.is_empty(), "revoked ban must not enforce");
    }

    #[tokio::test]
    async fn expired_bans_and_scope_are_respected() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP expired_bans_and_scope_are_respected: TEST_DATABASE_URL unset");
            return;
        };
        let pepper = b"ban-pepper";
        let tenant = TenantId(Uuid::new_v4());
        let server_a = Uuid::new_v4();
        let server_b = Uuid::new_v4();

        // Expired network ban → not enforced.
        let mut expired = new_ban("EXPIRED", "network", None);
        expired.expires_at = Some(Utc::now() - Duration::hours(1));
        create(&pool, tenant, pepper, expired).await.unwrap();
        assert!(
            enforce(&pool, pepper, tenant.0, server_a, &["EXPIRED".into()])
                .await
                .unwrap()
                .is_empty(),
            "expired ban must not enforce"
        );

        // Server-scoped ban → enforced only on its server.
        create(
            &pool,
            tenant,
            pepper,
            new_ban("SRVBAN", "server", Some(server_a)),
        )
        .await
        .unwrap();
        assert_eq!(
            enforce(&pool, pepper, tenant.0, server_a, &["SRVBAN".into()])
                .await
                .unwrap()
                .len(),
            1,
            "server ban enforces on its server"
        );
        assert!(
            enforce(&pool, pepper, tenant.0, server_b, &["SRVBAN".into()])
                .await
                .unwrap()
                .is_empty(),
            "server ban must not enforce on a different server"
        );
    }

    #[tokio::test]
    async fn name_ban_with_steamid_shaped_value_does_not_enforce() {
        let Some(pool) = setup().await else {
            eprintln!(
                "SKIP name_ban_with_steamid_shaped_value_does_not_enforce: TEST_DATABASE_URL unset"
            );
            return;
        };
        let pepper = b"ban-pepper";
        let tenant = TenantId(Uuid::new_v4());
        // An imported BM name ban whose value happens to look like a SteamID64 (a
        // griefer's rename). HMAC(value) collides with HMAC(steam_id) by construction;
        // the type filter must keep it from kicking the innocent Steam player.
        let mut ban = new_ban("76561198012345678", "network", None);
        ban.subject_type = "name".into();
        create(&pool, tenant, pepper, ban).await.expect("create");

        let hits = enforce(
            &pool,
            pepper,
            tenant.0,
            Uuid::new_v4(),
            &["76561198012345678".into()],
        )
        .await
        .unwrap();
        assert!(
            hits.is_empty(),
            "a name ban must never match a steam identifier"
        );
    }

    #[tokio::test]
    async fn enforcement_is_tenant_isolated() {
        let Some(pool) = setup().await else {
            eprintln!("SKIP enforcement_is_tenant_isolated: TEST_DATABASE_URL unset");
            return;
        };
        let pepper = b"ban-pepper";
        let tenant_a = TenantId(Uuid::new_v4());
        let tenant_b = TenantId(Uuid::new_v4());
        let server = Uuid::new_v4();
        create(&pool, tenant_a, pepper, new_ban("XONLY", "network", None))
            .await
            .unwrap();
        // Tenant B must not see tenant A's ban.
        assert!(
            enforce(&pool, pepper, tenant_b.0, server, &["XONLY".into()])
                .await
                .unwrap()
                .is_empty(),
            "a ban in tenant A must not enforce for tenant B"
        );
    }
}
