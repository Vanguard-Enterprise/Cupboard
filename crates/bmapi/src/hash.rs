//! Canonical content hash for synced records.
//!
//! One mechanism serves three jobs (plan decision K): echo guard (skip inbound records
//! whose hash matches what we last wrote), no-op skip on re-scan, and edit detection
//! (hash differs = the record changed on the BM side). Canonical form: JSON with
//! alphabetical keys (serde_json's default map is a BTreeMap), identifiers sorted,
//! absent strings normalized to "" so `null` and empty compare equal, timestamps
//! normalized to millisecond RFC3339 in UTC.

use chrono::{DateTime, SecondsFormat, Utc};

pub fn ban_content_hash(
    reason: Option<&str>,
    expires: Option<DateTime<Utc>>,
    identifiers: &[(String, String)],
    note: Option<&str>,
) -> Vec<u8> {
    let mut ids: Vec<String> = identifiers
        .iter()
        .map(|(kind, value)| format!("{kind}:{value}"))
        .collect();
    ids.sort();
    let canon = serde_json::json!({
        "expires": expires.map(|e| e.to_rfc3339_opts(SecondsFormat::Millis, true)),
        "identifiers": ids,
        "note": note.unwrap_or(""),
        "reason": reason.unwrap_or(""),
    });
    cupboard_crypto::sha256(canon.to_string().as_bytes()).to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone as _;

    fn ids(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn stable_across_identifier_order() {
        let a = ban_content_hash(
            Some("cheating"),
            None,
            &ids(&[("steamID", "1"), ("ip", "2.2.2.2")]),
            None,
        );
        let b = ban_content_hash(
            Some("cheating"),
            None,
            &ids(&[("ip", "2.2.2.2"), ("steamID", "1")]),
            None,
        );
        assert_eq!(a, b);
    }

    #[test]
    fn null_and_empty_strings_compare_equal() {
        let a = ban_content_hash(None, None, &[], None);
        let b = ban_content_hash(Some(""), None, &[], Some(""));
        assert_eq!(a, b);
    }

    #[test]
    fn changes_are_detected() {
        let base = ban_content_hash(Some("cheating"), None, &ids(&[("steamID", "1")]), None);
        let reason = ban_content_hash(Some("toxicity"), None, &ids(&[("steamID", "1")]), None);
        let expires = ban_content_hash(
            Some("cheating"),
            Some(Utc.with_ymd_and_hms(2027, 1, 1, 0, 0, 0).unwrap()),
            &ids(&[("steamID", "1")]),
            None,
        );
        assert_ne!(base, reason);
        assert_ne!(base, expires);
    }
}
