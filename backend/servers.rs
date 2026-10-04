use crate::{
    auth::{ApiResult, AuthSession, account, forbidden, internal},
    team,
};
use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use axum::{
    Extension, Json, Router,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use std::collections::BTreeMap;
use tower_sessions::Session;

#[derive(Clone)]
pub struct SecretKey([u8; 32]);
impl SecretKey {
    pub fn parse(value: &str) -> Result<Self, &'static str> {
        if value.len() != 64 || !value.is_ascii() {
            return Err("CUPBOARD_SECRET_KEY must contain 64 hexadecimal characters");
        }
        let mut key = [0; 32];
        for (i, byte) in key.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&value[i * 2..i * 2 + 2], 16)
                .map_err(|_| "CUPBOARD_SECRET_KEY must contain 64 hexadecimal characters")?;
        }
        Ok(Self(key))
    }
    fn encrypt(&self, secret: &str, org: &str, id: &str) -> ApiResult<Vec<u8>> {
        let mut nonce = [0; 12];
        OsRng.fill_bytes(&mut nonce);
        let cipher = Aes256Gcm::new_from_slice(&self.0).map_err(|_| internal())?;
        let aad = format!("cupboard:rcon:v1:{org}:{id}");
        let encrypted = cipher
            .encrypt(
                &Nonce::from(nonce),
                Payload {
                    msg: secret.as_bytes(),
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| internal())?;
        Ok([nonce.to_vec(), encrypted].concat())
    }
    #[cfg(test)]
    fn decrypt(&self, encrypted: &[u8], org: &str, id: &str) -> Result<Vec<u8>, aes_gcm::Error> {
        let cipher = Aes256Gcm::new_from_slice(&self.0).unwrap();
        let aad = format!("cupboard:rcon:v1:{org}:{id}");
        cipher.decrypt(
            &Nonce::from(<[u8; 12]>::try_from(&encrypted[..12]).unwrap()),
            Payload {
                msg: &encrypted[12..],
                aad: aad.as_bytes(),
            },
        )
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NewServer {
    name: String,
    rcon_host: String,
    rcon_port: i32,
    rcon_password: String,
    a2s_host: String,
    a2s_port: i32,
}
#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
struct Server {
    id: String,
    name: String,
    rcon_host: String,
    rcon_port: i32,
    a2s_host: String,
    a2s_port: i32,
}
#[derive(Debug)]
struct Validation(BTreeMap<&'static str, &'static str>);
impl IntoResponse for Validation {
    fn into_response(self) -> Response {
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(serde_json::json!({"error":"Check the highlighted fields.","fields":self.0})),
        )
            .into_response()
    }
}
fn host(value: &str) -> bool {
    if value.parse::<std::net::IpAddr>().is_ok() {
        return true;
    }
    value.len() <= 253
        && !value.is_empty()
        && value.split('.').all(|part| {
            !part.is_empty()
                && part.len() <= 63
                && !part.starts_with('-')
                && !part.ends_with('-')
                && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}
impl NewServer {
    fn validate(&mut self) -> Result<(), Validation> {
        self.name = self.name.trim().to_owned();
        self.rcon_host = self.rcon_host.trim().to_owned();
        self.a2s_host = self.a2s_host.trim().to_owned();
        let mut fields = BTreeMap::new();
        if self.name.is_empty()
            || self.name.chars().count() > 80
            || self.name.chars().any(char::is_control)
        {
            fields.insert("name", "Enter a server name of 1 to 80 characters.");
        }
        for (field, value) in [("rconHost", &self.rcon_host), ("a2sHost", &self.a2s_host)] {
            if !host(value) {
                fields.insert(
                    field,
                    "Enter an IP address or hostname without a scheme or port.",
                );
            }
        }
        for (field, value) in [("rconPort", self.rcon_port), ("a2sPort", self.a2s_port)] {
            if !(1..=65535).contains(&value) {
                fields.insert(field, "Enter a port from 1 to 65535.");
            }
        }
        if self.rcon_password.is_empty()
            || self.rcon_password.len() > 1024
            || self.rcon_password.chars().any(char::is_control)
        {
            fields.insert(
                "rconPassword",
                "Enter an RCON password of at most 1024 bytes without control characters.",
            );
        }
        if fields.is_empty() {
            Ok(())
        } else {
            Err(Validation(fields))
        }
    }
}
pub fn routes() -> Router<PgPool> {
    Router::new().route("/app-api/servers", get(list).post(create))
}
async fn list(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
) -> ApiResult<Json<Vec<Server>>> {
    let user = account(&auth)?;
    let org = team::organization_id(&session).await?;
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT id FROM organizations WHERE id=$1 FOR SHARE")
        .bind(&org)
        .execute(&mut *tx)
        .await?;
    let ctx = team::context_on(&mut tx, &user.id, &org).await?;
    if !ctx.permissions.iter().any(|p| p == "servers.view") {
        return Err(forbidden());
    }
    let servers = sqlx::query_as("SELECT id,name,rcon_host,rcon_port,a2s_host,a2s_port FROM servers WHERE organization_id=$1 ORDER BY created_at,id").bind(&ctx.organization_id).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(servers))
}
async fn create(
    State(pool): State<PgPool>,
    Extension(key): Extension<SecretKey>,
    auth: AuthSession,
    session: Session,
    input: Result<Json<NewServer>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Server>, Response> {
    let user = account(&auth).map_err(IntoResponse::into_response)?;
    let org = team::organization_id(&session)
        .await
        .map_err(IntoResponse::into_response)?;
    let mut tx = pool.begin().await.map_err(|_| internal().into_response())?;
    sqlx::query("SELECT id FROM organizations WHERE id=$1 FOR SHARE")
        .bind(&org)
        .execute(&mut *tx)
        .await
        .map_err(|_| internal().into_response())?;
    let ctx = team::context_on(&mut tx, &user.id, &org)
        .await
        .map_err(IntoResponse::into_response)?;
    if !ctx.permissions.iter().any(|p| p == "servers.manage") {
        return Err(forbidden().into_response());
    }
    let Json(mut input) = input.map_err(|_| {
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(serde_json::json!({"error":"Enter valid server connection details."})),
        )
            .into_response()
    })?;
    input.validate().map_err(IntoResponse::into_response)?;
    let id = uuid::Uuid::new_v4().to_string();
    let encrypted = key
        .encrypt(&input.rcon_password, &ctx.organization_id, &id)
        .map_err(IntoResponse::into_response)?;
    let result=sqlx::query_as("INSERT INTO servers(id,organization_id,name,rcon_host,rcon_port,rcon_password_encrypted,a2s_host,a2s_port) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,name,rcon_host,rcon_port,a2s_host,a2s_port")
        .bind(id).bind(&ctx.organization_id).bind(input.name).bind(input.rcon_host).bind(input.rcon_port).bind(encrypted).bind(input.a2s_host).bind(input.a2s_port).fetch_one(&mut *tx).await.map_err(|_|internal().into_response())?;
    tx.commit().await.map_err(|_| internal().into_response())?;
    Ok(Json(result))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn secrets_are_authenticated_randomized_and_bound_to_the_record() {
        let key = SecretKey::parse(&"ab".repeat(32)).unwrap();
        let a = key.encrypt("private password", "tenant", "server").unwrap();
        let b = key.encrypt("private password", "tenant", "server").unwrap();
        assert_ne!(a, b);
        assert!(!a.windows(16).any(|w| w == b"private password"));
        assert_eq!(
            key.decrypt(&a, "tenant", "server").unwrap(),
            b"private password"
        );
        assert!(key.decrypt(&a, "another", "server").is_err());
        assert!(key.decrypt(&a, "tenant", "another").is_err());
        let mut corrupt = a;
        corrupt[13] ^= 1;
        assert!(key.decrypt(&corrupt, "tenant", "server").is_err());
    }
}
