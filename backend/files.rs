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
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use tower_sessions::Session;

pub const MAX_FILE_SIZE: usize = 10 * 1024 * 1024;
#[derive(Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
struct File {
    id: String,
    name: String,
    size: i64,
    created_at: i64,
    parent_id: Option<String>,
    is_folder: bool,
}

pub fn routes() -> Router<PgPool> {
    Router::new()
        .route("/app-api/files", get(list).post(upload))
        .route("/app-api/files/folders", post(create_folder))
        .route(
            "/app-api/files/{id}/share",
            get(share_status).post(create_share),
        )
        .route("/app-api/files/{id}/share/revoke", post(revoke_share))
        .route("/app-api/public-files/download", post(public_download))
        .route("/app-api/files/{id}/rename", post(rename))
        .route("/app-api/files/{id}/move", post(move_file))
        .route("/app-api/files/{id}/copy", post(copy_file))
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
    sqlx::query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE")
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
    let files = sqlx::query_as("SELECT id,name,size,created_at,parent_id,is_folder FROM organization_files WHERE organization_id=$1 AND ready ORDER BY created_at DESC,id DESC").bind(org).fetch_all(&mut *tx).await?;
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
    valid_name(&name)?;
    Ok(name)
}
fn valid_name(name: &str) -> ApiResult<()> {
    if name.trim().is_empty()
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
    Ok(())
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
    let parent = headers
        .get("x-cupboard-folder")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    destination(&mut tx, &org, parent.as_deref()).await?;
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
    let file: File = sqlx::query_as("INSERT INTO organization_files(organization_id,id,name,size,parent_id) VALUES($1,$2,$3,$4,$5) RETURNING id,name,size,created_at,parent_id,is_folder").bind(&org).bind(&id).bind(name).bind(data.len() as i64).bind(parent).fetch_one(&mut *tx).await?;
    // Persist the key before S3 I/O so interrupted uploads can be reclaimed.
    tx.commit().await?;
    let (mut tx, org) = authorized(&pool, &auth, &session, &headers).await?;
    // A destination deleted while the pending key was committed must not make
    // this upload reappear in the root folder.
    destination(&mut tx, &org, file.parent_id.as_deref()).await?;
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
    let file: File = sqlx::query_as("SELECT id,name,size,created_at,parent_id,is_folder FROM organization_files WHERE organization_id=$1 AND id=$2 AND ready FOR SHARE").bind(&org).bind(&id).fetch_optional(&mut *tx).await?.ok_or(ApiError(StatusCode::NOT_FOUND, "File not found."))?;
    if file.is_folder {
        return Err(invalid("Open the folder to download its files."));
    }
    let bytes = file_bytes(store(&storage)?, &org, &file).await?;
    tx.commit().await?;
    attachment(&file, bytes)
}
async fn file_bytes(storage: &FileStore, org: &str, file: &File) -> ApiResult<axum::body::Bytes> {
    let object = storage
        .0
        .get(&key(org, &file.id))
        .await
        .map_err(|_| unavailable())?;
    if object.meta.size != file.size as u64 {
        return Err(unavailable());
    }
    let bytes = object.bytes().await.map_err(|_| unavailable())?;
    if bytes.len() != file.size as usize {
        return Err(unavailable());
    }
    Ok(bytes)
}
fn attachment(file: &File, bytes: axum::body::Bytes) -> ApiResult<Response> {
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
    let entries = subtree(&mut tx, &org, &id).await?;
    for entry in &entries {
        sqlx::query("UPDATE organization_files SET ready=false WHERE organization_id=$1 AND id=$2")
            .bind(&org)
            .bind(&entry.id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    for entry in entries.iter().rev() {
        remove(&pool, storage, &org, &entry.id).await?;
    }
    Ok(Json(serde_json::json!({"deleted": true})))
}
pub(crate) async fn remove(
    pool: &PgPool,
    storage: &FileStore,
    org: &str,
    id: &str,
) -> ApiResult<()> {
    let mut tx = pool.begin().await?;
    let row: Option<bool> = sqlx::query_scalar("SELECT is_folder FROM organization_files WHERE organization_id=$1 AND id=$2 AND NOT ready FOR UPDATE").bind(org).bind(id).fetch_optional(&mut *tx).await?;
    if let Some(is_folder) = row {
        if !is_folder {
            match storage.0.delete(&key(org, id)).await {
                Ok(_) | Err(object_store::Error::NotFound { .. }) => {}
                Err(_) => return Err(unavailable()),
            }
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NamedFolder {
    name: String,
    parent_id: Option<String>,
}
#[derive(Deserialize)]
struct Rename {
    name: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Destination {
    parent_id: Option<String>,
}

async fn destination(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    id: Option<&str>,
) -> ApiResult<()> {
    if let Some(id) = id {
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM organization_files WHERE organization_id=$1 AND id=$2 AND is_folder AND ready)")
            .bind(org).bind(id).fetch_one(&mut **tx).await?;
        if !exists {
            return Err(ApiError(
                StatusCode::NOT_FOUND,
                "Folder not found. Refresh and try again.",
            ));
        }
    }
    Ok(())
}
async fn subtree(tx: &mut Transaction<'_, Postgres>, org: &str, id: &str) -> ApiResult<Vec<File>> {
    let files: Vec<File> = sqlx::query_as("WITH RECURSIVE tree AS (SELECT id,name,size,created_at,parent_id,is_folder,0 AS depth FROM organization_files WHERE organization_id=$1 AND id=$2 AND ready UNION ALL SELECT f.id,f.name,f.size,f.created_at,f.parent_id,f.is_folder,t.depth+1 FROM organization_files f JOIN tree t ON f.parent_id=t.id WHERE f.organization_id=$1 AND f.ready) SELECT id,name,size,created_at,parent_id,is_folder FROM tree ORDER BY depth,id")
        .bind(org).bind(id).fetch_all(&mut **tx).await?;
    if files.is_empty() {
        return Err(ApiError(StatusCode::NOT_FOUND, "File not found."));
    }
    Ok(files)
}
async fn create_folder(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    headers: HeaderMap,
    Json(input): Json<NamedFolder>,
) -> ApiResult<Json<File>> {
    let (mut tx, org) = authorized(&pool, &auth, &session, &headers).await?;
    let name = input.name.trim();
    valid_name(name)?;
    destination(&mut tx, &org, input.parent_id.as_deref()).await?;
    let file = sqlx::query_as("INSERT INTO organization_files(organization_id,id,name,size,parent_id,is_folder,ready) VALUES($1,$2,$3,0,$4,true,true) RETURNING id,name,size,created_at,parent_id,is_folder")
        .bind(&org).bind(uuid::Uuid::new_v4().to_string()).bind(name).bind(input.parent_id).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(file))
}
async fn rename(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<Rename>,
) -> ApiResult<Json<File>> {
    let (mut tx, org) = authorized(&pool, &auth, &session, &headers).await?;
    let name = input.name.trim();
    valid_name(name)?;
    let file = sqlx::query_as("UPDATE organization_files SET name=$3 WHERE organization_id=$1 AND id=$2 AND ready RETURNING id,name,size,created_at,parent_id,is_folder")
        .bind(&org).bind(id).bind(name).fetch_optional(&mut *tx).await?.ok_or(ApiError(StatusCode::NOT_FOUND, "File not found."))?;
    tx.commit().await?;
    Ok(Json(file))
}
async fn move_file(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<Destination>,
) -> ApiResult<Json<File>> {
    let (mut tx, org) = authorized(&pool, &auth, &session, &headers).await?;
    destination(&mut tx, &org, input.parent_id.as_deref()).await?;
    let entries = subtree(&mut tx, &org, &id).await?;
    if entries
        .iter()
        .any(|file| Some(&file.id) == input.parent_id.as_ref())
    {
        return Err(invalid(
            "A folder cannot be moved into itself or one of its subfolders.",
        ));
    }
    let file = sqlx::query_as("UPDATE organization_files SET parent_id=$3 WHERE organization_id=$1 AND id=$2 AND ready RETURNING id,name,size,created_at,parent_id,is_folder")
        .bind(&org).bind(id).bind(input.parent_id).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(file))
}
async fn copy_file(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    storage: Option<Extension<FileStore>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<Destination>,
) -> ApiResult<Json<Vec<File>>> {
    let (mut tx, org) = authorized(&pool, &auth, &session, &headers).await?;
    let storage = store(&storage)?;
    destination(&mut tx, &org, input.parent_id.as_deref()).await?;
    let entries = subtree(&mut tx, &org, &id).await?;
    if entries
        .iter()
        .any(|file| Some(&file.id) == input.parent_id.as_ref())
    {
        return Err(invalid(
            "Choose a destination outside the folder being copied.",
        ));
    }
    let mut ids = std::collections::HashMap::new();
    let mut copies: Vec<File> = Vec::new();
    for entry in &entries {
        let new_id = uuid::Uuid::new_v4().to_string();
        let parent = if entry.id == id {
            input.parent_id.clone()
        } else {
            entry.parent_id.as_ref().and_then(|p| ids.get(p)).cloned()
        };
        let copy = sqlx::query_as("INSERT INTO organization_files(organization_id,id,name,size,parent_id,is_folder) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,size,created_at,parent_id,is_folder")
            .bind(&org).bind(&new_id).bind(&entry.name).bind(entry.size).bind(parent).bind(entry.is_folder).fetch_one(&mut *tx).await?;
        ids.insert(entry.id.clone(), new_id);
        copies.push(copy);
    }
    // Retain unpublished keys for cleanup if S3 copying is interrupted.
    tx.commit().await?;
    let (mut tx, org) = authorized(&pool, &auth, &session, &headers).await?;
    destination(&mut tx, &org, input.parent_id.as_deref()).await?;
    for (source, copy) in entries.iter().zip(&copies) {
        let ready: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM organization_files WHERE organization_id=$1 AND id=$2 AND ready)")
            .bind(&org).bind(&source.id).fetch_one(&mut *tx).await?;
        if !ready {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "The source changed. Refresh and try again.",
            ));
        }
        sqlx::query(
            "SELECT id FROM organization_files WHERE organization_id=$1 AND id=$2 FOR UPDATE",
        )
        .bind(&org)
        .bind(&copy.id)
        .fetch_one(&mut *tx)
        .await?;
        if !source.is_folder {
            storage
                .0
                .copy(&key(&org, &source.id), &key(&org, &copy.id))
                .await
                .map_err(|_| unavailable())?;
        }
        sqlx::query("UPDATE organization_files SET ready=true WHERE organization_id=$1 AND id=$2")
            .bind(&org)
            .bind(&copy.id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(Json(copies))
}

#[derive(Deserialize)]
struct ShareExpiry {
    days: i64,
}
#[derive(Deserialize)]
struct PublicToken {
    token: String,
}
async fn share_status(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Json<serde_json::Value>> {
    let (mut tx, org) = authorized(&pool, &auth, &session, &headers).await?;
    subtree(&mut tx, &org, &id).await?;
    let expiry: Option<i64> = sqlx::query_scalar("SELECT expires_at FROM organization_file_shares WHERE organization_id=$1 AND file_id=$2 AND expires_at>extract(epoch FROM now())::bigint")
        .bind(&org).bind(id).fetch_optional(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(serde_json::json!({"expiresAt":expiry})))
}
async fn create_share(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<ShareExpiry>,
) -> ApiResult<Json<serde_json::Value>> {
    let (mut tx, org) = authorized(&pool, &auth, &session, &headers).await?;
    if ![1, 7, 30].contains(&input.days) {
        return Err(invalid("Choose an expiry of 1, 7, or 30 days."));
    }
    let entries = subtree(&mut tx, &org, &id).await?;
    if entries[0].is_folder {
        return Err(invalid("Public links are available for individual files."));
    }
    let token = crate::auth::secret();
    let expiry: i64 = sqlx::query_scalar("INSERT INTO organization_file_shares(organization_id,file_id,token_hash,expires_at) VALUES($1,$2,$3,extract(epoch FROM now())::bigint+$4::bigint*86400) ON CONFLICT(organization_id,file_id) DO UPDATE SET token_hash=EXCLUDED.token_hash,expires_at=EXCLUDED.expires_at RETURNING expires_at")
        .bind(&org).bind(id).bind(crate::auth::digest(&token)).bind(input.days).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(serde_json::json!({"token":token,"expiresAt":expiry})))
}
async fn revoke_share(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Json<serde_json::Value>> {
    let (mut tx, org) = authorized(&pool, &auth, &session, &headers).await?;
    subtree(&mut tx, &org, &id).await?;
    sqlx::query("DELETE FROM organization_file_shares WHERE organization_id=$1 AND file_id=$2")
        .bind(org)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(serde_json::json!({"revoked":true})))
}
async fn public_download(
    State(pool): State<PgPool>,
    storage: Option<Extension<FileStore>>,
    Json(input): Json<PublicToken>,
) -> ApiResult<Response> {
    let missing = || {
        ApiError(
            StatusCode::NOT_FOUND,
            "This link has expired or is no longer available.",
        )
    };
    if input.token.len() != 64 || !input.token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(missing());
    }
    let mut tx = pool.begin().await?;
    let row: Option<(String,String)> = sqlx::query_as("SELECT organization_id,file_id FROM organization_file_shares WHERE token_hash=$1 AND expires_at>extract(epoch FROM now())::bigint")
        .bind(crate::auth::digest(&input.token)).fetch_optional(&mut *tx).await?;
    let (org, id) = row.ok_or_else(missing)?;
    // Match the organization-first lock order used by file mutations and recheck
    // after waiting, so revocation cannot race authorization.
    sqlx::query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE")
        .bind(&org)
        .execute(&mut *tx)
        .await?;
    let valid: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM organization_file_shares WHERE organization_id=$1 AND file_id=$2 AND token_hash=$3 AND expires_at>extract(epoch FROM now())::bigint)")
        .bind(&org).bind(&id).bind(crate::auth::digest(&input.token)).fetch_one(&mut *tx).await?;
    if !valid {
        return Err(missing());
    }

    let file: File = sqlx::query_as("SELECT id,name,size,created_at,parent_id,is_folder FROM organization_files WHERE organization_id=$1 AND id=$2 AND ready AND NOT is_folder FOR SHARE")
        .bind(&org).bind(id).fetch_optional(&mut *tx).await?.ok_or_else(missing)?;
    let bytes = file_bytes(store(&storage)?, &org, &file).await?;
    tx.commit().await?;
    attachment(&file, bytes)
}
