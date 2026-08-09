//! Real Lab Board V2 ACL round-trip against an isolated relay.
//!
//! Run with the relay and its isolated Postgres/Redis services available:
//!
//! ```text
//! cargo test -p buzz-test-client --test e2e_lab_acl -- --ignored --nocapture
//! ```

use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use buzz_core::kind::{KIND_LAB_BOARD_HEAD, KIND_LAB_BOARD_REVISION};
use buzz_test_client::{BuzzTestClient, RelayMessage, TestClientError};
use nostr::{Alphabet, Event, EventBuilder, Filter, JsonUtil, Keys, Kind, SingleLetterTag, Tag};
use reqwest::StatusCode;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

fn relay_url() -> String {
    std::env::var("RELAY_URL").unwrap_or_else(|_| "ws://localhost:3000".to_string())
}

fn relay_http_url() -> String {
    relay_url()
        .replace("wss://", "https://")
        .replace("ws://", "http://")
        .trim_end_matches('/')
        .to_string()
}

async fn database_pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://buzz:buzz_dev@localhost:5432/buzz".to_string());
    PgPool::connect(&url)
        .await
        .expect("connect to isolated Postgres")
}

async fn seed_users(pool: &PgPool, keys: [&Keys; 4]) -> Uuid {
    let host = relay_http_url()
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .to_string();
    let community_id: Uuid =
        sqlx::query_scalar("SELECT id FROM communities WHERE lower(host) = lower($1)")
            .bind(&host)
            .fetch_one(pool)
            .await
            .expect("lookup isolated test community");

    for keys in keys {
        sqlx::query(
            "INSERT INTO users (community_id, pubkey) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        )
        .bind(community_id)
        .bind(keys.public_key().to_bytes().as_slice())
        .execute(pool)
        .await
        .expect("seed test user");
    }

    sqlx::query(
        "UPDATE users SET agent_owner_pubkey = $1
         WHERE community_id = $2 AND pubkey = $3 AND agent_owner_pubkey IS NULL",
    )
    .bind(keys[0].public_key().to_bytes().as_slice())
    .bind(community_id)
    .bind(keys[1].public_key().to_bytes().as_slice())
    .execute(pool)
    .await
    .expect("bind agent A to human A");

    sqlx::query(
        "UPDATE users SET agent_owner_pubkey = $1
         WHERE community_id = $2 AND pubkey = $3 AND agent_owner_pubkey IS NULL",
    )
    .bind(keys[2].public_key().to_bytes().as_slice())
    .bind(community_id)
    .bind(keys[3].public_key().to_bytes().as_slice())
    .execute(pool)
    .await
    .expect("bind agent B to human B");

    community_id
}

fn tag_value<'a>(event: &'a Event, name: &str) -> Option<&'a str> {
    event.tags.iter().find_map(|tag| {
        let parts = tag.as_slice();
        (parts.first().map(String::as_str) == Some(name))
            .then(|| parts.get(1).map(String::as_str))
            .flatten()
    })
}

fn topic_tag_values(event: &Event) -> Vec<String> {
    event
        .tags
        .iter()
        .filter_map(|tag| {
            let parts = tag.as_slice();
            (parts.first().map(String::as_str) == Some("t"))
                .then(|| parts.get(1).cloned())
                .flatten()
        })
        .collect()
}

async fn db_head_snapshot(
    pool: &PgPool,
    community_id: Uuid,
    board_id: Uuid,
) -> (Vec<u8>, Vec<String>) {
    sqlx::query_as(
        "SELECT head_projection_event_id, tags
         FROM lab_board_heads
         WHERE community_id = $1 AND board_id = $2",
    )
    .bind(community_id)
    .bind(board_id)
    .fetch_one(pool)
    .await
    .expect("load Lab Board head snapshot")
}

fn board_filter(board_id: Uuid) -> Filter {
    Filter::new()
        .kinds([
            Kind::Custom(KIND_LAB_BOARD_REVISION as u16),
            Kind::Custom(KIND_LAB_BOARD_HEAD as u16),
        ])
        .custom_tags(
            SingleLetterTag::lowercase(Alphabet::D),
            [board_id.to_string()],
        )
}

