//! Runtime-focused tests retained from the pre-split module.

//! Pin the load-bearing contract for `Db::communities_of_channels`:
//! a channel id that does NOT exist MUST be absent from the result
//! map, never mapped to a default. The relay-side read-row emitter
//! relies on this — a missing entry triggers `MissingLookup →
//! ImplBug{row_community_lookup_missing} → CoverageBreach`. If this
//! helper ever started returning a default/zero entry for unknown
//! channels, that fail-closed chain would go blind.
use super::*;
use crate::{relay_members, thread, CreateCommunityWithOwnerResult};
use buzz_core::CommunityId;
use sqlx::postgres::PgPoolOptions;
use sqlx::{Acquire, PgPool};
use uuid::Uuid;

const TEST_DB_URL: &str = "postgres://buzz:buzz_dev@localhost:5432/buzz";

async fn setup_db() -> Db {
    let database_url = std::env::var("TEST_DATABASE_URL").unwrap_or_else(|_| TEST_DB_URL.into());
    let pool = PgPool::connect(&database_url)
        .await
        .expect("connect to test DB");
    Db::from_pool(pool)
}

async fn make_community(pool: &PgPool) -> Uuid {
    let id = Uuid::new_v4();
    let host = format!("communities-of-channels-{}.example", id.simple());
    sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
        .bind(id)
        .bind(host)
        .execute(pool)
        .await
        .expect("insert community");
    id
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn addressable_replacement_rolls_back_when_mention_indexing_fails() {
    use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};

    let admin = PgPool::connect(&admin_url().await)
        .await
        .expect("connect admin");
    let (pool, scratch_name) = create_scratch_db(&admin, "atomic_addressable").await;
    let db = Db::from_pool(pool.clone());
    let community_uuid = Uuid::new_v4();
    let channel = Uuid::new_v4();
    let keys = Keys::generate();
    seed_community_channel(&pool, community_uuid, channel, &keys).await;
    let community = CommunityId::from_uuid(community_uuid);
    let member = Keys::generate().public_key().to_hex();
    let tags = || {
        vec![
            Tag::parse(["d", channel.to_string().as_str()]).expect("d tag"),
            Tag::parse(["p", member.as_str(), "", "member"]).expect("p tag"),
        ]
    };
    let base = Timestamp::now().as_secs();
    let old = EventBuilder::new(Kind::Custom(39002), "old")
        .tags(tags())
        .custom_created_at(Timestamp::from(base))
        .sign_with_keys(&keys)
        .expect("sign old");
    db.replace_addressable_event(community, &old, Some(channel))
        .await
        .expect("insert old roster");

    sqlx::query(
        "CREATE FUNCTION reject_test_mention() RETURNS trigger AS $$ \
             BEGIN RAISE EXCEPTION 'injected mention failure'; END; \
             $$ LANGUAGE plpgsql",
    )
    .execute(&pool)
    .await
    .expect("create failure function");
    sqlx::query(
        "CREATE TRIGGER reject_test_mention BEFORE INSERT ON event_mentions \
             FOR EACH ROW EXECUTE FUNCTION reject_test_mention()",
    )
    .execute(&pool)
    .await
    .expect("install failure injection");

    let new = EventBuilder::new(Kind::Custom(39002), "new")
        .tags(tags())
        .custom_created_at(Timestamp::from(base + 1))
        .sign_with_keys(&keys)
        .expect("sign new");
    let error = db
        .replace_addressable_event(community, &new, Some(channel))
        .await
        .expect_err("mention failure must fail replacement");
    assert!(error.to_string().contains("injected mention failure"));

    let live_id: Vec<u8> = sqlx::query_scalar(
        "SELECT id FROM events WHERE community_id=$1 AND channel_id=$2 \
             AND kind=39002 AND deleted_at IS NULL",
    )
    .bind(community.as_uuid())
    .bind(channel)
    .fetch_one(&pool)
    .await
    .expect("query live roster");
    assert_eq!(live_id, old.id.as_bytes(), "old roster must remain live");
    let new_rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM events WHERE community_id=$1 AND id=$2")
            .bind(community.as_uuid())
            .bind(new.id.as_bytes().as_slice())
            .fetch_one(&pool)
            .await
            .expect("count rolled-back event");
    assert_eq!(new_rows, 0, "new roster must roll back with its index");

    drop_scratch_db(&admin, pool, &scratch_name).await;
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn nip_rs_replacement_hard_deletes_payload_and_watermark_rejects_replay() {
    use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};

    let db = setup_db().await;
    let community = CommunityId::from_uuid(make_community(&db.pool).await);
    let keys = Keys::generate();
    let d_tag = format!("read-state:{}", "a".repeat(32));
    let tags = vec![
        Tag::parse(["d", d_tag.as_str()]).expect("d tag"),
        Tag::parse(["t", "read-state"]).expect("t tag"),
    ];
    let base = Timestamp::now().as_secs();
    let old = EventBuilder::new(Kind::Custom(buzz_core::kind::KIND_READ_STATE as u16), "old")
        .tags(tags.clone())
        .custom_created_at(Timestamp::from(base))
        .sign_with_keys(&keys)
        .expect("sign old");
    let new = EventBuilder::new(Kind::Custom(buzz_core::kind::KIND_READ_STATE as u16), "new")
        .tags(tags)
        .custom_created_at(Timestamp::from(base + 1))
        .sign_with_keys(&keys)
        .expect("sign new");

    assert!(
        db.replace_parameterized_event(community, &old, &d_tag, None)
            .await
            .expect("insert old")
            .1
    );
    assert!(
        db.replace_parameterized_event(community, &new, &d_tag, None)
            .await
            .expect("replace with new")
            .1
    );

    let rows: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM events WHERE community_id=$1 AND kind=30078 AND pubkey=$2 AND d_tag=$3",
        )
        .bind(community.as_uuid())
        .bind(keys.public_key().to_bytes())
        .bind(&d_tag)
        .fetch_one(&db.pool)
        .await
        .expect("count NIP-RS rows");
    assert_eq!(rows, 1, "superseded payload must be physically deleted");

    sqlx::query(
            "UPDATE events SET deleted_at=NOW() WHERE community_id=$1 AND kind=30078 AND pubkey=$2 AND d_tag=$3",
        )
        .bind(community.as_uuid())
        .bind(keys.public_key().to_bytes())
        .bind(&d_tag)
        .execute(&db.pool)
        .await
        .expect("simulate NIP-09 coordinate deletion");

    assert!(
        !db.replace_parameterized_event(community, &old, &d_tag, None)
            .await
            .expect("replay old")
            .1
    );
    let live: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM events WHERE community_id=$1 AND kind=30078 AND pubkey=$2 AND d_tag=$3 AND deleted_at IS NULL",
        )
        .bind(community.as_uuid())
        .bind(keys.public_key().to_bytes())
        .bind(&d_tag)
        .fetch_one(&db.pool)
        .await
        .expect("count live NIP-RS rows");
    assert_eq!(live, 0, "watermark must block stale resurrection");
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn mesh_status_replacement_keeps_one_physical_row() {
    use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};

    let db = setup_db().await;
    let community = CommunityId::from_uuid(make_community(&db.pool).await);
    let keys = Keys::generate();
    let d_tag = "buzz-mesh-member-status:owner-test";
    let tags = vec![
        Tag::parse(["d", d_tag]).expect("d tag"),
        Tag::parse(["k", "buzz-mesh-status"]).expect("k tag"),
    ];
    let base = Timestamp::now().as_secs();
    for (offset, content) in [(0, "running"), (1, "running-again"), (2, "stopped")] {
        let event = EventBuilder::new(
            Kind::Custom(buzz_core::kind::KIND_BOOKMARK_SET as u16),
            content,
        )
        .tags(tags.clone())
        .custom_created_at(Timestamp::from(base + offset))
        .sign_with_keys(&keys)
        .expect("sign mesh status");
        assert!(
            db.replace_parameterized_event(community, &event, d_tag, None)
                .await
                .expect("replace mesh status")
                .1
        );
    }

    let (rows, live): (i64, i64) = sqlx::query_as(
        "SELECT count(*), count(*) FILTER (WHERE deleted_at IS NULL) FROM events \
             WHERE community_id=$1 AND kind=30003 AND pubkey=$2 AND d_tag=$3",
    )
    .bind(community.as_uuid())
    .bind(keys.public_key().to_bytes())
    .bind(d_tag)
    .fetch_one(&db.pool)
    .await
    .expect("count mesh status rows");
    assert_eq!((rows, live), (1, 1));

    sqlx::query(
        "UPDATE events SET deleted_at=NOW() \
             WHERE community_id=$1 AND kind=30003 AND pubkey=$2 AND d_tag=$3",
    )
    .bind(community.as_uuid())
    .bind(keys.public_key().to_bytes())
    .bind(d_tag)
    .execute(&db.pool)
    .await
    .expect("simulate old relay soft delete");
    let rows_after_legacy_delete: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM events \
             WHERE community_id=$1 AND kind=30003 AND pubkey=$2 AND d_tag=$3",
    )
    .bind(community.as_uuid())
    .bind(keys.public_key().to_bytes())
    .bind(d_tag)
    .fetch_one(&db.pool)
    .await
    .expect("count rows after old relay soft delete");
    assert_eq!(
        rows_after_legacy_delete, 0,
        "migration trigger must purge soft-deleted mesh status"
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn coordinate_delete_spares_head_newer_than_the_deletion() {
    use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};

    let db = setup_db().await;
    let community = CommunityId::from_uuid(make_community(&db.pool).await);
    let keys = Keys::generate();
    let kind = buzz_core::kind::KIND_PROJECT as i32;
    let d_tag = "stale-tombstone-project";
    let pubkey = keys.public_key().to_bytes().to_vec();
    let base = Timestamp::now().as_secs();

    let version = |content: &str, offset: u64| {
        EventBuilder::new(Kind::Custom(buzz_core::kind::KIND_PROJECT as u16), content)
            .tags(vec![Tag::parse(["d", d_tag]).expect("d tag")])
            .custom_created_at(Timestamp::from(base + offset))
            .sign_with_keys(&keys)
            .expect("sign project version")
    };

    for (content, offset) in [("v1", 0), ("v2", 100)] {
        assert!(
            db.replace_parameterized_event(community, &version(content, offset), d_tag, None)
                .await
                .expect("store project version")
                .1
        );
    }

    // Tombstone timestamped between V1 and V2: it authorizes deleting V1,
    // never the newer head that replaced it.
    let stale_deleted = db
        .soft_delete_by_coordinate(community, kind, &pubkey, d_tag, (base + 50) as i64)
        .await
        .expect("stale coordinate delete");
    assert!(
        !stale_deleted,
        "a tombstone older than the live head must delete nothing"
    );

    let live_content: Option<String> = sqlx::query_scalar(
        "SELECT content FROM events \
             WHERE community_id=$1 AND kind=$2 AND pubkey=$3 AND d_tag=$4 AND deleted_at IS NULL",
    )
    .bind(community.as_uuid())
    .bind(kind)
    .bind(&pubkey)
    .bind(d_tag)
    .fetch_optional(&db.pool)
    .await
    .expect("read live head");
    assert_eq!(
        live_content.as_deref(),
        Some("v2"),
        "the newer head must survive a stale tombstone"
    );

    // A tombstone at or after the head's own timestamp still deletes it.
    let current_deleted = db
        .soft_delete_by_coordinate(community, kind, &pubkey, d_tag, (base + 100) as i64)
        .await
        .expect("current coordinate delete");
    assert!(
        current_deleted,
        "a tombstone at the head's timestamp must delete it (NIP-09 is at-or-before)"
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn duplicate_nip_rs_discriminator_tags_keep_legacy_retention() {
    use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};

    let db = setup_db().await;
    let community = CommunityId::from_uuid(make_community(&db.pool).await);
    let keys = Keys::generate();
    let base = Timestamp::now().as_secs();

    for (case, tags) in [
        (
            "duplicate-d",
            vec![
                Tag::parse(["d", &format!("read-state:{}", "c".repeat(32))]).expect("first d tag"),
                Tag::parse(["d", &format!("read-state:{}", "d".repeat(32))]).expect("second d tag"),
                Tag::parse(["t", "read-state"]).expect("t tag"),
            ],
        ),
        (
            "duplicate-t",
            vec![
                Tag::parse(["d", &format!("read-state:{}", "e".repeat(32))]).expect("d tag"),
                Tag::parse(["t", "read-state"]).expect("first t tag"),
                Tag::parse(["t", "read-state"]).expect("second t tag"),
            ],
        ),
    ] {
        let d_tag = tags
            .iter()
            .find_map(|tag| {
                let parts = tag.as_slice();
                (parts.first().is_some_and(|part| part == "d") && parts.len() >= 2)
                    .then(|| parts[1].clone())
            })
            .expect("first d-tag value");
        let old = EventBuilder::new(
            Kind::Custom(buzz_core::kind::KIND_READ_STATE as u16),
            format!("{case}-old"),
        )
        .tags(tags.clone())
        .custom_created_at(Timestamp::from(base))
        .sign_with_keys(&keys)
        .expect("sign old event");
        let new = EventBuilder::new(
            Kind::Custom(buzz_core::kind::KIND_READ_STATE as u16),
            format!("{case}-new"),
        )
        .tags(tags)
        .custom_created_at(Timestamp::from(base + 1))
        .sign_with_keys(&keys)
        .expect("sign new event");

        assert!(
            db.replace_parameterized_event(community, &old, &d_tag, None)
                .await
                .expect("insert old event")
                .1
        );
        assert!(
            db.replace_parameterized_event(community, &new, &d_tag, None)
                .await
                .expect("replace with new event")
                .1
        );

        let (rows, live): (i64, i64) = sqlx::query_as(
            "SELECT count(*), count(*) FILTER (WHERE deleted_at IS NULL) FROM events \
                 WHERE community_id=$1 AND kind=30078 AND pubkey=$2 AND d_tag=$3",
        )
        .bind(community.as_uuid())
        .bind(keys.public_key().to_bytes())
        .bind(&d_tag)
        .fetch_one(&db.pool)
        .await
        .expect("count retained rows");
        assert_eq!((rows, live), (2, 1), "{case} must retain legacy history");

        let watermarks: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM parameterized_event_watermarks \
                 WHERE community_id=$1 AND kind=30078 AND pubkey=$2 AND d_tag=$3",
        )
        .bind(community.as_uuid())
        .bind(keys.public_key().to_bytes())
        .bind(&d_tag)
        .fetch_one(&db.pool)
        .await
        .expect("count watermarks");
        assert_eq!(watermarks, 0, "{case} must not create a watermark");
    }
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn nip_rs_hard_delete_fence_fails_closed_and_scopes_opt_in_to_transaction() {
    use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};

    let db = setup_db().await;
    let community = CommunityId::from_uuid(make_community(&db.pool).await);
    let keys = Keys::generate();
    let base = Timestamp::now().as_secs();
    let conforming_d = format!("read-state:{}", "6".repeat(32));
    let conforming = EventBuilder::new(
        Kind::Custom(buzz_core::kind::KIND_READ_STATE as u16),
        "fenced-conforming",
    )
    .tags(vec![
        Tag::parse(["d", conforming_d.as_str()]).expect("d tag"),
        Tag::parse(["t", "read-state"]).expect("t tag"),
    ])
    .custom_created_at(Timestamp::from(base))
    .sign_with_keys(&keys)
    .expect("sign conforming event");
    assert!(
        db.replace_parameterized_event(community, &conforming, &conforming_d, None)
            .await
            .expect("insert conforming event")
            .1
    );
    sqlx::query(
        "INSERT INTO event_mentions \
             (community_id, pubkey_hex, event_id, event_created_at, event_kind) \
             VALUES ($1, $2, $3, to_timestamp($4), 30078)",
    )
    .bind(community.as_uuid())
    .bind("6".repeat(64))
    .bind(conforming.id.as_bytes().as_slice())
    .bind(conforming.created_at.as_secs() as f64)
    .execute(&db.pool)
    .await
    .expect("insert mention");

    // Model ce10's first destructive statement. RAISE aborts the transaction,
    // so its later mention delete and incoming insert can never commit.
    let mut old_writer = db.pool.begin().await.expect("begin old-writer tx");
    let rejected = sqlx::query(
        "DELETE FROM events WHERE community_id=$1 AND kind=30078 \
             AND pubkey=$2 AND d_tag=$3 AND deleted_at IS NULL",
    )
    .bind(community.as_uuid())
    .bind(keys.public_key().to_bytes())
    .bind(&conforming_d)
    .execute(&mut *old_writer)
    .await;
    assert!(rejected.is_err(), "old-writer hard delete must be rejected");
    old_writer.rollback().await.expect("rollback rejected tx");
    let preserved: (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM events WHERE community_id=$1 AND id=$2), \
                    (SELECT count(*) FROM event_mentions WHERE community_id=$1 AND event_id=$2)",
    )
    .bind(community.as_uuid())
    .bind(conforming.id.as_bytes().as_slice())
    .fetch_one(&db.pool)
    .await
    .expect("count preserved payload and mention");
    assert_eq!(preserved, (1, 1));

    let nonconforming_d = format!("read-state:{}", "7".repeat(32));
    let nonconforming = EventBuilder::new(
        Kind::Custom(buzz_core::kind::KIND_READ_STATE as u16),
        "fenced-nonconforming",
    )
    .tags(vec![
        Tag::parse(["d", nonconforming_d.as_str()]).expect("first d tag"),
        Tag::parse(["d", "other"]).expect("second d tag"),
        Tag::parse(["t", "read-state"]).expect("t tag"),
    ])
    .custom_created_at(Timestamp::from(base + 1))
    .sign_with_keys(&keys)
    .expect("sign nonconforming event");
    assert!(
        db.replace_parameterized_event(community, &nonconforming, &nonconforming_d, None,)
            .await
            .expect("insert nonconforming event")
            .1
    );
    let rejected_nonconforming = sqlx::query(
        "DELETE FROM events WHERE community_id=$1 AND id=$2 AND created_at=to_timestamp($3)",
    )
    .bind(community.as_uuid())
    .bind(nonconforming.id.as_bytes().as_slice())
    .bind(nonconforming.created_at.as_secs() as f64)
    .execute(&db.pool)
    .await;
    assert!(
        rejected_nonconforming.is_err(),
        "fence must cover a nonconforming OLD row at a regex coordinate"
    );

    let unrelated_d = format!("read-state:{}", "8".repeat(32));
    let unrelated = EventBuilder::new(Kind::Custom(30023), "unrelated")
        .tags(vec![Tag::parse(["d", unrelated_d.as_str()]).expect("d tag")])
        .custom_created_at(Timestamp::from(base + 2))
        .sign_with_keys(&keys)
        .expect("sign unrelated event");
    assert!(
        db.replace_parameterized_event(community, &unrelated, &unrelated_d, None)
            .await
            .expect("insert unrelated event")
            .1
    );
    let unrelated_delete = sqlx::query(
        "DELETE FROM events WHERE community_id=$1 AND id=$2 AND created_at=to_timestamp($3)",
    )
    .bind(community.as_uuid())
    .bind(unrelated.id.as_bytes().as_slice())
    .bind(unrelated.created_at.as_secs() as f64)
    .execute(&db.pool)
    .await
    .expect("delete unrelated event");
    assert_eq!(unrelated_delete.rows_affected(), 1);

    // Check both transaction exits on one physical session; pool selection
    // cannot accidentally hide a leaked session-local authorization value.
    let mut conn = db.pool.acquire().await.expect("acquire dedicated session");
    for commit in [true, false] {
        let mut tx = conn.begin().await.expect("begin GUC transaction");
        let value: String =
            sqlx::query_scalar("SELECT set_config('buzz.nip_rs_hard_delete', 'on', true)")
                .fetch_one(&mut *tx)
                .await
                .expect("set transaction-local GUC");
        assert_eq!(value, "on");
        if commit {
            tx.commit().await.expect("commit GUC transaction");
        } else {
            tx.rollback().await.expect("rollback GUC transaction");
        }
        let leaked: Option<String> = sqlx::query_scalar(
            "SELECT NULLIF(current_setting('buzz.nip_rs_hard_delete', true), '')",
        )
        .fetch_one(&mut *conn)
        .await
        .expect("read GUC after transaction");
        assert_ne!(leaked.as_deref(), Some("on"));
    }
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn database_guard_covers_legacy_writer_and_nip09_deletion() {
    use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};

    let db = setup_db().await;
    let community = CommunityId::from_uuid(make_community(&db.pool).await);
    let keys = Keys::generate();
    let d_tag = format!("read-state:{}", "b".repeat(32));
    let tags = vec![
        Tag::parse(["d", d_tag.as_str()]).expect("d tag"),
        Tag::parse(["t", "read-state"]).expect("t tag"),
    ];
    let base = Timestamp::now().as_secs();
    let a = EventBuilder::new(Kind::Custom(buzz_core::kind::KIND_READ_STATE as u16), "A")
        .tags(tags.clone())
        .custom_created_at(Timestamp::from(base))
        .sign_with_keys(&keys)
        .expect("sign A");
    let x = EventBuilder::new(Kind::Custom(buzz_core::kind::KIND_READ_STATE as u16), "X")
        .tags(tags.clone())
        .custom_created_at(Timestamp::from(base + 1))
        .sign_with_keys(&keys)
        .expect("sign X");
    let b = EventBuilder::new(Kind::Custom(buzz_core::kind::KIND_READ_STATE as u16), "B")
        .tags(tags.clone())
        .custom_created_at(Timestamp::from(base + 2))
        .sign_with_keys(&keys)
        .expect("sign B");
    let c = EventBuilder::new(Kind::Custom(buzz_core::kind::KIND_READ_STATE as u16), "C")
        .tags(tags)
        .custom_created_at(Timestamp::from(base + 3))
        .sign_with_keys(&keys)
        .expect("sign C");

    async fn legacy_insert(
        pool: &PgPool,
        community: CommunityId,
        event: &nostr::Event,
        d_tag: &str,
    ) -> std::result::Result<sqlx::postgres::PgQueryResult, sqlx::Error> {
        sqlx::query(
                "INSERT INTO events (community_id, id, pubkey, created_at, kind, tags, content, sig, received_at, d_tag) \
                 VALUES ($1, $2, $3, to_timestamp($4), $5, $6, $7, $8, NOW(), $9) ON CONFLICT DO NOTHING",
            )
            .bind(community.as_uuid())
            .bind(event.id.as_bytes().as_slice())
            .bind(event.pubkey.to_bytes())
            .bind(event.created_at.as_secs() as f64)
            .bind(buzz_core::kind::KIND_READ_STATE as i32)
            .bind(serde_json::to_value(&event.tags).expect("serialize tags"))
            .bind(&event.content)
            .bind(event.sig.serialize().as_slice())
            .bind(d_tag)
            .execute(pool)
            .await
    }

    legacy_insert(&db.pool, community, &a, &d_tag)
        .await
        .expect("legacy insert A");
    let duplicate = legacy_insert(&db.pool, community, &a, &d_tag)
        .await
        .expect("legacy duplicate A remains idempotent");
    assert_eq!(duplicate.rows_affected(), 0);

    sqlx::query(
        "INSERT INTO event_mentions \
                 (community_id, pubkey_hex, event_id, event_created_at, event_kind) \
             VALUES ($1, $2, $3, to_timestamp($4), 30078)",
    )
    .bind(community.as_uuid())
    .bind("c".repeat(64))
    .bind(a.id.as_bytes().as_slice())
    .bind(a.created_at.as_secs() as f64)
    .execute(&db.pool)
    .await
    .expect("insert live mention");

    // Emulate the pre-PR replacement path after migration 0007: soft-delete
    // the live row, then insert B without any application watermark write.
    sqlx::query(
            "UPDATE events SET deleted_at=NOW() \
             WHERE community_id=$1 AND kind=30078 AND pubkey=$2 AND d_tag=$3 AND deleted_at IS NULL",
        )
        .bind(community.as_uuid())
        .bind(keys.public_key().to_bytes())
        .bind(&d_tag)
        .execute(&db.pool)
        .await
        .expect("legacy soft-delete A");
    let mentions_after_delete: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM event_mentions WHERE community_id=$1 AND event_id=$2",
    )
    .bind(community.as_uuid())
    .bind(a.id.as_bytes().as_slice())
    .fetch_one(&db.pool)
    .await
    .expect("count mentions after delete");
    assert_eq!(mentions_after_delete, 0);

    let stale_mention = sqlx::query(
        "INSERT INTO event_mentions \
                 (community_id, pubkey_hex, event_id, event_created_at, event_kind) \
             VALUES ($1, $2, $3, to_timestamp($4), 30078)",
    )
    .bind(community.as_uuid())
    .bind("d".repeat(64))
    .bind(a.id.as_bytes().as_slice())
    .bind(a.created_at.as_secs() as f64)
    .execute(&db.pool)
    .await
    .expect("stale post-commit mention is skipped");
    assert_eq!(stale_mention.rows_affected(), 0);

    legacy_insert(&db.pool, community, &b, &d_tag)
        .await
        .expect("legacy insert B");
    let duplicate_b = legacy_insert(&db.pool, community, &b, &d_tag)
        .await
        .expect("live duplicate B is skipped");
    assert_eq!(duplicate_b.rows_affected(), 0);

    sqlx::query(
        "INSERT INTO event_mentions \
                 (community_id, pubkey_hex, event_id, event_created_at, event_kind) \
             VALUES ($1, $2, $3, to_timestamp($4), 30078)",
    )
    .bind(community.as_uuid())
    .bind("e".repeat(64))
    .bind(b.id.as_bytes().as_slice())
    .bind(b.created_at.as_secs() as f64)
    .execute(&db.pool)
    .await
    .expect("insert B mention");

    // Exercise the new Rust hard-delete path independently. An in-flight
    // mention holds KEY SHARE on B, so replacement by C must block, then
    // complete after the mention commits and remove both B and its mention.
    let mut rust_mention_tx = db
        .pool
        .begin()
        .await
        .expect("begin Rust mention transaction");
    sqlx::query(
        "INSERT INTO event_mentions \
                 (community_id, pubkey_hex, event_id, event_created_at, event_kind) \
             VALUES ($1, $2, $3, to_timestamp($4), 30078) ON CONFLICT DO NOTHING",
    )
    .bind(community.as_uuid())
    .bind("e".repeat(64))
    .bind(b.id.as_bytes().as_slice())
    .bind(b.created_at.as_secs() as f64)
    .execute(&mut *rust_mention_tx)
    .await
    .expect("hold B live-event key-share lock");

    let replace_db = db.clone();
    let replace_d_tag = d_tag.clone();
    let replace_c = c.clone();
    let replace_task = tokio::spawn(async move {
        replace_db
            .replace_parameterized_event(community, &replace_c, &replace_d_tag, None)
            .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(
        !replace_task.is_finished(),
        "Rust hard delete should wait for mention lock"
    );
    rust_mention_tx
        .commit()
        .await
        .expect("release Rust mention lock");
    let replaced = tokio::time::timeout(std::time::Duration::from_secs(2), replace_task)
        .await
        .expect("Rust hard delete deadlocked with mention insert")
        .expect("replacement task panicked")
        .expect("replace B with C");
    assert!(replaced.1, "C must replace B");
    let b_mentions: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM event_mentions WHERE community_id=$1 AND event_id=$2",
    )
    .bind(community.as_uuid())
    .bind(b.id.as_bytes().as_slice())
    .fetch_one(&db.pool)
    .await
    .expect("count B mentions after Rust replacement");
    assert_eq!(b_mentions, 0);

    sqlx::query(
        "INSERT INTO event_mentions \
                 (community_id, pubkey_hex, event_id, event_created_at, event_kind) \
             VALUES ($1, $2, $3, to_timestamp($4), 30078)",
    )
    .bind(community.as_uuid())
    .bind("f".repeat(64))
    .bind(c.id.as_bytes().as_slice())
    .bind(c.created_at.as_secs() as f64)
    .execute(&db.pool)
    .await
    .expect("insert C mention");

    // Exercise legacy UPDATE-trigger deletion with the same barrier. While
    // deletion waits on C's KEY SHARE lock, an exact replay must already be
    // a zero-row trigger no-op; it must not wait for deletion or resurrect C.
    let mut legacy_mention_tx = db
        .pool
        .begin()
        .await
        .expect("begin legacy mention transaction");
    sqlx::query(
        "INSERT INTO event_mentions \
                 (community_id, pubkey_hex, event_id, event_created_at, event_kind) \
             VALUES ($1, $2, $3, to_timestamp($4), 30078) ON CONFLICT DO NOTHING",
    )
    .bind(community.as_uuid())
    .bind("f".repeat(64))
    .bind(c.id.as_bytes().as_slice())
    .bind(c.created_at.as_secs() as f64)
    .execute(&mut *legacy_mention_tx)
    .await
    .expect("hold C live-event key-share lock");

    let delete_pool = db.pool.clone();
    let delete_pubkey = keys.public_key().to_bytes();
    let delete_d_tag = d_tag.clone();
    let delete_task = tokio::spawn(async move {
        sqlx::query(
                "UPDATE events SET deleted_at=NOW() \
                 WHERE community_id=$1 AND kind=30078 AND pubkey=$2 AND d_tag=$3 AND deleted_at IS NULL",
            )
            .bind(community.as_uuid())
            .bind(delete_pubkey)
            .bind(delete_d_tag)
            .execute(&delete_pool)
            .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(
        !delete_task.is_finished(),
        "legacy delete should wait for mention lock"
    );

    let replay_while_delete_waits = legacy_insert(&db.pool, community, &c, &d_tag)
        .await
        .expect("concurrent exact C replay is skipped");
    assert_eq!(replay_while_delete_waits.rows_affected(), 0);

    legacy_mention_tx
        .commit()
        .await
        .expect("release legacy mention lock");
    tokio::time::timeout(std::time::Duration::from_secs(2), delete_task)
        .await
        .expect("legacy delete deadlocked with mention insert")
        .expect("delete task panicked")
        .expect("legacy NIP-09 delete C");

    let payloads: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM events WHERE community_id=$1 AND kind=30078 AND pubkey=$2 AND d_tag=$3",
        )
        .bind(community.as_uuid())
        .bind(keys.public_key().to_bytes())
        .bind(&d_tag)
        .fetch_one(&db.pool)
        .await
        .expect("count retained payloads");
    assert_eq!(
        payloads, 0,
        "legacy soft deletes must not retain NIP-RS payloads"
    );

    // Opposite commit order: deletion has committed before exact replay.
    // Equality remains an observable zero-row no-op, never a resurrection.
    let replay_c = legacy_insert(&db.pool, community, &c, &d_tag)
        .await
        .expect("post-delete exact C replay is skipped");
    assert_eq!(replay_c.rows_affected(), 0);
    let payloads_after_exact_replay: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM events WHERE community_id=$1 AND kind=30078 AND pubkey=$2 AND d_tag=$3",
        )
        .bind(community.as_uuid())
        .bind(keys.public_key().to_bytes())
        .bind(&d_tag)
        .fetch_one(&db.pool)
        .await
        .expect("count payloads after exact replay");
    assert_eq!(payloads_after_exact_replay, 0);

    let replay = legacy_insert(&db.pool, community, &x, &d_tag).await;
    assert!(
        replay.is_err(),
        "database guard must reject A < X < C replay"
    );

    let watermark: (chrono::DateTime<chrono::Utc>, Vec<u8>) = sqlx::query_as(
        "SELECT created_at, event_id FROM parameterized_event_watermarks \
             WHERE community_id=$1 AND kind=30078 AND pubkey=$2 AND d_tag=$3",
    )
    .bind(community.as_uuid())
    .bind(keys.public_key().to_bytes())
    .bind(&d_tag)
    .fetch_one(&db.pool)
    .await
    .expect("read C watermark");
    assert_eq!(watermark.0.timestamp(), base as i64 + 3);
    assert_eq!(watermark.1, c.id.as_bytes().as_slice());
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn test_usage_metrics_lock_has_single_owner_and_releases_on_drop() {
    // Use a private scratch database — not the shared TEST_DATABASE_URL.
    // Postgres advisory locks are per-database; hardcoding the production
    // USAGE_METRICS_LOCK_KEY (0x4255_5A5A_4D45_5452) on the shared test DB
    // races any live buzz-relay on the same database (see #3619).
    let admin_url = std::env::var("TEST_DATABASE_URL").unwrap_or_else(|_| TEST_DB_URL.into());
    let admin = PgPoolOptions::new()
        .max_connections(1)
        .connect(&admin_url)
        .await
        .expect("connect admin to create scratch db");
    let (pool, scratch_name) = create_scratch_db(&admin, "usage_metrics_lock").await;
    let first = Db::from_pool(pool.clone());
    let second = Db::from_pool(pool.clone());
    // Same key as production (`buzz-relay` USAGE_METRICS_LOCK_KEY) — safe here
    // because the scratch DB is empty of other holders.
    let key = 0x4255_5A5A_4D45_5452;

    let mut leader = first
        .try_lock_usage_metrics(key)
        .await
        .expect("first lock attempt")
        .expect("first database handle becomes leader");
    assert!(leader.is_live().await, "lock owner remains reachable");
    assert!(
        second
            .try_lock_usage_metrics(key)
            .await
            .expect("second lock attempt")
            .is_none(),
        "another session cannot become leader while the guard exists"
    );

    drop(leader);
    assert!(
        second
            .try_lock_usage_metrics(key)
            .await
            .expect("lock attempt after leader drop")
            .is_some(),
        "dropping the detached session releases its advisory lock"
    );

    // Release any remaining session state before DROP DATABASE.
    drop(first);
    drop(second);
    drop_scratch_db(&admin, pool, &scratch_name).await;
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn lookup_community_by_host_matches_case_insensitive_host_index() {
    let db = setup_db().await;
    let id = Uuid::new_v4();
    let lower_host = format!("lookup-community-{}.example", id.simple());
    let stored_host = lower_host.to_uppercase();

    sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
        .bind(id)
        .bind(&stored_host)
        .execute(&db.pool)
        .await
        .expect("insert mixed-case community host");

    let found = db
        .lookup_community_by_host(&lower_host)
        .await
        .expect("lookup lower-case host")
        .expect("community found by lower-case host");
    assert_eq!(found.id, CommunityId::from_uuid(id));
    assert_eq!(found.host, stored_host);

    let found = db
        .lookup_community_by_host(&stored_host)
        .await
        .expect("lookup stored-case host")
        .expect("community found by stored-case host");
    assert_eq!(found.id, CommunityId::from_uuid(id));
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn create_community_with_owner_is_atomic_and_create_only() {
    let db = setup_db().await;
    let host = format!("create-only-{}.example", Uuid::new_v4().simple());
    let owner = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let other = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    let created = db
        .create_community_with_owner(&host, owner)
        .await
        .expect("create community");
    let CreateCommunityWithOwnerResult::Created(created) = created else {
        panic!("expected new community");
    };
    assert_eq!(created.host, host);
    let owner_role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM relay_members WHERE community_id = $1 AND pubkey = $2",
    )
    .bind(created.id.as_uuid())
    .bind(owner)
    .fetch_optional(&db.pool)
    .await
    .expect("owner role");
    assert_eq!(owner_role.as_deref(), Some("owner"));

    let retry = db
        .create_community_with_owner(&host.to_ascii_uppercase(), owner)
        .await
        .expect("same-owner retry");
    assert_eq!(
        retry,
        CreateCommunityWithOwnerResult::Created(created.clone()),
        "retry returns the original row"
    );

    let collision = db
        .create_community_with_owner(&host, other)
        .await
        .expect("collision result");
    assert_eq!(collision, CreateCommunityWithOwnerResult::HostExists);
    let roles: Vec<(String, String)> = sqlx::query_as(
        "SELECT pubkey, role FROM relay_members WHERE community_id = $1 ORDER BY pubkey",
    )
    .bind(created.id.as_uuid())
    .fetch_all(&db.pool)
    .await
    .expect("community roles");
    assert_eq!(roles, vec![(owner.to_string(), "owner".to_string())]);

    db.bootstrap_owner(created.id, other)
        .await
        .expect("rotate owner");
    let post_rotation_retry = db
        .create_community_with_owner(&host, owner)
        .await
        .expect("post-rotation retry");
    assert_eq!(
        post_rotation_retry,
        CreateCommunityWithOwnerResult::HostExists
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn unarchive_community_owned_by_restores_admission_idempotently() {
    let db = setup_db().await;
    let host = format!("unarchive-{}.example", Uuid::new_v4().simple());
    let owner = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let outsider = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let created = db
        .create_community_with_owner(&host, &owner)
        .await
        .expect("create community");
    let CreateCommunityWithOwnerResult::Created(created) = created else {
        panic!("expected new community");
    };

    let archived = db
        .archive_community_owned_by(&host, &owner, "protected.example")
        .await
        .expect("archive community")
        .expect("owned community");
    assert_eq!(archived.id, created.id);
    assert!(
        db.lookup_community_by_host(&host)
            .await
            .expect("active lookup")
            .is_none(),
        "archived communities must fail admission"
    );
    assert!(db
        .unarchive_community_owned_by(&host, &outsider)
        .await
        .expect("wrong-owner unarchive")
        .is_none());
    assert!(db
        .unarchive_community_owned_by("missing.example", &owner)
        .await
        .expect("unknown-host unarchive")
        .is_none());

    let restored = db
        .unarchive_community_owned_by(&host.to_ascii_uppercase(), &owner)
        .await
        .expect("unarchive community")
        .expect("owned community");
    assert_eq!(restored.id, created.id);
    assert_eq!(restored.host, host);
    assert_eq!(
        db.lookup_community_by_host(&host)
            .await
            .expect("restored lookup")
            .expect("active community")
            .id,
        created.id
    );
    assert_eq!(
        db.get_relay_member(created.id, &owner)
            .await
            .expect("owner lookup")
            .expect("owner remains")
            .role,
        "owner"
    );

    let retry = db
        .unarchive_community_owned_by(&host, &owner)
        .await
        .expect("idempotent retry")
        .expect("owned community");
    assert_eq!(retry, restored);
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn create_community_with_owner_enforces_per_owner_limit() {
    let db = setup_db().await;
    let owner = format!("{:064x}", Uuid::new_v4().as_u128());

    // Create 3 communities for this owner (the max).
    for i in 0..3 {
        let host = format!("limit-test-{}-{}.example", i, Uuid::new_v4().simple());
        assert!(matches!(
            db.create_community_with_owner(&host, &owner)
                .await
                .expect("create community"),
            CreateCommunityWithOwnerResult::Created(_)
        ));
    }

    let host = format!("limit-test-3-{}.example", Uuid::new_v4().simple());
    assert_eq!(
        db.create_community_with_owner(&host, &owner)
            .await
            .expect("create community call"),
        CreateCommunityWithOwnerResult::LimitReached
    );
    assert!(
        db.lookup_community_by_host(&host)
            .await
            .expect("look up rolled-back fresh host")
            .is_none(),
        "limit rejection must roll back the fresh community row"
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn concurrent_same_owner_create_returns_the_winning_row_to_both_callers() {
    let db = setup_db().await;
    let host = format!("concurrent-create-{}.example", Uuid::new_v4().simple());
    let owner = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    let (first, second) = tokio::join!(
        db.create_community_with_owner(&host, owner),
        db.create_community_with_owner(&host, owner),
    );
    let first = first.expect("first concurrent create");
    let second = second.expect("second concurrent create");

    assert!(matches!(first, CreateCommunityWithOwnerResult::Created(_)));
    assert_eq!(first, second, "conflict loser re-reads the winning row");
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn ensure_configured_community_reports_insert_winner() {
    let db = setup_db().await;
    let host = format!("ensure-community-{}.example", Uuid::new_v4().simple());

    let first = db
        .ensure_configured_community(&host)
        .await
        .expect("first ensure");
    assert!(first.created, "first ensure should report created");
    assert_eq!(first.host, host);

    let second = db
        .ensure_configured_community(&host)
        .await
        .expect("second ensure");
    assert!(!second.created, "second ensure should report existed");
    assert_eq!(second.id, first.id);
    assert_eq!(second.host, host);
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn list_communities_owned_by_returns_only_owner_rows() {
    let db = setup_db().await;
    let community_a = CommunityId::from_uuid(make_community(&db.pool).await);
    let community_b = CommunityId::from_uuid(make_community(&db.pool).await);
    let community_c = CommunityId::from_uuid(make_community(&db.pool).await);
    // Unique per run: `list_communities_owned_by` is keyed only by pubkey,
    // so a shared fixed pubkey picks up communities leaked by sibling
    // ignored tests running against the same database.
    let owner = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let owner = owner.as_str();
    let other = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let other = other.as_str();

    db.bootstrap_owner(community_a, owner)
        .await
        .expect("owner A");
    db.bootstrap_owner(community_b, other)
        .await
        .expect("other owner B");
    db.add_relay_member(community_c, owner, "admin", None)
        .await
        .expect("admin C");

    let owned = db
        .list_communities_owned_by(owner)
        .await
        .expect("list owned communities");

    assert_eq!(owned.len(), 1);
    assert_eq!(owned[0].id, community_a);
}

async fn insert_channel(pool: &PgPool, community_id: Uuid, channel_id: Uuid) {
    let creator: Vec<u8> = vec![0u8; 32];
    sqlx::query(
        r#"
            INSERT INTO channels
                (id, community_id, name, channel_type, visibility, created_by)
            VALUES
                ($1, $2, $3, 'stream'::channel_type, 'open'::channel_visibility, $4)
            "#,
    )
    .bind(channel_id)
    .bind(community_id)
    .bind(format!("ch-{}", channel_id.simple()))
    .bind(&creator)
    .execute(pool)
    .await
    .expect("insert channel");
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn allowlist_is_scoped_to_community() {
    let db = setup_db().await;
    let community_a = CommunityId::from_uuid(make_community(&db.pool).await);
    let community_b = CommunityId::from_uuid(make_community(&db.pool).await);
    let pubkey = [7u8; 32];
    let added_by = [9u8; 32];

    assert!(db
        .add_to_allowlist(community_a, &pubkey, &added_by, Some("a-only"))
        .await
        .expect("add allowlist row"));
    assert!(!db
        .add_to_allowlist(community_a, &pubkey, &added_by, Some("duplicate"))
        .await
        .expect("duplicate allowlist row is idempotent"));

    assert!(
        db.is_pubkey_allowed(community_a, &pubkey)
            .await
            .expect("allowlist check A"),
        "pubkey added to A must be allowed in A"
    );
    assert!(
        !db.is_pubkey_allowed(community_b, &pubkey)
            .await
            .expect("allowlist check B"),
        "pubkey added only to A must not be allowed in B"
    );
    assert!(db
        .has_allowlist_entries(community_a)
        .await
        .expect("A has entries"));
    assert!(!db
        .has_allowlist_entries(community_b)
        .await
        .expect("B has no entries"));

    let listed = db
        .list_allowlist(community_a)
        .await
        .expect("list A allowlist");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].pubkey, pubkey);

    assert!(
        !db.remove_from_allowlist(community_b, &pubkey)
            .await
            .expect("remove from B is no-op"),
        "removing from B must not delete A's row"
    );
    assert!(db
        .is_pubkey_allowed(community_a, &pubkey)
        .await
        .expect("A still allowed after B remove"));
    assert!(db
        .remove_from_allowlist(community_a, &pubkey)
        .await
        .expect("remove from A"));
    assert!(!db
        .is_pubkey_allowed(community_a, &pubkey)
        .await
        .expect("A not allowed after remove"));
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn communities_of_channels_present_for_existing_absent_for_missing() {
    let db = setup_db().await;
    let community = make_community(&db.pool).await;
    let existing = Uuid::new_v4();
    insert_channel(&db.pool, community, existing).await;

    // Channel that is NOT inserted — the load-bearing case.
    let missing = Uuid::new_v4();

    let result = db
        .communities_of_channels(&[existing, missing])
        .await
        .expect("communities_of_channels");

    // (1) Existing channel → present with its true community.
    assert_eq!(
        result.get(&existing).copied(),
        Some(CommunityId::from_uuid(community)),
        "existing channel must map to its true community",
    );

    // (2) Missing channel → ABSENT from the map (never defaulted).
    // This is the contract the relay-side `MissingLookup → ImplBug`
    // fail-closed guard-rail depends on. If this assertion ever
    // weakens to `result.get(&missing) != Some(community)`, the
    // mutate-bite below stops biting.
    assert!(
        !result.contains_key(&missing),
        "missing channel must be absent from the result map, got {:?}",
        result.get(&missing),
    );

    // (3) Map size matches: exactly one entry, the existing one.
    assert_eq!(
        result.len(),
        1,
        "result map must contain only existing channels"
    );
}

/// BUG-5 regression: the `reactions` table is community-scoped
/// (`PK (community_id, event_created_at, event_id, pubkey, emoji)`), so a
/// reaction added under community A must be invisible and unremovable from
/// community B — even for the *identical* `(event_id, pubkey, emoji)` shape.
/// Before the fix, `add_reaction` omitted `community_id` (NOT NULL → 500) and
/// every read/remove filtered `event_id` only (latent cross-tenant bleed).
#[tokio::test]
#[ignore = "requires Postgres"]
async fn reactions_are_scoped_to_community() {
    let db = setup_db().await;
    let community_a = CommunityId::from_uuid(make_community(&db.pool).await);
    let community_b = CommunityId::from_uuid(make_community(&db.pool).await);

    // Identical referenced-event shape across both tenants.
    let event_id = [0xABu8; 32];
    let event_created_at = Utc::now();
    let pubkey = [7u8; 32];
    let emoji = "👍";

    // (1) Add succeeds under A (this INSERT 500'd before the fix).
    assert!(
        db.add_reaction(
            community_a,
            &event_id,
            event_created_at,
            &pubkey,
            emoji,
            None
        )
        .await
        .expect("add reaction under A"),
        "first reaction under A must be inserted"
    );
    // Idempotent: re-adding the same active reaction is a no-op.
    assert!(
        !db.add_reaction(
            community_a,
            &event_id,
            event_created_at,
            &pubkey,
            emoji,
            None
        )
        .await
        .expect("duplicate reaction under A"),
        "active duplicate under A must not re-insert"
    );

    // (2) Visible on A, invisible on B (grouped read path).
    let groups_a = db
        .get_reactions(community_a, &event_id, event_created_at, 100, None)
        .await
        .expect("get reactions A");
    assert_eq!(groups_a.len(), 1, "A must see its own reaction group");
    assert_eq!(groups_a[0].emoji, emoji);
    assert_eq!(groups_a[0].count, 1);

    let groups_b = db
        .get_reactions(community_b, &event_id, event_created_at, 100, None)
        .await
        .expect("get reactions B");
    assert!(
        groups_b.is_empty(),
        "B must NOT see A's reaction for the same event shape, got {groups_b:?}"
    );

    // (3) Active-record lookup is scoped: present on A, absent on B.
    assert!(
        db.get_active_reaction_record(community_a, &event_id, event_created_at, &pubkey, emoji)
            .await
            .expect("active record A")
            .is_some(),
        "A's active reaction record must be present"
    );
    assert!(
        db.get_active_reaction_record(community_b, &event_id, event_created_at, &pubkey, emoji)
            .await
            .expect("active record B")
            .is_none(),
        "B must not find A's active reaction record"
    );

    // (4) B can add the identical shape independently (no PK collision).
    assert!(
        db.add_reaction(
            community_b,
            &event_id,
            event_created_at,
            &pubkey,
            emoji,
            None
        )
        .await
        .expect("add reaction under B"),
        "B must be able to add the same shape as its own scoped row"
    );

    // (5) Removing from B does not touch A's row.
    assert!(
        db.remove_reaction(community_b, &event_id, event_created_at, &pubkey, emoji)
            .await
            .expect("remove under B"),
        "B remove must affect B's own row"
    );
    assert!(
        db.get_active_reaction_record(community_a, &event_id, event_created_at, &pubkey, emoji)
            .await
            .expect("active record A after B remove")
            .is_some(),
        "A's reaction must survive a B-side removal"
    );

    // (6) A remove affects only A; A's read now empty.
    assert!(
        db.remove_reaction(community_a, &event_id, event_created_at, &pubkey, emoji)
            .await
            .expect("remove under A"),
        "A remove must affect A's row"
    );
    let groups_a_after = db
        .get_reactions(community_a, &event_id, event_created_at, 100, None)
        .await
        .expect("get reactions A after remove");
    assert!(
        groups_a_after.is_empty(),
        "A's reaction must be gone after A removes it"
    );
}

// ---- Read-replica routing ------------------------------------------------
//
// These tests pin the routing contract of `Db::read()` and the two routed
// methods. A second scratch database stands in for the replica; the
// fixtures are deliberately DIVERGENT (rows that exist in only one of the
// two databases) so every assertion observes which pool actually served
// the query instead of trusting the routing code's word for it.

async fn admin_url() -> String {
    std::env::var("TEST_DATABASE_URL").unwrap_or_else(|_| TEST_DB_URL.into())
}

/// Create a fresh scratch database on the same server and run migrations.
/// Returns (pool, db_name); callers should `drop_scratch_db` when done.
async fn create_scratch_db(admin: &PgPool, prefix: &str) -> (PgPool, String) {
    let name = format!("{}_{}", prefix, Uuid::new_v4().simple());
    sqlx::query(sqlx::AssertSqlSafe(format!("CREATE DATABASE {name}")))
        .execute(admin)
        .await
        .expect("create scratch db");
    let base = admin_url().await;
    // Swap the database path segment of the admin URL for the scratch name.
    let scratch_url = {
        let idx = base.rfind('/').expect("db url has a path segment");
        format!("{}/{}", &base[..idx], name)
    };
    let pool = PgPool::connect(&scratch_url)
        .await
        .expect("connect scratch db");
    migration::run_migrations(&pool)
        .await
        .expect("migrate scratch db");
    (pool, name)
}

async fn drop_scratch_db(admin: &PgPool, pool: PgPool, name: &str) {
    pool.close().await;
    let _ = sqlx::query(sqlx::AssertSqlSafe(format!(
        "DROP DATABASE IF EXISTS {name} WITH (FORCE)"
    )))
    .execute(admin)
    .await;
}

/// Insert identical community + channel rows into a database so the same
/// (community, channel) ids resolve in both writer and replica.
async fn seed_community_channel(
    pool: &PgPool,
    community: Uuid,
    channel: Uuid,
    author: &nostr::Keys,
) {
    sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
        .bind(community)
        .bind(format!("replica-routing-{}.example", community.simple()))
        .execute(pool)
        .await
        .expect("insert community");
    crate::channel::create_channel_with_id(
        pool,
        CommunityId::from_uuid(community),
        channel,
        &format!("replica-routing-{channel}"),
        crate::channel::ChannelType::Stream,
        crate::channel::ChannelVisibility::Open,
        None,
        author.public_key().to_bytes().as_slice(),
        None,
    )
    .await
    .expect("create channel");
}

fn signed_event_at(keys: &nostr::Keys, content: &str, secs: u64) -> nostr::Event {
    nostr::EventBuilder::new(nostr::Kind::Custom(9), content)
        .custom_created_at(nostr::Timestamp::from(secs))
        .sign_with_keys(keys)
        .expect("sign event")
}

async fn insert_top_level(pool: &PgPool, community: Uuid, channel: Uuid, ev: &nostr::Event) {
    let ts = chrono::DateTime::from_timestamp(ev.created_at.as_secs() as i64, 0).expect("valid ts");
    event::insert_event_with_thread_metadata(
        pool,
        CommunityId::from_uuid(community),
        ev,
        Some(channel),
        Some(event::ThreadMetadataParams {
            event_id: ev.id.as_bytes(),
            event_created_at: ts,
            channel_id: channel,
            parent_event_id: None,
            parent_event_created_at: None,
            root_event_id: None,
            root_event_created_at: None,
            depth: 0,
            broadcast: true,
        }),
    )
    .await
    .expect("insert top-level event");
}

async fn insert_thread_reply(
    pool: &PgPool,
    community: Uuid,
    channel: Uuid,
    root: &nostr::Event,
    reply: &nostr::Event,
) {
    let reply_ts =
        chrono::DateTime::from_timestamp(reply.created_at.as_secs() as i64, 0).expect("valid ts");
    let root_ts =
        chrono::DateTime::from_timestamp(root.created_at.as_secs() as i64, 0).expect("valid ts");
    event::insert_event_with_thread_metadata(
        pool,
        CommunityId::from_uuid(community),
        reply,
        Some(channel),
        Some(event::ThreadMetadataParams {
            event_id: reply.id.as_bytes(),
            event_created_at: reply_ts,
            channel_id: channel,
            parent_event_id: Some(root.id.as_bytes()),
            parent_event_created_at: Some(root_ts),
            root_event_id: Some(root.id.as_bytes()),
            root_event_created_at: Some(root_ts),
            depth: 1,
            broadcast: false,
        }),
    )
    .await
    .expect("insert reply");
}

/// Composite thread cursor: 8-byte BE seconds + raw event id.
fn thread_cursor(reply: &crate::thread::ThreadReply) -> Vec<u8> {
    let mut cur = reply.created_at.timestamp().to_be_bytes().to_vec();
    cur.extend_from_slice(&reply.event_id);
    cur
}

#[tokio::test]
async fn read_falls_back_to_writer_when_no_replica_configured() {
    // Pure wiring test — connect_lazy never touches the network.
    let pool = sqlx::PgPool::connect_lazy(TEST_DB_URL).expect("lazy pool");
    let db = Db::from_pool(pool);
    assert!(!db.has_read_pool());
    assert!(
        std::ptr::eq(db.read(), &db.pool),
        "read() must be the writer pool when no replica is configured"
    );
    assert!(db.read_pool_stats().is_none());
}

#[test]
fn read_budget_zero_disables_and_large_values_clamp_to_staleness() {
    assert_eq!(read_budget_from_ms(0), None, "0 = bounded routing off");
    assert_eq!(
        read_budget_from_ms(1000),
        Some(std::time::Duration::from_millis(1000))
    );
    assert_eq!(
        read_budget_from_ms(10_000_000),
        Some(replica_fence::FENCE_STALENESS),
        "budgets above the staleness gate clamp to it"
    );
}

/// Truth table for [`RoutePredicate::for_query`]: the strongest sound
/// predicate per query shape, and — the deploy-day default row — that
/// `routing_enabled = false` (BUZZ_REPLICA_READ_MAX_AGE_MS unset)
/// forces `Bounded` even for covered-eligible shapes, so the zero
/// budget fails the new seams closed (Dawn's covered-at-zero-budget
/// catch, design doc rev 5).
#[test]
fn for_query_predicate_truth_table() {
    let community = CommunityId::from_uuid(Uuid::new_v4());
    let channel = Uuid::new_v4();
    let until = chrono::Utc::now();

    let pinned_with_until = {
        let mut q = event::EventQuery::for_community(community);
        q.channel_id = Some(channel);
        q.until = Some(until);
        q
    };
    let pinned_no_until = {
        let mut q = event::EventQuery::for_community(community);
        q.channel_id = Some(channel);
        q
    };
    let unpinned_with_until = {
        let mut q = event::EventQuery::for_community(community);
        q.until = Some(until);
        q
    };
    let global_only = {
        let mut q = event::EventQuery::for_community(community);
        q.global_only = true;
        q.until = Some(until);
        q
    };

    // Deploy-day default: budget unset ⇒ Bounded regardless of shape.
    // The zero budget then fails Bounded closed, so the new seams
    // record writer/disabled — merging with no env var set is a no-op.
    assert!(
        matches!(
            RoutePredicate::for_query(&pinned_with_until, false),
            RoutePredicate::Bounded
        ),
        "budget unset must not reach the covered arm even when eligible"
    );

    // Budget set + channel pin + until ⇒ the strongest predicate.
    assert!(matches!(
        RoutePredicate::for_query(&pinned_with_until, true),
        RoutePredicate::BoundedOrCovered { .. }
    ));

    // Missing either covered precondition ⇒ Bounded.
    assert!(matches!(
        RoutePredicate::for_query(&pinned_no_until, true),
        RoutePredicate::Bounded
    ));
    assert!(matches!(
        RoutePredicate::for_query(&unpinned_with_until, true),
        RoutePredicate::Bounded
    ));
    // global_only implies `channel_id = None`, so the channel-pin
    // precondition fails and no covered arm is possible — `for_query`
    // never inspects `global_only` itself; the row holds because
    // constructor 1 (channel pin) returns None for an unpinned query.
    assert!(matches!(
        RoutePredicate::for_query(&global_only, true),
        RoutePredicate::Bounded
    ));
}

/// The pre-existing cursor paths are NOT budget-gated: a channel-window
/// cursor page still derives `Covered` with no `routing_enabled` input
/// at all — at B=0 today it routes covered, and that status quo is
/// intentionally unchanged by the `for_query` gate (Max's matrix row:
/// old paths route at budget-unset; only the new seams go dark).
#[test]
fn channel_cursor_predicate_is_not_budget_gated() {
    let channel = Uuid::new_v4();
    let cursor = Some((chrono::Utc::now(), vec![1u8; 32]));
    assert!(matches!(
        RoutePredicate::from_channel_cursor(channel, &cursor),
        RoutePredicate::Covered { .. }
    ));
    // Head fetch (no cursor) is bounded — gated by the budget.
    assert!(matches!(
        RoutePredicate::from_channel_cursor(channel, &None),
        RoutePredicate::Bounded
    ));
}

/// D5 wiring: `read_pool_stats().max` must be the READER pool's own
/// ceiling, not the writer's — `buzz_db_read_pool_active / _max` is the
/// operator's utilisation signal and inheriting the writer's max hides
/// reader saturation by exactly the sizing ratio. Pure wiring test:
/// `connect_lazy` never touches the network, but it does spawn the
/// pool reaper task, which needs a Tokio runtime — hence
/// `#[tokio::test]` despite the test body itself never awaiting.
#[tokio::test]
async fn read_pool_stats_reports_reader_ceiling_not_writer() {
    let writer = sqlx::postgres::PgPoolOptions::new()
        .max_connections(20)
        .connect_lazy(TEST_DB_URL)
        .expect("lazy writer pool");
    let reader = sqlx::postgres::PgPoolOptions::new()
        .max_connections(40)
        .connect_lazy(TEST_DB_URL)
        .expect("lazy reader pool");
    let db = Db::from_pools(writer, reader);
    assert_eq!(db.pool_stats().max, 20);
    assert_eq!(
        db.read_pool_stats().expect("read pool configured").max,
        40,
        "reader gauge must report the reader's own ceiling"
    );
}

/// D4 wiring: the reader pool is built lazily with `min_connections(0)`
/// and the short reader acquire timeout — construction must succeed
/// with no replica listening (reader-down at boot must not crash the
/// relay), and `read_max_connections` must honour
/// `DbConfig::read_max_connections` over the writer sizing.
/// `#[tokio::test]` because `connect_lazy` spawns the pool reaper task,
/// which needs a Tokio runtime even though nothing is dialed.
#[tokio::test]
async fn connect_read_pool_is_lazy_and_independently_sized() {
    let config = DbConfig {
        max_connections: 20,
        read_max_connections: Some(7),
        ..DbConfig::default()
    };
    // Unroutable per RFC 5737 TEST-NET-1: proves nothing is dialed at
    // construction time.
    let pool = Db::connect_read_pool(&config, "postgres://user:pw@192.0.2.1:5432/none", 7)
        .expect("lazy construction must not dial the replica");
    assert_eq!(pool.options().get_max_connections(), 7);
    assert_eq!(pool.options().get_min_connections(), 0);
    assert_eq!(
        pool.options().get_acquire_timeout(),
        Db::READER_ACQUIRE_TIMEOUT
    );
}

/// Channel window: head fetch (no cursor) reads the WRITER; cursor pages
/// read the REPLICA. Divergent fixtures prove which pool served each.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn channel_window_routes_head_to_writer_and_cursor_pages_to_replica() {
    let admin = PgPool::connect(&admin_url().await)
        .await
        .expect("connect admin");
    let (writer, wname) = create_scratch_db(&admin, "routing_w").await;
    let (replica, rname) = create_scratch_db(&admin, "routing_r").await;

    let author = nostr::Keys::generate();
    let community = Uuid::new_v4();
    let channel = Uuid::new_v4();
    seed_community_channel(&writer, community, channel, &author).await;
    seed_community_channel(&replica, community, channel, &author).await;

    // Shared history (both databases): m1 < m2 < m3.
    let base = 1_700_000_000u64;
    let m1 = signed_event_at(&author, "m1", base);
    let m2 = signed_event_at(&author, "m2", base + 10);
    let m3 = signed_event_at(&author, "m3", base + 20);
    for pool in [&writer, &replica] {
        for ev in [&m1, &m2, &m3] {
            insert_top_level(pool, community, channel, ev).await;
        }
    }
    // Lag: the newest event exists only on the writer.
    let fresh = signed_event_at(&author, "fresh-writer-only", base + 30);
    insert_top_level(&writer, community, channel, &fresh).await;
    // Marker: exists only on the "replica" (unphysical for a real replica,
    // but it makes replica-served pages unambiguous).
    let marker = signed_event_at(&author, "replica-only-marker", base + 5);
    insert_top_level(&replica, community, channel, &marker).await;

    let db = Db::from_pools(writer.clone(), replica.clone());
    // Open the fence through "now": the fixture's history is far in the
    // past, so every cursor falls below the fence and routing is
    // eligible. Fence-gating itself is pinned by the fence tests below.
    db.fence().force_open_for_tests(chrono::Utc::now());
    let cid = CommunityId::from_uuid(community);

    // Head fetch (cursor: None) → writer: sees `fresh`, never `marker`.
    let head = db
        .get_channel_window(cid, channel, 2, None, None)
        .await
        .expect("head window");
    let head_contents: Vec<String> = head
        .rows
        .iter()
        .map(|r| r.stored_event.event.content.clone())
        .collect();
    assert_eq!(
        head_contents,
        vec!["fresh-writer-only".to_string(), "m3".to_string()],
        "head fetch must be served by the writer"
    );

    // Cursor page → replica: sees `marker`, never `fresh`.
    let cursor = head.next_cursor.expect("has_more implies next_cursor");
    let page2 = db
        .get_channel_window(cid, channel, 10, Some(cursor), None)
        .await
        .expect("cursor window");
    let page2_contents: Vec<String> = page2
        .rows
        .iter()
        .map(|r| r.stored_event.event.content.clone())
        .collect();
    assert_eq!(
        page2_contents,
        vec![
            "m2".to_string(),
            "replica-only-marker".to_string(),
            "m1".to_string()
        ],
        "cursor page must be served by the replica"
    );

    drop_scratch_db(&admin, replica, &rname).await;
    drop_scratch_db(&admin, writer, &wname).await;
}

/// Fail-closed on a mid-request replica failure (Dawn, review of
/// 1b0aa0dfa): a replica-routed page whose query errors *after* the
/// proof (the live shape is a hot-standby recovery conflict — 40001 /
/// 25P02 — cancelling the held snapshot under `max_standby_streaming_delay`)
/// must be re-run on the writer and served, never surfaced as an error
/// the writer could have answered. Degraded capacity, never holes.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn replica_window_failure_falls_back_to_writer() {
    let admin = PgPool::connect(&admin_url().await)
        .await
        .expect("connect admin");
    let (writer, wname) = create_scratch_db(&admin, "fb_w").await;
    let (replica, rname) = create_scratch_db(&admin, "fb_r").await;

    let author = nostr::Keys::generate();
    let community = Uuid::new_v4();
    let channel = Uuid::new_v4();
    seed_community_channel(&writer, community, channel, &author).await;
    seed_community_channel(&replica, community, channel, &author).await;

    let base = 1_700_000_000u64;
    let m1 = signed_event_at(&author, "m1", base);
    let m2 = signed_event_at(&author, "m2", base + 10);
    let m3 = signed_event_at(&author, "m3", base + 20);
    for pool in [&writer, &replica] {
        for ev in [&m1, &m2, &m3] {
            insert_top_level(pool, community, channel, ev).await;
        }
    }
    let marker = signed_event_at(&author, "replica-only-marker", base + 5);
    insert_top_level(&replica, community, channel, &marker).await;

    let db = Db::from_pools(writer.clone(), replica.clone());
    db.fence().force_open_for_tests(chrono::Utc::now());
    let cid = CommunityId::from_uuid(community);

    let head = db
        .get_channel_window(cid, channel, 1, None, None)
        .await
        .expect("head window");
    let cursor = head.next_cursor.expect("has_more implies next_cursor");

    // Guard against a vacuous pass: the cursor page must actually be
    // replica-eligible before we break the replica.
    let healthy = db
        .get_channel_window(cid, channel, 10, Some(cursor.clone()), None)
        .await
        .expect("healthy cursor window");
    assert!(
        healthy
            .rows
            .iter()
            .any(|r| r.stored_event.event.content == "replica-only-marker"),
        "fixture must route the cursor page to the replica while healthy"
    );

    // Break the replica AFTER the proof point: the heartbeat table stays
    // intact (the observation succeeds), the page query then fails.
    sqlx::query("DROP TABLE events CASCADE")
        .execute(&replica)
        .await
        .expect("drop replica events");

    let page = db
        .get_channel_window(cid, channel, 10, Some(cursor), None)
        .await
        .expect("replica failure must fall back to the writer, not error");
    let contents: Vec<&str> = page
        .rows
        .iter()
        .map(|r| r.stored_event.event.content.as_str())
        .collect();
    assert_eq!(
        contents,
        vec!["m2", "m1"],
        "fallback page must be the writer's answer (no replica marker)"
    );

    drop_scratch_db(&admin, replica, &rname).await;
    drop_scratch_db(&admin, writer, &wname).await;
}

/// [`replica_window_failure_falls_back_to_writer`] for the thread-replies
/// path: a replica-routed thread page whose query errors after the proof
/// re-runs on the writer instead of surfacing an error.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn replica_thread_failure_falls_back_to_writer() {
    let admin = PgPool::connect(&admin_url().await)
        .await
        .expect("connect admin");
    let (writer, wname) = create_scratch_db(&admin, "fbt_w").await;
    let (replica, rname) = create_scratch_db(&admin, "fbt_r").await;

    let author = nostr::Keys::generate();
    let community = Uuid::new_v4();
    let channel = Uuid::new_v4();
    seed_community_channel(&writer, community, channel, &author).await;
    seed_community_channel(&replica, community, channel, &author).await;

    let base = 1_700_000_000u64;
    let root = signed_event_at(&author, "root", base);
    for pool in [&writer, &replica] {
        insert_top_level(pool, community, channel, &root).await;
    }
    let replies: Vec<nostr::Event> = (1..=3)
        .map(|i| signed_event_at(&author, &format!("r{i}"), base + 10 * i as u64))
        .collect();
    for pool in [&writer, &replica] {
        for reply in &replies {
            insert_thread_reply(pool, community, channel, &root, reply).await;
        }
    }
    // Replica-only divergent reply between r2 and r3 marks replica serves.
    let ghost = signed_event_at(&author, "replica-only-ghost", base + 25);
    insert_thread_reply(&replica, community, channel, &root, &ghost).await;

    let db = Db::from_pools(writer.clone(), replica.clone());
    db.fence().force_open_for_tests(chrono::Utc::now());
    let cid = CommunityId::from_uuid(community);

    let page1 = db
        .get_thread_replies(cid, root.id.as_bytes(), Some(10), 2, None)
        .await
        .expect("head page");
    let cur = thread_cursor(page1.last().expect("page 1 non-empty"));

    // Healthy: the full page after r2 is the replica's [ghost].
    let healthy = db
        .get_thread_replies(cid, root.id.as_bytes(), Some(10), 1, Some(&cur))
        .await
        .expect("healthy replica page");
    assert_eq!(
        healthy[0].stored_event.event.content, "replica-only-ghost",
        "fixture must route the cursor page to the replica while healthy"
    );

    sqlx::query("DROP TABLE events CASCADE")
        .execute(&replica)
        .await
        .expect("drop replica events");

    let page = db
        .get_thread_replies(cid, root.id.as_bytes(), Some(10), 1, Some(&cur))
        .await
        .expect("replica failure must fall back to the writer, not error");
    assert_eq!(
        page[0].stored_event.event.content, "r3",
        "fallback page must be the writer's answer"
    );

    drop_scratch_db(&admin, replica, &rname).await;
    drop_scratch_db(&admin, writer, &wname).await;
}

/// Mid-request degradation of the held session (Dawn, review of
/// 1b0aa0dfa): when the proved replica transaction dies between the page
/// and an aux follow-up (stand-in: `pg_terminate_backend` on the reader
/// connection, the same tx-fatal shape as a recovery-conflict cancel),
/// [`ReadSession::query_events`] must re-run the query on the writer and
/// permanently degrade the session instead of surfacing the error.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn read_session_degrades_to_writer_when_replica_connection_dies() {
    let admin = PgPool::connect(&admin_url().await)
        .await
        .expect("connect admin");
    let (writer, wname) = create_scratch_db(&admin, "deg_w").await;
    let (replica, rname) = create_scratch_db(&admin, "deg_r").await;

    let author = nostr::Keys::generate();
    let community = Uuid::new_v4();
    let channel = Uuid::new_v4();
    seed_community_channel(&writer, community, channel, &author).await;
    seed_community_channel(&replica, community, channel, &author).await;

    let base = 1_700_000_000u64;
    let m1 = signed_event_at(&author, "m1", base);
    let m2 = signed_event_at(&author, "m2", base + 10);
    for pool in [&writer, &replica] {
        for ev in [&m1, &m2] {
            insert_top_level(pool, community, channel, ev).await;
        }
    }
    // Writer-only row proves the degraded aux ran on the writer.
    let fresh = signed_event_at(&author, "fresh-writer-only", base + 20);
    insert_top_level(&writer, community, channel, &fresh).await;

    let db = Db::from_pools(writer.clone(), replica.clone());
    db.fence().force_open_for_tests(chrono::Utc::now());
    let cid = CommunityId::from_uuid(community);

    let head = db
        .get_channel_window(cid, channel, 1, None, None)
        .await
        .expect("head window");
    let cursor = head.next_cursor.expect("has_more implies next_cursor");
    let (_window, mut session) = db
        .get_channel_window_with_session(cid, channel, 10, Some(cursor), None)
        .await
        .expect("routed cursor window");
    assert!(
        session.is_replica(),
        "fixture must route this page to the replica"
    );

    // Kill the reader's backend out from under the held transaction.
    sqlx::query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity \
             WHERE datname = $1 AND pid <> pg_backend_pid()",
    )
    .bind(&rname)
    .execute(&admin)
    .await
    .expect("terminate replica backends");

    let mut aux = EventQuery::for_community(cid);
    aux.channel_id = Some(channel);
    let rows = session
        .query_events(&aux)
        .await
        .expect("session must degrade to the writer, not error");
    assert!(
        rows.iter()
            .any(|se| se.event.content == "fresh-writer-only"),
        "degraded aux must be served by the writer"
    );
    assert!(
        !session.is_replica(),
        "the session must be permanently degraded to the writer"
    );

    drop(session);
    drop_scratch_db(&admin, replica, &rname).await;
    drop_scratch_db(&admin, writer, &wname).await;
}

/// Snapshot continuity (Wren, review of 17ea2ff6a): the routed request
/// runs inside ONE `REPEATABLE READ, READ ONLY` transaction whose first
/// statement was the heartbeat observation — so a row committed on the
/// replica *after* the proof must be invisible to every follow-up
/// statement in the same request (page, participants, aux). This
/// distinguishes the transaction contract from mere connection reuse:
/// autocommit statements on the same backend advance their snapshot
/// per statement and WOULD see the mid-request row.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn routed_request_holds_one_snapshot_across_page_and_aux() {
    let admin = PgPool::connect(&admin_url().await)
        .await
        .expect("connect admin");
    let (writer, wname) = create_scratch_db(&admin, "snap_w").await;
    let (replica, rname) = create_scratch_db(&admin, "snap_r").await;

    let author = nostr::Keys::generate();
    let community = Uuid::new_v4();
    let channel = Uuid::new_v4();
    seed_community_channel(&writer, community, channel, &author).await;
    seed_community_channel(&replica, community, channel, &author).await;

    let base = 1_700_000_000u64;
    let m1 = signed_event_at(&author, "m1", base);
    let m2 = signed_event_at(&author, "m2", base + 10);
    for pool in [&writer, &replica] {
        for ev in [&m1, &m2] {
            insert_top_level(pool, community, channel, ev).await;
        }
    }

    let db = Db::from_pools(writer.clone(), replica.clone());
    db.fence().force_open_for_tests(chrono::Utc::now());
    let cid = CommunityId::from_uuid(community);

    // Head page on the writer yields the cursor for a replica-routed page.
    let head = db
        .get_channel_window(cid, channel, 1, None, None)
        .await
        .expect("head window");
    let cursor = head.next_cursor.expect("has_more implies next_cursor");

    // Route the cursor page to the replica and HOLD the session.
    let (window, mut session) = db
        .get_channel_window_with_session(cid, channel, 10, Some(cursor), None)
        .await
        .expect("routed cursor window");
    assert!(
        session.is_replica(),
        "fixture must route this page to the replica"
    );
    assert_eq!(window.rows.len(), 1, "page after m2 is [m1]");

    // Mid-request: a new event commits on the replica (stands in for
    // replay advancing between the page and the aux closure).
    let mid = signed_event_at(&author, "mid-request-commit", base + 5);
    insert_top_level(&replica, community, channel, &mid).await;

    // A fresh autocommit statement on ANOTHER session sees it — the row
    // is really there (control for the assertion below).
    let mut control = EventQuery::for_community(cid);
    control.channel_id = Some(channel);
    let visible_elsewhere = event::query_events(&replica, &control)
        .await
        .expect("control query");
    assert!(
        visible_elsewhere
            .iter()
            .any(|se| se.event.content == "mid-request-commit"),
        "control: the mid-request row must be committed and visible to a new snapshot"
    );

    // The held request session must NOT see it: its snapshot was
    // anchored by the heartbeat observation, before the commit.
    let mut aux = EventQuery::for_community(cid);
    aux.channel_id = Some(channel);
    let in_request = session.query_events(&aux).await.expect("aux query");
    assert!(
        !in_request
            .iter()
            .any(|se| se.event.content == "mid-request-commit"),
        "request transaction must hold the proof-time snapshot; a \
             mid-request commit leaking in means the aux ran outside the \
             request transaction (autocommit connection reuse)"
    );
    // Rows from the proof-time snapshot are still served.
    assert!(
        in_request.iter().any(|se| se.event.content == "m1"),
        "proof-time rows must remain visible in the request snapshot"
    );

    drop(session);
    drop_scratch_db(&admin, replica, &rname).await;
    drop_scratch_db(&admin, writer, &wname).await;
}

/// Head gate (Predicate A): with the budget unset, a head fetch reads
/// the writer even over an open fence; with a budget set and a fresh
/// proved entry, the head page is served by the replica session
/// (bounded staleness accepted); with a budget the fence entry exceeds,
/// the head page falls back to the writer.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn head_fetch_routes_by_configured_budget() {
    let admin = PgPool::connect(&admin_url().await)
        .await
        .expect("connect admin");
    let (writer, wname) = create_scratch_db(&admin, "head_w").await;
    let (replica, rname) = create_scratch_db(&admin, "head_r").await;

    let author = nostr::Keys::generate();
    let community = Uuid::new_v4();
    let channel = Uuid::new_v4();
    seed_community_channel(&writer, community, channel, &author).await;
    seed_community_channel(&replica, community, channel, &author).await;

    let base = 1_700_000_000u64;
    let shared = signed_event_at(&author, "shared", base);
    for pool in [&writer, &replica] {
        insert_top_level(pool, community, channel, &shared).await;
    }
    // Divergent heads prove which pool served the fetch.
    let fresh = signed_event_at(&author, "fresh-writer-only", base + 30);
    insert_top_level(&writer, community, channel, &fresh).await;
    let marker = signed_event_at(&author, "replica-only-marker", base + 20);
    insert_top_level(&replica, community, channel, &marker).await;

    let mut db = Db::from_pools(writer.clone(), replica.clone());
    db.fence().force_open_for_tests(chrono::Utc::now());
    let cid = CommunityId::from_uuid(community);
    let head_contents = |w: &thread::ChannelWindow| -> Vec<String> {
        w.rows
            .iter()
            .map(|r| r.stored_event.event.content.clone())
            .collect()
    };

    // Budget unset (rollout default): head → writer, fence open or not.
    let head = db
        .get_channel_window(cid, channel, 2, None, None)
        .await
        .expect("head, gate off");
    assert_eq!(
        head_contents(&head),
        vec!["fresh-writer-only".to_string(), "shared".to_string()],
        "head routing must default off"
    );

    // Budget set, entry fresh (just recorded): head → replica.
    db.set_replica_read_max_age_for_tests(Some(std::time::Duration::from_secs(5)));
    let head = db
        .get_channel_window(cid, channel, 2, None, None)
        .await
        .expect("head, gate on");
    assert_eq!(
        head_contents(&head),
        vec!["replica-only-marker".to_string(), "shared".to_string()],
        "a fresh proved entry within budget must serve the head from the replica"
    );

    // Entry older than the budget: head falls back to the writer.
    db.fence().close();
    db.fence().force_open_for_tests_at(
        chrono::Utc::now(),
        std::time::Instant::now() - std::time::Duration::from_secs(10),
    );
    let head = db
        .get_channel_window(cid, channel, 2, None, None)
        .await
        .expect("head, entry too old");
    assert_eq!(
        head_contents(&head),
        vec!["fresh-writer-only".to_string(), "shared".to_string()],
        "an over-budget entry must fail the head gate closed"
    );

    drop_scratch_db(&admin, replica, &rname).await;
    drop_scratch_db(&admin, writer, &wname).await;
}

/// End-to-end deploy-default proof for the NEW routed seams: with the
/// budget unset, a covered-eligible query (channel-pinned + `until`)
/// through [`Db::query_events_routed`] is served by the WRITER — the
/// `for_query` gate keeps the covered arm dark (rev 5). With the budget
/// set and a fresh proved entry, the same query routes to the replica.
/// Divergent fixtures prove which pool served each read.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn query_events_routed_defaults_dark_and_routes_covered_when_enabled() {
    let admin = PgPool::connect(&admin_url().await)
        .await
        .expect("connect admin");
    let (writer, wname) = create_scratch_db(&admin, "qer_w").await;
    let (replica, rname) = create_scratch_db(&admin, "qer_r").await;

    let author = nostr::Keys::generate();
    let community = Uuid::new_v4();
    let channel = Uuid::new_v4();
    seed_community_channel(&writer, community, channel, &author).await;
    seed_community_channel(&replica, community, channel, &author).await;

    let base = 1_700_000_000u64;
    let shared = signed_event_at(&author, "shared", base);
    for pool in [&writer, &replica] {
        insert_top_level(pool, community, channel, &shared).await;
    }
    let writer_only = signed_event_at(&author, "writer-only", base + 10);
    insert_top_level(&writer, community, channel, &writer_only).await;
    let replica_only = signed_event_at(&author, "replica-only", base + 20);
    insert_top_level(&replica, community, channel, &replica_only).await;

    let mut db = Db::from_pools(writer.clone(), replica.clone());
    db.fence().force_open_for_tests(chrono::Utc::now());
    let cid = CommunityId::from_uuid(community);

    // Covered-eligible shape: channel-pinned with an `until` upper
    // bound below the (now) fence wall.
    let q = {
        let mut q = EventQuery::for_community(cid);
        q.channel_id = Some(channel);
        q.until = chrono::DateTime::from_timestamp((base + 60) as i64, 0);
        q
    };
    let contents = |evs: &[StoredEvent]| -> std::collections::BTreeSet<String> {
        evs.iter().map(|e| e.event.content.clone()).collect()
    };

    // Deploy default: budget unset ⇒ writer, even though the shape is
    // covered-eligible and the fence is open.
    let rows = db
        .query_events_routed("test_routed", &q)
        .await
        .expect("routed query, gate off");
    assert!(
        contents(&rows).contains("writer-only"),
        "budget unset must serve the writer"
    );
    assert!(
        !contents(&rows).contains("replica-only"),
        "budget unset must not reach the replica via the covered arm"
    );

    // Budget set ⇒ the covered arm serves it from the replica.
    db.set_replica_read_max_age_for_tests(Some(std::time::Duration::from_secs(5)));
    let rows = db
        .query_events_routed("test_routed", &q)
        .await
        .expect("routed query, gate on");
    assert!(
        contents(&rows).contains("replica-only"),
        "budget set + covered-eligible must route to the replica"
    );
    assert!(!contents(&rows).contains("writer-only"));

    drop_scratch_db(&admin, replica, &rname).await;
    drop_scratch_db(&admin, writer, &wname).await;
}

/// COUNT is bounded-only (rev 5 deletion-visibility rule): a
/// covered-eligible shape must NOT let a count take the covered arm.
/// With the budget unset the count reads the WRITER even with an open
/// fence; with the budget set and a fresh entry it reads the replica
/// under the bounded arm. Divergent row counts prove the serving pool.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn count_events_routed_is_bounded_only() {
    let admin = PgPool::connect(&admin_url().await)
        .await
        .expect("connect admin");
    let (writer, wname) = create_scratch_db(&admin, "cnt_w").await;
    let (replica, rname) = create_scratch_db(&admin, "cnt_r").await;

    let author = nostr::Keys::generate();
    let community = Uuid::new_v4();
    let channel = Uuid::new_v4();
    seed_community_channel(&writer, community, channel, &author).await;
    seed_community_channel(&replica, community, channel, &author).await;

    let base = 1_700_000_000u64;
    // Writer: 2 rows. Replica: 1 row.
    for (i, content) in ["a", "b"].iter().enumerate() {
        let ev = signed_event_at(&author, content, base + i as u64);
        insert_top_level(&writer, community, channel, &ev).await;
    }
    let ev = signed_event_at(&author, "c", base);
    insert_top_level(&replica, community, channel, &ev).await;

    let mut db = Db::from_pools(writer.clone(), replica.clone());
    db.fence().force_open_for_tests(chrono::Utc::now());
    let cid = CommunityId::from_uuid(community);

    // Covered-eligible shape on purpose: pinned + until. A count must
    // ignore that eligibility.
    let q = {
        let mut q = EventQuery::for_community(cid);
        q.channel_id = Some(channel);
        q.until = chrono::DateTime::from_timestamp((base + 60) as i64, 0);
        q
    };

    // Budget unset ⇒ bounded arm disabled ⇒ writer.
    let n = db
        .count_events_routed("test_count", &q)
        .await
        .expect("count, gate off");
    assert_eq!(n, 2, "budget unset must count on the writer");

    // Budget set + fresh entry ⇒ bounded arm ⇒ replica.
    db.set_replica_read_max_age_for_tests(Some(std::time::Duration::from_secs(5)));
    let n = db
        .count_events_routed("test_count", &q)
        .await
        .expect("count, gate on");
    assert_eq!(n, 1, "budget set must count on the replica (bounded)");

    // Entry older than the budget ⇒ bounded fails ⇒ writer. Covered
    // would still hold here (upper <= wall) — proving count never
    // consults it.
    db.fence().close();
    db.fence().force_open_for_tests_at(
        chrono::Utc::now(),
        std::time::Instant::now() - std::time::Duration::from_secs(10),
    );
    let n = db
        .count_events_routed("test_count", &q)
        .await
        .expect("count, entry too old");
    assert_eq!(
        n, 2,
        "an over-budget entry must fail the count closed to the writer, \
             even when the covered arm would admit the shape"
    );

    drop_scratch_db(&admin, replica, &rname).await;
    drop_scratch_db(&admin, writer, &wname).await;
}

