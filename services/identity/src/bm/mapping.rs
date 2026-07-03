//! BM resource -> Cupboard record mapping, shared by the import executor and the sync
//! loops (they walk the same iterator; decision H).

use crate::domain::bm::{BmConnection, ImportedBan, ImportedBanList};
use chrono::Utc;
use cupboard_bmapi::ban_content_hash;
use cupboard_bmapi::types::{BanAttrs, BanIdentifier, BanListAttrs, Resource};
use std::collections::HashMap;

pub(crate) fn imported_list(res: &Resource<BanListAttrs>, conn: &BmConnection) -> ImportedBanList {
    // The list's owning org rides the "organization" relationship ("owner" accepted
    // defensively); a list owned by someone else is a subscription.
    let owner = res
        .rel_id("organization")
        .or_else(|| res.rel_id("owner"))
        .map(str::to_string);
    let subscribed = owner.as_deref().is_some_and(|o| o != conn.bm_org_id);
    ImportedBanList {
        external_id: res.id.clone(),
        name: res.attributes.name.clone(),
        action: res.attributes.action.clone(),
        owner_bm_org: owner,
        subscribed,
        perm_create: res.attributes.perm_create.unwrap_or(false),
        perm_update: res.attributes.perm_update.unwrap_or(false),
        perm_delete: res.attributes.perm_delete.unwrap_or(false),
    }
}

/// Cupboard subject types an imported identifier can become, most durable first.
const PRECEDENCE: [&str; 5] = ["steam", "eos", "beguid", "ip", "name"];

fn bm_kind_to_subject(kind: &str) -> Option<&'static str> {
    match kind {
        "steamID" => Some("steam"),
        "eosID" | "egsID" | "epicID" => Some("eos"),
        "BEGUID" | "legacyBEGUID" => Some("beguid"),
        "ip" => Some("ip"),
        "name" => Some("name"),
        _ => None,
    }
}

fn pick_primary(resolved: &[(String, String)]) -> Option<(&'static str, String)> {
    let mut best: Option<(usize, &'static str, &str)> = None;
    for (kind, value) in resolved {
        if value.is_empty() {
            continue;
        }
        if let Some(subject) = bm_kind_to_subject(kind) {
            let rank = PRECEDENCE
                .iter()
                .position(|p| *p == subject)
                .expect("subject came from PRECEDENCE");
            if best.is_none_or(|(r, _, _)| rank < r) {
                best = Some((rank, subject, value));
            }
        }
    }
    best.map(|(_, kind, value)| (kind, value.to_string()))
}

/// Map one BM ban resource to an importable ban. `None` = no usable identifier
/// (counted, per decision F). The full resolved array + BM extras ride `meta`.
pub(crate) fn imported_ban(
    res: &Resource<BanAttrs>,
    ids_map: &HashMap<String, (String, String)>,
    list_id: &str,
) -> Option<ImportedBan> {
    let a = &res.attributes;
    let mut resolved: Vec<(String, String)> = Vec::new();
    let mut unresolved = 0u32;
    for ident in &a.identifiers {
        match ident {
            BanIdentifier::Ref(n) => match ids_map.get(&n.to_string()) {
                Some((kind, value)) => resolved.push((kind.clone(), value.clone())),
                None => unresolved += 1,
            },
            BanIdentifier::Manual(m) => resolved.push((m.kind.clone(), m.identifier.clone())),
            BanIdentifier::Other(_) => unresolved += 1,
        }
    }
    let (subject_type, subject_value) = pick_primary(&resolved)?;
    let content_hash =
        ban_content_hash(a.reason.as_deref(), a.expires, &resolved, a.note.as_deref());
    let meta = serde_json::json!({
        "uid": a.uid,
        "note": a.note,
        "org_wide": a.org_wide,
        "auto_add_enabled": a.auto_add_enabled,
        "native_enabled": a.native_enabled,
        "identifiers": resolved
            .iter()
            .map(|(kind, value)| serde_json::json!({ "type": kind, "value": value }))
            .collect::<Vec<_>>(),
        "unresolved_identifiers": unresolved,
        "ban_list": list_id,
        "bm_server": res.rel_id("server"),
        "bm_player": res.rel_id("player"),
    });
    Some(ImportedBan {
        external_id: res.id.clone(),
        subject_type: subject_type.to_string(),
        subject_value,
        reason: a.reason.clone(),
        issued_at: a.timestamp.unwrap_or_else(Utc::now),
        expires_at: a.expires,
        content_hash,
        meta,
    })
}

/// Map a fetched page: importable bans plus the count of skipped (no usable
/// identifier) resources.
pub(crate) fn imported_ban_page(
    data: &[Resource<BanAttrs>],
    ids_map: &HashMap<String, (String, String)>,
    list_id: &str,
) -> (Vec<ImportedBan>, usize) {
    let bans: Vec<ImportedBan> = data
        .iter()
        .filter_map(|res| imported_ban(res, ids_map, list_id))
        .collect();
    let skipped = data.len() - bans.len();
    (bans, skipped)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(input: &[(&str, &str)]) -> Vec<(String, String)> {
        input
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn primary_identifier_precedence() {
        let picked = pick_primary(&pairs(&[
            ("ip", "1.2.3.4"),
            ("BEGUID", "beguid-1"),
            ("steamID", "76561198000000001"),
        ]))
        .unwrap();
        assert_eq!(picked, ("steam", "76561198000000001".to_string()));

        let picked = pick_primary(&pairs(&[("ip", "1.2.3.4"), ("eosID", "eos-1")])).unwrap();
        assert_eq!(picked.0, "eos");

        assert!(pick_primary(&pairs(&[("unknownKind", "x")])).is_none());
        assert!(pick_primary(&[]).is_none());
    }

    #[test]
    fn ban_without_usable_identifier_is_skipped() {
        let res: Resource<BanAttrs> = serde_json::from_value(serde_json::json!({
            "type": "ban",
            "id": "b1",
            "attributes": { "identifiers": [ {"unexpected": 1} ] }
        }))
        .unwrap();
        assert!(imported_ban(&res, &HashMap::new(), "l1").is_none());
    }

    #[test]
    fn numeric_refs_resolve_through_included_map() {
        let res: Resource<BanAttrs> = serde_json::from_value(serde_json::json!({
            "type": "ban",
            "id": "b2",
            "attributes": {
                "reason": "cheating",
                "identifiers": [7, {"type": "ip", "identifier": "9.9.9.9"}]
            },
            "relationships": { "banList": {"data": {"type": "banList", "id": "l1"}} }
        }))
        .unwrap();
        let mut map = HashMap::new();
        map.insert(
            "7".to_string(),
            ("steamID".to_string(), "76561198000000009".to_string()),
        );
        let ban = imported_ban(&res, &map, "l1").expect("importable");
        assert_eq!(ban.subject_type, "steam");
        assert_eq!(ban.subject_value, "76561198000000009");
        let idents = ban.meta.get("identifiers").unwrap().as_array().unwrap();
        assert_eq!(idents.len(), 2, "meta keeps the full array");
    }
}
