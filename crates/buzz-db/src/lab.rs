//! Lab Board persistence — the CAS gate and append-only revision history for
//! community-wide, multi-writer Markdown documents ("Quadros").
//!
//! Two new PROVISIONAL Nostr kinds (pending upstream RFC — see
//! `buzz_core::kind` doc comments): `KIND_LAB_BOARD_REVISION` (40101,
//! client-signed edits) and `KIND_LAB_BOARD_HEAD` (30623, relay-signed head
//! projection). Both kinds are still inserted into the generic partitioned
//! `events` table (via [`insert_revision_event_tx`] /
//! [`replace_head_projection_event_tx`]) so ordinary REQ/subscription reads
//! keep working unchanged. `lab_board_heads` and `lab_board_revisions` (see
//! migration `0029_lab_boards.sql`) are the CAS *gate*: small,
//! non-partitioned tables the relay locks with `SELECT ... FOR UPDATE`
//! (behind a `pg_advisory_xact_lock` that also covers the not-yet-existing
//! "create" case) inside one transaction, alongside the `events` writes, so
//! accept/reject is decided and committed atomically.
//!
//! Every function here takes an already-open `&mut Transaction<'_, Postgres>`
//! — the caller (`crates/buzz-relay/src/handlers/lab.rs`) owns the
//! transaction lifecycle (`Db::begin_transaction` / `tx.commit()` /
//! `tx.rollback()`) so it can interleave CAS-gate writes with the relay's own
//! event-signing step (which needs the server-computed revision number
//! *before* it can build the kind:30623 content) inside a single commit. This
//! mirrors the `_tx`-suffixed helpers in `event.rs`
//! (`insert_event_with_thread_metadata_tx`) and the transactional flow in
//! `relay_invite::claim_relay_invite` / `relay_members::transfer_ownership`.
//!
//! `lab_board_heads`/`lab_board_revisions` are read-scoped by
//! `list_board_heads` / `list_board_revisions`, which take a plain `&PgPool`
//! like every other read-only query in this crate (no lock needed).

use chrono::{DateTime, Utc};
use sqlx::{PgPool, Postgres, QueryBuilder, Row as _, Transaction};
use uuid::Uuid;

use crate::error::{DbError, Result};
use crate::CommunityId;
use buzz_core::StoredEvent;

/// A board's current CAS pointer + moderation state (`lab_board_heads` row).
#[derive(Debug, Clone)]
pub struct BoardHead {
    /// Immutable board identifier (the event `d` tag). Renaming (title/summary)
    /// never changes this — links via `board_id` always resolve.
    pub board_id: Uuid,
    /// `"active"`, `"archived"`, or `"frozen"`.
    pub status: String,
    /// Monotonically increasing content revision counter (0 before the first
    /// accepted "create").
    pub revision: i32,
    /// 32-byte id of the accepted kind:40101 revision event this head points at.
    pub head_revision_event_id: Vec<u8>,
    /// 32-byte id of the relay-signed kind:30623 projection event, if one has
    /// been published for the current revision.
    pub head_projection_event_id: Option<Vec<u8>>,
    /// Current title (<=160 chars).
    pub title: String,
    /// Current summary (<=500 chars), if any.
    pub summary: Option<String>,
    /// Immutable read/write scope: `community`, `community_readonly`, or `private`.
    pub access_scope: String,
    /// Canonical human owner for restricted boards, if known.
    pub owner_pubkey: Option<Vec<u8>>,
    /// Canonical topic tags, atomically replaced by V2 edits.
    pub tags: Vec<String>,
    /// When the board was first created.
    pub created_at: DateTime<Utc>,
    /// 32-byte pubkey of whoever created the board.
    pub created_by: Vec<u8>,
    /// When any field of this row last changed (content OR moderation state).
    pub updated_at: DateTime<Utc>,
    /// 32-byte pubkey of whoever last changed this row.
    pub updated_by: Vec<u8>,
    /// When the board was last archived, if ever (never cleared on unarchive —
    /// a breadcrumb of the most recent archive action, not a "currently
    /// archived" flag; `status` is the authority for current state).
    pub archived_at: Option<DateTime<Utc>>,
    /// 32-byte pubkey of whoever last archived the board.
    pub archived_by: Option<Vec<u8>>,
    /// When the board was last frozen, if ever (same never-cleared convention
    /// as `archived_at`).
    pub frozen_at: Option<DateTime<Utc>>,
    /// 32-byte pubkey of whoever last froze the board.
    pub frozen_by: Option<Vec<u8>>,
}