async fn ws_query(client: &mut BuzzTestClient, name: &str, filter: Filter) -> Vec<Event> {
    let sub_id = format!("lab-v2-{name}-{}", Uuid::new_v4());
    client
        .subscribe(&sub_id, vec![filter])
        .await
        .expect("subscribe to Lab Board query");
    let events = client
        .collect_until_eose(&sub_id, Duration::from_secs(10))
        .await
        .expect("collect Lab Board query");
    client
        .close_subscription(&sub_id)
        .await
        .expect("close Lab Board query subscription");
    events
}

fn signed_board_event(
    keys: &Keys,
    board_id: Uuid,
    operation: &str,
    content: &str,
    extra_tags: impl IntoIterator<Item = Tag>,
) -> Event {
    let board = board_id.to_string();
    let mut tags = vec![
        Tag::parse(["d", board.as_str()]).expect("d tag"),
        Tag::parse(["op", operation]).expect("op tag"),
    ];
    tags.extend(extra_tags);
    EventBuilder::new(Kind::Custom(KIND_LAB_BOARD_REVISION as u16), content)
        .tags(tags)
        .sign_with_keys(keys)
        .expect("sign Lab Board event")
}

fn nip98_header(keys: &Keys, url: &str, body: &[u8]) -> String {
    let payload = hex::encode(Sha256::digest(body));
    let nonce = Uuid::new_v4().to_string();
    let event = EventBuilder::new(Kind::Custom(27_235), "")
        .tags([
            Tag::parse(["u", url]).expect("NIP-98 url tag"),
            Tag::parse(["method", "POST"]).expect("NIP-98 method tag"),
            Tag::parse(["payload", payload.as_str()]).expect("NIP-98 payload tag"),
            Tag::parse(["nonce", nonce.as_str()]).expect("NIP-98 nonce tag"),
        ])
        .sign_with_keys(keys)
        .expect("sign NIP-98 event");
    format!("Nostr {}", BASE64.encode(event.as_json().as_bytes()))
}

async fn http_json(keys: &Keys, path: &str, filter: &Filter) -> (StatusCode, Value) {
    let body = serde_json::to_vec(&vec![filter]).expect("serialize HTTP filter");
    let url = format!("{}{path}", relay_http_url());
    let response = reqwest::Client::new()
        .post(&url)
        .header("Authorization", nip98_header(keys, &url, &body))
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .expect("send HTTP Lab Board query");
    let status = response.status();
    let json = response
        .json()
        .await
        .expect("decode HTTP Lab Board response");
    (status, json)
}

async fn http_query(keys: &Keys, filter: &Filter) -> Vec<Value> {
    let (status, json) = http_json(keys, "/query", filter).await;
    assert_eq!(status, StatusCode::OK, "HTTP /query failed: {json}");
    json.as_array().cloned().expect("HTTP /query array")
}

async fn http_count(keys: &Keys, filter: &Filter) -> u64 {
    let (status, json) = http_json(keys, "/count", filter).await;
    assert_eq!(status, StatusCode::OK, "HTTP /count failed: {json}");
    json["count"].as_u64().expect("HTTP /count integer")
}

