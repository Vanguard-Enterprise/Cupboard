//! Argon2id password hashing. Hashes are stored in PHC string form (algorithm,
//! parameters, and salt are all encoded in the string), so verification needs no
//! out-of-band parameters.

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::SaltString;
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};

/// Hash a plaintext password with a fresh random salt. Returns the PHC string to store
/// in `users.password_hash`.
pub fn hash_password(password: &str) -> anyhow::Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| anyhow::anyhow!("argon2 hash failed: {e}"))
}

/// Verify a plaintext password against a stored PHC hash. Returns `false` on mismatch
/// or if the stored hash is malformed — never panics, never distinguishes the two to
/// the caller.
pub fn verify_password(password: &str, phc_hash: &str) -> bool {
    match PasswordHash::new(phc_hash) {
        Ok(parsed) => Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_then_verify() {
        let hash = hash_password("correct horse battery staple").unwrap();
        assert!(verify_password("correct horse battery staple", &hash));
        assert!(!verify_password("Tr0ub4dor&3", &hash));
    }

    #[test]
    fn malformed_hash_does_not_panic() {
        assert!(!verify_password("anything", "not-a-phc-string"));
    }
}
