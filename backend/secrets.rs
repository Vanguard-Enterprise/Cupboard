use crate::auth::{ApiResult, internal};
use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use rand_core::{OsRng, RngCore};

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
    pub(crate) fn encrypt(
        &self,
        secret: &str,
        org: &str,
        id: &str,
        purpose: &str,
    ) -> ApiResult<Vec<u8>> {
        let mut nonce = [0; 12];
        OsRng.fill_bytes(&mut nonce);
        let cipher = Aes256Gcm::new_from_slice(&self.0).map_err(|_| internal())?;
        let aad = format!("cupboard:{purpose}:v1:{org}:{id}");
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
    pub(crate) fn decrypt(
        &self,
        encrypted: &[u8],
        org: &str,
        id: &str,
        purpose: &str,
    ) -> Result<Vec<u8>, aes_gcm::Error> {
        if encrypted.len() < 28 {
            return Err(aes_gcm::Error);
        }
        let cipher = Aes256Gcm::new_from_slice(&self.0).map_err(|_| aes_gcm::Error)?;
        let aad = format!("cupboard:{purpose}:v1:{org}:{id}");
        cipher.decrypt(
            &Nonce::from(<[u8; 12]>::try_from(&encrypted[..12]).unwrap()),
            Payload {
                msg: &encrypted[12..],
                aad: aad.as_bytes(),
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn secrets_are_authenticated_randomized_and_bound_to_the_record() {
        let key = SecretKey::parse(&"ab".repeat(32)).unwrap();
        let a = key
            .encrypt("private password", "tenant", "server", "rcon")
            .unwrap();
        let b = key
            .encrypt("private password", "tenant", "server", "rcon")
            .unwrap();
        assert_ne!(a, b);
        assert!(key.decrypt(&a, "tenant", "server", "pelican").is_err());
        assert!(!a.windows(16).any(|w| w == b"private password"));
        assert_eq!(
            key.decrypt(&a, "tenant", "server", "rcon").unwrap(),
            b"private password"
        );
        assert!(key.decrypt(&a, "another", "server", "rcon").is_err());
        assert!(key.decrypt(&a, "tenant", "another", "rcon").is_err());
        assert!(key.decrypt(&[0], "tenant", "server", "rcon").is_err());
        let mut corrupt = a;
        corrupt[13] ^= 1;
        assert!(key.decrypt(&corrupt, "tenant", "server", "rcon").is_err());
    }
}
