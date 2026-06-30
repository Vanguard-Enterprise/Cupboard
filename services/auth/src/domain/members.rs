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
    pub status: String,
    /// Names of the roles assigned to this member.
    pub roles: Vec<String>,
}

/// List the org's members with their assigned role names. RLS confines every joined
/// table (memberships, membership_roles, roles) to `tenant`; `users` is global.
pub async fn list_members(app_pool: &PgPool, tenant: TenantId) -> Result<Vec<Member>, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let members = sqlx::query_as::<_, Member>(
        "SELECT m.id AS membership_id, u.id AS user_id, u.email, u.display_name, m.status, \
                COALESCE(array_agg(r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles \
         FROM memberships m \
         JOIN users u ON u.id = m.user_id \
         LEFT JOIN membership_roles mr ON mr.membership_id = m.id \
         LEFT JOIN roles r ON r.id = mr.role_id \
         GROUP BY m.id, u.id ORDER BY u.display_name",
    )
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(members)
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
