//! Access-token contract shared by the **auth** service (signs) and the **gateway**
//! (verifies). Centralizing it here means both agree on the algorithm, claim shape,
//! and validation rules — there is one definition, not two that can drift.
//!
//! Tokens are **EdDSA (Ed25519)**, asymmetric: auth holds the private key and is the
//! only minter; the gateway carries the public key and can only verify. A gateway
//! compromise therefore cannot forge tokens (Decision: locked with the user).
//!
//! Tokens are short-lived (~15 min) and carry the resolved permission set for the
//! active org, so the gateway gates routes with zero database access. Staleness after
//! a role change is bounded by the TTL; revocation of long-lived access goes through
//! the refresh token (a DB-backed session), not the access token.

use cupboard_domain::{OrgId, Permission, UserId};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum AuthCoreError {
    #[error("jwt error: {0}")]
    Jwt(#[from] jsonwebtoken::errors::Error),
    #[error("this key set has no private signing key (verify-only)")]
    NoSigningKey,
    #[error("invalid Ed25519 PEM key: {0}")]
    InvalidKey(jsonwebtoken::errors::Error),
}

/// The access-token claims. Serializes to a compact JWT body. Field names are the
/// stable wire contract.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    /// Subject — the operator/user id.
    pub sub: UserId,
    /// The active organization (tenant) this token is scoped to. `None` immediately
    /// after login when the user has not yet selected an org (or has none).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org: Option<OrgId>,
    /// The resolved permission strings for `org` (e.g. `["bans.create", ...]`). Empty
    /// when `org` is `None`. The gateway gates routes off this list.
    #[serde(default)]
    pub perms: Vec<String>,
    /// The session (refresh-token) this access token was minted from — lets the
    /// session be correlated/revoked.
    pub sid: Uuid,
    /// Issued-at (unix seconds).
    pub iat: i64,
    /// Expiry (unix seconds). Validated on decode.
    pub exp: i64,
    /// Unique token id (for tracing/replay diagnostics).
    pub jti: Uuid,
}

impl Claims {
    /// Build claims valid for `ttl_secs` from now. `org`/`perms` are `None`/empty for a
    /// freshly-logged-in token before an org is selected.
    pub fn new(
        sub: UserId,
        sid: Uuid,
        org: Option<OrgId>,
        perms: Vec<String>,
        ttl_secs: i64,
    ) -> Self {
        let now = chrono::Utc::now().timestamp();
        Claims {
            sub,
            org,
            perms,
            sid,
            iat: now,
            exp: now + ttl_secs,
            jti: Uuid::new_v4(),
        }
    }

    /// Whether this token grants `perm` in its active org.
    pub fn has_permission(&self, perm: Permission) -> bool {
        self.perms.iter().any(|p| p == perm.as_str())
    }
}

/// The audience value stamped on every player token; a defense-in-depth marker on top of
/// the load-bearing separation, which is the **distinct signing keypair** (see below).
pub const PLAYER_AUDIENCE: &str = "cupboard-player";

/// Access-token claims for **players** (storefront customers), a different population
/// from operators. Players authenticate per tenant site via Steam/Discord; their tokens
/// grant no operator permissions and are consumed only by the tenant service + web BFF.
///
/// SECURITY: operator services must never be able to accept one of these as a [`Claims`],
/// and vice versa. Because operator [`Keys::validation`] requires only `exp`/`sub` and
/// serde ignores unknown fields, a player token would otherwise deserialize into an
/// operator `Claims` (its `sub` becoming a `UserId`). The separation is therefore
/// enforced at the **signature layer**: player tokens are signed with a *different*
/// Ed25519 keypair ([`PlayerKeys`]), so an operator verifier rejects them outright and a
/// player verifier rejects operator tokens. The `aud` field is belt-and-braces only.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerClaims {
    /// Subject — the global player-account id.
    pub sub: Uuid,
    /// The tenant (organization) whose site this player logged in on. Player sessions are
    /// scoped to one tenant site; the token is not valid across tenants.
    pub tenant: OrgId,
    /// The player's verified Steam ID (steamid64), for provider customer lookup/checkout.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub steam_id: Option<String>,
    /// The player session (refresh-token) this access token was minted from.
    pub sid: Uuid,
    pub iat: i64,
    pub exp: i64,
    pub jti: Uuid,
    /// Always [`PLAYER_AUDIENCE`]; a redundant type marker.
    pub aud: String,
}

impl PlayerClaims {
    pub fn new(
        sub: Uuid,
        tenant: OrgId,
        steam_id: Option<String>,
        sid: Uuid,
        ttl_secs: i64,
    ) -> Self {
        let now = chrono::Utc::now().timestamp();
        PlayerClaims {
            sub,
            tenant,
            steam_id,
            sid,
            iat: now,
            exp: now + ttl_secs,
            jti: Uuid::new_v4(),
            aud: PLAYER_AUDIENCE.to_string(),
        }
    }
}

