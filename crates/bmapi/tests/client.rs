//! End-to-end `BmClient` tests against the in-process stub (feature `stub`).
//!
//! The client fetches absolute URLs and follows `links.next` verbatim, so pagination and
//! retry can only be exercised over a real socket, not a mocked transport. These drive
//! the whole path: bearer auth, retry/backoff, page walking, and `included` resolution.
//! No network, no env gates. The retry tests use `Retry-After: 1` to keep the client's
//! honored waits at ~1s each instead of its jittered exponential backoff.

use cupboard_bmapi::stub::{
    Fault, StubBan, StubBanList, StubBm, StubData, StubNote, StubPlayer, StubServer,
};
use cupboard_bmapi::types::{
    included_identifier_map, BanAttrs, BanIdentifier, BanListAttrs, NoteAttrs, PlayerAttrs,
    ServerAttrs,
};
use cupboard_bmapi::{BmClient, BmError, DeleteOutcome, NewBmBan};
use serde_json::json;
use std::collections::HashSet;

fn ts(secs: i64) -> String {
    // 2026-01-01T00:00:00Z + `secs`, kept well inside one hour for the pagination fixture.
    let base = chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z").unwrap();
    (base + chrono::Duration::seconds(secs)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

#[tokio::test]
async fn pagination_walks_links_next() {
    // 250 bans, inserted oldest-first so a correct `-timestamp` sort must reverse them.
    let bans: Vec<StubBan> = (0..250)
        .map(|i| {
            StubBan::new(
                "list-1",
                format!("ban-{i}"),
                format!("uid{i}"),
                ts(i),
                "cheating",
            )
        })
        .collect();
    let stub = StubBm::start(
        StubData::new("tok")
            .with_ban_list(StubBanList::new("list-1", "Main"))
            .with_bans(bans),
    )
    .await;
    let client = BmClient::new(stub.base_url(), "tok");

    let mut url = client.bans_first_page("list-1");
    let mut ids = Vec::new();
    let mut pages = 0;
    let mut last_ts: Option<chrono::DateTime<chrono::Utc>> = None;
    loop {
        let doc = client
            .list_page::<BanAttrs>(&url)
            .await
            .expect("page decodes");
        pages += 1;
        for r in &doc.data {
            ids.push(r.id.clone());
            let this = r.attributes.timestamp.expect("timestamp present");
            if let Some(prev) = last_ts {
                assert!(this <= prev, "results must be newest-first");
            }
            last_ts = Some(this);
        }
        match doc.links.next {
            Some(next) => url = next,
            None => break,
        }
    }

    assert_eq!(pages, 3, "250 / page[size]=100 -> 3 pages");
    assert_eq!(ids.len(), 250);
    let unique: HashSet<&String> = ids.iter().collect();
    assert_eq!(unique.len(), 250, "every ban id present exactly once");
    assert_eq!(ids[0], "ban-249", "highest timestamp is served first");
}

#[tokio::test]
async fn rate_limited_then_succeeds() {
    let stub = StubBm::start(StubData::new("tok").with_ban_list(StubBanList::new("l", "n"))).await;
    let client = BmClient::new(stub.base_url(), "tok");

    stub.push_fault(Fault::RateLimited {
        retry_after: Some(1),
    });
    let doc = client
        .list_page::<BanListAttrs>(&client.ban_lists_first_page())
        .await
        .expect("succeeds after honoring Retry-After");

    assert_eq!(doc.data.len(), 1);
    let reqs = stub.requests();
    assert_eq!(reqs.len(), 2, "one throttled attempt, then the retry");
    assert!(reqs.iter().all(|r| r.bearer_ok));
}

#[tokio::test]
async fn rate_limited_exhausts_retries() {
    let stub = StubBm::start(StubData::new("tok")).await;
    let client = BmClient::new(stub.base_url(), "tok");

    // More faults than the client will make attempts, so every request is throttled.
    for _ in 0..6 {
        stub.push_fault(Fault::RateLimited {
            retry_after: Some(1),
        });
    }
    let err = client
        .list_page::<BanListAttrs>(&client.ban_lists_first_page())
        .await
        .expect_err("persistent 429 surfaces");

    assert!(matches!(err, BmError::RateLimited), "got {err:?}");
    assert_eq!(
        stub.requests().len(),
        5,
        "5 attempts (MAX_GET_ATTEMPTS) then give up"
    );
}

#[tokio::test]
async fn unauthorized_is_immediate() {
    let stub = StubBm::start(StubData::new("tok")).await;
    let client = BmClient::new(stub.base_url(), "tok");

    stub.push_fault(Fault::Status(401));
    let err = client
        .list_page::<BanListAttrs>(&client.ban_lists_first_page())
        .await
        .expect_err("401 is fatal");

    assert!(matches!(err, BmError::Unauthorized), "got {err:?}");
    assert_eq!(stub.requests().len(), 1, "no retry on 401");
}

#[tokio::test]
async fn server_error_then_succeeds() {
    let stub = StubBm::start(StubData::new("tok").with_ban_list(StubBanList::new("l", "n"))).await;
    let client = BmClient::new(stub.base_url(), "tok");

    stub.push_fault(Fault::Status(500));
    let doc = client
        .list_page::<BanListAttrs>(&client.ban_lists_first_page())
        .await
        .expect("500 is retried, then succeeds");

    assert_eq!(doc.data.len(), 1);
    assert_eq!(stub.requests().len(), 2);
}

#[tokio::test]
async fn malformed_body_is_fatal_decode() {
    let stub = StubBm::start(StubData::new("tok")).await;
    let client = BmClient::new(stub.base_url(), "tok");

    stub.push_fault(Fault::Malformed);
    let err = client
        .list_page::<BanListAttrs>(&client.ban_lists_first_page())
        .await
        .expect_err("a 200 that will not decode is fatal");

    assert!(matches!(err, BmError::Decode(_)), "got {err:?}");
    assert_eq!(stub.requests().len(), 1, "decode failure is not retried");
}

#[tokio::test]
async fn wrong_token_is_unauthorized() {
    let stub =
        StubBm::start(StubData::new("right-token").with_ban_list(StubBanList::new("l", "n"))).await;
    let client = BmClient::new(stub.base_url(), "wrong-token");

    let err = client
        .list_page::<BanListAttrs>(&client.ban_lists_first_page())
        .await
        .expect_err("stub rejects a bad bearer");

    assert!(matches!(err, BmError::Unauthorized), "got {err:?}");
    let reqs = stub.requests();
    assert_eq!(reqs.len(), 1, "no retry on 401");
    assert!(!reqs[0].bearer_ok, "stub saw the wrong token");
}

#[tokio::test]
async fn bans_include_resolves_numeric_ref() {
    // A numeric ref (7) plus an inline manual entry; the ref resolves via `included`.
    let ban = StubBan::new("l1", "b1", "uid1", "2026-01-01T00:00:00Z", "cheating")
        .identifiers(json!([
            7,
            { "type": "steamID", "identifier": "76561198000000009" }
        ]))
        .included(vec![(
            "7".to_string(),
            "steamID".to_string(),
            "76561198000000007".to_string(),
        )]);
    let stub = StubBm::start(
        StubData::new("tok")
            .with_ban_list(StubBanList::new("l1", "n"))
            .with_bans(vec![ban]),
    )
    .await;
    let client = BmClient::new(stub.base_url(), "tok");

    let doc = client
        .list_page::<BanAttrs>(&client.bans_first_page("l1"))
        .await
        .expect("bans page decodes");

    assert_eq!(doc.data.len(), 1);
    let attrs = &doc.data[0].attributes;
    assert!(matches!(attrs.identifiers[0], BanIdentifier::Ref(7)));
    assert!(matches!(attrs.identifiers[1], BanIdentifier::Manual(_)));

    let map = cupboard_bmapi::types::included_identifier_map(&doc.included);
    assert_eq!(
        map.get("7"),
        Some(&("steamID".to_string(), "76561198000000007".to_string())),
        "numeric ref resolves to the included identifier",
    );
}

fn steam_identifier(value: &str) -> Vec<(String, String)> {
    vec![("steamID".to_string(), value.to_string())]
}

#[tokio::test]
async fn create_ban_happy_path() {
    let stub =
        StubBm::start(StubData::new("tok").with_ban_list(StubBanList::new("list-1", "Main"))).await;
    let client = BmClient::new(stub.base_url(), "tok");

    let identifiers = steam_identifier("76561198000000001");
    let new_ban = NewBmBan {
        org_id: "42",
        ban_list_id: "list-1",
        reason: Some("cheating"),
        note: None,
        expires: None,
        identifiers: &identifiers,
        org_wide: true,
    };

    let created = client.create_ban(&new_ban).await.expect("ban is created");
    assert!(created.id.starts_with("srv-ban-"), "got id {}", created.id);
    assert_eq!(created.rel_id("banList"), Some("list-1"));
    assert_eq!(created.attributes.reason.as_deref(), Some("cheating"));
    assert_eq!(created.attributes.org_wide, Some(true));

    let reqs = stub.requests();
    assert_eq!(reqs.len(), 1);
    let body = reqs[0].body.as_ref().expect("POST body is recorded");
    assert_eq!(
        body["data"]["relationships"]["banList"]["data"]["id"],
        "list-1"
    );
    assert_eq!(
        body["data"]["attributes"]["identifiers"][0]["type"],
        "steamID"
    );
    assert_eq!(body["data"]["attributes"]["identifiers"][0]["manual"], true);
    assert_eq!(body["data"]["attributes"]["orgWide"], true);

    let page = client
        .list_page::<BanAttrs>(&client.bans_first_page("list-1"))
        .await
        .expect("list decodes");
    assert!(
        page.data.iter().any(|r| r.id == created.id),
        "the new ban shows up on a subsequent list"
    );
}

#[tokio::test]
async fn delete_ban_removes_existing_and_reports_already_gone_for_missing() {
    let ban = StubBan::new(
        "list-1",
        "ban-1",
        "uid-1",
        "2026-01-01T00:00:00Z",
        "cheating",
    );
    let stub = StubBm::start(
        StubData::new("tok")
            .with_ban_list(StubBanList::new("list-1", "Main"))
            .with_bans(vec![ban]),
    )
    .await;
    let client = BmClient::new(stub.base_url(), "tok");

    let outcome = client.delete_ban("ban-1").await.expect("delete succeeds");
    assert_eq!(outcome, DeleteOutcome::Deleted);

    let page = client
        .list_page::<BanAttrs>(&client.bans_first_page("list-1"))
        .await
        .expect("list decodes");
    assert!(page.data.is_empty(), "deleted ban is gone from the list");

    let outcome = client
        .delete_ban("does-not-exist")
        .await
        .expect("404 converges with our intent");
    assert_eq!(outcome, DeleteOutcome::AlreadyGone);
}

#[tokio::test]
async fn expire_ban_now_updates_stored_expiry() {
    let ban = StubBan::new(
        "list-1",
        "ban-1",
        "uid-1",
        "2026-01-01T00:00:00Z",
        "cheating",
    );
    let stub = StubBm::start(
        StubData::new("tok")
            .with_ban_list(StubBanList::new("list-1", "Main"))
            .with_bans(vec![ban]),
    )
    .await;
    let client = BmClient::new(stub.base_url(), "tok");

    client
        .expire_ban_now("ban-1")
        .await
        .expect("expire succeeds");

    let page = client
        .list_page::<BanAttrs>(&client.bans_first_page("list-1"))
        .await
        .expect("list decodes");
    let updated = page
        .data
        .iter()
        .find(|r| r.id == "ban-1")
        .expect("ban is still present");
    assert!(
        updated.attributes.expires.is_some(),
        "expires is set instead of permanent"
    );
}

#[tokio::test]
async fn create_ban_server_error_is_ambiguous_no_retry() {
    let stub =
        StubBm::start(StubData::new("tok").with_ban_list(StubBanList::new("list-1", "Main"))).await;
    let client = BmClient::new(stub.base_url(), "tok");

    stub.push_fault(Fault::Status(500));
    let identifiers = steam_identifier("1");
    let new_ban = NewBmBan {
        org_id: "42",
        ban_list_id: "list-1",
        reason: Some("cheating"),
        note: None,
        expires: None,
        identifiers: &identifiers,
        org_wide: false,
    };

    let err = client
        .create_ban(&new_ban)
        .await
        .expect_err("a 5xx on a mutation is ambiguous, not retried");
    assert!(matches!(err, BmError::AmbiguousMutation(_)), "got {err:?}");
    assert_eq!(stub.requests().len(), 1, "no retry on a mutation 5xx");
}

#[tokio::test]
async fn create_ban_rate_limited_then_succeeds() {
    let stub =
        StubBm::start(StubData::new("tok").with_ban_list(StubBanList::new("list-1", "Main"))).await;
    let client = BmClient::new(stub.base_url(), "tok");

    stub.push_fault(Fault::RateLimited {
        retry_after: Some(1),
    });
    let identifiers = steam_identifier("1");
    let new_ban = NewBmBan {
        org_id: "42",
        ban_list_id: "list-1",
        reason: Some("cheating"),
        note: None,
        expires: None,
        identifiers: &identifiers,
        org_wide: false,
    };

    let created = client
        .create_ban(&new_ban)
        .await
        .expect("succeeds after honoring Retry-After");
    assert!(created.id.starts_with("srv-ban-"));
    assert_eq!(
        stub.requests().len(),
        2,
        "one throttled attempt, then the retry"
    );
}

#[tokio::test]
async fn servers_paginate_and_decode() {
    // 150 servers -> 2 pages of 100; decode into ServerAttrs, including portQuery.
    let servers: Vec<StubServer> = (0..150)
        .map(|i| {
            StubServer::new(format!("srv-{i}"), format!("Server {i}"))
                .ip(format!("10.0.0.{}", i % 255))
                .port(28015)
                .port_query(28017)
        })
        .collect();
    let stub = StubBm::start(StubData::new("tok").with_servers(servers)).await;
    let client = BmClient::new(stub.base_url(), "tok");

    let mut url = client.servers_first_page("9999");
    let mut ids = Vec::new();
    let mut pages = 0;
    loop {
        let doc = client
            .list_page::<ServerAttrs>(&url)
            .await
            .expect("servers page decodes");
        pages += 1;
        for r in &doc.data {
            ids.push(r.id.clone());
            assert!(r.attributes.name.is_some());
            assert_eq!(r.attributes.port_query, Some(28017), "portQuery decodes");
        }
        match doc.links.next {
            Some(next) => url = next,
            None => break,
        }
    }
    assert_eq!(pages, 2, "150 / page[size]=100 -> 2 pages");
    assert_eq!(ids.len(), 150);
    assert_eq!(ids.iter().collect::<HashSet<_>>().len(), 150);
}

#[tokio::test]
async fn players_paginate_decode_and_resolve_identifiers() {
    // 120 players -> 2 pages; each carries a steam + ip identifier via `included`.
    let players: Vec<StubPlayer> = (0..120)
        .map(|i| {
            StubPlayer::new(format!("p-{i}"), format!("Player {i}"))
                .created_at("2026-01-02T03:04:05Z")
                .identifier("steamID", format!("7656119800{i:06}"))
                .identifier("ip", format!("203.0.113.{}", i % 255))
        })
        .collect();
    let stub = StubBm::start(StubData::new("tok").with_players(players)).await;
    let client = BmClient::new(stub.base_url(), "tok");

    let mut url = client.players_first_page("9999");
    let mut total = 0;
    let mut pages = 0;
    loop {
        let doc = client
            .list_page::<PlayerAttrs>(&url)
            .await
            .expect("players page decodes");
        pages += 1;
        let ids_map = included_identifier_map(&doc.included);
        for r in &doc.data {
            total += 1;
            assert!(r.attributes.created_at.is_some(), "createdAt decodes");
            let resolved: Vec<(String, String)> = r
                .rel_ids("identifiers")
                .into_iter()
                .filter_map(|id| ids_map.get(id).cloned())
                .collect();
            assert!(
                resolved.iter().any(|(k, _)| k == "steamID"),
                "steam identifier resolves through included: {resolved:?}"
            );
            assert!(resolved.iter().any(|(k, _)| k == "ip"));
        }
        match doc.links.next {
            Some(next) => url = next,
            None => break,
        }
    }
    assert_eq!(pages, 2, "120 / page[size]=100 -> 2 pages");
    assert_eq!(total, 120);
}

#[tokio::test]
async fn player_notes_paginate_and_decode() {
    // 150 notes on one player -> 2 pages; decode into NoteAttrs.
    let notes: Vec<StubNote> = (0..150)
        .map(|i| {
            StubNote::new(
                format!("n-{i}"),
                format!("note {i}"),
                "2026-01-01T00:00:00Z",
            )
        })
        .collect();
    let stub = StubBm::start(StubData::new("tok").with_notes("p-1", notes)).await;
    let client = BmClient::new(stub.base_url(), "tok");

    let mut url = client.player_notes_first_page("p-1");
    let mut bodies = Vec::new();
    let mut pages = 0;
    loop {
        let doc = client
            .list_page::<NoteAttrs>(&url)
            .await
            .expect("notes page decodes");
        pages += 1;
        for r in &doc.data {
            bodies.push(r.attributes.note.clone().expect("note body decodes"));
            assert!(r.attributes.created_at.is_some(), "createdAt decodes");
        }
        match doc.links.next {
            Some(next) => url = next,
            None => break,
        }
    }
    assert_eq!(pages, 2, "150 / page[size]=100 -> 2 pages");
    assert_eq!(bodies.len(), 150);

    // A player with no notes returns an empty page, not an error.
    let doc = client
        .list_page::<NoteAttrs>(&client.player_notes_first_page("nobody"))
        .await
        .expect("empty notes page decodes");
    assert!(doc.data.is_empty());
    assert!(doc.links.next.is_none());
}

#[tokio::test]
async fn delete_ban_forbidden_is_the_delete_missing_signal() {
    let stub =
        StubBm::start(StubData::new("tok").with_ban_list(StubBanList::new("list-1", "Main"))).await;
    let client = BmClient::new(stub.base_url(), "tok");

    stub.push_fault(Fault::Status(403));
    let err = client
        .delete_ban("ban-1")
        .await
        .expect_err("403 is terminal, not treated as already-gone");
    assert!(matches!(err, BmError::Forbidden(_)), "got {err:?}");
}
