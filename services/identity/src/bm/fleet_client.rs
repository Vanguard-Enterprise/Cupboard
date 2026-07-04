//! Client for fleet's cluster-internal `POST /internal/servers/import` (BM import's
//! servers phase). Mirrors the collector's fleet client: a shared `X-Internal-Token`
//! over the ClusterIP-only `/internal/*` path. Fleet upserts by `(tenant_id, external_id)`
//! and returns the server uuid the sync map records; imported servers land disabled with
//! no RCON credentials for the tenant to configure.

use serde::Deserialize;
use uuid::Uuid;

const INTERNAL_TOKEN_HEADER: &str = "x-internal-token";

/// One BM server to register in fleet. `rcon_port` is omitted here (BM does not expose
/// RCON): fleet defaults it, and the tenant fills the real credentials in the servers UI.
pub struct ImportedServer {
    pub tenant_id: Uuid,
    pub external_id: String,
    pub name: String,
    pub rcon_host: String,
    pub query_port: Option<i64>,
}

#[derive(Clone)]
pub struct FleetClient {
    http: reqwest::Client,
    base_url: String,
    token: String,
}

#[derive(Deserialize)]
struct ImportResponse {
    id: Uuid,
}

impl FleetClient {
    pub fn new(http: reqwest::Client, base_url: String, token: String) -> Self {
        Self {
            http,
            base_url: base_url.trim_end_matches('/').to_string(),
            token,
        }
    }

    /// Upsert `server` in fleet, returning the server uuid. Idempotent server-side, so a
    /// re-run converges without duplicating rows.
    pub async fn upsert_imported_server(&self, server: &ImportedServer) -> anyhow::Result<Uuid> {
        let url = format!("{}/internal/servers/import", self.base_url);
        let resp = self
            .http
            .post(&url)
            .header(INTERNAL_TOKEN_HEADER, &self.token)
            .json(&serde_json::json!({
                "tenant_id": server.tenant_id,
                "external_id": server.external_id,
                "name": server.name,
                "rcon_host": server.rcon_host,
                "query_port": server.query_port,
            }))
            .send()
            .await?
            .error_for_status()?;
        let body: ImportResponse = resp.json().await?;
        Ok(body.id)
    }
}