fn row_to_board_head(row: &sqlx::postgres::PgRow) -> Result<BoardHead> {
    Ok(BoardHead {
        board_id: row.try_get("board_id")?,
        status: row.try_get("status")?,
        revision: row.try_get("revision")?,
        head_revision_event_id: row.try_get("head_revision_event_id")?,
        head_projection_event_id: row.try_get("head_projection_event_id")?,
        title: row.try_get("title")?,
        summary: row.try_get("summary")?,
        access_scope: row.try_get("access_scope")?,
        owner_pubkey: row.try_get("owner_pubkey")?,
        tags: row.try_get("tags")?,
        created_at: row.try_get("created_at")?,
        created_by: row.try_get("created_by")?,
        updated_at: row.try_get("updated_at")?,
        updated_by: row.try_get("updated_by")?,
        archived_at: row.try_get("archived_at")?,
        archived_by: row.try_get("archived_by")?,
        frozen_at: row.try_get("frozen_at")?,
        frozen_by: row.try_get("frozen_by")?,
    })
}

/// Column list for `lab_board_heads` reads — kept as one literal so every
/// query below and [`row_to_board_head`] can't drift out of sync. sqlx 0.9's
/// `SqlSafeStr` bound rejects runtime-formatted query strings (only
/// `&'static str` literals qualify), so this cannot be spliced in via
/// `format!`; each query spells the column list out directly instead.
macro_rules! board_head_columns {
    () => {
        "board_id, status, revision, head_revision_event_id, \
         head_projection_event_id, title, summary, created_at, created_by, \
         access_scope, owner_pubkey, tags, updated_at, updated_by, archived_at, \
         archived_by, frozen_at, frozen_by"
    };
}

/// A single accepted content mutation (`lab_board_revisions` row). Rows are
/// append-only — never UPDATEd or DELETEd (spec: "eventos antigos permanecem
/// imutáveis").
#[derive(Debug, Clone)]
pub struct BoardRevision {
    /// The board this revision belongs to.
    pub board_id: Uuid,
    /// 1-based revision number, monotonically increasing per board.
    pub revision: i32,
    /// 32-byte id of the kind:40101 event that carries this revision's
    /// Markdown snapshot.
    pub event_id: Vec<u8>,
    /// The "prev" this revision CAS'd against; `None` only for `revision = 1`.
    pub base_event_id: Option<Vec<u8>>,
    /// `"create"`, `"update"`, or `"restore"`.
    pub operation: String,
    /// 32-byte pubkey of the human/agent who authored this revision.
    pub author_pubkey: Vec<u8>,
    /// When the relay accepted this revision.
    pub accepted_at: DateTime<Utc>,
    /// SHA-256 of the Markdown content, for integrity cross-checks.
    pub content_hash: Vec<u8>,
    /// When `operation = "restore"`, the revision number this one restored
    /// content from. `None` otherwise.
    pub restored_from: Option<i32>,
}

fn row_to_board_revision(row: &sqlx::postgres::PgRow) -> Result<BoardRevision> {
    Ok(BoardRevision {
        board_id: row.try_get("board_id")?,
        revision: row.try_get("revision")?,
        event_id: row.try_get("event_id")?,
        base_event_id: row.try_get("base_event_id")?,
        operation: row.try_get("operation")?,
        author_pubkey: row.try_get("author_pubkey")?,
        accepted_at: row.try_get("accepted_at")?,
        content_hash: row.try_get("content_hash")?,
        restored_from: row.try_get("restored_from")?,
    })
}

/// Advisory-lock namespace for the Lab Board CAS gate. String-keyed via
/// `hashtextextended`, mirroring `channel.rs`'s
/// `CHANNEL_MEMBERSHIP_LOCK_NAMESPACE` idiom.
const BOARD_LOCK_NAMESPACE: &str = "buzz_lab_board:";