/// Routed relay-membership check: budget unset ⇒ writer; budget set +
/// fresh proved entry ⇒ replica (bounded arm); over-budget entry ⇒
/// writer. Divergent membership rows prove which pool answered.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn is_relay_member_is_bounded_routed_and_fails_closed() {
    let admin = PgPool::connect(&admin_url().await)
        .await
        .expect("connect admin");
    let (writer, wname) = create_scratch_db(&admin, "mem_w").await;
    let (replica, rname) = create_scratch_db(&admin, "mem_r").await;

    let community = Uuid::new_v4();
    for pool in [&writer, &replica] {
        sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
            .bind(community)
            .bind(format!("member-routing-{}.example", community.simple()))
            .execute(pool)
            .await
            .expect("insert community");
    }
    let cid = CommunityId::from_uuid(community);
    let writer_only = "aa".repeat(32);
    let replica_only = "bb".repeat(32);
    relay_members::add_relay_member(&writer, cid, &writer_only, "member", None)
        .await
        .expect("seed writer member");
    relay_members::add_relay_member(&replica, cid, &replica_only, "member", None)
        .await
        .expect("seed replica member");

    let mut db = Db::from_pools(writer.clone(), replica.clone());
    db.fence().force_open_for_tests(chrono::Utc::now());

    // Budget unset ⇒ bounded arm disabled ⇒ writer.
    assert!(
        db.is_relay_member(cid, &writer_only)
            .await
            .expect("gate off"),
        "budget unset must answer from the writer"
    );
    assert!(!db.is_relay_member(cid, &replica_only).await.unwrap());

    // Budget set + fresh entry ⇒ replica.
    db.set_replica_read_max_age_for_tests(Some(std::time::Duration::from_secs(5)));
    assert!(
        db.is_relay_member(cid, &replica_only)
            .await
            .expect("gate on"),
        "budget set must answer from the replica"
    );
    assert!(!db.is_relay_member(cid, &writer_only).await.unwrap());

    // Entry older than the budget ⇒ fail closed to the writer. Close
    // first so no prior fresh entry can be the one proved (matches the
    // count test; today `force_open_for_tests_at` also clears the ring).
    db.fence().close();
    db.fence().force_open_for_tests_at(
        chrono::Utc::now(),
        std::time::Instant::now() - std::time::Duration::from_secs(10),
    );
    assert!(
        db.is_relay_member(cid, &writer_only)
            .await
            .expect("entry too old"),
        "an over-budget entry must fail closed to the writer"
    );

    drop_scratch_db(&admin, replica, &rname).await;
    drop_scratch_db(&admin, writer, &wname).await;
}

