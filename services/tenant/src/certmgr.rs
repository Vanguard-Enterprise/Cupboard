//! Per-domain TLS provisioning via the Kubernetes API: one cert-manager `Certificate`
//! (HTTP-01, solved over Traefik) and one Traefik `IngressRoute` per active custom
//! domain, both created in the web namespace so the IngressRoute's `tls.secretName`
//! resolves locally (no cross-namespace service refs).
//!
//! Implemented with raw HTTP against the API server (the pod's ServiceAccount token +
//! the cluster CA) rather than pulling in the full kube-rs/k8s-openapi tree for two CRD
//! kinds. The [`CertProvisioner`] trait keeps the domain loop testable with a stub.

use serde_json::json;
use std::time::Duration;

const SA_TOKEN_PATH: &str = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const SA_CA_PATH: &str = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";
const API_BASE: &str = "https://kubernetes.default.svc";
const REQ_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, thiserror::Error)]
pub enum ProvisionError {
    #[error("kubernetes API error: {0}")]
    Api(String),
    #[error("transient: {0}")]
    Transient(String),
}

/// What the loop needs provisioned for one domain. Names are derived (stable) from the
/// domain row id by the caller.
#[derive(Debug, Clone)]
pub struct DomainSpec {
    pub domain: String,
    pub cert_name: String,
    pub secret_name: String,
    pub route_name: String,
}

/// Manages the k8s resources backing a custom domain. One method per lifecycle step.
pub trait CertProvisioner: Send + Sync + 'static {
    /// Create (idempotently) the Certificate + IngressRoute for a domain.
    fn ensure(
        &self,
        spec: &DomainSpec,
    ) -> impl std::future::Future<Output = Result<(), ProvisionError>> + Send;

    /// Whether the Certificate has a Ready=True condition (cert issued + stored).
    fn certificate_ready(
        &self,
        cert_name: &str,
    ) -> impl std::future::Future<Output = Result<bool, ProvisionError>> + Send;

    /// Delete the domain's Certificate, IngressRoute, and cert Secret (idempotent).
    fn teardown(
        &self,
        spec: &DomainSpec,
    ) -> impl std::future::Future<Output = Result<(), ProvisionError>> + Send;
}

/// Raw-HTTP Kubernetes provisioner using the in-cluster ServiceAccount.
pub struct KubeProvisioner {
    http: reqwest::Client,
    namespace: String,
    issuer: String,
    web_service: String,
    web_port: u16,
}

impl KubeProvisioner {
    /// Build from the in-cluster ServiceAccount, or `None` when not running in a cluster
    /// (no token file) so local/dev deployments simply skip TLS automation.
    pub fn from_in_cluster(
        namespace: String,
        issuer: String,
        web_service: String,
        web_port: u16,
    ) -> Option<Self> {
        // Confirm we are in-cluster (token present); the token itself is read fresh per
        // request below, not cached, since it is a short-lived BoundServiceAccountToken.
        std::fs::read_to_string(SA_TOKEN_PATH).ok()?;
        let ca = std::fs::read(SA_CA_PATH).ok()?;
        let ca_cert = reqwest::Certificate::from_pem(&ca).ok()?;
        let http = reqwest::Client::builder()
            .add_root_certificate(ca_cert)
            .timeout(REQ_TIMEOUT)
            .build()
            .ok()?;
        Some(Self {
            http,
            namespace,
            issuer,
            web_service,
            web_port,
        })
    }

    /// Read the current ServiceAccount token. The kubelet rotates the projected token
    /// (BoundServiceAccountToken, ~1h TTL) in place, so it is read fresh on every request
    /// rather than cached at startup, else all API calls would 401 after the first hour.
    fn bearer_token(&self) -> Result<String, ProvisionError> {
        std::fs::read_to_string(SA_TOKEN_PATH)
            .map(|t| t.trim().to_string())
            .map_err(|e| ProvisionError::Transient(format!("reading SA token: {e}")))
    }

    fn url(&self, group_version: &str, plural: &str, name: Option<&str>) -> String {
        let mut u = format!(
            "{API_BASE}/apis/{group_version}/namespaces/{}/{plural}",
            self.namespace
        );
        if let Some(n) = name {
            u.push('/');
            u.push_str(n);
        }
        u
    }

    /// POST a resource, treating 409 (already exists) as success (idempotent create).
    async fn create_idempotent(
        &self,
        group_version: &str,
        plural: &str,
        body: &serde_json::Value,
    ) -> Result<(), ProvisionError> {
        let resp = self
            .http
            .post(self.url(group_version, plural, None))
            .bearer_auth(self.bearer_token()?)
            .json(body)
            .send()
            .await
            .map_err(|e| ProvisionError::Transient(e.to_string()))?;
        let status = resp.status();
        if status.is_success() || status == reqwest::StatusCode::CONFLICT {
            return Ok(());
        }
        let brief: String = resp
            .text()
            .await
            .unwrap_or_default()
            .chars()
            .take(300)
            .collect();
        Err(ProvisionError::Api(format!(
            "{status} creating {plural}: {brief}"
        )))
    }

