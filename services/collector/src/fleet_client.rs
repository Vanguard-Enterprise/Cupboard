//! Client for fleet's cluster-internal API: fetch the enabled-server config feed and post
//! connection-status heartbeats. Fleet holds the envelope master key and returns decrypted
//! RCON credentials over this token-guarded, ClusterIP-only path.

use serde::Deserialize;
use uuid::Uuid;

const INTERNAL_TOKEN_HEADER: &str = "x-internal-token";

/// A decrypted server connection config, as served by fleet `/internal/servers`.
#[derive(Debug, Clone, Deserialize)]
pub struct ServerConfig {
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub name: String,
    pub rcon_host: String,
    pub rcon_port: i32,
    pub rcon_password: String,
    /// A2S/UDP query port; servers without one simply get no A2S task.
    pub query_port: Option<i32>,
    /// Hex SHA-256 of the server's push-ingest token; `None` = push disabled. Feeds the
    /// token registry — never logged.
    #[serde(default)]
    pub ingest_token_hash: Option<String>,
}

#[derive(Clone)]
pub struct FleetClient {
    http: reqwest::Client,
    base_url: String,
    token: String,
}

impl FleetClient {
    pub fn new(http: reqwest::Client, base_url: String, token: String) -> Self {
        Self {
            http,
            base_url: base_url.trim_end_matches('/').to_string(),
            token,
        }
    }

    /// GET the enabled-server config feed.
    pub async fn fetch_configs(&self) -> anyhow::Result<Vec<ServerConfig>> {
        let url = format!("{}/internal/servers", self.base_url);
        let resp = self
            .http
            .get(&url)
            .header(INTERNAL_TOKEN_HEADER, &self.token)
            .send()
            .await?
            .error_for_status()?;
        Ok(resp.json().await?)
    }

    /// POST a server's latest A2S_INFO snapshot. Best-effort, like `post_status`.
    pub async fn post_info(
        &self,
        server_id: Uuid,
        info: &cupboard_gameconn::ServerInfo,
    ) -> anyhow::Result<()> {
        let url = format!("{}/internal/servers/{server_id}/info", self.base_url);
        self.http
            .post(&url)
            .header(INTERNAL_TOKEN_HEADER, &self.token)
            .json(&serde_json::json!({
                "hostname": info.hostname,
                "map": info.map,
                "players": info.players,
                "max_players": info.max_players,
                "queued": info.queued,
            }))
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    /// POST a connection-status heartbeat for one server. Best-effort; errors are logged
    /// by the caller and never interrupt polling.
    pub async fn post_status(
        &self,
        server_id: Uuid,
        status: &str,
        error: Option<&str>,
    ) -> anyhow::Result<()> {
        let url = format!("{}/internal/servers/{server_id}/status", self.base_url);
        self.http
            .post(&url)
            .header(INTERNAL_TOKEN_HEADER, &self.token)
            .json(&serde_json::json!({ "status": status, "error": error }))
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }
}
