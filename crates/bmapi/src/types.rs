//! Minimal JSON:API types for the BattleMetrics API.
//!
//! Deliberately lenient: unknown fields are ignored, missing attributes default, and
//! malformed timestamps decode to `None` instead of failing a whole page. The import
//! pipeline records what it can and counts what it can't.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashMap;

/// `null` decodes as `T::default()`; combined with `#[serde(default)]` this makes a
/// field tolerate both an absent key AND an explicit JSON null. A decode failure is
/// fatal in the client (no retry can fix it), so every structural field here must be
/// null-tolerant or one odd record wedges a tenant's import permanently.
fn null_default<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

/// A JSON:API list document (`data` is an array). Follow `links.next` until absent.
#[derive(Debug, Deserialize)]
#[serde(bound(deserialize = "A: serde::de::DeserializeOwned + Default"))]
pub struct ListDoc<A> {
    #[serde(default, deserialize_with = "null_default")]
    pub data: Vec<Resource<A>>,
    #[serde(default, deserialize_with = "null_default")]
    pub included: Vec<serde_json::Value>,
    #[serde(default, deserialize_with = "null_default")]
    pub links: Links,
}

#[derive(Debug, Default, Deserialize)]
pub struct Links {
    #[serde(default)]
    pub next: Option<String>,
    #[serde(default)]
    pub prev: Option<String>,
}

/// One JSON:API resource. `attributes` defaults when absent so a sparse resource never
/// sinks its page.
#[derive(Debug, Deserialize)]
#[serde(bound(deserialize = "A: serde::de::DeserializeOwned + Default"))]
pub struct Resource<A> {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, deserialize_with = "null_default")]
    pub attributes: A,
    #[serde(default, deserialize_with = "null_default")]
    pub relationships: HashMap<String, Relationship>,
}

