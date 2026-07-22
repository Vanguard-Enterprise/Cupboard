//! Auth self-walk (Phase 7 PR2, decisions A/A2/B/B2/D): per-player export + erasure
//! over the auth schema, run in-process by the coordinator worker (no HTTP hop, no
//! token; auth calls itself, decision F).
//!
//! Semantics (decision B, auth side): `player_identities` rows are DELETED,
//! `player_accounts.display_name`/`avatar_url` are NULLed (the row itself survives as
//! the surrogate anchor tenant rows join on), `player_sessions` are revoked AND
//! scrubbed (ip/user_agent NULLed), and the one-time login/link code rows for the
//! subject are swept. Scope (decision A2, the identity precedent): platform scope
//! walks everything; tenant scope touches ONLY that tenant's tenant-scoped rows
//! (sessions/codes) and never the global account/identity rows. Every write carries
//! an idempotency guard, so a re-run counts zero. Dry-run runs the identical walk in
//! a rolled-back transaction: exact would-be counts, nothing written, audit included.

use crate::error::AppError;
use serde::Serialize;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

/// Privacy stance of one auth-schema table (decision B2). The schema-inventory
/// oracle test fails on any table missing here, so every migration must take a
/// stance to pass CI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Classification {
    /// Holds player data; covered by the erasure walk (and, where the rows carry
    /// content beyond hashed one-time credentials, by export).
    Walked,
    /// Holds no player data (operator/org/platform/infra rows only).
    NoPlayerData,
    /// Player-linked data retained under a stated lawful basis; never erased.
    RetainedWithBasis,
}

/// Every auth-schema table, classified (decision B2). Operator-population tables are
/// NoPlayerData: operators are a distinct GDPR population whose erasure is decision
/// H's soft-anonymization, not this walk.
pub const CLASSIFIED: &[(&str, Classification)] = &[
    ("_sqlx_migrations", Classification::NoPlayerData),
    // Operator accounts + their identities/sessions (decision H machinery, not players).
    ("users", Classification::NoPlayerData),
    ("user_identities", Classification::NoPlayerData),
    ("sessions", Classification::NoPlayerData),
    // Org/RBAC/invite bookkeeping: staff-side rows only.
    ("organizations", Classification::NoPlayerData),
    ("memberships", Classification::NoPlayerData),
    ("roles", Classification::NoPlayerData),
    ("permission_catalog", Classification::NoPlayerData),
    ("role_permissions", Classification::NoPlayerData),
    ("membership_roles", Classification::NoPlayerData),
    ("invites", Classification::NoPlayerData),
    ("invite_roles", Classification::NoPlayerData),
    ("api_keys", Classification::NoPlayerData),
    ("org_plans", Classification::NoPlayerData),
    // Operator/system action record; 2y retention window (decision E). Audit of
    // erasure is itself a GDPR obligation (decision D); metadata carries surrogate
    // ids + counts only, never raw identifiers.
    ("audit_log", Classification::RetainedWithBasis),
    // The DSAR record itself (accountability basis): job rows outlive the walk so
    // the request/confirm/download trail is provable; bundle bytes are TTL-bounded
    // and one-time (decision C).
    ("privacy_jobs", Classification::RetainedWithBasis),
    ("player_accounts", Classification::Walked),
    ("player_identities", Classification::Walked),
    ("player_sessions", Classification::Walked),
    // One-time code/state rows: erase-swept but not exported (short-TTL keyed-hash
    // credentials; their non-hash content duplicates what player_sessions shows).
    ("player_login_codes", Classification::Walked),
    ("player_link_codes", Classification::Walked),
    ("player_link_states", Classification::Walked),
    // Hashed Steam OpenID nonces with no subject linkage.
    ("openid_replay", Classification::NoPlayerData),
];

/// Blast radius of a walk (decision A2).
#[derive(Debug, Clone, Copy)]
pub enum Scope {
    Platform,
    Tenant(Uuid),
}