/// Community separation across every routed seam, verified on
/// REPLICA-SERVED reads.
///
/// The pre-existing feed/event scoping tests prove the shared SQL
/// builders confine rows to one community, but they exercise those
/// builders through the WRITER wrapper. `_on` variants are
/// executor-only refactors, so scoping *should* be identical — this
/// test refuses to take that on faith and re-proves it through the
/// routed executor, on a snapshot the replica actually served.
///
/// Construction: two communities A and B exist in BOTH databases with
/// the same ids. The replica additionally holds a `replica-only` row in
/// each — divergent fixtures, so any row bearing that content proves
/// the replica (not the writer) served the read. Every assertion
/// requests A and demands B's rows never appear, including B's
/// `replica-only` row, which is the one a leaky predicate would surface.
/// The routed fallback must cost ONE reader acquire budget, even when the
/// Aurora capability cache is cold.
///
/// Regression test for a stacked-budget bug found at `9fa3c9c0b`: the
/// capability probe used to `acquire()` from the pool itself and return
/// `false` *uncached* on `PoolTimedOut`, so the routed read then spent a
/// SECOND `READER_ACQUIRE_TIMEOUT` inside `begin`. Measured 302ms against
/// a ~150ms documented bound. Boot priming
/// ([`Db::spawn_read_pool_boot_ping`]) hid it only when the boot ping
/// SUCCEEDED — and a reader that is unavailable at boot is exactly the
/// case the bound is specified for, so the two failures are correlated.
///
/// The fixture reproduces that state deliberately: a size-1 reader whose
/// sole connection is established and then HELD (so every further acquire
/// must time out), with `reader_aurora_identity` asserted cold. It routes
/// through `count_events_routed` rather than calling `proved_reader`
/// directly, because `buzz_db_route_decision` is emitted by `route_read`
/// — a direct call would prove the timing but never emit the label.
///
/// Timing uses an upper bound of 2x the budget minus a margin: it must
/// fail for two stacked budgets (~300ms) while tolerating scheduler
/// jitter on one (~150ms). Asserting a lower bound too would pin the
/// budget's own value, which `reader_acquire_timeout_is_the_documented_budget`
/// already covers.
#[tokio::test(flavor = "current_thread")]
#[ignore = "requires Postgres"]
async fn routed_fallback_spends_one_acquire_budget_when_aurora_cache_is_cold() {
    let admin = PgPool::connect(&admin_url().await)
        .await
        .expect("connect admin");
    let (seed, wname) = create_scratch_db(&admin, "one_budget").await;
    seed.close().await;
    let base = admin_url().await;
    let scratch_url = {
        let idx = base.rfind('/').expect("db url has a path segment");
        format!("{}/{}", &base[..idx], wname)
    };

    // `Db::new` so the writer arms the floor guard and the reader is the
    // real lazy `connect_read_pool` pool (min_connections=0, 150ms
    // acquire timeout). Reader is sized 1 so holding one connection
    // saturates it.
    let mut db = Db::new(&DbConfig {
        database_url: scratch_url.clone(),
        read_database_url: Some(scratch_url),
        max_connections: 4,
        read_max_connections: Some(1),
        ..DbConfig::default()
    })
    .await
    .expect("connect armed Db with size-1 lazy reader");
    db.fence().force_open_for_tests(chrono::Utc::now());
    db.set_replica_read_max_age_for_tests(Some(Duration::from_secs(5)));

    let read_pool = db.read_pool.clone().expect("reader pool configured");
    // Establish and hold the reader's only connection: saturated.
    let held = read_pool
        .acquire()
        .await
        .expect("establish the reader's sole connection");
    assert_eq!(
        db.read_max_connections, 1,
        "reader max must report 1 for this fixture to test saturation"
    );
    assert_eq!(
        read_pool.size(),
        1,
        "the sole reader connection is established and held"
    );
    // The bug is only observable with the capability cache cold; if a
    // future change primes it here, this fixture would silently stop
    // discriminating.
    assert!(
        db.reader_aurora_identity.get().is_none(),
        "Aurora capability must be UNPRIMED (post-boot-ping-failure state)"
    );

    let recorder = metrics_util::debugging::DebuggingRecorder::new();
    let snapshotter = recorder.snapshotter();
    let query = EventQuery::for_community(CommunityId::from_uuid(Uuid::new_v4()));

    // The recorder is installed thread-locally, so it must stay installed
    // across the `.await` — hence the guard form rather than
    // `with_local_recorder`, whose closure cannot host an await. The
    // `current_thread` flavor keeps the route decision on this thread; on
    // a multi-thread runtime the emit could land on a worker where no
    // local recorder is installed and the label assertions would vacuously
    // see an empty snapshot.
    let start = std::time::Instant::now();
    let count = {
        let _guard = metrics::set_default_local_recorder(&recorder);
        db.count_events_routed("one_budget_probe", &query).await
    }
    .expect("writer fallback still answers the read");
    let elapsed = start.elapsed();

    assert_eq!(count, 0, "writer answered on an empty scratch database");
    assert!(
        elapsed < Duration::from_millis(250),
        "routed fallback must spend ONE {}ms acquire budget, not two; took {}ms",
        Db::READER_ACQUIRE_TIMEOUT.as_millis(),
        elapsed.as_millis()
    );

    let reasons: std::collections::HashMap<(String, String), u64> = snapshotter
        .snapshot()
        .into_vec()
        .into_iter()
        .filter(|(key, ..)| key.key().name() == "buzz_db_route_decision")
        .map(|(key, _, _, value)| {
            let metrics_util::debugging::DebugValue::Counter(n) = value else {
                panic!("buzz_db_route_decision must be a counter");
            };
            let labels: Vec<_> = key.key().labels().collect();
            let get = |name: &str| {
                labels
                    .iter()
                    .find(|l| l.key() == name)
                    .map(|l| l.value().to_owned())
                    .unwrap_or_default()
            };
            ((get("decision"), get("reason")), n)
        })
        .collect();

    assert_eq!(
        reasons.get(&("writer".to_owned(), "reader_acquire_timeout".to_owned())),
        Some(&1),
        "saturated reader must fall back as writer/reader_acquire_timeout; got {reasons:?}"
    );
    // `reader_validation_error` would mean we misclassified a timeout as a
    // broken reader, and `pool_busy` is the retired name — neither may
    // appear in ANY emitted label.
    assert!(
        !reasons
            .keys()
            .any(|(_, reason)| reason == "reader_validation_error" || reason == "pool_busy"),
        "no reader_validation_error or retired pool_busy label may be emitted; got {reasons:?}"
    );

    drop(held);
    drop_scratch_db(&admin, db.pool.clone(), &wname).await;
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn routed_reads_are_confined_to_the_requested_community() {
    let admin = PgPool::connect(&admin_url().await)
        .await
        .expect("connect admin");
    let (writer, wname) = create_scratch_db(&admin, "sep_w").await;
    let (replica, rname) = create_scratch_db(&admin, "sep_r").await;

    let author = nostr::Keys::generate();
    let (comm_a, chan_a) = (Uuid::new_v4(), Uuid::new_v4());
    let (comm_b, chan_b) = (Uuid::new_v4(), Uuid::new_v4());
    for pool in [&writer, &replica] {
        seed_community_channel(pool, comm_a, chan_a, &author).await;
        seed_community_channel(pool, comm_b, chan_b, &author).await;
    }

    // A p-tag mention is what makes a row eligible for the mentions and
    // needs-action feeds. Kind 9 satisfies mentions + activity;
    // needs-action admits only approval/reminder kinds, so each
    // community also gets a kind-46010 row.
    let mentioned = nostr::Keys::generate();
    let mentioned_hex = mentioned.public_key().to_hex();
    let mentioned_bytes = mentioned.public_key().to_bytes();
    let tagged_kind = |kind: u16, content: &str, secs: u64| {
        nostr::EventBuilder::new(nostr::Kind::Custom(kind), content)
            .tags([nostr::Tag::parse(["p", mentioned_hex.as_str()]).expect("p tag")])
            .custom_created_at(nostr::Timestamp::from(secs))
            .sign_with_keys(&author)
            .expect("sign event")
    };
    let tagged = |content: &str, secs: u64| tagged_kind(9, content, secs);

    let base = 1_700_000_000u64;
    // Shared rows (both DBs) + replica-only rows (divergence) per community.
    let a_shared = tagged("a-shared", base);
    let b_shared = tagged("b-shared", base + 1);
    for pool in [&writer, &replica] {
        insert_top_level(pool, comm_a, chan_a, &a_shared).await;
        insert_mentions(
            pool,
            CommunityId::from_uuid(comm_a),
            &a_shared,
            Some(chan_a),
        )
        .await
        .expect("mentions a-shared");
        insert_top_level(pool, comm_b, chan_b, &b_shared).await;
        insert_mentions(
            pool,
            CommunityId::from_uuid(comm_b),
            &b_shared,
            Some(chan_b),
        )
        .await
        .expect("mentions b-shared");
    }
    let a_replica_only = tagged("a-replica-only", base + 10);
    let b_replica_only = tagged("b-replica-only", base + 11);
    insert_top_level(&replica, comm_a, chan_a, &a_replica_only).await;
    insert_mentions(
        &replica,
        CommunityId::from_uuid(comm_a),
        &a_replica_only,
        Some(chan_a),
    )
    .await
    .expect("mentions a-replica-only");
    insert_top_level(&replica, comm_b, chan_b, &b_replica_only).await;
    insert_mentions(
        &replica,
        CommunityId::from_uuid(comm_b),
        &b_replica_only,
        Some(chan_b),
    )
    .await
    .expect("mentions b-replica-only");

    // Needs-action fixtures: approval kind, replica-only in BOTH
    // communities, so the assertion below is replica-served on A and
    // must still not see B's.
    let a_approval = tagged_kind(46010, "a-approval-replica-only", base + 20);
    let b_approval = tagged_kind(46010, "b-approval-replica-only", base + 21);
    insert_top_level(&replica, comm_a, chan_a, &a_approval).await;
    insert_mentions(
        &replica,
        CommunityId::from_uuid(comm_a),
        &a_approval,
        Some(chan_a),
    )
    .await
    .expect("mentions a-approval");
    insert_top_level(&replica, comm_b, chan_b, &b_approval).await;
    insert_mentions(
        &replica,
        CommunityId::from_uuid(comm_b),
        &b_approval,
        Some(chan_b),
    )
    .await
    .expect("mentions b-approval");

    let mut db = Db::from_pools(writer.clone(), replica.clone());
    db.fence().force_open_for_tests(chrono::Utc::now());
    db.set_replica_read_max_age_for_tests(Some(std::time::Duration::from_secs(5)));
    let cid_a = CommunityId::from_uuid(comm_a);

    let contents = |evs: &[StoredEvent]| -> std::collections::BTreeSet<String> {
        evs.iter().map(|e| e.event.content.clone()).collect()
    };
    // Every routed seam must (a) have been served by the replica —
    // proven by a divergent row absent from the writer — and (b) contain
    // no row belonging to community B. All B fixtures are named `b-*`,
    // so the leak check is a single prefix scan.
    let assert_a_only = |rows: &[StoredEvent], marker: &str, seam: &str| {
        let got = contents(rows);
        assert!(
                got.contains(marker),
                "{seam}: must be replica-served (divergent row `{marker}` absent from writer); got {got:?}"
            );
        assert!(
            !got.iter().any(|c| c.starts_with("b-")),
            "{seam}: community B rows leaked into a community A read; got {got:?}"
        );
    };

    // 1. Generic query — covered arm (channel-pinned + `until`).
    let mut q = EventQuery::for_community(cid_a);
    q.channel_id = Some(chan_a);
    q.until = chrono::DateTime::from_timestamp((base + 60) as i64, 0);
    let rows = db
        .query_events_routed("sep_query", &q)
        .await
        .expect("routed query");
    assert_a_only(&rows, "a-replica-only", "query_events_routed");

    // 2. Generic query — bounded arm (no channel pin at all, so a
    //    missing community predicate could not be masked by the pin).
    let unpinned = EventQuery::for_community(cid_a);
    let rows = db
        .query_events_routed_bounded("sep_query_bounded", &unpinned)
        .await
        .expect("routed bounded query");
    assert_a_only(&rows, "a-replica-only", "query_events_routed_bounded");

    // 3. COUNT — bounded-only. Community A holds 3 rows on the replica
    //    (shared + replica-only + approval) but only 1 on the writer,
    //    and 3 more exist in community B. Exactly 3 proves the read was
    //    both replica-served and community-confined.
    let count = db
        .count_events_routed("sep_count", &unpinned)
        .await
        .expect("routed count");
    assert_eq!(
        count, 3,
        "count must see A's three replica rows only — not B's, not the writer's one"
    );

    // 4. By-ID hydration — ids carry no channel pin, and B's ids are
    //    requested alongside A's. Only A's may hydrate.
    let ids: Vec<&[u8]> = vec![
        a_shared.id.as_bytes(),
        a_replica_only.id.as_bytes(),
        b_shared.id.as_bytes(),
        b_replica_only.id.as_bytes(),
    ];
    let rows = db
        .get_events_by_ids_routed("sep_by_ids", cid_a, &ids)
        .await
        .expect("routed by-ids");
    assert_a_only(&rows, "a-replica-only", "get_events_by_ids_routed");

    // 5-7. All three feed builders, each given BOTH channels as
    //      accessible — so only the community predicate can exclude B.
    let both = [chan_a, chan_b];
    let rows = db
        .query_feed_mentions_routed("sep_feed", cid_a, &mentioned_bytes, &both, None, 50)
        .await
        .expect("routed mentions");
    assert_a_only(&rows, "a-replica-only", "query_feed_mentions_routed");

    let rows = db
        .query_feed_needs_action_routed("sep_feed", cid_a, &mentioned_bytes, &both, None, 50)
        .await
        .expect("routed needs action");
    assert_a_only(
        &rows,
        "a-approval-replica-only",
        "query_feed_needs_action_routed",
    );

    let rows = db
        .query_feed_activity_routed("sep_feed", cid_a, &both, None, 50)
        .await
        .expect("routed activity");
    assert_a_only(&rows, "a-replica-only", "query_feed_activity_routed");

    drop_scratch_db(&admin, replica, &rname).await;
    drop_scratch_db(&admin, writer, &wname).await;
}

/// D4: a LAZY reader pool (connect_lazy, min_connections=0, never yet
/// used) must still let [`Db::spawn_fence_probe`] verify the writer's
/// floor guard and spawn — reader-down or reader-idle at boot must not
/// disable fence probing.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn lazy_reader_pool_still_spawns_fence_probe() {
    let admin = PgPool::connect(&admin_url().await)
        .await
        .expect("connect admin");
    let (seed, wname) = create_scratch_db(&admin, "lazy_w").await;
    seed.close().await;

    let writer_url = {
        let base = admin_url().await;
        let idx = base.rfind('/').expect("db url has a path segment");
        format!("{}/{}", &base[..idx], wname)
    };
    // `Db::new` (not `from_pools`) so the WRITER pool arms the
    // `buzz.created_at_floor` GUC — `spawn_fence_probe` verifies the
    // floor guard on a writer connection, and `create_scratch_db`'s
    // plain `PgPool::connect` never arms it. The reader is still the
    // lazy `connect_read_pool` pool this test is about.
    let db = Db::new(&DbConfig {
        database_url: writer_url.clone(),
        read_database_url: Some(writer_url),
        max_connections: 2,
        ..DbConfig::default()
    })
    .await
    .expect("connect armed Db with lazy reader");

    let spawned = db
        .spawn_fence_probe()
        .await
        .expect("floor-guard verification must pass on the migrated writer");
    assert!(spawned, "a configured (lazy) reader must spawn the probe");

    drop_scratch_db(&admin, db.pool.clone(), &wname).await;
}

