//! Publish → consumer-group read → ack round-trip against a real Redis.
//!
//! Requires `TEST_REDIS_URL` (e.g. `redis://localhost:6380`). Skips (passes) when unset,
//! so `cargo test` stays green without a broker; CI/local set it to run for real.

use cupboard_bus::Bus;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, PartialEq)]
struct Ping {
    n: u32,
    who: String,
}

#[tokio::test]
async fn publish_read_ack_round_trip() {
    let Ok(url) = std::env::var("TEST_REDIS_URL") else {
        eprintln!("SKIP publish_read_ack_round_trip: TEST_REDIS_URL unset");
        return;
    };

    // Unique stream + group per run so concurrent/repeat runs don't interfere.
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let stream = format!("test:bus:{suffix}");
    let group = "g1";

    let mut producer = Bus::connect(&url).await.expect("connect producer");
    let mut consumer = Bus::connect(&url).await.expect("connect consumer");

    // Group must exist before publishing, since it reads only new (`>`) entries.
    consumer
        .ensure_group(&stream, group)
        .await
        .expect("ensure group");
    // Idempotent: creating it again is not an error.
    consumer
        .ensure_group(&stream, group)
        .await
        .expect("ensure group twice");

    let sent = Ping {
        n: 7,
        who: "collector".into(),
    };
    producer.publish(&stream, &sent).await.expect("publish");

    let batch = consumer
        .read::<Ping>(&stream, group, "c1", 10, 2000)
        .await
        .expect("read");
    assert_eq!(batch.ok.len(), 1, "should read the one published entry");
    assert!(batch.failed_ids.is_empty(), "nothing malformed");
    assert_eq!(batch.ok[0].payload, sent);

    let ids: Vec<String> = batch.ok.iter().map(|d| d.id.clone()).collect();
    consumer.ack(&stream, group, &ids).await.expect("ack");

    // After ack + consuming all `>` entries, a second read blocks briefly then returns
    // empty (nothing new, nothing pending).
    let again = consumer
        .read::<Ping>(&stream, group, "c1", 10, 300)
        .await
        .expect("read again");
    assert!(again.ok.is_empty(), "no more entries after ack");
}

#[tokio::test]
async fn one_poison_entry_does_not_fail_the_batch() {
    let Ok(url) = std::env::var("TEST_REDIS_URL") else {
        eprintln!("SKIP one_poison_entry_does_not_fail_the_batch: TEST_REDIS_URL unset");
        return;
    };
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let stream = format!("test:poison:{suffix}");
    let group = "g1";

    let mut bus = Bus::connect(&url).await.expect("connect");
    bus.ensure_group(&stream, group).await.expect("group");

    // A well-formed JSON that is NOT a Ping (missing fields) — unparseable as T.
    bus.publish(&stream, &serde_json::json!({"not": "a ping"}))
        .await
        .expect("publish poison");
    let good = Ping {
        n: 1,
        who: "ok".into(),
    };
    bus.publish(&stream, &good).await.expect("publish good");

    let batch = bus
        .read::<Ping>(&stream, group, "c1", 10, 2000)
        .await
        .expect("read");
    assert_eq!(batch.ok.len(), 1, "the good entry still comes through");
    assert_eq!(batch.ok[0].payload, good);
    assert_eq!(
        batch.failed_ids.len(),
        1,
        "the poison entry is reported, not fatal"
    );
}