    /// DELETE a resource at a full URL, treating 404 as success (idempotent delete).
    async fn delete_url(&self, url: String, what: &str) -> Result<(), ProvisionError> {
        let resp = self
            .http
            .delete(url)
            .bearer_auth(self.bearer_token()?)
            .send()
            .await
            .map_err(|e| ProvisionError::Transient(e.to_string()))?;
        let status = resp.status();
        if status.is_success() || status == reqwest::StatusCode::NOT_FOUND {
            Ok(())
        } else {
            Err(ProvisionError::Api(format!("{status} deleting {what}")))
        }
    }

    /// URL for a core (`/api/v1`) namespaced resource (Secrets live here, not `/apis`).
    fn core_url(&self, plural: &str, name: &str) -> String {
        format!(
            "{API_BASE}/api/v1/namespaces/{}/{plural}/{name}",
            self.namespace
        )
    }
}

const CERT_GV: &str = "cert-manager.io/v1";
const ROUTE_GV: &str = "traefik.io/v1alpha1";

impl CertProvisioner for KubeProvisioner {
    async fn ensure(&self, spec: &DomainSpec) -> Result<(), ProvisionError> {
        let certificate = json!({
            "apiVersion": CERT_GV,
            "kind": "Certificate",
            "metadata": { "name": spec.cert_name, "namespace": self.namespace },
            "spec": {
                "secretName": spec.secret_name,
                "issuerRef": { "name": self.issuer, "kind": "ClusterIssuer" },
                "dnsNames": [spec.domain],
            }
        });
        self.create_idempotent(CERT_GV, "certificates", &certificate)
            .await?;

        let route = json!({
            "apiVersion": ROUTE_GV,
            "kind": "IngressRoute",
            "metadata": { "name": spec.route_name, "namespace": self.namespace },
            "spec": {
                "entryPoints": ["websecure"],
                "routes": [{
                    "match": format!("Host(`{}`)", spec.domain),
                    "kind": "Rule",
                    "services": [{ "name": self.web_service, "port": self.web_port }],
                }],
                "tls": { "secretName": spec.secret_name },
            }
        });
        self.create_idempotent(ROUTE_GV, "ingressroutes", &route)
            .await?;
        Ok(())
    }

    async fn certificate_ready(&self, cert_name: &str) -> Result<bool, ProvisionError> {
        let resp = self
            .http
            .get(self.url(CERT_GV, "certificates", Some(cert_name)))
            .bearer_auth(self.bearer_token()?)
            .send()
            .await
            .map_err(|e| ProvisionError::Transient(e.to_string()))?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(false);
        }
        if !resp.status().is_success() {
            return Err(ProvisionError::Api(format!(
                "{} reading certificate",
                resp.status()
            )));
        }
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| ProvisionError::Transient(e.to_string()))?;
        Ok(certificate_is_ready(&body))
    }

    async fn teardown(&self, spec: &DomainSpec) -> Result<(), ProvisionError> {
        self.delete_url(
            self.url(ROUTE_GV, "ingressroutes", Some(&spec.route_name)),
            "ingressroute",
        )
        .await?;
        self.delete_url(
            self.url(CERT_GV, "certificates", Some(&spec.cert_name)),
            "certificate",
        )
        .await?;
        // cert-manager does not remove the backing Secret on Certificate delete.
        self.delete_url(self.core_url("secrets", &spec.secret_name), "secret")
            .await?;
        Ok(())
    }
}

/// True when the Certificate object carries a `Ready` condition with status `True`.
fn certificate_is_ready(cert: &serde_json::Value) -> bool {
    cert.get("status")
        .and_then(|s| s.get("conditions"))
        .and_then(|c| c.as_array())
        .map(|conds| {
            conds.iter().any(|c| {
                c.get("type").and_then(|t| t.as_str()) == Some("Ready")
                    && c.get("status").and_then(|s| s.as_str()) == Some("True")
            })
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_condition_parsing() {
        let ready = json!({"status": {"conditions": [
            {"type": "Ready", "status": "True"}
        ]}});
        assert!(certificate_is_ready(&ready));
        let issuing = json!({"status": {"conditions": [
            {"type": "Ready", "status": "False", "reason": "InProgress"}
        ]}});
        assert!(!certificate_is_ready(&issuing));
        assert!(!certificate_is_ready(&json!({})));
    }
}
