//! The cluster-internal plan-mirror write endpoint (Phase 6 decision K): the tenant
//! service pushes each org's RESOLVED plan here on every subscription change (webhook
//! or reconcile), and auth mints it into operator tokens verbatim.

use crate::domain::plans;
use crate::error::AppError;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use cupboard_domain::Plan;
use serde::Deserialize;
use uuid::Uuid;

const INTERNAL_TOKEN_HEADER: &str = "x-internal-token";

/// Guard for the plan write: constant-time compare against the DISTINCT
/// `PLAN_WRITE_TOKEN` (never the shared `INTERNAL_API_TOKEN`; a plan write is a
/// privilege-escalation primitive, decision K), failing closed when unset. Plain 401
/// here, unlike the exchange guard's 403: the caller is the tenant service's push
/// loop, not the gateway's negative cache, so there is nothing that could mis-cache
/// a guard failure as a key refusal.
fn check_plan_write_token(state: &AppState, headers: &HeaderMap) -> Result<(), AppError> {
    let expected = state
        .config
        .plan_write_token
        .as_deref()
        .ok_or_else(|| AppError::Unauthorized("plan writes disabled".into()))?;
    let presented = headers
        .get(INTERNAL_TOKEN_HEADER)
        .and_then(|h| h.to_str().ok())
        .unwrap_or_default();
    if presented.is_empty()
        || !cupboard_crypto::constant_time_eq(presented.as_bytes(), expected.as_bytes())
    {
        return Err(AppError::Unauthorized("invalid plan write token".into()));
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct PutPlanRequest {
    pub plan: String,
    /// Stored verbatim (contract: active | trialing | past_due | canceled | none);
    /// the plan is already resolved for gating, so auth never interprets this.
    pub status: String,
}

/// `PUT /internal/orgs/{id}/plan`: upsert the org's mirrored plan (owner pool).
pub async fn put_org_plan(
    State(state): State<AppState>,
    Path(org_id): Path<Uuid>,
    headers: HeaderMap,
    Json(req): Json<PutPlanRequest>,
) -> Result<StatusCode, AppError> {
    check_plan_write_token(&state, &headers)?;
    let plan = Plan::from_wire(&req.plan)
        .ok_or_else(|| AppError::BadRequest(format!("unknown plan: {}", req.plan)))?;
    if req.status.trim().is_empty() {
        return Err(AppError::BadRequest("status is required".into()));
    }
    plans::upsert(&state.owner_pool, org_id, plan, req.status.trim()).await?;
    Ok(StatusCode::NO_CONTENT)
}
