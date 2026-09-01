//! Scheduled event-reminder persistence.

use crate::{Db, Result};
use buzz_core::{kind::KIND_EVENT_REMINDER, CommunityId};
use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row};
use uuid::Uuid;

/// A due reminder row returned by [`query_due_reminders`].
#[derive(Debug)]
pub struct DueReminder {
    /// Server-resolved community this reminder row belongs to.
    pub community_id: CommunityId,
    /// Normalized host mapped to that community.
    pub host: String,
    /// The event's raw ID bytes.
    pub id: Vec<u8>,
    /// The event's pubkey bytes.
    pub pubkey: Vec<u8>,
    /// The event's `created_at` timestamp.
    pub created_at: DateTime<Utc>,
    /// The event's kind (always 30300).
    pub kind: i32,
    /// The event's JSONB tags.
    pub tags: serde_json::Value,
    /// The event's encrypted content.
    pub content: String,
    /// The event's signature bytes.
    pub sig: Vec<u8>,
    /// The channel ID (always None for reminders — global events).
    pub channel_id: Option<Uuid>,
}

/// Query due reminders: latest-per-address `kind:30300` rows where
/// `not_before <= now`, `deleted_at IS NULL`, `delivered_at IS NULL`.
///
/// Returns the latest head per `(pubkey, d_tag)` using canonical NIP-16
/// ordering (`created_at DESC, id ASC`).
pub async fn query_due_reminders(
    pool: &PgPool,
    now_secs: i64,
    batch_limit: i64,
) -> Result<Vec<DueReminder>> {
    let kind_i32 = KIND_EVENT_REMINDER as i32;
    let rows = sqlx::query(
        r#"
        SELECT DISTINCT ON (e.community_id, e.pubkey, e.d_tag)
            e.community_id, c.host, e.id, e.pubkey, e.created_at, e.kind, e.tags, e.content, e.sig, e.channel_id
        FROM events AS e
        JOIN communities AS c ON c.id = e.community_id
        WHERE e.kind = $1
          AND e.not_before IS NOT NULL
          AND e.not_before <= $2
          AND e.deleted_at IS NULL
          AND e.delivered_at IS NULL
          AND c.archived_at IS NULL
        ORDER BY e.community_id, e.pubkey, e.d_tag, e.created_at DESC, e.id ASC
        LIMIT $3
        "#,
    )
    .bind(kind_i32)
    .bind(now_secs)
    .bind(batch_limit)
    .fetch_all(pool)
    .await?;

    let results = rows
        .into_iter()
        .map(|row| DueReminder {
            community_id: CommunityId::from_uuid(row.get("community_id")),
            host: row.get("host"),
            id: row.get("id"),
            pubkey: row.get("pubkey"),
            created_at: row.get("created_at"),
            kind: row.get("kind"),
            tags: row.get("tags"),
            content: row.get("content"),
            sig: row.get("sig"),
            channel_id: row.get("channel_id"),
        })
        .collect();

    Ok(results)
}

/// Atomically claim a due reminder for delivery. Returns `Some(id)` if this
/// caller won the claim (set `delivered_at`), or `None` if another pod already
/// claimed it. Mirrors the reaper's `archived_at IS NULL` guard for cross-pod
/// idempotency.
pub async fn claim_due_reminder(
    pool: &PgPool,
    community_id: CommunityId,
    event_id: &[u8],
    event_created_at: DateTime<Utc>,
) -> Result<bool> {
    claim_due_reminder_with_stamp(
        pool,
        community_id,
        event_id,
        event_created_at,
        Utc::now().timestamp(),
    )
    .await
}

