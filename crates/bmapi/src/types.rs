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

/// A JSON:API single-resource document (mutation responses).
#[derive(Debug, Deserialize)]
#[serde(bound(deserialize = "A: serde::de::DeserializeOwned + Default"))]
pub struct OneDoc<A> {
    pub data: Resource<A>,
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

    /// Every related resource id under `name` (a to-one yields one, a to-many yields
    /// all). Used to walk a player's `identifiers` relationship against a page's
    /// `included` resources.
    pub fn rel_ids(&self, name: &str) -> Vec<&str> {
        match self.relationships.get(name).and_then(|r| r.data.as_ref()) {
            Some(RelData::One(ident)) => vec![ident.id.as_str()],
            Some(RelData::Many(idents)) => idents.iter().map(|i| i.id.as_str()).collect(),
            None => Vec::new(),
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
    /// Raw BM `expires` value (`None` = permanent). Kept as a string and parsed lazily
    /// via [`BanAttrs::parsed_expires`]: a lenient decode that silently turned an
    /// unparseable expiry into `None` would import a temporary ban as permanent, keeping
    /// a player banned forever once the real BM expiry passed.
    #[serde(rename = "expires")]
    pub expires: Option<String>,
    /// Fully lenient: `null` or an unexpected shape decodes to empty (the ban is then
    /// counted as skipped by the import) rather than sinking the page.
    #[serde(default, deserialize_with = "lenient_identifiers")]
    pub identifiers: Vec<BanIdentifier>,
    pub org_wide: Option<bool>,
    pub auto_add_enabled: Option<bool>,
    pub native_enabled: Option<bool>,
}

impl BanAttrs {
    /// Parse `expires` into an instant. `Ok(None)` = permanent (absent/empty); `Ok(Some)`
    /// = a real expiry; `Err(())` = a non-empty value we could not parse. Callers skip a
    /// ban on `Err` rather than treating a parse failure as the strongest possible value
    /// (a permanent ban). Accepts RFC3339 plus BM's colon-less-offset variants
    /// (`...+0000`, with or without fractional seconds). The unit error is intentional:
    /// the only fact a caller needs is "unparseable".
    #[allow(clippy::result_unit_err)]
    pub fn parsed_expires(&self) -> Result<Option<DateTime<Utc>>, ()> {
        let Some(raw) = self
            .expires
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            return Ok(None);
        };
        DateTime::parse_from_rfc3339(raw)
            .or_else(|_| DateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S%.f%z"))
            .or_else(|_| DateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S%z"))
            .map(|t| Some(t.with_timezone(&Utc)))
            .map_err(|_| ())
    }
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

/// Server attributes (import "servers" phase). Minimal: enough to register the server
/// in fleet by external id. `port` is the game port; `port_query` (BM `portQuery`) is the
/// A2S query port. RCON credentials are never exposed by BM, so imported servers land
/// disabled for the tenant to configure.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ServerAttrs {
    pub name: Option<String>,
    pub ip: Option<String>,
    pub port: Option<i64>,
    pub port_query: Option<i64>,
}

/// Player attributes (import "players" phase). Identifiers ride the resource's
/// `identifiers` relationship, resolved through the page's `included` array.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PlayerAttrs {
    pub name: Option<String>,
    /// First-seen time on BM; the import uses it as the identity-graph observation
    /// timestamp when present.
    #[serde(deserialize_with = "lenient_ts")]
    pub created_at: Option<DateTime<Utc>>,
}

/// Player-note attributes (import "notes" phase). BM fidelity the local `player_notes`
/// row can't hold (shared flag, clearance level, expiry) rides `bm_sync_map.meta`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NoteAttrs {
    pub note: Option<String>,
    pub shared: Option<bool>,
    pub clearance_level: Option<i64>,
    #[serde(deserialize_with = "lenient_ts")]
    pub expires_at: Option<DateTime<Utc>>,
    #[serde(deserialize_with = "lenient_ts")]
    pub created_at: Option<DateTime<Utc>>,
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
        assert_eq!(ban.attributes.expires.as_deref(), Some("not-a-timestamp"));
        assert!(
            ban.attributes.parsed_expires().is_err(),
            "an unparseable expiry is an error, not a silent permanent ban"
        );
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
    fn parsed_expires_accepts_offset_without_colon_and_flags_garbage() {
        let parse = |raw: serde_json::Value| -> Result<Option<DateTime<Utc>>, ()> {
            let doc: ListDoc<BanAttrs> = serde_json::from_value(serde_json::json!({
                "data": [{ "type": "ban", "id": "1", "attributes": { "expires": raw } }]
            }))
            .expect("decode");
            doc.data[0].attributes.parsed_expires()
        };
        // RFC3339 with a Z.
        assert!(parse(serde_json::json!("2026-08-01T00:00:00.000Z"))
            .unwrap()
            .is_some());
        // Offset without a colon (BM's shape), with and without fractional seconds: must
        // parse now instead of skipping the ban.
        assert!(parse(serde_json::json!("2026-08-01T00:00:00+0000"))
            .unwrap()
            .is_some());
        assert!(parse(serde_json::json!("2026-08-01T00:00:00.123+0000"))
            .unwrap()
            .is_some());
        // Absent = permanent.
        assert_eq!(parse(serde_json::json!(null)), Ok(None));
        // Garbage = error: the caller skips the ban, never imports it as permanent.
        assert!(parse(serde_json::json!("not-a-timestamp")).is_err());
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
