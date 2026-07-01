//! Small cryptographic helpers shared across Cupboard services.
//!
//! Two jobs in Phase 1, both with a forward eye to Phase 2's identity/ban enforcement
//! keys (`docs/identity-schema.md`):
//!
//!   * **Deterministic keyed hashing** — `hmac_sha256(value, pepper)` with a single
//!     secret pepper from Vault. The *same* input always yields the *same* digest, so
//!     a value's raw form can be erased (GDPR) while lookups/matching on the digest
//!     keep working. This is the pattern the salted-Steam-hash enforcement key will use.
//!   * **Bearer-secret hygiene** — refresh tokens and invite tokens are random secrets
//!     shown once to the client; we persist only their keyed hash, never the raw value.

pub mod envelope;
pub use envelope::{open, seal, Envelope, EnvelopeError};

use base64::Engine as _;
use hmac::{Hmac, Mac};
use rand::RngCore as _;
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// HMAC-SHA256 of `value` under `pepper`. Deterministic: identical `(value, pepper)`
/// always produces the same 32-byte digest, which is exactly what lets enforcement
/// keys survive erasure of the raw value. The pepper is a process-wide secret, never
/// a per-row salt.
pub fn hmac_sha256(value: &[u8], pepper: &[u8]) -> [u8; 32] {
    // HMAC accepts a key of any length, so this never errors.
    let mut mac = HmacSha256::new_from_slice(pepper).expect("HMAC accepts any key length");
    mac.update(value);
    let digest = mac.finalize().into_bytes();
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

/// Generate a fresh URL-safe bearer secret (256 bits of entropy, base64url, no
/// padding). Used for refresh tokens and invite tokens — returned to the client once;
/// only its [`hash_token`] is stored.
pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Keyed hash of a bearer secret for at-rest storage. Look up by this value; the raw
/// token is never persisted. Keyed (not bare SHA-256) so a DB leak can't be brute-forced
/// without the pepper.
pub fn hash_token(token: &str, pepper: &[u8]) -> Vec<u8> {
    hmac_sha256(token.as_bytes(), pepper).to_vec()
}

/// Plain (unkeyed) SHA-256. Used for the OAuth2 PKCE S256 challenge, where the verifier
/// is a high-entropy secret and the challenge is its public, non-secret digest.
pub fn sha256(data: &[u8]) -> [u8; 32] {
    use sha2::Digest as _;
    let mut hasher = Sha256::new();
    hasher.update(data);
    let digest = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_is_deterministic_and_pepper_sensitive() {
        let a = hmac_sha256(b"76561197960287930", b"pepper-1");
        let b = hmac_sha256(b"76561197960287930", b"pepper-1");
        let c = hmac_sha256(b"76561197960287930", b"pepper-2");
        assert_eq!(
            a, b,
            "same input + pepper must match (enforcement-key invariant)"
        );
        assert_ne!(a, c, "different pepper must diverge");
    }

    #[test]
    fn random_tokens_are_unique_and_hash_stably() {
        let t1 = random_token();
        let t2 = random_token();
        assert_ne!(t1, t2);
        assert_eq!(hash_token(&t1, b"p"), hash_token(&t1, b"p"));
        assert_ne!(hash_token(&t1, b"p"), hash_token(&t2, b"p"));
    }
}