/// Atomically claim a due reminder using a caller-supplied delivery stamp.
///
/// The same stamp should be passed to [`release_due_reminder`] if the publish
/// side effect fails, so rollback can compare-and-clear only this pod's claim.
///
/// Scoped by `community_id`: `events` is keyed `(community_id, created_at, id)`,
/// and the same Nostr event id (hence the same `id`/`created_at` pair) is
/// allowed across communities. Without the community predicate a claim for
/// `A/X` would also mark `B/X` delivered. The caller already holds the owning
/// community on the `DueReminder` row.
pub async fn claim_due_reminder_with_stamp(
    pool: &PgPool,
    community_id: CommunityId,
    event_id: &[u8],
    event_created_at: DateTime<Utc>,
    delivery_stamp: i64,
) -> Result<bool> {
    let result = sqlx::query(
        r#"
        UPDATE events
        SET delivered_at = $1
        WHERE community_id = $2 AND created_at = $3 AND id = $4 AND delivered_at IS NULL
        "#,
    )
    .bind(delivery_stamp)
    .bind(community_id.as_uuid())
    .bind(event_created_at)
    .bind(event_id)
    .execute(pool)
    .await?;

    Ok(result.rows_affected() > 0)
}

/// Release a previously claimed reminder when publish fails.
///
/// The `delivery_stamp` must be the exact value written by the claiming pod;
/// that compare-and-clear prevents one pod from rolling back another pod's
/// later claim after a retry/race.
///
/// Scoped by `community_id` for the same reason as the claim: a release for
/// `A/X` must not clear `B/X` even when their `id`/`created_at`/stamp coincide.
pub async fn release_due_reminder(
    pool: &PgPool,
    community_id: CommunityId,
    event_id: &[u8],
    event_created_at: DateTime<Utc>,
    delivery_stamp: i64,
) -> Result<bool> {
    let result = sqlx::query(
        r#"
        UPDATE events
        SET delivered_at = NULL
        WHERE community_id = $1
          AND created_at = $2
          AND id = $3
          AND delivered_at = $4
        "#,
    )
    .bind(community_id.as_uuid())
    .bind(event_created_at)
    .bind(event_id)
    .bind(delivery_stamp)
    .execute(pool)
    .await?;

    Ok(result.rows_affected() == 1)
}

use buzz_datastore_tracing::datastore_span;

impl Db {
    /// Query due reminders ready for delivery.
    #[datastore_span(name = "query_due_reminders", system = "postgresql")]
    pub async fn query_due_reminders(
        &self,
        now_secs: i64,
        batch_limit: i64,
    ) -> Result<Vec<DueReminder>> {
        query_due_reminders(&self.pool, now_secs, batch_limit).await
    }

    /// Atomically claim a due reminder for delivery (cross-pod dedup).
    #[datastore_span(name = "claim_due_reminder", system = "postgresql")]
    pub async fn claim_due_reminder(
        &self,
        community_id: CommunityId,
        event_id: &[u8],
        event_created_at: chrono::DateTime<chrono::Utc>,
    ) -> Result<bool> {
        claim_due_reminder(&self.pool, community_id, event_id, event_created_at).await
    }

    /// Atomically claim a due reminder using a caller-supplied delivery stamp.
    #[datastore_span(name = "claim_due_reminder_with_stamp", system = "postgresql")]
    pub async fn claim_due_reminder_with_stamp(
        &self,
        community_id: CommunityId,
        event_id: &[u8],
        event_created_at: chrono::DateTime<chrono::Utc>,
        delivery_stamp: i64,
    ) -> Result<bool> {
        claim_due_reminder_with_stamp(
            &self.pool,
            community_id,
            event_id,
            event_created_at,
            delivery_stamp,
        )
        .await
    }

    /// Release a claimed due reminder after a publish failure.
    #[datastore_span(name = "release_due_reminder", system = "postgresql")]
    pub async fn release_due_reminder(
        &self,
        community_id: CommunityId,
        event_id: &[u8],
        event_created_at: chrono::DateTime<chrono::Utc>,
        delivery_stamp: i64,
    ) -> Result<bool> {
        release_due_reminder(
            &self.pool,
            community_id,
            event_id,
            event_created_at,
            delivery_stamp,
        )
        .await
    }
}
