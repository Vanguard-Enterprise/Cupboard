pub mod auth;
mod team;
use axum::{Router, extract::State, http::StatusCode, routing::get};
use sqlx::{ConnectOptions, PgPool, postgres::PgConnectOptions, postgres::PgPoolOptions};
use std::{str::FromStr, time::Duration};

/// Return fixed errors only: connection errors can contain credentials or hosts.
pub async fn connect(database_url: &str) -> Result<PgPool, &'static str> {
    let options = PgConnectOptions::from_str(database_url)
        .map_err(|_| "DATABASE_URL is invalid")?
        .disable_statement_logging();
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(Duration::from_secs(3))
        .connect_with(options)
        .await
        .map_err(|_| "PostgreSQL connection failed")?;
    sqlx::migrate!("backend/migrations")
        .run(&pool)
        .await
        .map_err(|_| "PostgreSQL migration failed")?;
    Ok(pool)
}

pub fn router(pool: PgPool) -> Router {
    router_with_auth(pool, auth::AuthConfig::default())
}

pub fn router_with_auth(pool: PgPool, config: auth::AuthConfig) -> Router {
    Router::new()
        .route("/health/live", get(|| async { StatusCode::NO_CONTENT }))
        .route("/health/ready", get(readiness))
        .with_state(pool.clone())
        .merge(auth::routes(pool, config))
}

async fn readiness(State(pool): State<PgPool>) -> StatusCode {
    match tokio::time::timeout(
        Duration::from_secs(3),
        sqlx::query("SELECT 1").execute(&pool),
    )
    .await
    {
        Ok(Ok(_)) => StatusCode::NO_CONTENT,
        _ => StatusCode::SERVICE_UNAVAILABLE,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use tower::ServiceExt;

    #[tokio::test]
    async fn liveness_does_not_require_a_database_and_unknown_routes_are_closed() {
        let pool = PgPoolOptions::new()
            .connect_lazy("postgres://unused:unused@127.0.0.1/unused")
            .unwrap();
        for (path, expected) in [
            ("/health/live", StatusCode::NO_CONTENT),
            ("/app-api/tenants", StatusCode::NOT_FOUND),
            ("/api/v1/servers", StatusCode::NOT_FOUND),
        ] {
            let response = router(pool.clone())
                .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
        }
    }

    #[tokio::test]
    async fn readiness_failure_has_no_database_details() {
        let pool = PgPoolOptions::new()
            .connect_lazy("postgres://private-user:private-password@127.0.0.1/private-db")
            .unwrap();
        pool.close().await;
        let response = router(pool)
            .oneshot(
                Request::builder()
                    .uri("/health/ready")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(
            to_bytes(response.into_body(), 1024)
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            connect("private-password").await.unwrap_err(),
            "DATABASE_URL is invalid"
        );
    }

    #[tokio::test]
    async fn postgres_connects_migrates_and_reports_ready_after_reconnect() {
        let url = std::env::var("CUPBOARD_TEST_DATABASE_URL").expect(
            "CUPBOARD_TEST_DATABASE_URL must point to a dedicated test database; use npm run check",
        );
        for _ in 0..2 {
            let pool = connect(&url).await.unwrap();
            let response = router(pool.clone())
                .oneshot(
                    Request::builder()
                        .uri("/health/ready")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NO_CONTENT);
            pool.close().await;
        }
    }
}

#[cfg(test)]
mod auth_tests;