#[tokio::test]
#[ignore = "requires an isolated Postgres/Redis-backed relay"]
async fn lab_v2_acl_queries_counts_subscriptions_and_managed_agents() {
    assert_eq!(
        std::env::var("BUZZ_ALLOW_NIP_OA_AUTH").as_deref(),
        Ok("true"),
        "the real V2 ACL proof requires NIP-OA owner mappings to be enabled"
    );

    let owner_a = Keys::generate();
    let agent_a = Keys::generate();
    let owner_b = Keys::generate();
    let agent_b = Keys::generate();
    let pool = database_pool().await;
    let _community_id = seed_users(&pool, [&owner_a, &agent_a, &owner_b, &agent_b]).await;

    let url = relay_url();
    let mut ws_a = BuzzTestClient::connect(&url, &owner_a)
        .await
        .expect("connect human A");
    let mut ws_agent_a = BuzzTestClient::connect(&url, &agent_a)
        .await
        .expect("connect managed agent A");
    let mut ws_b = BuzzTestClient::connect(&url, &owner_b)
        .await
        .expect("connect human B");
    let mut ws_agent_b = BuzzTestClient::connect(&url, &agent_b)
        .await
        .expect("connect managed agent B");

    let private_board = Uuid::new_v4();
    let create_private = signed_board_event(
        &owner_a,
        private_board,
        "create_v2",
        "private v1",
        [
            Tag::parse(["title", "Private A"]).expect("title tag"),
            Tag::parse(["revision", "1"]).expect("revision tag"),
            Tag::parse(["access_scope", "private"]).expect("scope tag"),
            Tag::parse(["tags", "replace"]).expect("tags marker"),
            Tag::parse(["t", "private-a"]).expect("topic tag"),
        ],
    );
    let create_private_id = create_private.id;
    let accepted = ws_a
        .send_event(create_private)
        .await
        .expect("send private create");
    assert!(
        accepted.accepted,
        "private create rejected: {}",
        accepted.message
    );

    let private_events = ws_query(&mut ws_a, "private-owner", board_filter(private_board)).await;
    assert_eq!(private_events.len(), 2, "owner sees revision and head");
    let private_head = private_events
        .iter()
        .find(|event| event.kind == Kind::Custom(KIND_LAB_BOARD_HEAD as u16))
        .expect("private head projection");
    assert_eq!(tag_value(private_head, "access_scope"), Some("private"));
    assert_eq!(
        tag_value(private_head, "owner"),
        Some(owner_a.public_key().to_hex().as_str())
    );
    assert_eq!(
        tag_value(private_head, "head"),
        Some(create_private_id.to_hex().as_str())
    );
    let private_revision = private_head
        .tags
        .iter()
        .find(|tag| tag.as_slice().first().map(String::as_str) == Some("revision"))
        .expect("private head revision")
        .as_slice()
        .get(1)
        .expect("private head revision value")
        .parse::<i32>()
        .expect("private head revision integer");
    assert_eq!(private_revision, 1);

    assert!(
        ws_query(&mut ws_b, "private-foreign", board_filter(private_board))
            .await
            .is_empty(),
        "human B must not discover private board events"
    );
    assert!(
        ws_query(
            &mut ws_agent_b,
            "private-agent-foreign",
            board_filter(private_board)
        )
        .await
        .is_empty(),
        "agent B must not discover private board events"
    );
    assert_eq!(
        http_query(&owner_b, &board_filter(private_board))
            .await
            .len(),
        0
    );
    assert_eq!(http_count(&owner_b, &board_filter(private_board)).await, 0);
    assert_eq!(
        http_query(&owner_a, &board_filter(private_board))
            .await
            .len(),
        2
    );
    assert_eq!(http_count(&owner_a, &board_filter(private_board)).await, 2);

    let live_a = format!("lab-private-owner-{}", Uuid::new_v4());
    let live_b = format!("lab-private-foreign-{}", Uuid::new_v4());
    ws_a.subscribe(&live_a, vec![board_filter(private_board)])
        .await
        .expect("subscribe owner A fan-out");
    assert_eq!(
        ws_a.collect_until_eose(&live_a, Duration::from_secs(10))
            .await
            .expect("drain owner A EOSE")
            .len(),
        2
    );
    ws_b.subscribe(&live_b, vec![board_filter(private_board)])
        .await
        .expect("subscribe human B fan-out");
    assert!(ws_b
        .collect_until_eose(&live_b, Duration::from_secs(10))
        .await
        .expect("drain human B EOSE")
        .is_empty());

    let prev = tag_value(private_head, "head")
        .expect("private head CAS token")
        .to_string();
    let update_private = signed_board_event(
        &agent_a,
        private_board,
        "update_v2",
        "private v2",
        [
            Tag::parse(["prev", prev.as_str()]).expect("private prev tag"),
            Tag::parse(["revision", "2"]).expect("private revision tag"),
            Tag::parse(["tags", "replace"]).expect("private tags marker"),
            Tag::parse(["t", "private-v2"]).expect("private replacement tag"),
        ],
    );
    let accepted = ws_agent_a
        .send_event(update_private)
        .await
        .expect("send managed-agent private update");
    assert!(
        accepted.accepted,
        "managed-agent private update rejected: {}",
        accepted.message
    );

    let mut owner_live = Vec::new();
    while owner_live.len() < 2 {
        match ws_a.recv_event(Duration::from_secs(10)).await {
            Ok(RelayMessage::Event {
                subscription_id,
                event,
            }) if subscription_id == live_a => owner_live.push(event),
            Ok(RelayMessage::Eose { .. }) => {}
            Ok(other) => panic!("unexpected owner fan-out message: {other:?}"),
            Err(error) => panic!("owner A did not receive private fan-out: {error}"),
        }
    }
    assert!(owner_live
        .iter()
        .any(|event| event.kind == Kind::Custom(KIND_LAB_BOARD_HEAD as u16)));
    assert!(owner_live
        .iter()
        .any(|event| event.kind == Kind::Custom(KIND_LAB_BOARD_REVISION as u16)));
    match ws_b.recv_event(Duration::from_secs(2)).await {
        Err(TestClientError::Timeout) => {}
        Ok(message) => panic!("human B received private fan-out: {message:?}"),
        Err(error) => panic!("foreign subscription failed instead of staying silent: {error}"),
    }

    let foreign_write = signed_board_event(
        &owner_b,
        private_board,
        "update_v2",
        "forged private update",
        [
            Tag::parse(["prev", prev.as_str()]).expect("foreign prev tag"),
            Tag::parse(["revision", "2"]).expect("foreign revision tag"),
            Tag::parse(["tags", "replace"]).expect("foreign tags marker"),
        ],
    );
    let rejected = ws_b
        .send_event(foreign_write)
        .await
        .expect("receive foreign private write result");
    assert!(!rejected.accepted);
    assert_eq!(rejected.message, "invalid: lab board not found");

    let readonly_board = Uuid::new_v4();
    let create_readonly = signed_board_event(
        &owner_a,
        readonly_board,
        "create_v2",
        "readonly v1",
        [
            Tag::parse(["title", "Read Only A"]).expect("readonly title tag"),
            Tag::parse(["revision", "1"]).expect("readonly revision tag"),
            Tag::parse(["access_scope", "community_readonly"]).expect("readonly scope tag"),
            Tag::parse(["tags", "replace"]).expect("readonly tags marker"),
        ],
    );
    let accepted = ws_a
        .send_event(create_readonly)
        .await
        .expect("send readonly create");
    assert!(
        accepted.accepted,
        "readonly create rejected: {}",
        accepted.message
    );
    assert_eq!(
        ws_query(&mut ws_b, "readonly-reader", board_filter(readonly_board))
            .await
            .len(),
        2
    );

    let readonly_head = ws_query(&mut ws_a, "readonly-owner", board_filter(readonly_board)).await;
    let readonly_token = readonly_head
        .iter()
        .find(|event| event.kind == Kind::Custom(KIND_LAB_BOARD_HEAD as u16))
        .and_then(|event| tag_value(event, "head"))
        .expect("readonly head token")
        .to_owned();
    let readonly_write = signed_board_event(
        &owner_b,
        readonly_board,
        "update_v2",
        "forbidden readonly update",
        [
            Tag::parse(["prev", readonly_token.as_str()]).expect("readonly prev tag"),
            Tag::parse(["revision", "2"]).expect("readonly revision tag"),
            Tag::parse(["tags", "replace"]).expect("readonly tags marker"),
        ],
    );
    let rejected = ws_b
        .send_event(readonly_write)
        .await
        .expect("receive readonly write result");
    assert!(!rejected.accepted);
    assert_eq!(rejected.message, "invalid: lab board not found");

    for client in [ws_a, ws_agent_a, ws_b, ws_agent_b] {
        client.disconnect().await.expect("disconnect E2E client");
    }
}