impl<A> Resource<A> {
    /// The related resource id under `name`, when it's a to-one relationship.
    pub fn rel_id(&self, name: &str) -> Option<&str> {
        match self.relationships.get(name)?.data.as_ref()? {
            RelData::One(ident) => Some(ident.id.as_str()),
            RelData::Many(_) => None,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
pub struct Relationship {
    #[serde(default)]
    pub data: Option<RelData>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum RelData {
    One(RelIdent),
    Many(Vec<RelIdent>),
}

#[derive(Debug, Deserialize)]
pub struct RelIdent {
    #[serde(rename = "type")]
    pub kind: String,
    pub id: String,
}

/// RFC3339 timestamp or `None`; malformed values decode to `None` (lenient by design).
fn lenient_ts<'de, D: Deserializer<'de>>(d: D) -> Result<Option<DateTime<Utc>>, D::Error> {
    let raw = Option::<String>::deserialize(d)?;
    Ok(raw
        .as_deref()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.with_timezone(&Utc)))
}

/// Ban attributes (<https://www.battlemetrics.com/developers/documentation> "Bans").
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BanAttrs {
    /// BM's short unique ban id (also usable in `DELETE /bans/{uid}` paths).
    pub uid: Option<String>,
    /// Creation time. BM exposes no last-modified field; sync diffs by content hash.
    #[serde(deserialize_with = "lenient_ts")]
    pub timestamp: Option<DateTime<Utc>>,
    pub reason: Option<String>,
    /// BM's private staff note on the ban.
    pub note: Option<String>,
    /// `None` = permanent.
    #[serde(deserialize_with = "lenient_ts")]
    pub expires: Option<DateTime<Utc>>,
    /// Fully lenient: `null` or an unexpected shape decodes to empty (the ban is then
    /// counted as skipped by the import) rather than sinking the page.
    #[serde(default, deserialize_with = "lenient_identifiers")]
    pub identifiers: Vec<BanIdentifier>,
    pub org_wide: Option<bool>,
    pub auto_add_enabled: Option<bool>,
    pub native_enabled: Option<bool>,
}

/// Any-shape tolerance for the identifiers array: element-level oddities are already
/// absorbed by [`BanIdentifier::Other`], and a non-array value decodes to empty.
fn lenient_identifiers<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<BanIdentifier>, D::Error> {
    let raw = serde_json::Value::deserialize(d)?;
    Ok(serde_json::from_value(raw).unwrap_or_default())
}

/// One entry of a ban's `identifiers` array: either a numeric reference to a stored
/// player identifier (resolved via `include=playerIdentifiers`) or an inline manual
/// entry. Anything else is preserved raw for meta fidelity and ignored for matching.
#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum BanIdentifier {
    Ref(u64),
    Manual(ManualIdentifier),
    Other(serde_json::Value),
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ManualIdentifier {
    #[serde(rename = "type")]
    pub kind: String,
    pub identifier: String,
}

/// Ban-list attributes. `perm_*` are the rights the list owner granted this org.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BanListAttrs {
    pub name: Option<String>,
    pub action: Option<String>,
    pub perm_manage: Option<bool>,
    pub perm_create: Option<bool>,
    pub perm_update: Option<bool>,
    pub perm_delete: Option<bool>,
}

/// Attributes of an included player-identifier resource.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct PlayerIdentifierAttrs {
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub identifier: Option<String>,
}

/// Resolve a page's `included` player identifiers into `id -> (type, value)`, for
/// dereferencing numeric [`BanIdentifier::Ref`] entries.
pub fn included_identifier_map(
    included: &[serde_json::Value],
) -> HashMap<String, (String, String)> {
    let mut map = HashMap::new();
    for item in included {
        let kind = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
        // BM labels these resources "identifier"; accept the long form defensively.
        if kind != "identifier" && kind != "playerIdentifier" {
            continue;
        }
        let (Some(id), Some(attrs)) = (
            item.get("id").and_then(|v| v.as_str()),
            item.get("attributes"),
        ) else {
            continue;
        };
        let (Some(id_type), Some(value)) = (
            attrs.get("type").and_then(|v| v.as_str()),
            attrs.get("identifier").and_then(|v| v.as_str()),
        ) else {
            continue;
        };
        map.insert(id.to_string(), (id_type.to_string(), value.to_string()));
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ban_page_decodes_leniently() {
        let raw = serde_json::json!({
            "data": [{
                "type": "ban",
                "id": "42",
                "attributes": {
                    "uid": "abc12345",
                    "timestamp": "2026-01-02T03:04:05.678Z",
                    "reason": "cheating",
                    "expires": "not-a-timestamp",
                    "identifiers": [
                        7,
                        {"type": "steamID", "identifier": "76561198000000001"},
                        {"unexpected": true}
                    ],
                    "orgWide": true,
                    "surpriseField": {"ignored": true}
                },
                "relationships": {
                    "banList": {"data": {"type": "banList", "id": "list-1"}},
                    "server": {"data": null}
                }
            }],
            "included": [{
                "type": "identifier",
                "id": "7",
                "attributes": {"type": "steamID", "identifier": "76561198000000002"}
            }],
            "links": {"next": "https://api.battlemetrics.com/bans?page[key]=x"}
        });
        let doc: ListDoc<BanAttrs> = serde_json::from_value(raw).expect("decode");
        assert_eq!(doc.data.len(), 1);
        let ban = &doc.data[0];
        assert_eq!(ban.attributes.uid.as_deref(), Some("abc12345"));
        assert!(ban.attributes.timestamp.is_some());
        assert!(ban.attributes.expires.is_none(), "malformed ts -> None");
        assert_eq!(ban.attributes.identifiers.len(), 3);
        assert!(matches!(
            ban.attributes.identifiers[0],
            BanIdentifier::Ref(7)
        ));
        assert!(matches!(
            ban.attributes.identifiers[2],
            BanIdentifier::Other(_)
        ));
        assert_eq!(ban.rel_id("banList"), Some("list-1"));
        assert_eq!(ban.rel_id("server"), None);
        assert!(doc.links.next.is_some());

        let ids = included_identifier_map(&doc.included);
        assert_eq!(
            ids.get("7"),
            Some(&("steamID".to_string(), "76561198000000002".to_string()))
        );
    }

    #[test]
    fn missing_attributes_default() {
        let raw = serde_json::json!({ "data": [{"type": "banList", "id": "l1"}] });
        let doc: ListDoc<BanListAttrs> = serde_json::from_value(raw).expect("decode");
        assert!(doc.data[0].attributes.name.is_none());
        assert!(doc.links.next.is_none());
    }

    #[test]
    fn explicit_nulls_do_not_sink_a_page() {
        // Every structural field as explicit null: attributes, relationships,
        // identifiers, links, included. One odd record must never wedge an import.
        let raw = serde_json::json!({
            "data": [
                {"type": "ban", "id": "1", "attributes": null, "relationships": null},
                {"type": "ban", "id": "2", "attributes": {"identifiers": null, "reason": "x"}},
                {"type": "ban", "id": "3", "attributes": {"identifiers": "not-an-array"}}
            ],
            "included": null,
            "links": null
        });
        let doc: ListDoc<BanAttrs> = serde_json::from_value(raw).expect("must decode");
        assert_eq!(doc.data.len(), 3);
        assert!(doc.data[0].attributes.reason.is_none());
        assert_eq!(doc.data[1].attributes.reason.as_deref(), Some("x"));
        assert!(doc.data[1].attributes.identifiers.is_empty());
        assert!(doc.data[2].attributes.identifiers.is_empty());
        assert!(doc.links.next.is_none());

        // data: null = empty page, not an error.
        let empty: ListDoc<BanAttrs> =
            serde_json::from_value(serde_json::json!({ "data": null })).expect("decode");
        assert!(empty.data.is_empty());
    }
}
