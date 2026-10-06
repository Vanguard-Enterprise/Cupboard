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
use image::{ImageDecoder, ImageFormat, ImageReader, Limits};
use object_store::{ObjectStoreExt, path::Path as ObjectPath};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Postgres, Transaction};
use std::{io::Cursor, time::Duration};
use tower_sessions::Session;

pub const MAX_LOGO_SIZE: usize = 2 * 1024 * 1024;
static IMAGE_JOBS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
#[derive(Serialize)]
struct Logo {
    id: Option<String>,
    revision: i64,
}
#[derive(Deserialize)]
struct Remove {
    revision: i64,
}
pub fn routes() -> Router<PgPool> {
    Router::new()
        .route("/app-api/organization-logo", get(details).post(upload))
        .route("/app-api/organization-logo/preview", post(preview))
        .route("/app-api/organization-logo/remove", post(delete))
        .route("/app-api/organization-logo/{id}", get(download))
}
fn unavailable() -> ApiError {
    ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        "Logo storage is unavailable. Try again shortly.",
    )
}
fn store(storage: &Option<Extension<FileStore>>) -> ApiResult<&FileStore> {
    storage.as_ref().map(|s| &s.0).ok_or_else(unavailable)
}
fn key(org: &str, id: &str) -> ObjectPath {
    ObjectPath::from(format!("organizations/{org}/logos/{id}"))
}
async fn authorized<'a>(
    pool: &'a PgPool,
    auth: &AuthSession,
    session: &Session,
    headers: &HeaderMap,
    manage: bool,
) -> ApiResult<(Transaction<'a, Postgres>, String)> {
    let user = account(auth)?;
    let org = team::organization_id(session).await?;
    if headers
        .get("x-cupboard-organization")
        .and_then(|v| v.to_str().ok())
        != Some(org.as_str())
    {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "The active organization changed. Refresh the page.",
        ));
    }
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE")
        .bind(&org)
        .execute(&mut *tx)
        .await?;
    let ctx = team::context_on(&mut tx, &user.id, &org).await?;
    if manage && !ctx.permissions.iter().any(|p| p == "organization.manage") {
        return Err(forbidden());
    }
    Ok((tx, org))
}
async fn current(tx: &mut Transaction<'_, Postgres>, org: &str) -> ApiResult<Logo> {
    let revision = sqlx::query_scalar("SELECT logo_revision FROM organizations WHERE id=$1")
        .bind(org)
        .fetch_one(&mut **tx)
        .await?;
    let id =
        sqlx::query_scalar("SELECT id FROM organization_logos WHERE organization_id=$1 AND active")
            .bind(org)
            .fetch_optional(&mut **tx)
            .await?;
    Ok(Logo { id, revision })
}
fn check_revision(logo: &Logo, revision: i64) -> ApiResult<()> {
    if logo.revision != revision {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "The logo changed. Cancel to load the latest logo before editing again.",
        ));
    }
    Ok(())
}
async fn details(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    headers: HeaderMap,
) -> ApiResult<Json<Logo>> {
    let (mut tx, org) = authorized(&pool, &auth, &session, &headers, false).await?;
    let logo = current(&mut tx, &org).await?;
    tx.commit().await?;
    Ok(Json(logo))
}
const LOGO_EDGE: u32 = 160;
const IMAGE_ERROR: &str = "Choose a valid PNG, JPEG, WebP, GIF, BMP, ICO, TIFF, or SVG image.";
const DIMENSION_ERROR: &str = "Use an image up to 8192 pixels per side and 16 megapixels.";
fn png(image: image::DynamicImage) -> ApiResult<Vec<u8>> {
    use image::{
        ImageEncoder,
        codecs::png::{CompressionType, FilterType, PngEncoder},
    };
    let resized = if image.width() > LOGO_EDGE || image.height() > LOGO_EDGE {
        image.resize(LOGO_EDGE, LOGO_EDGE, image::imageops::FilterType::Lanczos3)
    } else {
        image
    };
    let rgba = resized.to_rgba8();
    let mut output = Vec::new();
    PngEncoder::new_with_quality(&mut output, CompressionType::Best, FilterType::Adaptive)
        .write_image(
            &rgba,
            rgba.width(),
            rgba.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|_| internal())?;
    Ok(output)
}
fn svg(bytes: &[u8]) -> ApiResult<Vec<u8>> {
    // SVG is a deliberately bounded vector subset. Never load source images,
    // fonts, external documents, scripts, entities, filters, or reusable subtrees.
    const ERROR: &str = "Use a self-contained SVG with outlined text and flattened images, filters, and references.";
    if bytes.len() > 256 * 1024 {
        return Err(invalid("SVG files must be no larger than 256 KiB."));
    }
    let source = std::str::from_utf8(bytes).map_err(|_| invalid(IMAGE_ERROR))?;
    let doc = roxmltree::Document::parse(source).map_err(|_| invalid(IMAGE_ERROR))?;
    if doc.root_element().tag_name().name() != "svg" || doc.descendants().count() > 2000 {
        return Err(invalid(ERROR));
    }
    for node in doc.descendants().filter(|n| n.is_element()) {
        if node.ancestors().count() > 32 {
            return Err(invalid(ERROR));
        }
        if matches!(
            node.tag_name().name(),
            "script"
                | "foreignObject"
                | "image"
                | "use"
                | "text"
                | "filter"
                | "mask"
                | "pattern"
                | "animate"
                | "animateTransform"
                | "animateMotion"
                | "set"
                | "style"
        ) {
            return Err(invalid(ERROR));
        }
        for attribute in node.attributes() {
            if attribute.name().to_ascii_lowercase().starts_with("on")
                || attribute.value().len() > 64 * 1024
                || (attribute.name() == "href" && !attribute.value().starts_with('#'))
            {
                return Err(invalid(ERROR));
            }
        }
    }
    let options = resvg::usvg::Options {
        resources_dir: None,
        image_href_resolver: resvg::usvg::ImageHrefResolver {
            resolve_data: Box::new(|_, _, _| None),
            resolve_string: Box::new(|_, _| None),
        },
        ..Default::default()
    };
    let tree = resvg::usvg::Tree::from_str(source, &options).map_err(|_| invalid(IMAGE_ERROR))?;
    let size = tree.size();
    if size.width() > 8192.0 || size.height() > 8192.0 {
        return Err(invalid(DIMENSION_ERROR));
    }
    let scale = (LOGO_EDGE as f32 / size.width().max(size.height())).min(1.0);
    let width = (size.width() * scale).ceil().max(1.0) as u32;
    let height = (size.height() * scale).ceil().max(1.0) as u32;
    let mut pixmap = resvg::tiny_skia::Pixmap::new(width, height).ok_or_else(internal)?;
    resvg::render(
        &tree,
        resvg::tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    // tiny-skia pixels are premultiplied. Its PNG encoder unpremultiplies them.
    let rendered = pixmap.encode_png().map_err(|_| internal())?;
    png(image::load_from_memory(&rendered).map_err(|_| internal())?)
}
pub(crate) fn validate_image(bytes: Vec<u8>) -> ApiResult<Vec<u8>> {
    if bytes.is_empty() || bytes.len() > MAX_LOGO_SIZE {
        return Err(invalid("Choose an image no larger than 2 MiB."));
    }
    let format = match image::guess_format(&bytes) {
        Ok(format) => format,
        Err(_) => return svg(&bytes),
    };
    if !matches!(
        format,
        ImageFormat::Png
            | ImageFormat::Jpeg
            | ImageFormat::WebP
            | ImageFormat::Gif
            | ImageFormat::Bmp
            | ImageFormat::Ico
            | ImageFormat::Tiff
    ) {
        return Err(invalid(IMAGE_ERROR));
    }
    let (width, height) = ImageReader::with_format(Cursor::new(&bytes), format)
        .into_dimensions()
        .map_err(|_| invalid(IMAGE_ERROR))?;
    if width == 0
        || height == 0
        || width > 8192
        || height > 8192
        || u64::from(width) * u64::from(height) > 16_777_216
    {
        return Err(invalid(DIMENSION_ERROR));
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits.clone());
    let mut decoder = reader.into_decoder().map_err(|_| invalid(IMAGE_ERROR))?;
    // Preserve ImageReader::decode's allocation budget when using the decoder directly.
    limits
        .reserve(decoder.total_bytes())
        .map_err(|_| invalid(IMAGE_ERROR))?;
    decoder
        .set_limits(limits)
        .map_err(|_| invalid(IMAGE_ERROR))?;
    let orientation = decoder.orientation().map_err(|_| invalid(IMAGE_ERROR))?;
    let mut image = image::DynamicImage::from_decoder(decoder).map_err(|_| invalid(IMAGE_ERROR))?;
    image.apply_orientation(orientation);
    // Decode a single frame; animation and all original metadata are discarded.
    png(image)
}
async fn normalized(request: Request) -> ApiResult<Vec<u8>> {
    if request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        != Some("application/octet-stream")
    {
        return Err(invalid("Upload the image as binary data."));
    }
    let bytes = to_bytes(request.into_body(), MAX_LOGO_SIZE)
        .await
        .map_err(|_| {
            ApiError(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Choose an image no larger than 2 MiB.",
            )
        })?;
    let permit = IMAGE_JOBS.try_acquire().map_err(|_| {
        ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Logo processing is busy. Try again shortly.",
        )
    })?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        validate_image(bytes.to_vec())
    })
    .await
    .map_err(|_| internal())?
}
fn image_response(data: impl Into<Body>) -> Response {
    let mut response = data.into().into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, "image/png".parse().unwrap());
    response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    response.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        "default-src 'none'; sandbox".parse().unwrap(),
    );
    response
}
async fn preview(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    request: Request,
) -> ApiResult<Response> {
    tokio::time::timeout(Duration::from_secs(45), async {
        let (tx, _) = authorized(&pool, &auth, &session, request.headers(), true).await?;
        tx.commit().await?;
        Ok(image_response(normalized(request).await?))
    })
    .await
    .map_err(|_| {
        ApiError(
            StatusCode::REQUEST_TIMEOUT,
            "Logo preview timed out. Choose a simpler image.",
        )
    })?
}
async fn upload(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    storage: Option<Extension<FileStore>>,
    request: Request,
) -> ApiResult<Json<Logo>> {
    tokio::time::timeout(Duration::from_secs(45), async {
        let headers = request.headers().clone();
        let revision = headers.get("x-cupboard-logo-revision").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<i64>().ok()).ok_or_else(|| invalid("Reload the logo before saving."))?;
        let (mut tx, org) = authorized(&pool, &auth, &session, &headers, true).await?;
        check_revision(&current(&mut tx, &org).await?, revision)?;
        let storage = store(&storage)?;
        tx.commit().await?;
        let data = normalized(request).await?;
        let (mut tx, org) = authorized(&pool, &auth, &session, &headers, true).await?;
        check_revision(&current(&mut tx, &org).await?, revision)?;
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO organization_logos(organization_id,id) VALUES($1,$2)").bind(&org).bind(&id).execute(&mut *tx).await?;
        tx.commit().await?;
        storage.0.put(&key(&org, &id), data.into()).await.map_err(|_| unavailable())?;
        let (mut tx, org) = authorized(&pool, &auth, &session, &headers, true).await?;
        check_revision(&current(&mut tx, &org).await?, revision)?;
        sqlx::query("UPDATE organization_logos SET active=false,created_at=0 WHERE organization_id=$1 AND active").bind(&org).execute(&mut *tx).await?;
        sqlx::query("UPDATE organization_logos SET active=true WHERE organization_id=$1 AND id=$2").bind(&org).bind(&id).execute(&mut *tx).await?;
        sqlx::query("UPDATE organizations SET logo_revision=logo_revision+1 WHERE id=$1").bind(&org).execute(&mut *tx).await?;
        tx.commit().await?;
        queue_cleanup(pool.clone(), storage.clone());
        Ok(Json(Logo { id: Some(id), revision: revision + 1 }))
    }).await.map_err(|_| ApiError(StatusCode::REQUEST_TIMEOUT, "Saving the logo timed out. Cancel to reload its saved state."))?
}
async fn delete(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    storage: Option<Extension<FileStore>>,
    headers: HeaderMap,
    Json(input): Json<Remove>,
) -> ApiResult<Json<Logo>> {
    let (mut tx, org) = authorized(&pool, &auth, &session, &headers, true).await?;
    check_revision(&current(&mut tx, &org).await?, input.revision)?;
    sqlx::query("UPDATE organization_logos SET active=false,created_at=0 WHERE organization_id=$1 AND active").bind(&org).execute(&mut *tx).await?;
    sqlx::query("UPDATE organizations SET logo_revision=logo_revision+1 WHERE id=$1")
        .bind(&org)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    if let Some(storage) = storage {
        queue_cleanup(pool, storage.0);
    }
    Ok(Json(Logo {
        id: None,
        revision: input.revision + 1,
    }))
}
async fn download(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    storage: Option<Extension<FileStore>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let (mut tx, org) = authorized(&pool, &auth, &session, &headers, false).await?;
    if current(&mut tx, &org).await?.id.as_deref() != Some(&id) {
        return Err(ApiError(StatusCode::NOT_FOUND, "Logo not found."));
    }
    tx.commit().await?;
    let object = store(&storage)?
        .0
        .get(&key(&org, &id))
        .await
        .map_err(|_| unavailable())?;
    if object.meta.size > 20 * 1024 * 1024 {
        return Err(unavailable());
    }
    let data = object.bytes().await.map_err(|_| unavailable())?;
    Ok(image_response(data))
}
fn queue_cleanup(pool: PgPool, storage: FileStore) {
    tokio::spawn(async move {
        cleanup(&pool, &storage).await;
    });
}
pub(crate) async fn cleanup(pool: &PgPool, storage: &FileStore) {
    let rows: Result<Vec<(String,String)>,_> = sqlx::query_as("SELECT organization_id,id FROM organization_logos WHERE NOT active AND created_at < extract(epoch FROM now())::bigint-3600 ORDER BY created_at LIMIT 100").fetch_all(pool).await;
    if let Ok(rows) = rows {
        for (org, id) in rows {
            match storage.0.delete(&key(&org, &id)).await {
                Ok(_) | Err(object_store::Error::NotFound { .. }) => {}
                Err(_) => continue,
            }
            let _ = sqlx::query(
                "DELETE FROM organization_logos WHERE organization_id=$1 AND id=$2 AND NOT active",
            )
            .bind(org)
            .bind(id)
            .execute(pool)
            .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    pub(crate) fn image_bytes(format: ImageFormat, width: u32, height: u32) -> Vec<u8> {
        let image = if format == ImageFormat::Ico {
            image::DynamicImage::new_rgba8(width, height)
        } else {
            image::DynamicImage::new_rgb8(width, height)
        };
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, format).unwrap();
        bytes.into_inner()
    }
    #[test]
    fn applies_exif_rotation_and_mirroring_before_stripping_metadata() {
        let pixels = image::RgbImage::from_fn(32, 16, |x, _| {
            if x < 16 {
                image::Rgb([240, 0, 0])
            } else {
                image::Rgb([0, 0, 240])
            }
        });
        let mut jpeg = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(pixels)
            .write_to(&mut jpeg, ImageFormat::Jpeg)
            .unwrap();
        let jpeg = jpeg.into_inner();
        for orientation in [2_u8, 6] {
            // JPEG APP1 with a little-endian TIFF IFD containing the orientation tag.
            let mut exif = b"Exif\0\0II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0".to_vec();
            exif.extend_from_slice(&[orientation, 0, 0, 0, 0, 0, 0, 0]);
            let mut source = jpeg[..2].to_vec();
            source.extend_from_slice(&[0xff, 0xe1]);
            source.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
            source.extend_from_slice(&exif);
            source.extend_from_slice(&jpeg[2..]);
            let normalized = validate_image(source).unwrap();
            assert!(!normalized.windows(4).any(|w| w == b"eXIf"));
            let output = image::load_from_memory(&normalized).unwrap().to_rgb8();
            let (red, blue) = if orientation == 2 {
                assert_eq!(output.dimensions(), (32, 16));
                (output.get_pixel(28, 8), output.get_pixel(3, 8))
            } else {
                assert_eq!(output.dimensions(), (16, 32));
                (output.get_pixel(8, 3), output.get_pixel(8, 28))
            };
            assert!(red[0] > 200 && red[2] < 30);
            assert!(blue[2] > 200 && blue[0] < 30);
        }
    }
    #[test]
    fn decodes_supported_formats_and_strips_nonpixel_content() {
        for format in [
            ImageFormat::Png,
            ImageFormat::Jpeg,
            ImageFormat::WebP,
            ImageFormat::Gif,
            ImageFormat::Bmp,
            ImageFormat::Ico,
            ImageFormat::Tiff,
        ] {
            let mut bytes = image_bytes(format, 32, 48);
            bytes.extend_from_slice(b"private metadata appended payload");
            let normalized =
                validate_image(bytes).unwrap_or_else(|error| panic!("{format:?}: {error:?}"));
            assert_eq!(image::guess_format(&normalized).unwrap(), ImageFormat::Png);
            let image = image::load_from_memory(&normalized).unwrap();
            assert_eq!((image.width(), image.height()), (32, 48));
            assert!(!String::from_utf8_lossy(&normalized).contains("private metadata"));
        }
    }
    #[test]
    fn rejects_unsafe_truncated_oversized_and_unsupported_images() {
        for bytes in [
            b"<svg onload='alert(1)'/>".to_vec(),
            b"GIF89a".to_vec(),
            b"\x89PNG\r\n\x1a\n".to_vec(),
            vec![0; MAX_LOGO_SIZE + 1],
            vec![],
            image_bytes(ImageFormat::Png, 8193, 1),
            image_bytes(ImageFormat::Png, 1, 8193),
        ] {
            assert!(validate_image(bytes).is_err());
        }
    }
    #[test]
    fn raster_and_svg_logos_are_small_pngs_with_preserved_proportions() {
        for bytes in [image_bytes(ImageFormat::Png, 1600, 800), br##"<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="800"><rect width="1600" height="800" fill="#7cb58d"/></svg>"##.to_vec()] {
            let normalized = validate_image(bytes).unwrap();
            let image = image::load_from_memory(&normalized).unwrap();
            assert_eq!((image.width(),image.height()), (160,80));
            assert!(normalized.len() < 2048);
        }
    }
    #[test]
    fn svg_rejects_active_external_and_expansive_content() {
        for content in [
            "<script>alert(1)</script>",
            "<rect onload='alert(1)'/>",
            "<image href='file:///etc/passwd'/>",
            "<image href='http://127.0.0.1/private'/>",
            "<image href='data:image/svg+xml;base64,PHN2Zy8+'/>",
            "<use href='#recursive'/>",
            "<filter><feGaussianBlur stdDeviation='1000000'/></filter>",
            "<foreignObject><div>unsafe</div></foreignObject>",
            "<style>@import url('https://example.com/private');</style>",
            "<text>Outline this first</text>",
        ] {
            let svg = format!(
                "<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'>{content}</svg>"
            );
            assert!(validate_image(svg.into_bytes()).is_err(), "{content}");
        }
        assert!(
            validate_image(
                b"<!DOCTYPE svg [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><svg>&x;</svg>".to_vec()
            )
            .is_err()
        );
        assert!(
            validate_image(format!("<svg>{}</svg>", "<g/>".repeat(2001)).into_bytes()).is_err()
        );
        assert!(
            validate_image(
                format!("<svg>{}{}</svg>", "<g>".repeat(33), "</g>".repeat(33)).into_bytes()
            )
            .is_err()
        );
    }
}