/// Serialize every write attempt against one board's CAS gate.
///
/// A plain `SELECT ... FOR UPDATE` cannot lock a row that does not exist yet
/// (the "create" case), so every mutation — including the very first
/// "create" — takes this transaction-scoped advisory lock keyed by
/// `(community_id, board_id)` *before* touching `lab_board_heads`. Two
/// concurrent "create" attempts for the same fresh `board_id` therefore still
/// serialize correctly: the second to acquire the lock sees the first's
/// committed row and is rejected by the caller's `NotFound`-vs-`Some` check.
async fn acquire_board_lock_tx(
    tx: &mut Transaction<'_, Postgres>,
    community: CommunityId,
    board_id: Uuid,
) -> Result<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!(
            "{BOARD_LOCK_NAMESPACE}{}:{}",
            community.as_uuid(),
            board_id
        ))
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Step 2–3 of the CAS algorithm: acquire the board lock, then read the
/// current head row `FOR UPDATE`. Returns `None` when no board with this id
/// exists yet in this community (the only valid predecessor state for a
/// "create").
///
/// Must be called inside a transaction the caller commits or rolls back —
/// the advisory lock (and the row lock, if a row exists) hold until then.
pub async fn get_board_head_for_update_tx(
    tx: &mut Transaction<'_, Postgres>,
    community: CommunityId,
    board_id: Uuid,
) -> Result<Option<BoardHead>> {
    acquire_board_lock_tx(tx, community, board_id).await?;

    let row = sqlx::query(concat!(
        "SELECT ",
        board_head_columns!(),
        " FROM lab_board_heads WHERE community_id = $1 AND board_id = $2 FOR UPDATE"
    ))
    .bind(community.as_uuid())
    .bind(board_id)
    .fetch_optional(&mut **tx)
    .await?;

    row.as_ref().map(row_to_board_head).transpose()
}

/// Idempotent-replay probe: true iff an event with this exact id was already
/// accepted into `events` for this community.
///
/// Must be called *after* [`get_board_head_for_update_tx`] (i.e. while
/// holding the board's advisory lock) and *before* any CAS/status-transition
/// check, so a client resending the exact same signed event after a dropped
/// ack (same event id — Nostr ids are a deterministic hash of the signed
/// content, so a retry cannot legally differ) is recognized as "already
/// done" rather than judged against state its own prior commit already
/// advanced. See `handlers::lab` module doc / the retry-vs-CAS ordering
/// fix: `event.id` is checked directly (`ON CONFLICT DO NOTHING` in
/// [`insert_revision_event_tx`] makes the *insert* idempotent already, but
/// only if code reaches that insert — a CAS/status-transition check that
/// runs first, keyed off `prev`/status rather than `event.id`, can reject
/// the retry before the insert is ever attempted).
///
/// Ignores `deleted_at` deliberately: a Lab Board revision event (the only
/// kind this is ever probed for) is never soft-deleted, and even if it were,
/// "this exact id was already accepted" is still the right answer.
pub async fn revision_event_exists_tx(
    tx: &mut Transaction<'_, Postgres>,
    community: CommunityId,
    event_id: &[u8],
) -> Result<bool> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM events WHERE community_id = $1 AND id = $2)",
    )
    .bind(community.as_uuid())
    .bind(event_id)
    .fetch_one(&mut **tx)
    .await?;
    Ok(exists)
}

/// Insert the client-signed kind:40101 revision event into the generic
/// `events` table (ordinary, non-replaceable insert — no thread metadata, no
/// `channel_id`: Lab Boards are community-scoped, not channel-scoped).
///
/// Returns `(stored_event, was_inserted)`; `was_inserted = false` only on an
/// exact event-id replay (`ON CONFLICT DO NOTHING`), which the caller should
/// treat as an idempotent no-op, not an error.
pub async fn insert_revision_event_tx(
    tx: &mut Transaction<'_, Postgres>,
    community: CommunityId,
    event: &nostr::Event,
) -> Result<(StoredEvent, bool)> {
    let id_bytes = event.id.as_bytes();
    let pubkey_bytes = event.pubkey.to_bytes();
    let sig_bytes = event.sig.serialize();
    let tags_json = serde_json::to_value(&event.tags)?;
    let kind_i32 = buzz_core::kind::event_kind_i32(event);
    let created_at_secs = event.created_at.as_secs() as i64;
    let created_at = DateTime::from_timestamp(created_at_secs, 0)
        .ok_or(DbError::InvalidTimestamp(created_at_secs))?;
    let received_at = Utc::now();
    let d_tag = crate::event::extract_d_tag(event);

    let result = sqlx::query(
        "INSERT INTO events (community_id, id, pubkey, created_at, kind, tags, content, sig, received_at, channel_id, d_tag, not_before) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, NULL) \
         ON CONFLICT DO NOTHING",
    )
    .bind(community.as_uuid())
    .bind(id_bytes.as_slice())
    .bind(pubkey_bytes.as_slice())
    .bind(created_at)
    .bind(kind_i32)
    .bind(&tags_json)
    .bind(&event.content)
    .bind(sig_bytes.as_slice())
    .bind(received_at)
    .bind(d_tag.as_deref())
    .execute(&mut **tx)
    .await?;

    Ok((
        StoredEvent::with_received_at(event.clone(), received_at, None, true),
        result.rows_affected() > 0,
    ))
}