impl Scope {
    fn tenant(&self) -> Option<Uuid> {
        match self {
            Scope::Platform => None,
            Scope::Tenant(t) => Some(*t),
        }
    }
}

/// The person being walked (the coordinator fan-out payload, decision A). At least
/// one identifier is present (the job CHECK constraint is the backstop).
#[derive(Debug, Clone)]
pub struct Subject {
    pub steam_id: Option<String>,
    pub discord_id: Option<String>,
    pub player_account_id: Option<Uuid>,
}

/// Per-table changed-row counts for an erasure. The keyset is fixed; global-table
/// steps report 0 under tenant scope (skipped by decision A2, nothing changed).
#[derive(Debug, Default, Serialize)]
pub struct EraseCounts {
    pub player_accounts: u64,
    pub player_identities: u64,
    pub player_sessions: u64,
    pub player_login_codes: u64,
    pub player_link_codes: u64,
    pub player_link_states: u64,
}

/// Resolve the subject to player-account ids: identity match on the raw
/// provider+subject (auth is the store that legitimately holds them, decision A),
/// unioned with a directly-named account id.
async fn resolve(
    tx: &mut Transaction<'_, Postgres>,
    subject: &Subject,
) -> Result<Vec<Uuid>, sqlx::Error> {
    let mut ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT DISTINCT player_account_id FROM player_identities \
         WHERE (provider = 'steam' AND subject = $1::text) \
            OR (provider = 'discord' AND subject = $2::text)",
    )
    .bind(subject.steam_id.as_deref())
    .bind(subject.discord_id.as_deref())
    .fetch_all(&mut **tx)
    .await?;
    if let Some(id) = subject.player_account_id {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    Ok(ids)
}

const TENANT_CLAUSE: &str = "($2::uuid IS NULL OR t.tenant_id = $2)";

/// Export the subject's rows per scope as `{table: [row objects]}`, raw values
/// included (sessions ship ip/user_agent: the access right covers everything held).
/// Tenant scope excludes the global account/identity rows entirely (decision A2), so
/// those keys are absent, the identity-walker convention.
pub async fn export(
    pool: &PgPool,
    scope: Scope,
    subject: &Subject,
) -> Result<serde_json::Map<String, serde_json::Value>, AppError> {
    let mut tx = pool.begin().await?;
    let ids = resolve(&mut tx, subject).await?;
    let tenant = scope.tenant();
    let mut data = serde_json::Map::new();

    let agg = |pred: &str, table: &str| {
        format!(
            "SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]'::jsonb) \
             FROM {table} t WHERE {pred}"
        )
    };
    if tenant.is_none() {
        let accounts: serde_json::Value =
            sqlx::query_scalar(&agg("t.id = ANY($1)", "player_accounts"))
                .bind(&ids)
                .fetch_one(&mut *tx)
                .await?;
        data.insert("player_accounts".into(), accounts);
        let identities: serde_json::Value =
            sqlx::query_scalar(&agg("t.player_account_id = ANY($1)", "player_identities"))
                .bind(&ids)
                .fetch_one(&mut *tx)
                .await?;
        data.insert("player_identities".into(), identities);
    }
    let sessions: serde_json::Value = sqlx::query_scalar(&agg(
        &format!("t.player_account_id = ANY($1) AND {TENANT_CLAUSE}"),
        "player_sessions",
    ))
    .bind(&ids)
    .bind(tenant)
    .fetch_one(&mut *tx)
    .await?;
    data.insert("player_sessions".into(), sessions);
    tx.commit().await?;
    Ok(data)
}

