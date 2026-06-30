//! Organizations (tenants) and membership. Creation seeds the per-org default roles and
//! makes the creator the Owner. All operations here are cross-tenant/system work, so
//! they run on the owner pool (RLS-exempt).

use crate::error::AppError;
use cupboard_domain::DEFAULT_ROLE_TEMPLATES;
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, sqlx::FromRow, serde::Serialize)]
pub struct Organization {
    pub id: Uuid,
    pub slug: String,
    pub name: String,
}

/// Create an organization, instantiate the default role templates into it, and add the
/// creator as an Owner — atomically. Returns [`AppError::Conflict`] on a slug clash.
pub async fn create_organization(
    owner_pool: &PgPool,
    name: &str,
    slug: &str,
    creator: Uuid,
) -> Result<Organization, AppError> {
    let mut tx = owner_pool.begin().await?;

    let org = sqlx::query_as::<_, Organization>(
        "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id, slug, name",
    )
    .bind(name)
    .bind(slug)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| match e {
        sqlx::Error::Database(db) if db.is_unique_violation() => {
            AppError::Conflict("an organization with that slug already exists".into())
        }
        other => other.into(),
    })?;

    // Seed default roles + their permissions; remember the Owner role to assign it.
    let mut owner_role_id: Option<Uuid> = None;
    for tpl in DEFAULT_ROLE_TEMPLATES {
        let role_id: Uuid = sqlx::query_scalar(
            "INSERT INTO roles (organization_id, name, immutable) VALUES ($1, $2, $3) RETURNING id",
        )
        .bind(org.id)
        .bind(tpl.name)
        .bind(tpl.immutable)
        .fetch_one(&mut *tx)
        .await?;

        for perm in tpl.permissions {
            sqlx::query(
                "INSERT INTO role_permissions (organization_id, role_id, permission) \
                 VALUES ($1, $2, $3)",
            )
            .bind(org.id)
            .bind(role_id)
            .bind(perm.as_str())
            .execute(&mut *tx)
            .await?;
        }

        if tpl.name == "Owner" {
            owner_role_id = Some(role_id);
        }
    }
    let owner_role_id = owner_role_id.expect("Owner template is always present");

    let membership_id: Uuid = sqlx::query_scalar(
        "INSERT INTO memberships (organization_id, user_id, status) VALUES ($1, $2, 'active') \
         RETURNING id",
    )
    .bind(org.id)
    .bind(creator)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO membership_roles (organization_id, membership_id, role_id) \
         VALUES ($1, $2, $3)",
    )
    .bind(org.id)
    .bind(membership_id)
    .bind(owner_role_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(org)
}

/// All organizations the user is an active member of — drives the tenant switcher.
pub async fn list_for_user(
    owner_pool: &PgPool,
    user_id: Uuid,
) -> Result<Vec<Organization>, AppError> {
    Ok(sqlx::query_as::<_, Organization>(
        "SELECT o.id, o.slug, o.name FROM organizations o \
         JOIN memberships m ON m.organization_id = o.id \
         WHERE m.user_id = $1 AND m.status = 'active' \
         ORDER BY o.name",
    )
    .bind(user_id)
    .fetch_all(owner_pool)
    .await?)
}

/// Derive a URL-safe slug from a display name (lowercase, non-alphanumerics → `-`).
pub fn slugify(name: &str) -> String {
    let mut slug = String::with_capacity(name.len());
    let mut prev_dash = false;
    for ch in name.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            slug.push('-');
            prev_dash = true;
        }
    }
    slug.trim_matches('-').to_string()
}