/// Publish the relay-signed kind:30623 head projection: soft-delete the
/// previous projection event (if this board already had one — mirrors
/// `Db::replace_addressable_event`'s NIP-33 replace semantics) and insert the
/// new one, both inside the caller's transaction so a subscriber can never
/// observe two live projections, or none, for the same board.
pub async fn replace_head_projection_event_tx(
    tx: &mut Transaction<'_, Postgres>,
    community: CommunityId,
    event: &nostr::Event,
    previous_projection_event_id: Option<&[u8]>,
) -> Result<StoredEvent> {
    if let Some(prev_id) = previous_projection_event_id {
        sqlx::query(
            "UPDATE events SET deleted_at = now() \
             WHERE community_id = $1 AND id = $2 AND deleted_at IS NULL",
        )
        .bind(community.as_uuid())
        .bind(prev_id)
        .execute(&mut **tx)
        .await?;
    }

    let id_bytes = event.id.as_bytes();
    let pubkey_bytes = event.pubkey.to_bytes();
    let sig_bytes = event.sig.serialize();
    let tags_json = serde_json::to_value(&event.tags)?;
    let kind_i32 = buzz_core::kind::event_kind_i32(event);
    let created_at_secs = event.created_at.as_secs() as i64;
    let created_at = DateTime::from_timestamp(created_at_secs, 0)
        .ok_or(DbError::InvalidTimestamp(created_at_secs))?;
    let received_at = Utc::now();
    let d_tag = crate::event::extract_d_tag(event);

    sqlx::query(
        "INSERT INTO events (community_id, id, pubkey, created_at, kind, tags, content, sig, received_at, channel_id, d_tag, not_before) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, NULL) \
         ON CONFLICT DO NOTHING",
    )
    .bind(community.as_uuid())
    .bind(id_bytes.as_slice())
    .bind(pubkey_bytes.as_slice())
    .bind(created_at)
    .bind(kind_i32)
    .bind(&tags_json)
    .bind(&event.content)
    .bind(sig_bytes.as_slice())
    .bind(received_at)
    .bind(d_tag.as_deref())
    .execute(&mut **tx)
    .await?;

    Ok(StoredEvent::with_received_at(
        event.clone(),
        received_at,
        None,
        true,
    ))
}