/// Erase the subject's auth rows (decision B semantics) in ONE owner-pool
/// transaction. `dry_run` runs the IDENTICAL walk and rolls back: exact would-be
/// counts, nothing written, not even audit. A real run commits and writes one
/// `player.erase` audit row carrying the surrogate account id and per-table counts,
/// never raw identifiers.
pub async fn erase(
    pool: &PgPool,
    scope: Scope,
    subject: &Subject,
    dry_run: bool,
) -> Result<EraseCounts, AppError> {
    let mut tx = pool.begin().await?;
    let ids = resolve(&mut tx, subject).await?;
    let tenant = scope.tenant();

    // One guarded statement per table; every predicate embeds its idempotency guard.
    async fn scoped(
        tx: &mut Transaction<'_, Postgres>,
        sql: &str,
        ids: &[Uuid],
        tenant: Option<Uuid>,
    ) -> Result<u64, sqlx::Error> {
        Ok(sqlx::query(sql)
            .bind(ids)
            .bind(tenant)
            .execute(&mut **tx)
            .await?
            .rows_affected())
    }

    // Tenant-scoped rows first: sessions revoked AND scrubbed in one guarded update,
    // then the one-time code/state sweeps.
    let player_sessions = scoped(
        &mut tx,
        "UPDATE player_sessions t SET revoked_at = coalesce(t.revoked_at, now()), \
             ip = NULL, user_agent = NULL \
         WHERE t.player_account_id = ANY($1) AND ($2::uuid IS NULL OR t.tenant_id = $2) \
           AND (t.revoked_at IS NULL OR t.ip IS NOT NULL OR t.user_agent IS NOT NULL)",
        &ids,
        tenant,
    )
    .await?;
    let player_login_codes = scoped(
        &mut tx,
        "DELETE FROM player_login_codes t \
         WHERE t.player_account_id = ANY($1) AND ($2::uuid IS NULL OR t.tenant_id = $2)",
        &ids,
        tenant,
    )
    .await?;
    let player_link_codes = scoped(
        &mut tx,
        "DELETE FROM player_link_codes t \
         WHERE t.player_account_id = ANY($1) AND ($2::uuid IS NULL OR t.tenant_id = $2)",
        &ids,
        tenant,
    )
    .await?;
    let player_link_states = scoped(
        &mut tx,
        "DELETE FROM player_link_states t \
         WHERE t.player_account_id = ANY($1) AND ($2::uuid IS NULL OR t.tenant_id = $2)",
        &ids,
        tenant,
    )
    .await?;

    // Global rows: platform scope only (decision A2: a tenant-scoped erasure must
    // never destroy the shared person graph). Identities are DELETEd; the account
    // row survives as a NULLed tombstone anchor.
    let (player_identities, player_accounts) = if tenant.is_none() {
        let identities =
            sqlx::query("DELETE FROM player_identities WHERE player_account_id = ANY($1)")
                .bind(&ids)
                .execute(&mut *tx)
                .await?
                .rows_affected();
        let accounts = sqlx::query(
            "UPDATE player_accounts SET display_name = NULL, avatar_url = NULL \
             WHERE id = ANY($1) AND (display_name IS NOT NULL OR avatar_url IS NOT NULL)",
        )
        .bind(&ids)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        (identities, accounts)
    } else {
        (0, 0)
    };

    let counts = EraseCounts {
        player_accounts,
        player_identities,
        player_sessions,
        player_login_codes,
        player_link_codes,
        player_link_states,
    };

    if dry_run {
        tx.rollback().await?;
        return Ok(counts);
    }

    // Audit in the same transaction (decision D): surrogate account id + counts
    // only. No raw identifiers and no identifier digests either (steam64/snowflake
    // spaces are enumerable, so an unsalted hash is reversible). Skipped when no
    // account resolved and nothing changed (no noise for unknown subjects).
    let changed = counts.player_accounts
        + counts.player_identities
        + counts.player_sessions
        + counts.player_login_codes
        + counts.player_link_codes
        + counts.player_link_states;
    if !ids.is_empty() || changed > 0 {
        sqlx::query(
            "INSERT INTO audit_log (organization_id, actor_id, action, target_type, \
                 target_id, metadata) \
             VALUES ($1, NULL, 'player.erase', 'player', $2, $3)",
        )
        .bind(tenant)
        .bind(ids.first().copied())
        .bind(serde_json::json!({
            "scope": match scope { Scope::Platform => "platform", Scope::Tenant(_) => "tenant" },
            "counts": counts,
        }))
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(counts)
}