/// An Ed25519 key set for **player** tokens, cryptographically disjoint from the operator
/// [`Keys`]. Auth mints with the full set; the tenant service and web BFF verify with the
/// public key only. Kept a distinct type so a player key can never be passed where an
/// operator key is expected.
pub struct PlayerKeys {
    encoding: Option<EncodingKey>,
    decoding: DecodingKey,
    validation: Validation,
}

impl PlayerKeys {
    fn validation() -> Validation {
        let mut v = Validation::new(Algorithm::EdDSA);
        v.validate_exp = true;
        // Require the player audience in addition to exp/sub: a second, independent
        // gate beyond the signing-key separation.
        v.set_required_spec_claims(&["exp", "sub", "aud"]);
        v.set_audience(&[PLAYER_AUDIENCE]);
        v
    }

    /// Full signer+verifier from a PKCS#8 Ed25519 keypair in PEM. Used by auth.
    pub fn from_ed_pem(private_pem: &str, public_pem: &str) -> Result<Self, AuthCoreError> {
        Ok(PlayerKeys {
            encoding: Some(
                EncodingKey::from_ed_pem(private_pem.as_bytes())
                    .map_err(AuthCoreError::InvalidKey)?,
            ),
            decoding: DecodingKey::from_ed_pem(public_pem.as_bytes())
                .map_err(AuthCoreError::InvalidKey)?,
            validation: Self::validation(),
        })
    }

    /// Verify-only set from the public key in PEM. Used by the tenant service + web BFF.
    pub fn verifier_from_ed_pem(public_pem: &str) -> Result<Self, AuthCoreError> {
        Ok(PlayerKeys {
            encoding: None,
            decoding: DecodingKey::from_ed_pem(public_pem.as_bytes())
                .map_err(AuthCoreError::InvalidKey)?,
            validation: Self::validation(),
        })
    }

    pub fn encode(&self, claims: &PlayerClaims) -> Result<String, AuthCoreError> {
        let key = self.encoding.as_ref().ok_or(AuthCoreError::NoSigningKey)?;
        Ok(jsonwebtoken::encode(
            &Header::new(Algorithm::EdDSA),
            claims,
            key,
        )?)
    }

    pub fn decode(&self, token: &str) -> Result<PlayerClaims, AuthCoreError> {
        Ok(jsonwebtoken::decode::<PlayerClaims>(token, &self.decoding, &self.validation)?.claims)
    }
}

/// An Ed25519 key set. The gateway constructs a verify-only set
/// ([`Keys::verifier_from_ed_pem`]); the auth service constructs a full set
/// ([`Keys::from_ed_pem`]) and can both sign and verify.
pub struct Keys {
    encoding: Option<EncodingKey>,
    decoding: DecodingKey,
    validation: Validation,
}

impl Keys {
    fn validation() -> Validation {
        let mut v = Validation::new(Algorithm::EdDSA);
        v.validate_exp = true;
        // We don't use aud/iss in Phase 1; require only the standard exp/sub.
        v.set_required_spec_claims(&["exp", "sub"]);
        v
    }

    /// Full signer+verifier from a PKCS#8 Ed25519 keypair in PEM. Used by the auth
    /// service.
    pub fn from_ed_pem(private_pem: &str, public_pem: &str) -> Result<Self, AuthCoreError> {
        Ok(Keys {
            encoding: Some(
                EncodingKey::from_ed_pem(private_pem.as_bytes())
                    .map_err(AuthCoreError::InvalidKey)?,
            ),
            decoding: DecodingKey::from_ed_pem(public_pem.as_bytes())
                .map_err(AuthCoreError::InvalidKey)?,
            validation: Self::validation(),
        })
    }

    /// Verify-only set from the Ed25519 public key in PEM. Used by the gateway — it can
    /// never mint a token.
    pub fn verifier_from_ed_pem(public_pem: &str) -> Result<Self, AuthCoreError> {
        Ok(Keys {
            encoding: None,
            decoding: DecodingKey::from_ed_pem(public_pem.as_bytes())
                .map_err(AuthCoreError::InvalidKey)?,
            validation: Self::validation(),
        })
    }

    /// Sign `claims` into a compact JWT. Errors if this is a verify-only key set.
    pub fn encode(&self, claims: &Claims) -> Result<String, AuthCoreError> {
        let key = self.encoding.as_ref().ok_or(AuthCoreError::NoSigningKey)?;
        Ok(jsonwebtoken::encode(
            &Header::new(Algorithm::EdDSA),
            claims,
            key,
        )?)
    }

