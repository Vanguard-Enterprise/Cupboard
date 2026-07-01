//! Envelope encryption for tenant-supplied secrets at rest — RCON passwords today,
//! panel/store credentials later (ARCHITECTURE §4 "Panel connections").
//!
//! There are hundreds of tenants supplying secrets at runtime, so a Vault entry per
//! secret doesn't scale. Instead a single **master key** lives in Vault and each secret
//! gets its own random **data-encryption key (DEK)**:
//!
//!   * the plaintext is sealed under a fresh DEK (AES-256-GCM), and
//!   * the DEK is wrapped under the master key (AES-256-GCM).
//!
//! Both blobs are stored next to the row (`*_enc` = [`Envelope::ciphertext`], `*_dek` =
//! [`Envelope::wrapped_dek`]). Rotating the master key only re-wraps DEKs, never touches
//! ciphertext. Each blob is `nonce(12) || ciphertext`; GCM's tag authenticates it, so
//! tampering or a wrong key fails closed on [`open`].

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use rand::rngs::OsRng;
use rand::RngCore as _;

const NONCE_LEN: usize = 12;
const DEK_LEN: usize = 32;

#[derive(Debug, thiserror::Error)]
pub enum EnvelopeError {
    #[error("encryption failed")]
    Encrypt,
    #[error("decryption failed: wrong key or corrupt/tampered data")]
    Decrypt,
    #[error("stored blob is too short to be valid")]
    Malformed,
}

/// The two ciphertext blobs produced by [`seal`]. Store both; pass both back to [`open`].
#[derive(Debug, Clone)]
pub struct Envelope {
    /// The DEK, encrypted under the master key (`nonce || ciphertext`).
    pub wrapped_dek: Vec<u8>,
    /// The secret, encrypted under the DEK (`nonce || ciphertext`).
    pub ciphertext: Vec<u8>,
}

/// Seal `plaintext` under a fresh random DEK, then wrap that DEK under `master_key`.
pub fn seal(master_key: &[u8; 32], plaintext: &[u8]) -> Result<Envelope, EnvelopeError> {
    let mut dek = [0u8; DEK_LEN];
    OsRng.fill_bytes(&mut dek);

    let ciphertext = aead_encrypt(&dek, plaintext)?;
    let wrapped_dek = aead_encrypt(master_key, &dek)?;

    // Best-effort scrub of the raw DEK from the stack once it's wrapped.
    dek.fill(0);
    Ok(Envelope {
        wrapped_dek,
        ciphertext,
    })
}

/// Unwrap the DEK with `master_key`, then decrypt the secret. Fails closed if the master
/// key is wrong or either blob was tampered with (GCM tag mismatch).
pub fn open(master_key: &[u8; 32], envelope: &Envelope) -> Result<Vec<u8>, EnvelopeError> {
    let dek_vec = aead_decrypt(master_key, &envelope.wrapped_dek)?;
    let dek: [u8; DEK_LEN] = dek_vec
        .as_slice()
        .try_into()
        .map_err(|_| EnvelopeError::Decrypt)?;
    let plaintext = aead_decrypt(&dek, &envelope.ciphertext);
    // dek_vec still holds the key bytes; scrub them.
    let mut dek_vec = dek_vec;
    dek_vec.fill(0);
    plaintext
}

fn aead_encrypt(key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ct = cipher
        .encrypt(nonce, plaintext)
        .map_err(|_| EnvelopeError::Encrypt)?;
    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);
    Ok(out)
}

fn aead_decrypt(key: &[u8; 32], blob: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
    if blob.len() < NONCE_LEN {
        return Err(EnvelopeError::Malformed);
    }
    let (nonce_bytes, ct) = blob.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher
        .decrypt(nonce, ct)
        .map_err(|_| EnvelopeError::Decrypt)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        let key = [7u8; 32];
        let env = seal(&key, b"changeme123").unwrap();
        assert_eq!(open(&key, &env).unwrap(), b"changeme123");
    }

    #[test]
    fn distinct_ciphertexts_for_same_plaintext() {
        // Fresh DEK + nonce each time → identical plaintext seals to different bytes.
        let key = [1u8; 32];
        let a = seal(&key, b"secret").unwrap();
        let b = seal(&key, b"secret").unwrap();
        assert_ne!(a.ciphertext, b.ciphertext);
        assert_ne!(a.wrapped_dek, b.wrapped_dek);
    }

    #[test]
    fn wrong_master_key_fails() {
        let env = seal(&[1u8; 32], b"secret").unwrap();
        assert!(matches!(
            open(&[2u8; 32], &env),
            Err(EnvelopeError::Decrypt)
        ));
    }

    #[test]
    fn tampered_ciphertext_fails() {
        let key = [3u8; 32];
        let mut env = seal(&key, b"secret").unwrap();
        *env.ciphertext.last_mut().unwrap() ^= 0xff;
        assert!(matches!(open(&key, &env), Err(EnvelopeError::Decrypt)));
    }

    #[test]
    fn short_blob_is_malformed() {
        // A wrapped-DEK blob shorter than the nonce can't even be split.
        let key = [4u8; 32];
        let env = Envelope {
            wrapped_dek: vec![0u8; 4],
            ciphertext: vec![0u8; 4],
        };
        assert!(matches!(open(&key, &env), Err(EnvelopeError::Malformed)));
    }
}
