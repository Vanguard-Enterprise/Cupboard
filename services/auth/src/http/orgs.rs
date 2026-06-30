//! Organization endpoints: create an org (caller becomes Owner) and list the caller's
//! orgs (the tenant switcher). Org switching itself is `POST /auth/token` with `org_id`.

use crate::domain::{audit, orgs};
use crate::error::AppError;
use crate::http::AuthClaims;
use crate::state::AppState;
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;

#[derive(Deserialize)]
pub struct CreateOrgRequest {
    pub name: String,
    #[serde(default)]
    pub slug: Option<String>,
}

/// Any authenticated user may create an org; they become its Owner.
pub async fn create(
    State(state): State<AppState>,
    claims: AuthClaims,
    Json(req): Json<CreateOrgRequest>,
) -> Result<(StatusCode, Json<orgs::Organization>), AppError> {
    let name = req.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("organization name is required".into()));
    }
    let slug = req
        .slug
        .map(|s| orgs::slugify(&s))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| orgs::slugify(name));
    if slug.is_empty() {
        return Err(AppError::BadRequest(
            "could not derive a URL slug from the name".into(),
        ));
    }

    let org = orgs::create_organization(&state.owner_pool, name, &slug, claims.0.sub.0).await?;
    audit::record(
        &state.owner_pool,
        Some(org.id),
        Some(claims.0.sub.0),
        "org.create",
        Some("organization"),
        Some(org.id),
        None,
    )
    .await;
    Ok((StatusCode::CREATED, Json(org)))
}

/// List the orgs the caller is an active member of.
pub async fn list(
    State(state): State<AppState>,
    claims: AuthClaims,
) -> Result<Json<Vec<orgs::Organization>>, AppError> {
    Ok(Json(
        orgs::list_for_user(&state.owner_pool, claims.0.sub.0).await?,
    ))
}