/// Thread replies: head fetch reads the writer; a FULL cursor page is
/// served by the replica; an UNDER-limit cursor page (candidate terminal
/// page) is re-run on the writer so a lagged replica can never truncate
/// the tail into a false EOF.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn thread_replies_cursor_pages_route_to_replica_with_writer_terminal_verification() {
    let admin = PgPool::connect(&admin_url().await)
        .await
        .expect("connect admin");
    let (writer, wname) = create_scratch_db(&admin, "routing_tw").await;
    let (replica, rname) = create_scratch_db(&admin, "routing_tr").await;

    let author = nostr::Keys::generate();
    let community = Uuid::new_v4();
    let channel = Uuid::new_v4();
    seed_community_channel(&writer, community, channel, &author).await;
    seed_community_channel(&replica, community, channel, &author).await;

    let base = 1_700_000_000u64;
    let root = signed_event_at(&author, "root", base);
    for pool in [&writer, &replica] {
        insert_top_level(pool, community, channel, &root).await;
    }

    // Writer holds replies r1..r5; the lagged replica only has r1..r3.
    let replies: Vec<nostr::Event> = (1..=5)
        .map(|i| signed_event_at(&author, &format!("r{i}"), base + 10 * i as u64))
        .collect();
    for reply in &replies {
        insert_thread_reply(&writer, community, channel, &root, reply).await;
    }
    for reply in &replies[..3] {
        insert_thread_reply(&replica, community, channel, &root, reply).await;
    }

    let db = Db::from_pools(writer.clone(), replica.clone());
    // Open the fence through "now" — fixture history is far in the past.
    db.fence().force_open_for_tests(chrono::Utc::now());
    let cid = CommunityId::from_uuid(community);

    // Page 1 (no cursor) → writer.
    let page1 = db
        .get_thread_replies(cid, root.id.as_bytes(), Some(10), 2, None)
        .await
        .expect("page 1");
    let contents: Vec<&str> = page1
        .iter()
        .map(|r| r.stored_event.event.content.as_str())
        .collect();
    assert_eq!(contents, vec!["r1", "r2"], "head page from writer");

    // Page 2: replica serves a FULL page (r3 exists there) — but wait:
    // replica has r1..r3, page after r2 with limit 2 returns only [r3]
    // (under limit) → terminal-verification re-runs on the writer, which
    // returns [r3, r4]. A lag-truncated EOF must never surface.
    let cur2 = thread_cursor(page1.last().expect("page 1 non-empty"));
    let page2 = db
        .get_thread_replies(cid, root.id.as_bytes(), Some(10), 2, Some(&cur2))
        .await
        .expect("page 2");
    let contents: Vec<&str> = page2
        .iter()
        .map(|r| r.stored_event.event.content.as_str())
        .collect();
    assert_eq!(
        contents,
        vec!["r3", "r4"],
        "under-limit replica page must be re-verified on the writer"
    );

    // Full-page replica serve: with limit 1, the page after r2 is [r3] —
    // exactly `limit` rows, so the replica result stands. Prove it came
    // from the replica with a replica-only divergent reply.
    let ghost = signed_event_at(&author, "replica-only-ghost", base + 25);
    insert_thread_reply(&replica, community, channel, &root, &ghost).await;
    let page_replica = db
        .get_thread_replies(cid, root.id.as_bytes(), Some(10), 1, Some(&cur2))
        .await
        .expect("full replica page");
    let contents: Vec<&str> = page_replica
        .iter()
        .map(|r| r.stored_event.event.content.as_str())
        .collect();
    assert_eq!(
        contents,
        vec!["replica-only-ghost"],
        "a full cursor page must be served by the replica"
    );

    // Same query with no replica configured reads the writer and cannot
    // see the ghost.
    let db_writer_only = Db::from_pool(writer.clone());
    let page_writer = db_writer_only
        .get_thread_replies(cid, root.id.as_bytes(), Some(10), 1, Some(&cur2))
        .await
        .expect("writer-only page");
    let contents: Vec<&str> = page_writer
        .iter()
        .map(|r| r.stored_event.event.content.as_str())
        .collect();
    assert_eq!(contents, vec!["r3"], "unset replica falls back to writer");

    drop_scratch_db(&admin, replica, &rname).await;
    drop_scratch_db(&admin, writer, &wname).await;
}

