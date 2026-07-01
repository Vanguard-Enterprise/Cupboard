//! Client for identity's cluster-internal ban-enforcement lookup. At each poll the
//! Collector asks which of the currently-connected Steam IDs are banned, then kicks them
//! over RCON.

use serde::Deserialize;
use uuid::Uuid;

const INTERNAL_TOKEN_HEADER: &str = "x-internal-token";

/// A banned Steam ID (with reason for the kick message), as returned by identity.
#[derive(Debug, Clone, Deserialize)]
pub struct EnforcementHit {
    pub steam_id: String,
    pub reason: Option<String>,
}

#[derive(Clone)]
pub struct IdentityClient {
    http: reqwest::Client,
    base_url: String,
    token: String,
}

impl IdentityClient {
    pub fn new(http: reqwest::Client, base_url: String, token: String) -> Self {
        Self {
            http,
            base_url: base_url.trim_end_matches('/').to_string(),
            token,
        }
    }

    /// Which of `steam_ids` are banned for `tenant_id` on `server_id`.
    pub async fn enforce(
        &self,
        tenant_id: Uuid,
        server_id: Uuid,
        steam_ids: &[String],
    ) -> anyhow::Result<Vec<EnforcementHit>> {
        let url = format!("{}/internal/enforce", self.base_url);
        let resp = self
            .http
            .post(&url)
            .header(INTERNAL_TOKEN_HEADER, &self.token)
            .json(&serde_json::json!({
                "tenant_id": tenant_id,
                "server_id": server_id,
                "steam_ids": steam_ids,
            }))
            .send()
            .await?
            .error_for_status()?;
        Ok(resp.json().await?)
    }
}
