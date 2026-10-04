use crate::{
    auth::{ApiError, ApiResult, AuthSession, account, forbidden, internal, invalid},
    storage::FileStore,
    team,
};
use axum::{
    Extension, Json, Router,
    body::{Body, to_bytes},
    extract::{Path, Request, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use object_store::{ObjectStoreExt, path::Path as ObjectPath};
use percent_encoding::{NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use serde::Serialize;
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use tower_sessions::Session;

pub const MAX_FILE_SIZE: usize = 10 * 1024 * 1024;
#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
struct File {
    id: String,
    name: String,
    size: i64,
    created_at: i64,
}

pub fn routes() -> Router<PgPool> {
    Router::new()
        .route("/app-api/files", get(list).post(upload))
        .route("/app-api/files/{id}", get(download))
        .route("/app-api/files/{id}/delete", post(delete))
}
fn unavailable() -> ApiError {
    ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        "File storage is unavailable. Try again shortly.",
    )
}
fn key(org: &str, id: &str) -> ObjectPath {
    ObjectPath::from(format!("organizations/{org}/files/{id}"))
}
fn store(store: &Option<Extension<FileStore>>) -> ApiResult<&FileStore> {
    store.as_ref().map(|s| &s.0).ok_or_else(unavailable)
}
async fn authorized<'a>(
    pool: &'a PgPool,
    auth: &AuthSession,
    session: &Session,
    headers: &HeaderMap,
) -> ApiResult<(Transaction<'a, Postgres>, String)> {
    let user = account(auth)?;
    let org = team::organization_id(session).await?;
    if headers
        .get("x-cupboard-organization")
        .and_then(|value| value.to_str().ok())
        != Some(org.as_str())
    {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "The active organization changed. Refresh the page before accessing files.",
        ));
    }
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT id FROM organizations WHERE id=$1 FOR SHARE")
        .bind(&org)
        .execute(&mut *tx)
        .await?;
    let ctx = team::context_on(&mut tx, &user.id, &org).await?;
    if !ctx.permissions.iter().any(|p| p == "organization.manage") {
        return Err(forbidden());
    }
    Ok((tx, ctx.organization_id))
}
async fn list(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    storage: Option<Extension<FileStore>>,
    headers: HeaderMap,
) -> ApiResult<Json<Vec<File>>> {
    let (mut tx, org) = authorized(&pool, &auth, &session, &headers).await?;
    store(&storage)?;
    let files = sqlx::query_as("SELECT id,name,size,created_at FROM organization_files WHERE organization_id=$1 AND ready ORDER BY created_at DESC,id DESC").bind(org).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(files))
}
fn filename(request: &Request) -> ApiResult<String> {
    let encoded = request
        .headers()
        .get("x-cupboard-filename")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| invalid("Choose a file to upload."))?;
    let name = percent_decode_str(encoded)
        .decode_utf8()
        .map_err(|_| invalid("Use a valid filename."))?
        .trim()
        .to_owned();
    if name.is_empty()
        || name.len() > 255
        || name == "."
        || name == ".."
        || name
            .chars()
            .any(|c| c.is_control() || c == '/' || c == '\\')
    {
        return Err(invalid(
            "Use a filename of 1 to 255 bytes without slashes or control characters.",
        ));
    }
    Ok(name)
}
async fn upload(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    storage: Option<Extension<FileStore>>,
    request: Request,
) -> ApiResult<Json<File>> {
    let headers = request.headers().clone();
    let (mut tx, org) = authorized(&pool, &auth, &session, &headers).await?;
    let storage = store(&storage)?;
    if request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        != Some("application/octet-stream")
    {
        return Err(invalid("Upload the file as binary data."));
    }
    let name = filename(&request)?;
    let data = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        to_bytes(request.into_body(), MAX_FILE_SIZE),
    )
    .await
    .map_err(|_| ApiError(StatusCode::REQUEST_TIMEOUT, "Upload timed out. Try again."))?
    .map_err(|_| {
        ApiError(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Choose a file no larger than 10 MiB.",
        )
    })?;
    let id = uuid::Uuid::new_v4().to_string();
    let file: File = sqlx::query_as("INSERT INTO organization_files(organization_id,id,name,size) VALUES($1,$2,$3,$4) RETURNING id,name,size,created_at").bind(&org).bind(&id).bind(name).bind(data.len() as i64).fetch_one(&mut *tx).await?;
    // Persist the key before S3 I/O so interrupted uploads can be reclaimed.
    tx.commit().await?;
    let (mut tx, org) = authorized(&pool, &auth, &session, &headers).await?;
    sqlx::query("SELECT id FROM organization_files WHERE organization_id=$1 AND id=$2 FOR UPDATE")
        .bind(&org)
        .bind(&id)
        .fetch_one(&mut *tx)
        .await?;
    storage
        .0
        .put(&key(&org, &id), data.into())
        .await
        .map_err(|_| unavailable())?;
    sqlx::query("UPDATE organization_files SET ready=true WHERE organization_id=$1 AND id=$2")
        .bind(&org)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(file))
}
async fn download(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    storage: Option<Extension<FileStore>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let (mut tx, org) = authorized(&pool, &auth, &session, &headers).await?;
    let file: File = sqlx::query_as("SELECT id,name,size,created_at FROM organization_files WHERE organization_id=$1 AND id=$2 AND ready FOR SHARE").bind(&org).bind(&id).fetch_optional(&mut *tx).await?.ok_or(ApiError(StatusCode::NOT_FOUND, "File not found."))?;
    let object = store(&storage)?
        .0
        .get(&key(&org, &file.id))
        .await
        .map_err(|_| unavailable())?;
    if object.meta.size != file.size as u64 {
        return Err(unavailable());
    }
    let bytes = object.bytes().await.map_err(|_| unavailable())?;
    if bytes.len() != file.size as usize {
        return Err(unavailable());
    }
    tx.commit().await?;
    let mut response = Body::from(bytes).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        "application/octet-stream".parse().unwrap(),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        format!(
            "attachment; filename=\"download\"; filename*=UTF-8''{}",
            utf8_percent_encode(&file.name, NON_ALPHANUMERIC)
        )
        .parse()
        .map_err(|_| internal())?,
    );
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    headers.insert(
        header::CONTENT_LENGTH,
        file.size.to_string().parse().unwrap(),
    );
    Ok(response)
}
async fn delete(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    storage: Option<Extension<FileStore>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Json<serde_json::Value>> {
    let (mut tx, org) = authorized(&pool, &auth, &session, &headers).await?;
    let storage = store(&storage)?;
    // Persist the tombstone first. A failed S3 delete is retried by cleanup.
    let found =
        sqlx::query("UPDATE organization_files SET ready=false WHERE organization_id=$1 AND id=$2")
            .bind(&org)
            .bind(&id)
            .execute(&mut *tx)
            .await?;
    if found.rows_affected() == 0 {
        return Err(ApiError(StatusCode::NOT_FOUND, "File not found."));
    }
    tx.commit().await?;
    remove(&pool, storage, &org, &id).await?;
    Ok(Json(serde_json::json!({"deleted": true})))
}
pub(crate) async fn remove(
    pool: &PgPool,
    storage: &FileStore,
    org: &str,
    id: &str,
) -> ApiResult<()> {
    let mut tx = pool.begin().await?;
    let row: Option<String> = sqlx::query_scalar("SELECT id FROM organization_files WHERE organization_id=$1 AND id=$2 AND NOT ready FOR UPDATE").bind(org).bind(id).fetch_optional(&mut *tx).await?;
    if row.is_some() {
        match storage.0.delete(&key(org, id)).await {
            Ok(_) | Err(object_store::Error::NotFound { .. }) => {}
            Err(_) => return Err(unavailable()),
        }
        sqlx::query("DELETE FROM organization_files WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}
pub async fn cleanup(pool: PgPool, storage: FileStore) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(600));
    loop {
        interval.tick().await;
        // An hour exceeds all bounded request times. Row locks serialize cleanup with uploads.
        let rows: Result<Vec<(String, String)>, _> = sqlx::query_as("SELECT organization_id,id FROM organization_files WHERE NOT ready AND created_at < extract(epoch FROM now())::bigint-3600 ORDER BY created_at LIMIT 100").fetch_all(&pool).await;
        if let Ok(rows) = rows {
            for (org, id) in rows {
                let _ = remove(&pool, &storage, &org, &id).await;
            }
        }
    }
}