/// Channel DESC scrollback, out-of-order commit adversary: the replica is
/// missing a MIDDLE row (`m2`) because a transaction with an older
/// client-signed `created_at` committed late and has not replayed yet.
/// The replica's cursor page would be `[m1]` — silently skipping `m2`
/// forever, since the next cursor advances past it. The fence must route
/// any cursor above it to the writer.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn channel_cursor_above_fence_stays_on_writer_preventing_middle_hole() {
    let admin = PgPool::connect(&admin_url().await)
        .await
        .expect("connect admin");
    let (writer, wname) = create_scratch_db(&admin, "fence_cw").await;
    let (replica, rname) = create_scratch_db(&admin, "fence_cr").await;

    let author = nostr::Keys::generate();
    let community = Uuid::new_v4();
    let channel = Uuid::new_v4();
    seed_community_channel(&writer, community, channel, &author).await;
    seed_community_channel(&replica, community, channel, &author).await;

    let base = 1_700_000_000u64;
    let m1 = signed_event_at(&author, "m1", base);
    let m2 = signed_event_at(&author, "m2-late-commit", base + 10);
    let m3 = signed_event_at(&author, "m3", base + 20);
    let m4 = signed_event_at(&author, "m4", base + 30);
    for ev in [&m1, &m2, &m3, &m4] {
        insert_top_level(&writer, community, channel, ev).await;
    }
    // Replica replayed everything EXCEPT the late-committed m2.
    for ev in [&m1, &m3, &m4] {
        insert_top_level(&replica, community, channel, ev).await;
    }

    let db = Db::from_pools(writer.clone(), replica.clone());
    let cid = CommunityId::from_uuid(community);

    // Head page (writer): [m4, m3]; cursor lands on m3 (base+20).
    let head = db
        .get_channel_window(cid, channel, 2, None, None)
        .await
        .expect("head window");
    let cursor = head.next_cursor.expect("has_more implies next_cursor");

    // Fence closed → cursor page must come from the writer: m2 present.
    let contents = |w: &thread::ChannelWindow| -> Vec<String> {
        w.rows
            .iter()
            .map(|r| r.stored_event.event.content.clone())
            .collect()
    };
    let page_closed = db
        .get_channel_window(cid, channel, 10, Some(cursor.clone()), None)
        .await
        .expect("cursor page, fence closed");
    assert_eq!(
        contents(&page_closed),
        vec!["m2-late-commit".to_string(), "m1".to_string()],
        "fence closed: cursor pages route to the writer"
    );

    // Fence open but BELOW the cursor timestamp (covers base+5 only):
    // the cursor (base+20) is not covered → writer again.
    db.fence()
        .force_open_for_tests(chrono::DateTime::from_timestamp(base as i64 + 5, 0).expect("ts"));
    let page_below = db
        .get_channel_window(cid, channel, 10, Some(cursor.clone()), None)
        .await
        .expect("cursor page, fence below cursor");
    assert_eq!(
        contents(&page_below),
        vec!["m2-late-commit".to_string(), "m1".to_string()],
        "cursor above the fence must stay on the writer"
    );

    // Counterfactual pinning the hazard: were the fence (wrongly) open
    // through now, the replica would serve the page WITHOUT m2 — the
    // permanent-skip hole this fence exists to prevent.
    db.fence().force_open_for_tests(chrono::Utc::now());
    let page_hazard = db
        .get_channel_window(cid, channel, 10, Some(cursor), None)
        .await
        .expect("cursor page, fence wrongly open");
    assert_eq!(
        contents(&page_hazard),
        vec!["m1".to_string()],
        "fixture models the inversion: an over-open fence would skip m2"
    );

    drop_scratch_db(&admin, replica, &rname).await;
    drop_scratch_db(&admin, writer, &wname).await;
}