#[tokio::test]
#[ignore = "requires an isolated Postgres/Redis-backed relay"]
async fn lab_v2_tag_replacement_survives_legacy_update_in_db_and_projection() {
    assert_eq!(
        std::env::var("BUZZ_ALLOW_NIP_OA_AUTH").as_deref(),
        Ok("true"),
        "the real V2 tag proof requires NIP-OA owner mappings to be enabled"
    );

    let owner = Keys::generate();
    let agent = Keys::generate();
    let other_owner = Keys::generate();
    let other_agent = Keys::generate();
    let pool = database_pool().await;
    let community_id = seed_users(&pool, [&owner, &agent, &other_owner, &other_agent]).await;
    let mut client = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("connect Lab tag regression client");
    let mut agent_client = BuzzTestClient::connect(&relay_url(), &agent)
        .await
        .expect("connect Lab tag regression managed agent");

    let board_id = Uuid::new_v4();
    let create = signed_board_event(
        &owner,
        board_id,
        "create_v2",
        "tag regression v1",
        [
            Tag::parse(["title", "Tag regression"]).expect("title tag"),
            Tag::parse(["revision", "1"]).expect("revision tag"),
            Tag::parse(["access_scope", "private"]).expect("scope tag"),
            Tag::parse(["tags", "replace"]).expect("tags marker"),
            Tag::parse(["t", "initial-tag"]).expect("initial topic tag"),
        ],
    );
    let create_id = create.id;
    let accepted = client
        .send_event(create)
        .await
        .expect("send tag regression create");
    assert!(accepted.accepted, "create rejected: {}", accepted.message);

    let initial_events =
        ws_query(&mut client, "tag-regression-create", board_filter(board_id)).await;
    let initial_head = initial_events
        .iter()
        .find(|event| event.kind == Kind::Custom(KIND_LAB_BOARD_HEAD as u16))
        .expect("initial head projection");
    assert_eq!(
        tag_value(initial_head, "head"),
        Some(create_id.to_hex().as_str())
    );
    assert_eq!(topic_tag_values(initial_head), vec!["initial-tag"]);
    let (initial_projection_id, initial_db_tags) =
        db_head_snapshot(&pool, community_id, board_id).await;
    assert_eq!(initial_projection_id, initial_head.id.as_bytes());
    assert_eq!(initial_db_tags, vec!["initial-tag"]);

    let create_id_hex = create_id.to_hex();
    let update_v2 = signed_board_event(
        &agent,
        board_id,
        "update_v2",
        "tag regression v2",
        [
            Tag::parse(["prev", create_id_hex.as_str()]).expect("update prev tag"),
            Tag::parse(["revision", "2"]).expect("update revision tag"),
            Tag::parse(["tags", "replace"]).expect("replacement marker"),
            Tag::parse(["t", "replacement-tag"]).expect("replacement topic tag"),
        ],
    );
    let update_v2_id = update_v2.id;
    let accepted = agent_client
        .send_event(update_v2)
        .await
        .expect("send V2 tag replacement");
    assert!(
        accepted.accepted,
        "update_v2 rejected: {}",
        accepted.message
    );

    let replaced_events = ws_query(&mut client, "tag-regression-v2", board_filter(board_id)).await;
    let replaced_head = replaced_events
        .iter()
        .find(|event| event.kind == Kind::Custom(KIND_LAB_BOARD_HEAD as u16))
        .expect("replacement head projection");
    assert_eq!(
        tag_value(replaced_head, "head"),
        Some(update_v2_id.to_hex().as_str())
    );
    assert_eq!(topic_tag_values(replaced_head), vec!["replacement-tag"]);
    let (replaced_projection_id, replaced_db_tags) =
        db_head_snapshot(&pool, community_id, board_id).await;
    assert_eq!(replaced_projection_id, replaced_head.id.as_bytes());
    assert_eq!(replaced_db_tags, vec!["replacement-tag"]);

    let update_v2_id_hex = update_v2_id.to_hex();
    let legacy_update = signed_board_event(
        &agent,
        board_id,
        "update",
        "tag regression v3",
        [
            Tag::parse(["prev", update_v2_id_hex.as_str()]).expect("legacy prev tag"),
            Tag::parse(["revision", "3"]).expect("legacy revision tag"),
        ],
    );
    let legacy_update_id = legacy_update.id;
    let accepted = agent_client
        .send_event(legacy_update)
        .await
        .expect("send legacy tag-preserving update");
    assert!(
        accepted.accepted,
        "legacy update rejected: {}",
        accepted.message
    );

    let legacy_events =
        ws_query(&mut client, "tag-regression-legacy", board_filter(board_id)).await;
    let legacy_head = legacy_events
        .iter()
        .find(|event| event.kind == Kind::Custom(KIND_LAB_BOARD_HEAD as u16))
        .expect("legacy update head projection");
    assert_eq!(
        tag_value(legacy_head, "head"),
        Some(legacy_update_id.to_hex().as_str())
    );
    assert_eq!(topic_tag_values(legacy_head), vec!["replacement-tag"]);
    let (legacy_projection_id, legacy_db_tags) =
        db_head_snapshot(&pool, community_id, board_id).await;
    assert_eq!(legacy_projection_id, legacy_head.id.as_bytes());
    assert_eq!(legacy_db_tags, vec!["replacement-tag"]);

    client
        .disconnect()
        .await
        .expect("disconnect tag regression client");
    agent_client
        .disconnect()
        .await
        .expect("disconnect tag regression agent");
}
