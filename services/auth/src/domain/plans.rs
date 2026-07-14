//! The org plan mirror (Phase 6 decision K): a local, owner-pool copy of each org's
//! resolved subscription plan, pushed by the tenant service on every subscription
//! change and read at every operator token mint. Keeping it local means the token hot
//! path never calls another service; staleness is healed by the tenant's 15-minute
//! reconcile re-push.
//!
//! The pushed plan is already RESOLVED for gating (the tenant applies past_due grace
//! windows etc. before pushing): auth stores and mints it verbatim, no interpretation.
//! A missing row means the free tier.

use crate::error::AppError;
use cupboard_domain::Plan;
use sqlx::PgPool;
use uuid::Uuid;

/// Upsert the mirror row for `org_id`. `plan` must already be validated against the
/// known wire strings by the caller; `status` is stored verbatim (contract values:
/// active | trialing | past_due | canceled | none).
pub async fn upsert(
    owner_pool: &PgPool,
    org_id: Uuid,
    plan: Plan,
    status: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO org_plans (organization_id, plan, status) VALUES ($1, $2, $3) \
         ON CONFLICT (organization_id) DO UPDATE \
         SET plan = EXCLUDED.plan, status = EXCLUDED.status, updated_at = now()",
    )
    .bind(org_id)
    .bind(plan.as_str())
    .bind(status)
    .execute(owner_pool)
    .await?;
    Ok(())
}

/// The plan `org_id` gates as: the mirrored plan, or [`Plan::Free`] with no row.
/// One indexed PK lookup, cheap enough for the mint hot path (the same cost class as
/// the `resolve_permissions` queries that already run there).
pub async fn gating_plan(owner_pool: &PgPool, org_id: Uuid) -> Result<Plan, AppError> {
    let stored: Option<String> =
        sqlx::query_scalar("SELECT plan FROM org_plans WHERE organization_id = $1")
            .bind(org_id)
            .fetch_optional(owner_pool)
            .await?;
    Ok(Plan::from_claim(stored.as_deref()))
}

/// The value to mint as the JWT `plan` claim for `org_id`: `Some(plan)` for a paid
/// tier, `None` for free. Free is deliberately minted as ABSENT rather than
/// `Some("free")`: absent-means-free is the claim's documented semantics (decision K),
/// it keeps tokens minimal, and old-shape tokens without the claim stay
/// indistinguishable from free-tier ones.
pub async fn plan_claim(owner_pool: &PgPool, org_id: Uuid) -> Result<Option<String>, AppError> {
    let plan = gating_plan(owner_pool, org_id).await?;
    Ok(match plan {
        Plan::Free => None,
        paid => Some(paid.as_str().to_string()),
    })
}
