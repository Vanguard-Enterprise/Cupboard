//! The service error type and its mapping to HTTP responses. Handlers return
//! `Result<T, AppError>`; client-facing errors carry a stable `error` code plus a
//! human message, while unexpected failures are logged and surfaced as a generic 500.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Forbidden(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("service unavailable: {0}")]
    Unavailable(String),
    /// Anything unexpected — logged with detail, shown to the client as a bare 500.
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl AppError {
    /// `(status, stable error code)` for this variant.
    fn parts(&self) -> (StatusCode, &'static str) {
        match self {
            AppError::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad_request"),
            AppError::Unauthorized(_) => (StatusCode::UNAUTHORIZED, "unauthorized"),
            AppError::Forbidden(_) => (StatusCode::FORBIDDEN, "forbidden"),
            AppError::NotFound(_) => (StatusCode::NOT_FOUND, "not_found"),
            AppError::Conflict(_) => (StatusCode::CONFLICT, "conflict"),
            AppError::Unavailable(_) => (StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
            AppError::Internal(_) => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code) = self.parts();
        let message = if status == StatusCode::INTERNAL_SERVER_ERROR {
            // Don't leak internals; log the detail server-side.
            tracing::error!(error = ?self, "internal error");
            "internal server error".to_string()
        } else {
            self.to_string()
        };
        (status, Json(json!({ "error": code, "message": message }))).into_response()
    }
}

/// sqlx errors are always unexpected at the handler boundary (callers translate the
/// few expected ones — e.g. unique violations — into `Conflict` before this).
impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        AppError::Internal(e.into())
    }
}

impl From<cupboard_db::DbError> for AppError {
    fn from(e: cupboard_db::DbError) -> Self {
        AppError::Internal(e.into())
    }
}

impl From<cupboard_auth_core::AuthCoreError> for AppError {
    fn from(e: cupboard_auth_core::AuthCoreError) -> Self {
        AppError::Internal(e.into())
    }
}
