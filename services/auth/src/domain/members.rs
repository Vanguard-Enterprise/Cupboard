//! Organization membership listing and role assignment (app pool, RLS-scoped).

use crate::error::AppError;
use cupboard_domain::TenantId;
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, sqlx::FromRow, serde::Serialize)]
pub struct Member {
    pub membership_id: Uuid,
    pub user_id: Uuid,
    pub email: Option<String>,
    pub display_name: String,
    pub nickname: Option<String>,
    pub status: String,
    /// Names of the roles assigned to this member.
    pub roles: Vec<String>,
}

/// List the org's members with their assigned role names. RLS confines every joined
/// table (memberships, membership_roles, roles) to `tenant`; `users` is global.
pub async fn list_members(app_pool: &PgPool, tenant: TenantId) -> Result<Vec<Member>, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let members = sqlx::query_as::<_, Member>(
        "SELECT m.id AS membership_id, u.id AS user_id, u.email, u.display_name, m.nickname, m.status, \
                COALESCE(array_agg(r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles \
         FROM memberships m \
         JOIN users u ON u.id = m.user_id \
         LEFT JOIN membership_roles mr ON mr.membership_id = m.id \
         LEFT JOIN roles r ON r.id = mr.role_id \
         WHERE m.status = 'active' \
         GROUP BY m.id, u.id ORDER BY COALESCE(m.nickname, u.display_name)",
    )
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(members)
}

/// Set (or clear) the organization-specific nickname shown in this member's row.
pub async fn set_member_nickname(
    app_pool: &PgPool,
    tenant: TenantId,
    membership_id: Uuid,
    nickname: Option<&str>,
) -> Result<(), AppError> {
    let nickname = nickname.map(str::trim).filter(|value| !value.is_empty());
    if nickname.is_some_and(|value| value.chars().count() > 80) {
        return Err(AppError::BadRequest(
            "nickname must be 80 characters or fewer".into(),
        ));
    }
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let result =
        sqlx::query("UPDATE memberships SET nickname = $2 WHERE id = $1 AND status = 'active'")
            .bind(membership_id)
            .bind(nickname)
            .execute(&mut *tx)
            .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("member not found".into()));
    }
    tx.commit().await?;
    Ok(())
}

/// Soft-remove an active member. The actor cannot remove themself or the immutable Owner.
pub async fn remove_member(
    app_pool: &PgPool,
    tenant: TenantId,
    membership_id: Uuid,
    actor_id: Uuid,
) -> Result<(), AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let actor_membership: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM memberships WHERE user_id = $1 AND status = 'active'")
            .bind(actor_id)
            .fetch_optional(&mut *tx)
            .await?;
    if actor_membership == Some(membership_id) {
        return Err(AppError::Conflict(
            "you cannot remove yourself from the organization".into(),
        ));
    }
    let is_owner: Option<bool> = sqlx::query_scalar(
        "SELECT r.immutable FROM membership_roles mr JOIN roles r ON r.id = mr.role_id \
         WHERE mr.membership_id = $1 AND r.immutable = true LIMIT 1",
    )
    .bind(membership_id)
    .fetch_optional(&mut *tx)
    .await?;
    if is_owner == Some(true) {
        return Err(AppError::Forbidden("the Owner cannot be removed".into()));
    }
    let result = sqlx::query(
        "UPDATE memberships SET status = 'removed' WHERE id = $1 AND status = 'active'",
    )
    .bind(membership_id)
    .execute(&mut *tx)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("member not found".into()));
    }
    // A removed membership may be reactivated by a later invite. Do not leave its
    // previous role assignments behind for that reinvite to inherit.
    sqlx::query("DELETE FROM membership_roles WHERE membership_id = $1")
        .bind(membership_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// Replace a member's role set. Verifies (under RLS) that both the membership and every
/// role belong to this org, so a caller can't reach across tenants by id.
pub async fn set_member_roles(
    app_pool: &PgPool,
    tenant: TenantId,
    membership_id: Uuid,
    role_ids: &[Uuid],
) -> Result<(), AppError> {
    let mut unique: Vec<Uuid> = role_ids.to_vec();
    unique.sort();
    unique.dedup();

    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;

    let membership_exists: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM memberships WHERE id = $1")
            .bind(membership_id)
            .fetch_optional(&mut *tx)
            .await?;
    if membership_exists.is_none() {
        return Err(AppError::NotFound("member not found".into()));
    }

    if !unique.is_empty() {
        let found: i64 = sqlx::query_scalar("SELECT count(*) FROM roles WHERE id = ANY($1)")
            .bind(&unique)
            .fetch_one(&mut *tx)
            .await?;
        if found as usize != unique.len() {
            return Err(AppError::BadRequest(
                "one or more roles do not exist in this organization".into(),
            ));
        }
    }

    sqlx::query("DELETE FROM membership_roles WHERE membership_id = $1")
        .bind(membership_id)
        .execute(&mut *tx)
        .await?;
    for role_id in &unique {
        sqlx::query(
            "INSERT INTO membership_roles (organization_id, membership_id, role_id) \
             VALUES ($1, $2, $3)",
        )
        .bind(tenant.0)
        .bind(membership_id)
        .bind(role_id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}