/// Thread ASC pagination, out-of-order commit adversary: the replica
/// holds a FULL page whose newest row (`r4`) has a later key than a
/// not-yet-replayed row (`r3`). The old under-limit check alone would
/// serve `[r4]` and the client cursor would advance past `r3` forever.
/// The fence rule (full AND tail ≤ fence) must send that page to the
/// writer instead.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn thread_full_replica_page_above_fence_is_reverified_on_writer() {
    let admin = PgPool::connect(&admin_url().await)
        .await
        .expect("connect admin");
    let (writer, wname) = create_scratch_db(&admin, "fence_tw").await;
    let (replica, rname) = create_scratch_db(&admin, "fence_tr").await;

    let author = nostr::Keys::generate();
    let community = Uuid::new_v4();
    let channel = Uuid::new_v4();
    seed_community_channel(&writer, community, channel, &author).await;
    seed_community_channel(&replica, community, channel, &author).await;

    let base = 1_700_000_000u64;
    let root = signed_event_at(&author, "root", base);
    for pool in [&writer, &replica] {
        insert_top_level(pool, community, channel, &root).await;
    }
    let replies: Vec<nostr::Event> = (1..=4)
        .map(|i| signed_event_at(&author, &format!("r{i}"), base + 10 * i as u64))
        .collect();
    for reply in &replies {
        insert_thread_reply(&writer, community, channel, &root, reply).await;
    }
    // Replica replayed r1, r2, r4 — the late-committed r3 is missing.
    for reply in [&replies[0], &replies[1], &replies[3]] {
        insert_thread_reply(&replica, community, channel, &root, reply).await;
    }

    let db = Db::from_pools(writer.clone(), replica.clone());
    let cid = CommunityId::from_uuid(community);

    // Fence covers r2 (base+20) but not r3/r4.
    db.fence()
        .force_open_for_tests(chrono::DateTime::from_timestamp(base as i64 + 20, 0).expect("ts"));

    // Page after r2 with limit 1: the replica would return the FULL page
    // [r4] — but its tail is above the fence, so the writer re-runs it
    // and returns [r3]. No skip.
    let page1 = db
        .get_thread_replies(cid, root.id.as_bytes(), Some(10), 2, None)
        .await
        .expect("head page");
    let cur = thread_cursor(page1.last().expect("head page non-empty"));
    let page = db
        .get_thread_replies(cid, root.id.as_bytes(), Some(10), 1, Some(&cur))
        .await
        .expect("cursor page");
    let contents: Vec<&str> = page
        .iter()
        .map(|r| r.stored_event.event.content.as_str())
        .collect();
    assert_eq!(
        contents,
        vec!["r3"],
        "a full replica page above the fence must be re-run on the writer"
    );

    // Counterfactual: an over-open fence would serve the replica's [r4],
    // skipping r3 permanently.
    db.fence().force_open_for_tests(chrono::Utc::now());
    let hazard = db
        .get_thread_replies(cid, root.id.as_bytes(), Some(10), 1, Some(&cur))
        .await
        .expect("hazard page");
    let contents: Vec<&str> = hazard
        .iter()
        .map(|r| r.stored_event.event.content.as_str())
        .collect();
    assert_eq!(
        contents,
        vec!["r4"],
        "fixture models the inversion: an over-open fence would skip r3"
    );

    drop_scratch_db(&admin, replica, &rname).await;
    drop_scratch_db(&admin, writer, &wname).await;
}