/// Append a `lab_board_revisions` row for an accepted "create"/"update"/
/// "restore". Never called for pure moderation ops (archive/unarchive/
/// freeze/unfreeze) — those carry no Markdown snapshot to version (spec §8).
#[allow(clippy::too_many_arguments)]
pub async fn record_board_revision_tx(
    tx: &mut Transaction<'_, Postgres>,
    community: CommunityId,
    board_id: Uuid,
    revision: i32,
    event_id: &[u8],
    base_event_id: Option<&[u8]>,
    operation: &str,
    author_pubkey: &[u8],
    content_hash: &[u8],
    restored_from: Option<i32>,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO lab_board_revisions \
         (community_id, board_id, revision, event_id, base_event_id, operation, author_pubkey, content_hash, restored_from) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(community.as_uuid())
    .bind(board_id)
    .bind(revision)
    .bind(event_id)
    .bind(base_event_id)
    .bind(operation)
    .bind(author_pubkey)
    .bind(content_hash)
    .bind(restored_from)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Read a stored event's Markdown content inside the CAS transaction.
///
/// Moderation re-signs the head projection, which has to carry the same
/// content the current revision holds. `lab_board_heads` stores the pointer,
/// not the text, so the text is read back from `events` here rather than
/// duplicated into the CAS table where it could drift.
pub async fn get_event_content_tx(
    tx: &mut Transaction<'_, Postgres>,
    community: CommunityId,
    event_id: &[u8],
) -> Result<Option<String>> {
    let content: Option<String> =
        sqlx::query_scalar("SELECT content FROM events WHERE community_id = $1 AND id = $2")
            .bind(community.as_uuid())
            .bind(event_id)
            .fetch_optional(&mut **tx)
            .await?;
    Ok(content)
}

/// Read one recorded revision inside the CAS transaction.
///
/// Used to validate a `restore`: the relay must confirm that the revision the
/// client claims to be restoring exists on this board and that the content it
/// submitted really is that revision's content. Without this read, the
/// `restored_from` column is only the client's word, and the history would
/// record a provenance that never happened.
pub async fn get_board_revision_tx(
    tx: &mut Transaction<'_, Postgres>,
    community: CommunityId,
    board_id: Uuid,
    revision: i32,
) -> Result<Option<BoardRevision>> {
    let row = sqlx::query(
        "SELECT board_id, revision, event_id, base_event_id, operation, author_pubkey, \
                accepted_at, content_hash, restored_from \
         FROM lab_board_revisions \
         WHERE community_id = $1 AND board_id = $2 AND revision = $3",
    )
    .bind(community.as_uuid())
    .bind(board_id)
    .bind(revision)
    .fetch_optional(&mut **tx)
    .await?;

    row.as_ref().map(row_to_board_revision).transpose()
}

/// Create the first `lab_board_heads` row for a board (accepted "create",
/// `revision = 1`, `status = 'active'`).
///
/// Caller must have already confirmed via [`get_board_head_for_update_tx`]
/// that no row exists yet for this `(community, board_id)` — this function
/// does not itself re-check (the advisory lock already serializes racing
/// creates; a genuine duplicate would trip the primary key and surface as a
/// `DbError::Sqlx`, which the caller should treat as a rejected CAS, not a
/// server error).
#[allow(clippy::too_many_arguments)]
pub async fn create_board_head_tx(
    tx: &mut Transaction<'_, Postgres>,
    community: CommunityId,
    board_id: Uuid,
    head_revision_event_id: &[u8],
    head_projection_event_id: &[u8],
    title: &str,
    summary: Option<&str>,
    access_scope: &str,
    owner_pubkey: Option<&[u8]>,
    tags: &[String],
    actor_pubkey: &[u8],
) -> Result<BoardHead> {
    let row = sqlx::query(concat!(
        "INSERT INTO lab_board_heads \
         (community_id, board_id, status, revision, head_revision_event_id, head_projection_event_id, \
          title, summary, access_scope, owner_pubkey, tags, created_by, updated_by) \
         VALUES ($1, $2, 'active', 1, $3, $4, $5, $6, $7, $8, $9, $10, $10) \
         RETURNING ",
        board_head_columns!()
    ))
    .bind(community.as_uuid())
    .bind(board_id)
    .bind(head_revision_event_id)
    .bind(head_projection_event_id)
    .bind(title)
    .bind(summary)
    .bind(access_scope)
    .bind(owner_pubkey)
    .bind(tags)
    .bind(actor_pubkey)
    .fetch_one(&mut **tx)
    .await?;

    row_to_board_head(&row)
}

/// Advance an existing board's content head (accepted "update"/"restore").
///
/// `title`/`summary` are the caller-resolved *effective* values (the relay
/// handler already merged "tag present" vs "keep existing" before calling
/// this — this function always overwrites unconditionally).
#[allow(clippy::too_many_arguments)]
pub async fn update_board_content_head_tx(
    tx: &mut Transaction<'_, Postgres>,
    community: CommunityId,
    board_id: Uuid,
    new_revision: i32,
    head_revision_event_id: &[u8],
    head_projection_event_id: &[u8],
    title: &str,
    summary: Option<&str>,
    actor_pubkey: &[u8],
) -> Result<BoardHead> {
    let row = sqlx::query(concat!(
        "UPDATE lab_board_heads \
         SET revision = $3, head_revision_event_id = $4, head_projection_event_id = $5, \
             title = $6, summary = $7, updated_at = now(), updated_by = $8 \
         WHERE community_id = $1 AND board_id = $2 \
         RETURNING ",
        board_head_columns!()
    ))
    .bind(community.as_uuid())
    .bind(board_id)
    .bind(new_revision)
    .bind(head_revision_event_id)
    .bind(head_projection_event_id)
    .bind(title)
    .bind(summary)
    .bind(actor_pubkey)
    .fetch_optional(&mut **tx)
    .await?;

    row.as_ref()
        .map(row_to_board_head)
        .transpose()?
        .ok_or_else(|| DbError::NotFound(format!("lab board {board_id}")))
}

/// Apply a moderation status transition (archive/unarchive/freeze/unfreeze).
///
/// Touches only `lab_board_heads` — content (`lab_board_revisions`,
/// `head_revision_event_id`, `revision`) is untouched, per spec §8 ("arquivar
/// /congelar não destrói histórico"). `archived_at`/`archived_by` and
/// `frozen_at`/`frozen_by` are set on entering that state and deliberately
/// left as-is on leaving it (a "last time this happened" breadcrumb, not a
/// "currently in that state" flag — `status` is the sole authority for
/// current state).
///
/// The caller is responsible for validating the transition is legal from the
/// row's current `status` (e.g. only `active` -> `archived`) using the row it
/// already holds `FOR UPDATE` from [`get_board_head_for_update_tx`] — the
/// held row lock is what makes that check race-free, so this function does
/// not re-validate the starting state itself.
pub async fn set_board_status_tx(
    tx: &mut Transaction<'_, Postgres>,
    community: CommunityId,
    board_id: Uuid,
    new_status: &str,
    actor_pubkey: &[u8],
    head_projection_event_id: Option<&[u8]>,
) -> Result<BoardHead> {
    let row = match new_status {
        "archived" => {
            sqlx::query(concat!(
                "UPDATE lab_board_heads \
                 SET status = 'archived', archived_at = now(), archived_by = $3, \
                     head_projection_event_id = COALESCE($4, head_projection_event_id), \
                     updated_at = now(), updated_by = $3 \
                 WHERE community_id = $1 AND board_id = $2 \
                 RETURNING ",
                board_head_columns!()
            ))
            .bind(community.as_uuid())
            .bind(board_id)
            .bind(actor_pubkey)
            .bind(head_projection_event_id)
            .fetch_optional(&mut **tx)
            .await?
        }
        "frozen" => {
            sqlx::query(concat!(
                "UPDATE lab_board_heads \
                 SET status = 'frozen', frozen_at = now(), frozen_by = $3, \
                     head_projection_event_id = COALESCE($4, head_projection_event_id), \
                     updated_at = now(), updated_by = $3 \
                 WHERE community_id = $1 AND board_id = $2 \
                 RETURNING ",
                board_head_columns!()
            ))
            .bind(community.as_uuid())
            .bind(board_id)
            .bind(actor_pubkey)
            .bind(head_projection_event_id)
            .fetch_optional(&mut **tx)
            .await?
        }
        "active" => {
            sqlx::query(concat!(
                "UPDATE lab_board_heads \
                 SET status = 'active', \
                     head_projection_event_id = COALESCE($4, head_projection_event_id), \
                     updated_at = now(), updated_by = $3 \
                 WHERE community_id = $1 AND board_id = $2 \
                 RETURNING ",
                board_head_columns!()
            ))
            .bind(community.as_uuid())
            .bind(board_id)
            .bind(actor_pubkey)
            .bind(head_projection_event_id)
            .fetch_optional(&mut **tx)
            .await?
        }
        other => {
            return Err(DbError::InvalidData(format!(
                "unknown lab board status transition target: {other}"
            )))
        }
    };

    row.as_ref()
        .map(row_to_board_head)
        .transpose()?
        .ok_or_else(|| DbError::NotFound(format!("lab board {board_id}")))
}

/// List a community's board heads, most recently updated first.
///
/// `status_filter` narrows to one status (`"active"`/`"archived"`/
/// `"frozen"`); `None` returns all statuses. Plain pool read — no lock, no
/// transaction (matches every other list query in this crate).
pub async fn list_board_heads(
    pool: &PgPool,
    community: CommunityId,
    status_filter: Option<&str>,
    limit: i64,
) -> Result<Vec<BoardHead>> {
    let rows = match status_filter {
        Some(status) => {
            sqlx::query(concat!(
                "SELECT ",
                board_head_columns!(),
                " FROM lab_board_heads WHERE community_id = $1 AND status = $2 \
                 ORDER BY updated_at DESC LIMIT $3"
            ))
            .bind(community.as_uuid())
            .bind(status)
            .bind(limit)
            .fetch_all(pool)
            .await?
        }
        None => {
            sqlx::query(concat!(
                "SELECT ",
                board_head_columns!(),
                " FROM lab_board_heads WHERE community_id = $1 \
                 ORDER BY updated_at DESC LIMIT $2"
            ))
            .bind(community.as_uuid())
            .bind(limit)
            .fetch_all(pool)
            .await?
        }
    };

    rows.iter().map(row_to_board_head).collect()
}

/// Fetch one board's current head row (plain read, no lock).
pub async fn get_board_head(
    pool: &PgPool,
    community: CommunityId,
    board_id: Uuid,
) -> Result<Option<BoardHead>> {
    let row = sqlx::query(concat!(
        "SELECT ",
        board_head_columns!(),
        " FROM lab_board_heads WHERE community_id = $1 AND board_id = $2"
    ))
    .bind(community.as_uuid())
    .bind(board_id)
    .fetch_optional(pool)
    .await?;

    row.as_ref().map(row_to_board_head).transpose()
}

/// Test the board ACL for one authenticated reader.
///
/// `principals` contains the reader pubkey and, when the reader is a managed
/// agent and NIP-OA is enabled by the relay, its canonical owner pubkey.  The
/// query is intentionally a single boolean and never returns a head row, so a
/// caller can apply the same fail-closed decision to history, subscriptions,
/// and fan-out without creating an existence oracle.
pub async fn board_can_read(
    pool: &PgPool,
    community: CommunityId,
    board_id: Uuid,
    principals: &[Vec<u8>],
) -> Result<bool> {
    let mut query = QueryBuilder::<Postgres>::new(
        "SELECT EXISTS (SELECT 1 FROM lab_board_heads h \
         WHERE h.community_id = ",
    );
    query.push_bind(community.as_uuid());
    query.push(" AND h.board_id = ");
    query.push_bind(board_id);
    query
        .push(" AND (h.access_scope IN ('community', 'community_readonly') OR h.owner_pubkey IN (");
    if principals.is_empty() {
        query.push("NULL");
    } else {
        let mut separated = query.separated(", ");
        for principal in principals {
            separated.push_bind(principal.clone());
        }
    }
    query.push(")))");
    Ok(query.build_query_scalar().fetch_one(pool).await?)
}

/// List a board's revision history, newest first.
///
/// `before_revision`, when set, returns only revisions strictly older than
/// it (keyset pagination anchor) — this is the primary history-browsing
/// query, so it never scans the whole history to serve one page.
pub async fn list_board_revisions(
    pool: &PgPool,
    community: CommunityId,
    board_id: Uuid,
    before_revision: Option<i32>,
    limit: i64,
) -> Result<Vec<BoardRevision>> {
    let rows =
        match before_revision {
            Some(before) => sqlx::query(
                "SELECT board_id, revision, event_id, base_event_id, operation, author_pubkey, \
                    accepted_at, content_hash, restored_from \
             FROM lab_board_revisions \
             WHERE community_id = $1 AND board_id = $2 AND revision < $3 \
             ORDER BY revision DESC LIMIT $4",
            )
            .bind(community.as_uuid())
            .bind(board_id)
            .bind(before)
            .bind(limit)
            .fetch_all(pool)
            .await?,
            None => sqlx::query(
                "SELECT board_id, revision, event_id, base_event_id, operation, author_pubkey, \
                    accepted_at, content_hash, restored_from \
             FROM lab_board_revisions \
             WHERE community_id = $1 AND board_id = $2 \
             ORDER BY revision DESC LIMIT $3",
            )
            .bind(community.as_uuid())
            .bind(board_id)
            .bind(limit)
            .fetch_all(pool)
            .await?,
        };

    rows.iter().map(row_to_board_revision).collect()
}
