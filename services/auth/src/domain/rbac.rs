//! RBAC: resolving a user's effective permissions in an org (for token minting, on the
//! owner pool) and managing custom roles (on the RLS-scoped app pool).

use crate::error::AppError;
use cupboard_domain::{Permission, TenantId};
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, sqlx::FromRow, serde::Serialize)]
pub struct Role {
    pub id: Uuid,
    pub name: String,
    pub immutable: bool,
    /// Permission strings granted by this role.
    pub permissions: Vec<String>,
}

/// Resolve a user's effective permission strings within `org_id`. Returns `None` when
/// the user is not an active member (caller maps to 403). On the owner pool — this is
/// system work done while minting an org-scoped token.
pub async fn resolve_permissions(
    owner_pool: &PgPool,
    user_id: Uuid,
    org_id: Uuid,
) -> Result<Option<Vec<String>>, AppError> {
    let membership_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM memberships \
         WHERE user_id = $1 AND organization_id = $2 AND status = 'active'",
    )
    .bind(user_id)
    .bind(org_id)
    .fetch_optional(owner_pool)
    .await?;

    let Some(membership_id) = membership_id else {
        return Ok(None);
    };

    let perms: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT rp.permission FROM membership_roles mr \
         JOIN role_permissions rp ON rp.role_id = mr.role_id \
         WHERE mr.membership_id = $1",
    )
    .bind(membership_id)
    .fetch_all(owner_pool)
    .await?;
    Ok(Some(perms))
}

/// Validate that every string is a known permission; returns the unknown one if not.
pub fn validate_permissions(perms: &[String]) -> Result<(), AppError> {
    for p in perms {
        if Permission::from_wire(p).is_none() {
            return Err(AppError::BadRequest(format!("unknown permission: {p}")));
        }
    }
    Ok(())
}

/// List the org's roles with their permissions (app pool, RLS-scoped to `tenant`).
pub async fn list_roles(app_pool: &PgPool, tenant: TenantId) -> Result<Vec<Role>, AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let roles = sqlx::query_as::<_, Role>(
        "SELECT r.id, r.name, r.immutable, \
                COALESCE(array_agg(rp.permission) FILTER (WHERE rp.permission IS NOT NULL), '{}') \
                    AS permissions \
         FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id \
         GROUP BY r.id ORDER BY r.name",
    )
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(roles)
}

/// Create a custom role with the given permissions. RLS-scoped to `tenant`.
pub async fn create_role(
    app_pool: &PgPool,
    tenant: TenantId,
    name: &str,
    permissions: &[String],
) -> Result<Role, AppError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("role name is required".into()));
    }
    validate_permissions(permissions)?;

    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let role_id: Uuid = sqlx::query_scalar(
        "INSERT INTO roles (organization_id, name) VALUES ($1, $2) RETURNING id",
    )
    .bind(tenant.0)
    .bind(name)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| match e {
        sqlx::Error::Database(db) if db.is_unique_violation() => {
            AppError::Conflict("a role with that name already exists".into())
        }
        other => other.into(),
    })?;

    for perm in permissions {
        sqlx::query(
            "INSERT INTO role_permissions (organization_id, role_id, permission) VALUES ($1, $2, $3)",
        )
        .bind(tenant.0)
        .bind(role_id)
        .bind(perm)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    Ok(Role {
        id: role_id,
        name: name.to_string(),
        immutable: false,
        permissions: permissions.to_vec(),
    })
}

/// Replace a custom role's name and/or permissions. Rejects edits to immutable roles
/// (the Owner) and unknown roles.
pub async fn update_role(
    app_pool: &PgPool,
    tenant: TenantId,
    role_id: Uuid,
    name: Option<&str>,
    permissions: Option<&[String]>,
) -> Result<(), AppError> {
    if let Some(perms) = permissions {
        validate_permissions(perms)?;
    }

    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    // RLS scopes this to the tenant; `immutable` distinguishes Owner.
    let immutable: Option<bool> = sqlx::query_scalar("SELECT immutable FROM roles WHERE id = $1")
        .bind(role_id)
        .fetch_optional(&mut *tx)
        .await?;
    match immutable {
        None => return Err(AppError::NotFound("role not found".into())),
        Some(true) => {
            return Err(AppError::Forbidden(
                "the Owner role cannot be edited".into(),
            ))
        }
        Some(false) => {}
    }

    if let Some(name) = name {
        sqlx::query("UPDATE roles SET name = $2, updated_at = now() WHERE id = $1")
            .bind(role_id)
            .bind(name.trim())
            .execute(&mut *tx)
            .await
            .map_err(|e| match e {
                sqlx::Error::Database(db) if db.is_unique_violation() => {
                    AppError::Conflict("a role with that name already exists".into())
                }
                other => other.into(),
            })?;
    }
    if let Some(perms) = permissions {
        sqlx::query("DELETE FROM role_permissions WHERE role_id = $1")
            .bind(role_id)
            .execute(&mut *tx)
            .await?;
        for perm in perms {
            sqlx::query(
                "INSERT INTO role_permissions (organization_id, role_id, permission) \
                 VALUES ($1, $2, $3)",
            )
            .bind(tenant.0)
            .bind(role_id)
            .bind(perm)
            .execute(&mut *tx)
            .await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

/// Delete a custom role. Rejects the immutable Owner and unknown roles.
pub async fn delete_role(
    app_pool: &PgPool,
    tenant: TenantId,
    role_id: Uuid,
) -> Result<(), AppError> {
    let mut tx = cupboard_db::begin_tenant_tx(app_pool, tenant).await?;
    let immutable: Option<bool> = sqlx::query_scalar("SELECT immutable FROM roles WHERE id = $1")
        .bind(role_id)
        .fetch_optional(&mut *tx)
        .await?;
    match immutable {
        None => return Err(AppError::NotFound("role not found".into())),
        Some(true) => {
            return Err(AppError::Forbidden(
                "the Owner role cannot be deleted".into(),
            ))
        }
        Some(false) => {}
    }
    sqlx::query("DELETE FROM roles WHERE id = $1")
        .bind(role_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}
