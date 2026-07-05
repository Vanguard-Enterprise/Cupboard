//! Client for fleet's cluster-internal `POST /internal/servers/import` (BM import's
//! servers phase). Mirrors the collector's fleet client: a shared `X-Internal-Token`
//! over the ClusterIP-only `/internal/*` path. Fleet upserts by `(tenant_id, external_id)`
//! and returns the server uuid the sync map records; imported servers land disabled with
//! no RCON credentials for the tenant to configure.

use serde::Deserialize;
use std::time::Duration;
use uuid::Uuid;

const INTERNAL_TOKEN_HEADER: &str = "x-internal-token";

/// Bound on a single fleet call so a hung/black-holed cluster peer can't stall the import
/// runner (the shared reqwest client applies no default timeout). Mirrors the BM client's.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Why a fleet server upsert did not return an id.
pub enum FleetError {
    /// Fleet rejected THIS server's payload (4xx): the data is unusable no matter how many
    /// times we retry, so the import skips-and-counts this one server and moves on rather
    /// than failing the whole job.
    Rejected(String),
    /// Transport failure or fleet 5xx: transient (a pod roll, a timeout), so the import
    /// fails the job with the cursor kept and a re-run resumes from the same page.
    Transient(anyhow::Error),
}

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
    /// re-run converges without duplicating rows. A 4xx settles as [`FleetError::Rejected`]
    /// (skip this one server); a 5xx or transport error as [`FleetError::Transient`] (fail
    /// the job, keep the cursor for a re-run).
    pub async fn upsert_imported_server(
        &self,
        server: &ImportedServer,
    ) -> Result<Uuid, FleetError> {
        let url = format!("{}/internal/servers/import", self.base_url);
        let resp = self
            .http
            .post(&url)
            .timeout(REQUEST_TIMEOUT)
            .header(INTERNAL_TOKEN_HEADER, &self.token)
            .json(&serde_json::json!({
                "tenant_id": server.tenant_id,
                "external_id": server.external_id,
                "name": server.name,
                "rcon_host": server.rcon_host,
                "query_port": server.query_port,
            }))
            .send()
            .await
            .map_err(|e| FleetError::Transient(e.into()))?;
        let status = resp.status();
        if status.is_success() {
            let body: ImportResponse = resp
                .json()
                .await
                .map_err(|e| FleetError::Transient(e.into()))?;
            return Ok(body.id);
        }
        let detail = resp.text().await.unwrap_or_default();
        if status.is_client_error() {
            Err(FleetError::Rejected(format!(
                "fleet rejected server import ({status}): {detail}"
            )))
        } else {
            Err(FleetError::Transient(anyhow::anyhow!(
                "fleet server import failed ({status}): {detail}"
            )))
        }
    }
}