/// Commit-time floor guard (migration 0021), exact held-transaction
/// adversary: a channel-bearing row whose `created_at` is older than the
/// floor at COMMIT time must abort the transaction — the guard runs
/// inside commit processing with `clock_timestamp()`, so holding the
/// transaction open cannot outrun it. channel_id-NULL rows are
/// structurally exempt, and sessions without the GUC are unaffected.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn created_at_floor_guard_aborts_old_channel_rows_at_commit() {
    let admin = PgPool::connect(&admin_url().await)
        .await
        .expect("connect admin");
    let (pool, name) = create_scratch_db(&admin, "floor_guard").await;

    let author = nostr::Keys::generate();
    let community = Uuid::new_v4();
    let channel = Uuid::new_v4();
    seed_community_channel(&pool, community, channel, &author).await;

    let insert_raw = |ev: nostr::Event, channel_id: Option<Uuid>| {
        let pool = pool.clone();
        async move {
            let mut tx = pool.begin().await.expect("begin");
            // Arm the guard for this transaction only (the relay's
            // writer pool arms it per connection; tests are explicit).
            sqlx::query("SELECT set_config('buzz.created_at_floor', $1, true)")
                .bind(crate::replica_fence::CREATED_AT_FLOOR_SECS.to_string())
                .execute(&mut *tx)
                .await
                .expect("arm guard");
            sqlx::query(
                "INSERT INTO events (community_id, id, pubkey, created_at, kind, tags, \
                     content, sig, received_at, channel_id) \
                     VALUES ($1, $2, $3, to_timestamp($4), 9, '[]', $5, $6, NOW(), $7)",
            )
            .bind(community)
            .bind(ev.id.as_bytes().as_slice())
            .bind(ev.pubkey.to_bytes().as_slice())
            .bind(ev.created_at.as_secs() as f64)
            .bind(&ev.content)
            .bind(ev.sig.serialize().as_slice())
            .bind(channel_id)
            .execute(&mut *tx)
            .await
            .expect("insert inside tx (guard is deferred to commit)");
            // Hold the transaction "open" past the insert, then commit —
            // the deferred guard must still see the stale created_at.
            sqlx::query("SELECT pg_sleep(0.05)")
                .execute(&mut *tx)
                .await
                .expect("hold tx");
            tx.commit().await
        }
    };

    let now_secs = chrono::Utc::now().timestamp() as u64;
    let floor = crate::replica_fence::CREATED_AT_FLOOR_SECS as u64;

    // Old channel-bearing row → COMMIT aborts with check_violation.
    let old = signed_event_at(&author, "old-held-tx", now_secs - floor - 60);
    let err = insert_raw(old, Some(channel))
        .await
        .expect_err("below-floor channel row must abort at COMMIT");
    let code = match &err {
        sqlx::Error::Database(db_err) => db_err.code().map(|c| c.to_string()),
        other => panic!("expected database error, got {other:?}"),
    };
    assert_eq!(
        code.as_deref(),
        Some("23514"),
        "guard raises check_violation"
    );

    // Fresh channel-bearing row → commits.
    let fresh = signed_event_at(&author, "fresh", now_secs);
    insert_raw(fresh, Some(channel))
        .await
        .expect("fresh row commits under the armed guard");

    // Old row WITHOUT a channel (push lease / profile shapes) →
    // structurally exempt, commits.
    let old_global = signed_event_at(&author, "old-global", now_secs - floor - 60);
    insert_raw(old_global, None)
        .await
        .expect("channel_id-NULL rows are exempt from the floor");

    // Unarmed session (no GUC) → guard inert; backfills stay possible
    // (and must hold the fence closed, per the migration header).
    let old_backfill = signed_event_at(&author, "old-backfill", now_secs - floor - 60);
    insert_top_level(&pool, community, channel, &old_backfill).await;

    drop_scratch_db(&admin, pool, &name).await;
}

