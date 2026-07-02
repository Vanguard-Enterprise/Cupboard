//! The push-token registry: which ingest tokens are currently valid, and which server
//! each one speaks for. Rebuilt from fleet's config feed on every reconcile, so issue /
//! rotate / revoke / disable all propagate within one reconcile interval.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use uuid::Uuid;

use crate::fleet_client::ServerConfig;

/// Who a valid token belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PushIdentity {
    pub server_id: Uuid,
    pub tenant_id: Uuid,
}

/// Cheaply cloneable shared map from token *hash* to server identity. Keyed by the
/// SHA-256 of the token: the handler hashes what the caller presented and does an exact
/// lookup, so no attacker-controlled comparison happens against stored secrets.
#[derive(Clone, Default)]
pub struct TokenRegistry {
    inner: Arc<RwLock<HashMap<[u8; 32], PushIdentity>>>,
}

impl TokenRegistry {
    /// Replace the registry contents from a fresh config feed. Rows without a token (or
    /// with a malformed hash) are simply absent — push disabled for them.
    pub fn update(&self, configs: &[ServerConfig]) {
        let mut map = HashMap::new();
        for c in configs {
            let Some(hex_hash) = &c.ingest_token_hash else {
                continue;
            };
            match parse_hash(hex_hash) {
                Some(hash) => {
                    map.insert(
                        hash,
                        PushIdentity {
                            server_id: c.id,
                            tenant_id: c.tenant_id,
                        },
                    );
                }
                None => {
                    tracing::warn!(server_id = %c.id, "malformed ingest token hash in config feed; push disabled for this server");
                }
            }
        }
        *self.inner.write().expect("token registry poisoned") = map;
    }

    /// Resolve a presented bearer token to its server, or `None` if it's not valid.
    pub fn lookup(&self, token: &str) -> Option<PushIdentity> {
        let hash = cupboard_crypto::sha256(token.as_bytes());
        self.inner
            .read()
            .expect("token registry poisoned")
            .get(&hash)
            .copied()
    }

    /// How many servers currently accept pushes (for logs/metrics).
    pub fn len(&self) -> usize {
        self.inner.read().expect("token registry poisoned").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

fn parse_hash(hex_hash: &str) -> Option<[u8; 32]> {
    let bytes = hex::decode(hex_hash).ok()?;
    bytes.try_into().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(id: Uuid, token_hash: Option<String>) -> ServerConfig {
        ServerConfig {
            id,
            tenant_id: Uuid::new_v4(),
            name: "s".into(),
            rcon_host: "h".into(),
            rcon_port: 28016,
            rcon_password: "p".into(),
            query_port: None,
            ingest_token_hash: token_hash,
        }
    }

    #[test]
    fn lookup_resolves_only_current_tokens() {
        let registry = TokenRegistry::default();
        let token = "cus_test-token";
        let hash = hex::encode(cupboard_crypto::sha256(token.as_bytes()));
        let server = Uuid::new_v4();

        registry.update(&[config(server, Some(hash))]);
        assert_eq!(registry.lookup(token).unwrap().server_id, server);
        assert_eq!(registry.lookup("cus_wrong"), None);

        // Rotation: the feed now carries a different hash → the old token dies.
        registry.update(&[config(server, Some(hex::encode([7u8; 32])))]);
        assert_eq!(registry.lookup(token), None);

        // Revocation/no token: nothing resolves.
        registry.update(&[config(server, None)]);
        assert!(registry.is_empty());
    }
}