    /// Verify a compact JWT (signature + expiry + required claims) and return its
    /// claims.
    pub fn decode(&self, token: &str) -> Result<Claims, AuthCoreError> {
        Ok(jsonwebtoken::decode::<Claims>(token, &self.decoding, &self.validation)?.claims)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A throwaway Ed25519 keypair generated for tests only (openssl genpkey -algorithm
    // ed25519). Never used outside this test module.
    const TEST_PRIVATE_PEM: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIKfwTrhSm/f0QxY6e5mzQ+iTAvdyp3omCt4lyOjWItDm\n-----END PRIVATE KEY-----\n";
    const TEST_PUBLIC_PEM: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAyKMiwFH0hHn4HiPl8DTEq+aPzW9XyzG5v1ELTEVNsbY=\n-----END PUBLIC KEY-----\n";

    fn signer() -> Keys {
        Keys::from_ed_pem(TEST_PRIVATE_PEM, TEST_PUBLIC_PEM).expect("valid test keypair")
    }

    fn verifier() -> Keys {
        Keys::verifier_from_ed_pem(TEST_PUBLIC_PEM).expect("valid test public key")
    }

    fn sample_claims() -> Claims {
        Claims::new(
            UserId(Uuid::new_v4()),
            Uuid::new_v4(),
            Some(OrgId(Uuid::new_v4())),
            vec![Permission::BansCreate.as_str().to_string()],
            900,
        )
    }

    #[test]
    fn sign_then_verify_roundtrips_with_public_key_only() {
        let token = signer().encode(&sample_claims()).unwrap();
        // The gateway only ever has the public key.
        let decoded = verifier().decode(&token).unwrap();
        assert!(decoded.has_permission(Permission::BansCreate));
        assert!(!decoded.has_permission(Permission::OrgManage));
    }

    #[test]
    fn verify_only_keyset_cannot_sign() {
        assert!(matches!(
            verifier().encode(&sample_claims()),
            Err(AuthCoreError::NoSigningKey)
        ));
    }

    #[test]
    fn tampered_token_is_rejected() {
        let token = signer().encode(&sample_claims()).unwrap();
        // Flip a character in the signature segment.
        let mut bad = token.clone();
        let last = bad.pop().unwrap();
        bad.push(if last == 'A' { 'B' } else { 'A' });
        assert!(verifier().decode(&bad).is_err());
    }

    #[test]
    fn expired_token_is_rejected() {
        let mut claims = sample_claims();
        claims.iat -= 7200;
        claims.exp -= 3600; // expired an hour ago
        let token = signer().encode(&claims).unwrap();
        assert!(verifier().decode(&token).is_err());
    }

    // A second throwaway Ed25519 keypair, disjoint from the operator one above, standing
    // in for the player signing keys. (openssl genpkey -algorithm ed25519)
    const PLAYER_PRIVATE_PEM: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEICAsWQZFbg1O0Lpje3nZDeGXPq5tHVY7EY5g6l0cMHfN\n-----END PRIVATE KEY-----\n";
    const PLAYER_PUBLIC_PEM: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAG7f7pC1cQ0/mQ0dQ6mL4wUuqf4kSaP0aQ2xkPq0e0M8=\n-----END PUBLIC KEY-----\n";

    fn player_signer() -> PlayerKeys {
        PlayerKeys::from_ed_pem(TEST_PRIVATE_PEM, TEST_PUBLIC_PEM).expect("player keypair")
    }

    fn sample_player_claims() -> PlayerClaims {
        PlayerClaims::new(
            Uuid::new_v4(),
            OrgId(Uuid::new_v4()),
            Some("76561198000000000".into()),
            Uuid::new_v4(),
            900,
        )
    }

    #[test]
    fn player_token_roundtrips_and_carries_audience() {
        let signer = player_signer();
        let verifier = PlayerKeys::verifier_from_ed_pem(TEST_PUBLIC_PEM).unwrap();
        let claims = sample_player_claims();
        let token = signer.encode(&claims).unwrap();
        let decoded = verifier.decode(&token).unwrap();
        assert_eq!(decoded.aud, PLAYER_AUDIENCE);
        assert_eq!(decoded.steam_id.as_deref(), Some("76561198000000000"));
    }

    // The load-bearing security property: with the operator and player keypairs DISTINCT
    // (as in the real deployment), each verifier rejects the other population's tokens
    // at the signature layer.
    #[test]
    fn operator_verifier_rejects_player_token_signed_by_a_different_key() {
        let player_signer =
            PlayerKeys::from_ed_pem(PLAYER_PRIVATE_PEM, PLAYER_PUBLIC_PEM).expect("player keypair");
        let token = player_signer.encode(&sample_player_claims()).unwrap();
        assert!(
            verifier().decode(&token).is_err(),
            "operator verifier must reject a player-key-signed token"
        );
    }

    #[test]
    fn player_verifier_rejects_operator_token_signed_by_a_different_key() {
        let operator_token = signer().encode(&sample_claims()).unwrap();
        let player_verifier =
            PlayerKeys::verifier_from_ed_pem(PLAYER_PUBLIC_PEM).expect("player verifier");
        assert!(
            player_verifier.decode(&operator_token).is_err(),
            "player verifier must reject an operator-key-signed token"
        );
    }

    #[test]
    fn player_verifier_requires_the_player_audience() {
        let signer = player_signer();
        let mut claims = sample_player_claims();
        claims.aud = "cupboard-operator".into();
        let token = signer.encode(&claims).unwrap();
        let verifier = PlayerKeys::verifier_from_ed_pem(TEST_PUBLIC_PEM).unwrap();
        assert!(
            verifier.decode(&token).is_err(),
            "wrong audience must be rejected even with a valid player signature"
        );
    }
}