#[test]
fn writer_pool_safety_hook_is_single_and_composed() {
    let source = include_str!("mod.rs");
    let connect_pool = source
        .split("async fn connect_pool")
        .nth(1)
        .and_then(|tail| tail.split("const READER_ACQUIRE_TIMEOUT").next())
        .expect("connect_pool source block");
    assert_eq!(
        connect_pool.matches(".after_connect(").count(),
        1,
        "SQLx replaces after_connect hooks; writer safety must use exactly one"
    );
    assert!(connect_pool.contains("buzz.created_at_floor"));
    assert!(connect_pool.contains("SHOW transaction_isolation"));
    assert!(!connect_pool.contains("arm_floor_guard"));
    assert!(!connect_pool.contains("_arm_floor_guard"));
    assert!(!connect_pool.contains("allow(unused_variables)"));

    let reader_doc = source
        .split("fn connect_read_pool")
        .next()
        .and_then(|prefix| prefix.rsplit("/// Connect the read-replica").next())
        .expect("reader pool documentation");
    assert!(reader_doc.contains("replica sessions are"));
    assert!(reader_doc.contains("read-only"));
    assert!(!reader_doc.contains("Db::connect_pool"));
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn writer_pool_rejects_non_read_committed_database_default() {
    let admin = PgPool::connect(&admin_url().await)
        .await
        .expect("connect admin");
    let (seed_pool, name) = create_scratch_db(&admin, "writer_isolation").await;
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "ALTER DATABASE {name} SET default_transaction_isolation = 'repeatable read'"
    )))
    .execute(&admin)
    .await
    .expect("set unsafe database default");
    seed_pool.close().await;

    let base = admin_url().await;
    let idx = base.rfind('/').expect("db url has a path segment");
    let scratch_url = format!("{}/{}", &base[..idx], name);
    let error = Db::new(&DbConfig {
        database_url: scratch_url,
        max_connections: 1,
        min_connections: 1,
        acquire_timeout_secs: 1,
        ..DbConfig::default()
    })
    .await
    .expect_err("writer pool must reject pinned-snapshot database defaults");
    assert!(
        error.to_string().contains("requires READ COMMITTED")
            || error.to_string().contains("pool timed out"),
        "unexpected isolation rejection: {error}"
    );

    sqlx::query(sqlx::AssertSqlSafe(format!(
        "DROP DATABASE {name} WITH (FORCE)"
    )))
    .execute(&admin)
    .await
    .expect("drop isolation test database");
}

/// The armed writer pool (`Db::new`) must enforce the floor end-to-end
/// through the public insert APIs, and the session GUC must be verifiably
/// set on pooled connections.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn armed_pool_rejects_old_channel_inserts_through_public_api() {
    let admin = PgPool::connect(&admin_url().await)
        .await
        .expect("connect admin");
    let (seed_pool, name) = create_scratch_db(&admin, "floor_pool").await;

    let author = nostr::Keys::generate();
    let community = Uuid::new_v4();
    let channel = Uuid::new_v4();
    seed_community_channel(&seed_pool, community, channel, &author).await;

    // Connect a Db the production way: after_connect arms the guard.
    let base = admin_url().await;
    let idx = base.rfind('/').expect("db url has a path segment");
    let scratch_url = format!("{}/{}", &base[..idx], name);
    let db = Db::new(&DbConfig {
        database_url: scratch_url,
        max_connections: 2,
        ..DbConfig::default()
    })
    .await
    .expect("connect armed Db");
    let cid = CommunityId::from_uuid(community);

    // Perci nit: assert the effective session value, not the intent.
    let effective: String = sqlx::query_scalar("SHOW buzz.created_at_floor")
        .fetch_one(&db.pool)
        .await
        .expect("SHOW guard GUC");
    assert_eq!(
        effective,
        crate::replica_fence::CREATED_AT_FLOOR_SECS.to_string(),
        "writer pool must arm the floor guard on every connection"
    );
    let isolation: String = sqlx::query_scalar("SHOW transaction_isolation")
        .fetch_one(&db.pool)
        .await
        .expect("SHOW writer isolation");
    assert_eq!(
        isolation, "read committed",
        "the same writer after_connect hook must enforce the isolation premise"
    );

    let now_secs = chrono::Utc::now().timestamp() as u64;
    let floor = crate::replica_fence::CREATED_AT_FLOOR_SECS as u64;

    // insert_event (single INSERT, autocommit): old channel row rejected.
    let old = signed_event_at(&author, "old-direct", now_secs - floor - 60);
    let err = event::insert_event(&db.pool, cid, &old, Some(channel))
        .await
        .expect_err("armed pool must reject below-floor channel inserts");
    assert!(
        err.to_string().contains("below the replica-fence floor"),
        "unexpected error: {err}"
    );

    // insert_event_with_thread_metadata (multi-statement tx): same.
    let old2 = signed_event_at(&author, "old-thread-meta", now_secs - floor - 90);
    let ts =
        chrono::DateTime::from_timestamp(old2.created_at.as_secs() as i64, 0).expect("valid ts");
    let err = event::insert_event_with_thread_metadata(
        &db.pool,
        cid,
        &old2,
        Some(channel),
        Some(event::ThreadMetadataParams {
            event_id: old2.id.as_bytes(),
            event_created_at: ts,
            channel_id: channel,
            parent_event_id: None,
            parent_event_created_at: None,
            root_event_id: None,
            root_event_created_at: None,
            depth: 0,
            broadcast: true,
        }),
    )
    .await
    .expect_err("armed pool must reject below-floor thread-metadata inserts");
    assert!(
        err.to_string().contains("below the replica-fence floor"),
        "unexpected error: {err}"
    );

    // Fresh events pass through both APIs.
    let fresh = signed_event_at(&author, "fresh-direct", now_secs);
    event::insert_event(&db.pool, cid, &fresh, Some(channel))
        .await
        .expect("fresh insert passes the armed guard");

    drop_scratch_db(&admin, seed_pool, &name).await;
    // db pool still holds connections to the dropped DB; close it.
    db.pool.close().await;
}

/// `spawn_fence_probe` must verify the floor guard before letting the
/// probe run — catalog shape AND observed behavior — and refuse on
/// sabotage. This is the production gate for a relay running with
/// `BUZZ_AUTO_MIGRATE` off: an armed GUC with no enforcing trigger must
/// never yield an open fence.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn fence_probe_refuses_to_start_without_verified_floor_guard() {
    let admin = PgPool::connect(&admin_url().await)
        .await
        .expect("connect admin");
    let (seed_pool, wname) = create_scratch_db(&admin, "fence_gate_w").await;
    let (replica_pool, rname) = create_scratch_db(&admin, "fence_gate_r").await;
    seed_pool.close().await;
    replica_pool.close().await;

    let base = admin_url().await;
    let idx = base.rfind('/').expect("db url has a path segment");
    let writer_url = format!("{}/{}", &base[..idx], wname);
    let replica_url = format!("{}/{}", &base[..idx], rname);

    // Healthy schema: verification passes, probe starts. A SEPARATE Db
    // instance, because its background probe legitimately opens its own
    // fence (the heartbeat probe is writer-side only) — the refusal
    // assertions below must run against a fence whose spawns were all
    // refused.
    let db_healthy = Db::new(&DbConfig {
        database_url: writer_url.clone(),
        read_database_url: Some(replica_url.clone()),
        max_connections: 2,
        ..DbConfig::default()
    })
    .await
    .expect("connect armed Db with replica");
    assert!(
        db_healthy
            .spawn_fence_probe()
            .await
            .expect("verification passes"),
        "probe must start on a verified schema"
    );

    let db = Db::new(&DbConfig {
        database_url: writer_url,
        read_database_url: Some(replica_url),
        max_connections: 2,
        ..DbConfig::default()
    })
    .await
    .expect("connect armed Db with replica");

    // Sabotage A: catalog-shaped no-op — same trigger, gutted function
    // body. Catalog check alone would pass; behavior check must refuse.
    sqlx::query(
        "CREATE OR REPLACE FUNCTION events_created_at_floor_guard() RETURNS trigger \
             LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$",
    )
    .execute(&db.pool)
    .await
    .expect("gut the guard function");
    let err = db
        .spawn_fence_probe()
        .await
        .expect_err("inert guard body must refuse the probe");
    assert!(
        err.to_string().contains("floor guard is inert"),
        "unexpected error: {err}"
    );

    // Sabotage B: trigger dropped entirely (the BUZZ_AUTO_MIGRATE=off /
    // 0021-unapplied shape). Catalog check must refuse.
    sqlx::query("DROP TRIGGER events_created_at_floor ON events")
        .execute(&db.pool)
        .await
        .expect("drop the guard trigger");
    let err = db
        .spawn_fence_probe()
        .await
        .expect_err("missing trigger must refuse the probe");
    assert!(
        err.to_string().contains("missing or mis-shaped"),
        "unexpected error: {err}"
    );

    // In both refusal states the fence never opened.
    assert!(
        db.fence().verified_through().is_none(),
        "fence must remain closed when verification refuses the probe"
    );

    db_healthy.pool.close().await;
    if let Some(rp) = &db_healthy.read_pool {
        rp.close().await;
    }
    db.pool.close().await;
    if let Some(rp) = &db.read_pool {
        rp.close().await;
    }
    let _ = sqlx::query(sqlx::AssertSqlSafe(format!(
        "DROP DATABASE IF EXISTS {wname} WITH (FORCE)"
    )))
    .execute(&admin)
    .await;
    let _ = sqlx::query(sqlx::AssertSqlSafe(format!(
        "DROP DATABASE IF EXISTS {rname} WITH (FORCE)"
    )))
    .execute(&admin)
    .await;
}

/// The `UPDATE OF` arm of the floor guard (Perci's second structural
/// hole): an old row legitimately admitted with `channel_id` NULL must
/// not be movable into keyset windows, and a channel row's `created_at`
/// must not be movable below the fence — through raw SQL, at COMMIT.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn floor_guard_blocks_updates_that_move_rows_below_the_fence() {
    let admin = PgPool::connect(&admin_url().await)
        .await
        .expect("connect admin");
    let (pool, name) = create_scratch_db(&admin, "floor_upd").await;

    let author = nostr::Keys::generate();
    let community = Uuid::new_v4();
    let channel = Uuid::new_v4();
    seed_community_channel(&pool, community, channel, &author).await;

    let now_secs = chrono::Utc::now().timestamp() as u64;
    let floor = crate::replica_fence::CREATED_AT_FLOOR_SECS as u64;

    // Seed via unarmed session: one old channel-NULL row, one fresh
    // channel row.
    let old_null = signed_event_at(&author, "old-null", now_secs - floor - 120);
    insert_top_level(&pool, community, channel, &old_null).await;
    sqlx::query("UPDATE events SET channel_id = NULL WHERE community_id = $1 AND id = $2")
        .bind(community)
        .bind(old_null.id.as_bytes().as_slice())
        .execute(&pool)
        .await
        .expect("detach channel (unarmed seed)");
    let fresh = signed_event_at(&author, "fresh-row", now_secs);
    insert_top_level(&pool, community, channel, &fresh).await;

    // Armed transaction, deferred to COMMIT (the production shape).
    let run_armed_update = |sql: &'static str, id: Vec<u8>, age: Option<u64>| {
        let pool = pool.clone();
        async move {
            let mut tx = pool.begin().await.expect("begin");
            sqlx::query("SELECT set_config('buzz.created_at_floor', $1, true)")
                .bind(crate::replica_fence::CREATED_AT_FLOOR_SECS.to_string())
                .execute(&mut *tx)
                .await
                .expect("arm guard");
            let q = sqlx::query(sql).bind(community).bind(id);
            let q = match age {
                Some(a) => q.bind(a as f64),
                None => q,
            };
            q.execute(&mut *tx)
                .await
                .expect("update inside tx (deferred)");
            tx.commit().await
        }
    };

    // channel-NULL → channel-bearing on an old row: COMMIT must abort.
    let err = run_armed_update(
        "UPDATE events SET channel_id = community_id WHERE community_id = $1 AND id = $2",
        old_null.id.as_bytes().to_vec(),
        None,
    )
    .await
    .expect_err("moving an old channel-NULL row into a channel must abort at COMMIT");
    assert!(
        matches!(&err, sqlx::Error::Database(e) if e.code().as_deref() == Some("23514")),
        "unexpected error: {err}"
    );

    // created_at rewrite below the floor on a channel row: COMMIT must abort.
    let err = run_armed_update(
            "UPDATE events SET created_at = clock_timestamp() - make_interval(secs => $3::double precision) \
             WHERE community_id = $1 AND id = $2",
            fresh.id.as_bytes().to_vec(),
            Some(floor + 120),
        )
        .await
        .expect_err("rewriting created_at below the floor must abort at COMMIT");
    assert!(
        matches!(&err, sqlx::Error::Database(e) if e.code().as_deref() == Some("23514")),
        "unexpected error: {err}"
    );

    drop_scratch_db(&admin, pool, &name).await;
}
