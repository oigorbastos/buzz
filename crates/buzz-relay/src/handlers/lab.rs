//! Lab Board (kind:40101 revision / kind:30623 head) CAS handler.
//!
//! Both kinds are PROVISIONAL, pending upstream RFC — see doc comments on
//! `buzz_core::kind::KIND_LAB_BOARD_REVISION` / `KIND_LAB_BOARD_HEAD`.
//!
//! A Lab Board ("Quadro") is a community-wide, multi-writer Markdown
//! document with compare-and-swap concurrency and full revision history —
//! not channel-scoped (unlike `KIND_CANVAS`/kind:40100), so this handler
//! never touches `channel_id`/`h`-tag machinery. It is reached from
//! `ingest::ingest_event_inner` the same way `KIND_PRODUCT_FEEDBACK` and
//! `KIND_REPORT` are: an early-return branch right after the ban/timeout
//! write-block gate, entirely bypassing the generic
//! replaceable/parameterized-replaceable/plain-insert persistence branch
//! (`events` storage here is driven explicitly, inside the CAS transaction,
//! by `buzz_db::lab`).
//!
//! ## The CAS algorithm (spec §3)
//! 1. Generic gates already ran (signature, size, timestamp, pubkey/auth
//!    match, `boards:write`/`boards:moderate` scope, ban/timeout) —
//!    see `ingest_event_inner` before the call site of this module. Pure
//!    Nostr auth grants every scope to every authenticated connection (see
//!    the `Scope` module doc), so the scope check alone cannot enforce
//!    community membership; [`check_lab_board_membership`] and, for
//!    moderation ops, `moderation_authz::authorize_moderation_action` are the
//!    real per-write gates and run before step 2.
//! 2. [`buzz_db::lab::get_board_head_for_update_tx`] takes the
//!    `(community, board_id)` advisory lock, then `SELECT ... FOR UPDATE`.
//! 3. Read the current head (or `None` for a fresh board_id).
//! 3.5. [`buzz_db::lab::revision_event_exists_tx`] checks whether this exact
//!    event id was already accepted (dropped-ack retry) — if so, short-
//!    circuit straight to the idempotent "duplicate:" outcome, *before* the
//!    CAS/status-transition checks in step 4 can misjudge the retry against
//!    state its own prior commit already advanced.
//! 4. Compare the event's `prev` tag against the locked head — mismatch or
//!    an illegal state transition is rejected via [`board_head_mismatch`]
//!    *before* any write.
//! 5. Insert the signed revision event ([`buzz_db::lab::insert_revision_event_tx`]).
//! 6. Build and sign the new kind:30623 head projection with
//!    `state.relay_keypair` — for content mutations *and* for moderation ops
//!    (see the module doc on moderation ops below: a status flip re-signs the
//!    projection with the same content/revision and the new `status` tag).
//! 7. Persist the head projection
//!    ([`buzz_db::lab::replace_head_projection_event_tx`]) — same transaction.
//! 8. Upsert `lab_board_heads` ([`buzz_db::lab::create_board_head_tx`] /
//!    [`buzz_db::lab::update_board_content_head_tx`] /
//!    [`buzz_db::lab::set_board_status_tx`]).
//! 9. Append the `lab_board_revisions` row
//!    ([`buzz_db::lab::record_board_revision_tx`]) — **after** step 8, never
//!    before: that table has a foreign key into `lab_board_heads`, so on an
//!    `op=create` the head row must exist first (see the comment at that call
//!    site).
//! 10. `tx.commit()`, THEN publish to subscribers via
//!    `dispatch_persistent_event` — never before commit.
//!
//! ## V2 read and authorization invariants
//! - `access_scope` and the canonical owner are immutable after `create_v2`;
//!   legacy creates remain community-wide for compatibility with V1 rows.
//! - The owner is derived from the authenticated principal and the durable
//!   NIP-OA mapping. Client-supplied `owner` tags are rejected.
//! - REQ, COUNT, HTTP search, historical hydration, and fan-out apply the
//!   corresponding head ACL before pagination or delivery. The CLI and
//!   desktop use the same `create_v2`/`update_v2` tag contract.
//! - Private and read-only boards return the same opaque not-found response
//!   for unauthorized writes, so a guessed board id is not an existence
//!   oracle. Rate limiting is applied before the CAS transaction is opened.
//! - **Moderation ops DO re-sign the head projection**: archive/unarchive/
//!   freeze/unfreeze leave content and `revision` untouched, but they update
//!   `lab_board_heads.status` (+ audit columns) *and* publish a fresh
//!   kind:30623 carrying the new `status` tag, reusing the current head
//!   revision's Markdown and revision number. That tag is the only
//!   Nostr-visible "is this board archived/frozen" signal a client has, so
//!   leaving the old projection in place would keep announcing `active` while
//!   the database said `archived`. Verified end to end against Postgres by
//!   `postgres_tests::archive_and_unarchive_round_trip_and_resign_the_head_projection`;
//!   see also the doc on [`handle_moderation_op`].

use std::sync::Arc;

use nostr::{Event, EventBuilder, Kind, Tag};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

use buzz_core::kind::{KIND_LAB_BOARD_HEAD, KIND_LAB_BOARD_REVISION};
use buzz_core::tenant::{CommunityId, TenantContext};
use buzz_db::lab::BoardHead;

use super::event::dispatch_persistent_event;
use super::ingest::{IngestAuth, IngestError, IngestResult};
use super::moderation_authz::{self, ModerationAction, ModerationTarget};
use crate::state::AppState;

/// Markdown content cap (spec §8): 64 KiB, measured in bytes (not chars) —
/// matches the byte-based convention of the generic `MAX_EVENT_CONTENT_BYTES`
/// / diff-event / push-lease content caps elsewhere in `ingest.rs`.
const MAX_MARKDOWN_BYTES: usize = 64 * 1024;
/// Title cap (spec §8): 160 characters, measured via `.chars().count()` —
/// matches the char-based convention `single_bounded_d_tag` already uses for
/// text-length limits (bytes would under-count multi-byte titles).
const MAX_TITLE_CHARS: usize = 160;
/// Summary cap (spec §8): 500 characters, same char-counting convention.
const MAX_SUMMARY_CHARS: usize = 500;

/// The `op` tag, closed to the 7 values the spec defines (§2/§3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LabBoardOp {
    Create,
    CreateV2,
    Update,
    UpdateV2,
    Restore,
    Archive,
    Unarchive,
    Freeze,
    Unfreeze,
}

impl LabBoardOp {
    fn from_tag(s: &str) -> Option<Self> {
        Some(match s {
            "create" => Self::Create,
            "create_v2" => Self::CreateV2,
            "update" => Self::Update,
            "update_v2" => Self::UpdateV2,
            "restore" => Self::Restore,
            "archive" => Self::Archive,
            "unarchive" => Self::Unarchive,
            "freeze" => Self::Freeze,
            "unfreeze" => Self::Unfreeze,
            _ => return None,
        })
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::CreateV2 => "create_v2",
            Self::Update => "update",
            Self::UpdateV2 => "update_v2",
            Self::Restore => "restore",
            Self::Archive => "archive",
            Self::Unarchive => "unarchive",
            Self::Freeze => "freeze",
            Self::Unfreeze => "unfreeze",
        }
    }

    /// `create`/`update`/`restore` — mutate Markdown content and CAS against
    /// `prev`; every one produces a `lab_board_revisions` row.
    fn is_content_mutation(self) -> bool {
        matches!(
            self,
            Self::Create | Self::CreateV2 | Self::Update | Self::UpdateV2 | Self::Restore
        )
    }

    /// `archive`/`unarchive`/`freeze`/`unfreeze` — status-only, no Markdown,
    /// no `lab_board_revisions` row (spec §8).
    fn is_moderation(self) -> bool {
        !self.is_content_mutation()
    }

    /// `lab_board_revisions.operation` value for a content mutation. Only
    /// called when `is_content_mutation()` is true.
    fn revision_operation_label(self) -> &'static str {
        match self {
            Self::Create | Self::CreateV2 => "create",
            Self::Update | Self::UpdateV2 => "update",
            Self::Restore => "restore",
            _ => unreachable!("revision_operation_label called on a moderation op"),
        }
    }

    /// The `lab_board_heads.status` this op requires as its starting state.
    /// Only called when `is_moderation()` is true.
    fn required_source_status(self) -> &'static str {
        match self {
            Self::Archive | Self::Freeze => "active",
            Self::Unarchive => "archived",
            Self::Unfreeze => "frozen",
            _ => unreachable!("required_source_status called on a content op"),
        }
    }

    /// The `lab_board_heads.status` this op transitions to. Only called when
    /// `is_moderation()` is true.
    fn target_status(self) -> &'static str {
        match self {
            Self::Archive => "archived",
            Self::Freeze => "frozen",
            Self::Unarchive | Self::Unfreeze => "active",
            _ => unreachable!("target_status called on a content op"),
        }
    }
}

/// Parsed, validated tag envelope of a kind:40101 event. Validation here is
/// envelope-shape only (tag cardinality, sizes, hex/UUID well-formedness);
/// the CAS compare itself (does `prev` match the locked head?) happens in
/// [`handle_lab_board_revision_event`], which is the only place that may
/// legally read `lab_board_heads`.
struct LabBoardEnvelope {
    board_id: Uuid,
    op: LabBoardOp,
    /// 32-byte id of the revision this mutation CAS'd against. Required for
    /// every content mutation except `create`; unused (and ignored, not
    /// required) for moderation ops.
    prev: Option<[u8; 32]>,
    /// Client-asserted revision number, if present. Cross-checked against
    /// the server-computed value as a defense-in-depth sanity check — the
    /// relay-assigned number inside the CAS transaction is always the
    /// authority (spec §2: "nunca o relógio/estado do cliente").
    claimed_revision: Option<i32>,
    title: Option<String>,
    summary: Option<String>,
    /// V2 create-only immutable access scope.
    access_scope: Option<String>,
    /// V2 atomically replaced canonical topic tags.
    tags: Option<Vec<String>>,
    /// Required exactly when `op == Restore`: the revision number being
    /// restored from. Existence within this board's history is enforced by
    /// the `lab_board_revisions` self-referential FK at insert time, not
    /// re-checked here.
    restored_from: Option<i32>,
}

fn find_single_tag<'a>(event: &'a Event, name: &str) -> Result<Option<&'a str>, String> {
    let mut found: Option<&str> = None;
    for tag in event.tags.iter() {
        let parts = tag.as_slice();
        if parts.first().map(|s| s.as_str()) == Some(name) {
            if found.is_some() {
                return Err(format!("duplicate `{name}` tag"));
            }
            found = Some(parts.get(1).map(|s| s.as_str()).unwrap_or(""));
        }
    }
    Ok(found)
}

fn parse_lab_board_envelope(event: &Event) -> Result<LabBoardEnvelope, String> {
    let board_id_str = find_single_tag(event, "d")?
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "lab board event must have exactly one non-empty `d` tag".to_string())?;
    let board_id = Uuid::parse_str(board_id_str)
        .map_err(|_| "lab board `d` tag must be a valid UUID".to_string())?;

    let op_str = find_single_tag(event, "op")?
        .ok_or_else(|| "lab board event must have exactly one `op` tag".to_string())?;
    let op =
        LabBoardOp::from_tag(op_str).ok_or_else(|| format!("unknown lab board op `{op_str}`"))?;

    let prev = match find_single_tag(event, "prev")? {
        Some(hex_str) => {
            let bytes = hex::decode(hex_str)
                .map_err(|_| "lab board `prev` tag must be 64 hex chars".to_string())?;
            let arr: [u8; 32] = bytes
                .try_into()
                .map_err(|_| "lab board `prev` tag must decode to 32 bytes".to_string())?;
            Some(arr)
        }
        None => None,
    };
    if op.is_content_mutation() {
        if matches!(op, LabBoardOp::Create | LabBoardOp::CreateV2) && prev.is_some() {
            return Err("lab board `create` must not carry a `prev` tag".to_string());
        }
        if !matches!(op, LabBoardOp::Create | LabBoardOp::CreateV2) && prev.is_none() {
            return Err(format!("lab board `{}` requires a `prev` tag", op.as_str()));
        }
    }

    let claimed_revision = match find_single_tag(event, "revision")? {
        Some(s) => Some(
            s.parse::<i32>()
                .map_err(|_| "lab board `revision` tag must be a positive integer".to_string())
                .and_then(|n| {
                    if n >= 1 {
                        Ok(n)
                    } else {
                        Err("lab board `revision` tag must be >= 1".to_string())
                    }
                })?,
        ),
        None => None,
    };

    let title = find_single_tag(event, "title")?
        .map(str::to_owned)
        .filter(|s| !s.is_empty());
    if let Some(t) = &title {
        if t.chars().count() > MAX_TITLE_CHARS {
            return Err(format!(
                "lab board title exceeds maximum of {MAX_TITLE_CHARS} characters (got {})",
                t.chars().count()
            ));
        }
    }
    if matches!(op, LabBoardOp::Create | LabBoardOp::CreateV2) && title.is_none() {
        return Err("lab board `create` requires a non-empty `title` tag".to_string());
    }

    let summary = find_single_tag(event, "summary")?
        .map(str::to_owned)
        .filter(|s| !s.is_empty());
    if let Some(s) = &summary {
        if s.chars().count() > MAX_SUMMARY_CHARS {
            return Err(format!(
                "lab board summary exceeds maximum of {MAX_SUMMARY_CHARS} characters (got {})",
                s.chars().count()
            ));
        }
    }

    let restored_from =
        match find_single_tag(event, "restored_from")? {
            Some(s) => Some(s.parse::<i32>().map_err(|_| {
                "lab board `restored_from` tag must be a positive integer".to_string()
            })?),
            None => None,
        };
    if op == LabBoardOp::Restore && restored_from.is_none() {
        return Err("lab board `restore` requires a `restored_from` tag".to_string());
    }
    if op != LabBoardOp::Restore && restored_from.is_some() {
        return Err("lab board `restored_from` tag is only valid on `restore`".to_string());
    }

    let access_scope = find_single_tag(event, "access_scope")?.map(str::to_owned);
    if let Some(scope) = &access_scope {
        if !matches!(
            scope.as_str(),
            "community" | "community_readonly" | "private"
        ) {
            return Err(
                "lab board `access_scope` must be community, community_readonly, or private"
                    .to_string(),
            );
        }
    }
    // The owner is always server-derived from the authenticated principal and
    // the durable NIP-OA mapping. Accepting a client owner would let a signer
    // grant itself access to another person's private board.
    if find_single_tag(event, "owner")?.is_some() {
        return Err(
            "lab board `owner` is relay-derived and must not be supplied by clients".to_string(),
        );
    }

    let tags_marker = find_single_tag(event, "tags")?.map(str::to_owned);
    let mut topic_tags = Vec::new();
    for tag in event.tags.iter() {
        let parts = tag.as_slice();
        if parts.first().map(String::as_str) != Some("t") {
            continue;
        }
        let raw = parts.get(1).map(String::as_str).unwrap_or("");
        let normalized = normalize_lab_tag(raw);
        if raw != normalized || normalized.is_empty() || normalized.chars().count() > 32 {
            return Err(
                "lab board topic tags must be canonical, non-empty, and <= 32 characters"
                    .to_string(),
            );
        }
        if topic_tags.iter().any(|existing| existing == &normalized) {
            return Err("duplicate lab board topic tag".to_string());
        }
        topic_tags.push(normalized);
    }
    if topic_tags.len() > 12 {
        return Err("lab board accepts at most 12 topic tags".to_string());
    }

    let is_v2_create = op == LabBoardOp::CreateV2;
    let is_v2_update = op == LabBoardOp::UpdateV2;
    if is_v2_create {
        if access_scope.is_none() || tags_marker.as_deref() != Some("replace") {
            return Err("lab board `create_v2` requires access_scope and tags=replace".to_string());
        }
    } else if is_v2_update {
        if access_scope.is_some() || tags_marker.as_deref() != Some("replace") {
            return Err(
                "lab board `update_v2` may not change access_scope and requires tags=replace"
                    .to_string(),
            );
        }
    } else if access_scope.is_some() || tags_marker.is_some() || !topic_tags.is_empty() {
        return Err("access_scope and topic tags require create_v2/update_v2".to_string());
    }

    Ok(LabBoardEnvelope {
        board_id,
        op,
        prev,
        claimed_revision,
        title,
        summary,
        access_scope,
        tags: if is_v2_create || is_v2_update {
            Some(topic_tags)
        } else {
            None
        },
        restored_from,
    })
}

/// Normalize a topic tag exactly as the desktop and CLI clients do before
/// signing. Wire values are required to already equal this result, keeping
/// relay, CLI, and desktop filtering deterministic.
pub(crate) fn normalize_lab_tag(raw: &str) -> String {
    let normalized: String = raw.nfkc().collect();
    let mut out = String::new();
    let mut pending_dash = false;
    for ch in normalized.trim().to_lowercase().chars() {
        if ch.is_whitespace() {
            pending_dash = true;
        } else if ch.is_alphanumeric() || ch == '_' || ch == '-' {
            if pending_dash && !out.is_empty() && !out.ends_with('-') {
                out.push('-');
            }
            pending_dash = false;
            out.push(ch);
        } else {
            pending_dash = true;
        }
    }
    out.trim_matches(['-', '_']).to_owned()
}

/// Format a CAS-conflict rejection. Uses the exact same wire convention
/// every other rejected kind in `ingest.rs` uses — `IngestError::Rejected`
/// wrapping an `"invalid: ..."`-prefixed string, nothing bespoke — with a
/// `BOARD_HEAD_MISMATCH` marker token in the message so callers/tests can
/// pattern-match on the specific failure without a new response shape.
fn board_head_mismatch(detail: &str) -> IngestError {
    IngestError::Rejected(format!("invalid: BOARD_HEAD_MISMATCH — {detail}"))
}

/// Build and sign the kind:30623 head projection with the relay's own key.
///
/// Content is the full Markdown snapshot (mirroring the revision event's
/// content — kind:30623 is a relay-attested *copy* of the accepted
/// revision, not new data). Tags: `d`=board_id (addressable coordinate),
/// `community`, `revision`, `title`, `summary` (if any), `head`=hex id of the
/// revision event this projection reflects, `status`.
// Each argument is one tag/field of the projection; bundling them into a
// params struct would only move the same list one indirection away. Matches
// the `#[allow]` already carried by the sibling writers in `buzz_db::lab`.
#[allow(clippy::too_many_arguments)]
fn build_head_projection_event(
    tenant: &TenantContext,
    relay_keys: &nostr::Keys,
    board_id: Uuid,
    content: &str,
    revision: i32,
    title: &str,
    summary: Option<&str>,
    head_revision_event_hex: &str,
    status: &str,
    access_scope: &str,
    owner_pubkey: Option<&[u8]>,
    topic_tags: &[String],
) -> Result<Event, IngestError> {
    let mut tags = vec![
        Tag::parse(["d", &board_id.to_string()]),
        Tag::parse(["community", &tenant.community().to_string()]),
        Tag::parse(["revision", &revision.to_string()]),
        Tag::parse(["title", title]),
        Tag::parse(["head", head_revision_event_hex]),
        Tag::parse(["status", status]),
        Tag::parse(["access_scope", access_scope]),
    ]
    .into_iter()
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| IngestError::Internal(format!("error: building lab board head tags: {e}")))?;
    if let Some(summary) = summary {
        tags.push(Tag::parse(["summary", summary]).map_err(|e| {
            IngestError::Internal(format!("error: building lab board head tags: {e}"))
        })?);
    }
    if let Some(owner) = owner_pubkey {
        tags.push(Tag::parse(["owner", &hex::encode(owner)]).map_err(|e| {
            IngestError::Internal(format!("error: building lab board owner tag: {e}"))
        })?);
    }
    tags.push(Tag::parse(["tags", "replace"]).map_err(|e| {
        IngestError::Internal(format!("error: building lab board tags marker: {e}"))
    })?);
    for topic_tag in topic_tags {
        tags.push(Tag::parse(["t", topic_tag]).map_err(|e| {
            IngestError::Internal(format!("error: building lab board topic tag: {e}"))
        })?);
    }

    EventBuilder::new(Kind::Custom(KIND_LAB_BOARD_HEAD as u16), content)
        .tags(tags)
        .sign_with_keys(relay_keys)
        .map_err(|e| IngestError::Internal(format!("error: signing lab board head event: {e}")))
}

/// Real per-write community-membership gate for every Lab Board op (content
/// mutation or moderation alike).
///
/// Lab Boards are community-wide, not channel-scoped (module doc), so there
/// is no `channel_id`/open-visibility row for a per-write check to fall back
/// on the way [`super::ingest::check_channel_membership`] does for
/// channel-scoped kinds. This is the community-level analog: on an open
/// relay (`require_relay_membership == false`) it is `Ok(())` for any
/// authenticated pubkey — pure Nostr mode already treats every authenticated
/// connection as a legitimate community participant everywhere else in the
/// codebase (see `crate::api::relay_members::check_relay_membership`'s doc,
/// which this mirrors). On a closed relay it re-derives the same
/// Member/ViaOwner decision `enforce_relay_membership` makes once at the AUTH
/// handshake — but from durable storage only, since no NIP-OA auth-tag
/// header is available this deep in the ingest pipeline (the tag was already
/// verified once at connect time, and its owner mapping durably persisted by
/// `materialize_nip_oa_owner` into `users.agent_owner_pubkey` — see
/// `buzz_db::user::get_agent_channel_policy`). Re-deriving this per write
/// (rather than trusting the connection's initial handshake for its whole
/// lifetime) closes the same "already-open socket outlives membership" gap
/// the ban/timeout re-check in `ingest_event_inner` closes for bans: a
/// pubkey (or its owning agent, for NIP-OA delegation) removed from
/// `relay_members` mid-session is denied on its very next Lab Board write,
/// not just its next reconnect.
pub async fn is_lab_board_member(
    state: &AppState,
    community: CommunityId,
    pubkey: &[u8],
) -> Result<bool, String> {
    if !state.config.require_relay_membership {
        return Ok(true);
    }

    if state
        .db
        .is_relay_member(community, &hex::encode(pubkey))
        .await
        .map_err(|e| format!("relay membership check failed: {e}"))?
    {
        return Ok(true);
    }

    // Not a direct member — fall back to NIP-OA delegation via the durably
    // persisted owner mapping. An agent's own pubkey is NEVER materialized in
    // `relay_members`; only its owner's is. Skipping this fallback would lock
    // every agent out of Lab Boards while looking like a correct membership
    // check, which is precisely the population the feature exists to serve.
    if state.config.allow_nip_oa_auth {
        if let Some((_, Some(owner_bytes))) = state
            .db
            .get_agent_channel_policy(community, pubkey)
            .await
            .map_err(|e| format!("relay membership check failed: {e}"))?
        {
            return state
                .db
                .is_relay_member(community, &hex::encode(&owner_bytes))
                .await
                .map_err(|e| format!("relay membership check failed: {e}"));
        }
    }

    Ok(false)
}

/// Resolve the principals that may read a board for this authenticated
/// connection. The authenticated pubkey is always included; a managed agent's
/// owner is included only when the relay has NIP-OA enabled and the durable
/// user mapping proves that delegation.
pub async fn lab_reader_principals(
    state: &AppState,
    community: CommunityId,
    reader_pubkey: &[u8],
) -> Result<Vec<Vec<u8>>, String> {
    let mut principals = vec![reader_pubkey.to_vec()];
    if state.config.allow_nip_oa_auth {
        if let Some((_, Some(owner))) = state
            .db
            .get_agent_channel_policy(community, reader_pubkey)
            .await
            .map_err(|e| format!("lab owner lookup failed: {e}"))?
        {
            if owner.as_slice() != reader_pubkey && !principals.iter().any(|p| p == &owner) {
                principals.push(owner);
            }
        }
    }
    Ok(principals)
}

async fn lab_author_can_write(
    state: &AppState,
    community: CommunityId,
    head: &BoardHead,
    author_pubkey: &[u8],
) -> Result<bool, String> {
    if head.access_scope == "community" {
        return Ok(true);
    }
    let Some(owner) = head.owner_pubkey.as_deref() else {
        return Ok(false);
    };
    if owner == author_pubkey {
        return Ok(true);
    }
    if !state.config.allow_nip_oa_auth {
        return Ok(false);
    }
    state
        .db
        .is_agent_owner(community, author_pubkey, owner)
        .await
        .map_err(|e| format!("lab owner authorization failed: {e}"))
}

async fn effective_board_owner(
    state: &AppState,
    community: CommunityId,
    author_pubkey: &[u8],
) -> Result<Option<Vec<u8>>, String> {
    match state
        .db
        .get_agent_channel_policy(community, author_pubkey)
        .await
        .map_err(|e| format!("lab owner lookup failed: {e}"))?
    {
        Some((_, Some(owner))) => Ok(Some(owner)),
        Some((_, None)) => Ok(Some(author_pubkey.to_vec())),
        None => Ok(None),
    }
}

async fn check_lab_board_membership(
    state: &Arc<AppState>,
    community: CommunityId,
    author_pubkey: &[u8; 32],
) -> Result<(), IngestError> {
    match is_lab_board_member(state, community, author_pubkey.as_slice()).await {
        Ok(true) => Ok(()),
        Ok(false) => Err(IngestError::AuthFailed(
            "restricted: not a relay member".to_string(),
        )),
        Err(e) => Err(IngestError::Internal(format!("error: {e}"))),
    }
}

/// Writes per author per minute before the relay starts refusing.
///
/// Sized for humans and for an agent doing real work (a board edit is a
/// deliberate act, not telemetry), while still bounding a runaway loop to
/// something an operator can notice and stop.
const MAX_BOARD_WRITES_PER_MINUTE: u32 = 30;

/// Check + bump the per-author Lab write budget.
///
/// Scoped by community so a key active in one tenant cannot spend another
/// tenant's budget, mirroring `observer_frame_rate_limited`. Enforced BEFORE
/// the CAS transaction opens: the advisory lock this write would take is the
/// one resource every other writer on that board waits behind, so a loop must
/// be stopped before it acquires it, not after.
fn lab_write_rate_limited(
    state: &AppState,
    community: CommunityId,
    author_pubkey: [u8; 32],
) -> bool {
    let now = std::time::Instant::now();
    let mut entry = state
        .lab_board_rate_limiter
        .entry((community, author_pubkey))
        .or_insert((0, now));
    let (count, window_start) = entry.value_mut();
    if now.duration_since(*window_start).as_secs() >= 60 {
        *count = 1;
        *window_start = now;
        false
    } else {
        *count += 1;
        *count > MAX_BOARD_WRITES_PER_MINUTE
    }
}

/// Entry point called from `ingest_event_inner` when `kind_u32 ==
/// KIND_LAB_BOARD_REVISION`. See the module doc for the full 9-step
/// algorithm this implements.
pub async fn handle_lab_board_revision_event(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event: Event,
    auth: &IngestAuth,
) -> Result<IngestResult, IngestError> {
    let event_id_hex = event.id.to_hex();
    let community = tenant.community();

    // Lab Boards are community-global, so a token restricted to a set of
    // channels must not be able to write one.
    //
    // `ingest_event_inner` enforces this for every other global kind, but that
    // check lives *after* the branch that routes kind:40101 here (Lab has no
    // `h` tag, so it returns before channel resolution runs at all). Repeating
    // the rule here is what keeps the restriction from being silently skipped
    // for this one kind — the alternative, moving the dispatch below the
    // channel block, would drag Lab through machinery it has no channel for.
    if auth.channel_ids().is_some() {
        return Err(IngestError::AuthFailed(
            "restricted: channel-scoped tokens cannot publish global events".into(),
        ));
    }

    let envelope = parse_lab_board_envelope(&event)
        .map_err(|e| IngestError::Rejected(format!("invalid: {e}")))?;

    if event.content.len() > MAX_MARKDOWN_BYTES {
        return Err(IngestError::Rejected(format!(
            "invalid: lab board markdown exceeds maximum size of {MAX_MARKDOWN_BYTES} bytes (got {})",
            event.content.len()
        )));
    }

    let author_pubkey = auth.pubkey().to_bytes();
    let author_pubkey_hex = auth.pubkey().to_hex();
    let content_hash: [u8; 32] = Sha256::digest(event.content.as_bytes()).into();

    // Real community-membership gate (see `check_lab_board_membership` doc):
    // no-op on an open relay, but on a closed relay this is the only place
    // that re-derives Lab Board write eligibility per event rather than
    // trusting the connection's membership state as of its AUTH handshake.
    // Checked before the moderation-role check below so a non-member is
    // denied "not a relay member" rather than the more specific-sounding
    // "moderator access required".
    check_lab_board_membership(state, community, &author_pubkey).await?;

    // Budget check before the transaction, for the reason in the doc above.
    if lab_write_rate_limited(state, community, author_pubkey) {
        return Err(IngestError::Rejected(format!(
            "rate-limited: too many lab board writes; retry in 60s (limit {MAX_BOARD_WRITES_PER_MINUTE}/min)"
        )));
    }

    // Moderation ops (archive/unarchive/freeze/unfreeze) require community
    // owner/admin. `Scope::BoardsModerate` alone cannot enforce this — pure
    // Nostr auth grants `Scope::all_known()` to every authenticated
    // connection (see the `Scope` module doc) — so the real gate is role,
    // via the same community-authority seam `Ban`/`Timeout`/`ResolveReport`
    // use. Checked before opening the CAS transaction, matching how the
    // generic scope check in `ingest_event_inner` also runs pre-persistence.
    if envelope.op.is_moderation() {
        moderation_authz::authorize_moderation_action(
            tenant,
            state,
            &author_pubkey,
            None,
            ModerationTarget::None,
            ModerationAction::ModerateBoard,
        )
        .await
        .map_err(|e| IngestError::AuthFailed(format!("restricted: {e}")))?;
    }

    let mut tx = state
        .db
        .begin_transaction()
        .await
        .map_err(|e| IngestError::Internal(format!("error: begin transaction: {e}")))?;

    // Steps 2–3: advisory lock + `SELECT ... FOR UPDATE`.
    let current_head =
        buzz_db::lab::get_board_head_for_update_tx(&mut tx, community, envelope.board_id)
            .await
            .map_err(|e| {
                IngestError::Internal(format!("error: database error reading board head: {e}"))
            })?;

    // Idempotent-replay short-circuit: a client resending the exact same
    // signed event after a dropped ack (WS/HTTP response lost, connection
    // timeout) must be recognized as "already done" *before* any CAS/
    // status-transition check runs — those checks are keyed off `prev`/
    // current `status`, which the retry's own prior commit already advanced,
    // so evaluating them against the now-current state would spuriously
    // reject a successful edit as a conflict. Must run after acquiring the
    // board lock (so it observes a fully consistent, serialized view) and
    // before `handle_content_mutation`/`handle_moderation_op`. See
    // `buzz_db::lab::revision_event_exists_tx` doc and the module doc's
    // "Known gaps" note on why the `ON CONFLICT DO NOTHING` duplicate path
    // inside those functions alone is not reachable for this case.
    let already_accepted =
        buzz_db::lab::revision_event_exists_tx(&mut tx, community, event.id.as_bytes())
            .await
            .map_err(|e| {
                IngestError::Internal(format!("error: database error checking replay: {e}"))
            })?;

    let result = if already_accepted {
        Ok((None, None, "duplicate:".to_string()))
    } else if envelope.op.is_content_mutation() {
        handle_content_mutation(
            &mut tx,
            tenant,
            state,
            &event,
            &envelope,
            current_head,
            &author_pubkey,
            &content_hash,
        )
        .await
    } else {
        handle_moderation_op(
            &mut tx,
            tenant,
            state,
            &event,
            &envelope,
            current_head,
            &author_pubkey,
        )
        .await
    };

    let (revision_stored, head_stored, message) = match result {
        Ok(outcome) => outcome,
        Err(e) => {
            let _ = tx.rollback().await;
            return Err(e);
        }
    };

    tx.commit()
        .await
        .map_err(|e| IngestError::Internal(format!("error: commit lab board transaction: {e}")))?;

    // Step 9: publish ONLY after a successful commit.
    if let Some(revision_stored) = revision_stored {
        dispatch_persistent_event(
            tenant,
            state,
            &revision_stored,
            KIND_LAB_BOARD_REVISION,
            &author_pubkey_hex,
            None,
        )
        .await;
    }
    if let Some(head_stored) = head_stored {
        let relay_pubkey_hex = state.relay_keypair.public_key().to_hex();
        dispatch_persistent_event(
            tenant,
            state,
            &head_stored,
            KIND_LAB_BOARD_HEAD,
            &relay_pubkey_hex,
            None,
        )
        .await;
    }

    Ok(IngestResult {
        event_id: event_id_hex,
        accepted: true,
        message,
    })
}

type MutationOutcome = (
    Option<buzz_core::StoredEvent>,
    Option<buzz_core::StoredEvent>,
    String,
);

/// Steps 4–8 for `create`/`update`/`restore`.
#[allow(clippy::too_many_arguments)]
async fn handle_content_mutation(
    tx: &mut sqlx::Transaction<'static, sqlx::Postgres>,
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event: &Event,
    envelope: &LabBoardEnvelope,
    current_head: Option<BoardHead>,
    author_pubkey: &[u8; 32],
    content_hash: &[u8; 32],
) -> Result<MutationOutcome, IngestError> {
    let community = tenant.community();

    // Step 4: CAS compare.
    match (envelope.op, &current_head) {
        (LabBoardOp::Create | LabBoardOp::CreateV2, Some(_)) => {
            return Err(board_head_mismatch(&format!(
                "board {} already exists",
                envelope.board_id
            )));
        }
        (LabBoardOp::Create | LabBoardOp::CreateV2, None) => {}
        (LabBoardOp::Update | LabBoardOp::UpdateV2 | LabBoardOp::Restore, None) => {
            return Err(IngestError::Rejected(format!(
                "invalid: lab board {} does not exist",
                envelope.board_id
            )));
        }
        (LabBoardOp::Update | LabBoardOp::UpdateV2 | LabBoardOp::Restore, Some(head)) => {
            if !lab_author_can_write(state, community, head, author_pubkey)
                .await
                .map_err(|e| IngestError::Internal(format!("error: {e}")))?
            {
                // Deliberately use the same response as an unknown board for
                // restricted writes: guessed private board IDs do not become
                // an existence oracle.
                return Err(IngestError::Rejected(
                    "invalid: lab board not found".to_string(),
                ));
            }
            if head.status == "frozen" {
                return Err(IngestError::Rejected(
                    "restricted: lab board is frozen and cannot be edited".into(),
                ));
            }
            let prev = envelope
                .prev
                .expect("validated present for update/restore in parse_lab_board_envelope");
            if head.head_revision_event_id.as_slice() != prev.as_slice() {
                return Err(board_head_mismatch(&format!(
                    "submitted prev {} does not match current head {}",
                    hex::encode(prev),
                    hex::encode(&head.head_revision_event_id)
                )));
            }
        }
        (
            LabBoardOp::Archive | LabBoardOp::Unarchive | LabBoardOp::Freeze | LabBoardOp::Unfreeze,
            _,
        ) => {
            unreachable!("moderation ops never reach handle_content_mutation")
        }
    }

    let new_revision = current_head.as_ref().map_or(1, |h| h.revision + 1);
    if let Some(claimed) = envelope.claimed_revision {
        if claimed != new_revision {
            return Err(board_head_mismatch(&format!(
                "submitted revision {claimed} does not match server-computed revision {new_revision}"
            )));
        }
    }

    // A `restore` claims provenance: "this content is revision N brought back".
    // Verify that claim inside the transaction before recording it, otherwise
    // `restored_from` is only an assertion by the client and the audit trail
    // can be made to say something that never happened — an editor could
    // publish arbitrary text labelled as a restore of a revision the community
    // trusts.
    if envelope.op == LabBoardOp::Restore {
        let restored_from = envelope
            .restored_from
            .expect("validated present for restore in parse_lab_board_envelope");
        if restored_from < 1 || restored_from >= new_revision {
            return Err(IngestError::Rejected(format!(
                "invalid: restored_from {restored_from} must name an existing earlier revision (current head is {})",
                new_revision - 1
            )));
        }
        let source =
            buzz_db::lab::get_board_revision_tx(tx, community, envelope.board_id, restored_from)
                .await
                .map_err(|e| IngestError::Internal(format!("error: database error: {e}")))?
                .ok_or_else(|| {
                    IngestError::Rejected(format!(
                        "invalid: lab board {} has no revision {restored_from}",
                        envelope.board_id
                    ))
                })?;
        if source.content_hash.as_slice() != content_hash.as_slice() {
            return Err(IngestError::Rejected(format!(
                "invalid: submitted content does not match revision {restored_from}"
            )));
        }
    }

    let title = envelope
        .title
        .clone()
        .or_else(|| current_head.as_ref().map(|h| h.title.clone()))
        .expect("create requires title; update/restore fall back to current_head.title, which exists whenever current_head is Some — both cases are exhaustive here");
    let summary = envelope
        .summary
        .clone()
        .or_else(|| current_head.as_ref().and_then(|h| h.summary.clone()));

    // ACL metadata is immutable after creation. V2 creates derive the owner
    // from durable user/NIP-OA state; restricted boards fail closed when that
    // state cannot produce a canonical owner. Legacy creates remain
    // community boards so V1 staging rows retain compatibility.
    let (access_scope, owner_pubkey, topic_tags) = match current_head.as_ref() {
        None => {
            let scope = envelope
                .access_scope
                .as_deref()
                .unwrap_or("community")
                .to_owned();
            let owner = effective_board_owner(state, community, author_pubkey)
                .await
                .map_err(|e| IngestError::Internal(format!("error: {e}")))?;
            if scope != "community" && owner.is_none() {
                return Err(IngestError::Rejected(
                    "restricted: cannot create a restricted lab board without a canonical owner"
                        .to_string(),
                ));
            }
            (scope, owner, envelope.tags.clone().unwrap_or_default())
        }
        Some(head) => (
            head.access_scope.clone(),
            head.owner_pubkey.clone(),
            envelope.tags.clone().unwrap_or_else(|| head.tags.clone()),
        ),
    };

    // Step 5: insert the client-signed revision event.
    let (revision_stored, inserted) = buzz_db::lab::insert_revision_event_tx(tx, community, event)
        .await
        .map_err(|e| IngestError::Internal(format!("error: database error: {e}")))?;
    if !inserted {
        // Exact-id replay of an already-accepted event — idempotent no-op,
        // not an error (mirrors the generic `!was_inserted` duplicate path
        // in `ingest_event_inner`).
        return Ok((None, None, "duplicate:".to_string()));
    }

    // Step 7: build + sign the new head projection.
    let status = current_head
        .as_ref()
        .map_or("active", |h| h.status.as_str())
        .to_string();
    let head_event = build_head_projection_event(
        tenant,
        &state.relay_keypair,
        envelope.board_id,
        &event.content,
        new_revision,
        &title,
        summary.as_deref(),
        &event.id.to_hex(),
        &status,
        &access_scope,
        owner_pubkey.as_deref(),
        &topic_tags,
    )?;

    // Step 8: replace the head projection event + upsert lab_board_heads —
    // still inside this transaction.
    let previous_projection_id = current_head
        .as_ref()
        .and_then(|h| h.head_projection_event_id.clone());
    let head_stored = buzz_db::lab::replace_head_projection_event_tx(
        tx,
        community,
        &head_event,
        previous_projection_id.as_deref(),
    )
    .await
    .map_err(|e| IngestError::Internal(format!("error: database error: {e}")))?;

    if current_head.is_none() {
        buzz_db::lab::create_board_head_tx(
            tx,
            community,
            envelope.board_id,
            event.id.as_bytes(),
            head_event.id.as_bytes(),
            &title,
            summary.as_deref(),
            &access_scope,
            owner_pubkey.as_deref(),
            &topic_tags,
            author_pubkey.as_slice(),
        )
        .await
        .map_err(|e| IngestError::Internal(format!("error: database error: {e}")))?;
    } else {
        buzz_db::lab::update_board_content_head_tx(
            tx,
            community,
            envelope.board_id,
            new_revision,
            event.id.as_bytes(),
            head_event.id.as_bytes(),
            &title,
            summary.as_deref(),
            &topic_tags,
            author_pubkey.as_slice(),
        )
        .await
        .map_err(|e| IngestError::Internal(format!("error: database error: {e}")))?;
    }

    // Step 9: append the revisions-table row.
    //
    // ⚠️ ORDERING IS LOAD-BEARING: this MUST run after the `lab_board_heads`
    // upsert above, never before. `lab_board_revisions` carries
    // `FOREIGN KEY (community_id, board_id) REFERENCES lab_board_heads` (see
    // migration 0029), so on an `op=create` — where the head row does not
    // exist until `create_board_head_tx` runs — inserting the revision first
    // violates that constraint and fails the whole transaction with a 500.
    // Only `create` is affected (an `update`/`restore` finds the head row
    // already there), which is exactly why unit tests and static review both
    // missed it: it only reproduces against a real PostgreSQL, on the very
    // first write to a board.
    buzz_db::lab::record_board_revision_tx(
        tx,
        community,
        envelope.board_id,
        new_revision,
        event.id.as_bytes(),
        envelope.prev.as_ref().map(|p| p.as_slice()),
        envelope.op.revision_operation_label(),
        author_pubkey.as_slice(),
        content_hash.as_slice(),
        if envelope.op == LabBoardOp::Restore {
            envelope.restored_from
        } else {
            None
        },
    )
    .await
    .map_err(|e| IngestError::Internal(format!("error: database error: {e}")))?;

    Ok((Some(revision_stored), Some(head_stored), String::new()))
}

/// Steps 4–8 for `archive`/`unarchive`/`freeze`/`unfreeze`.
///
/// Content and revision are untouched, but the head projection IS re-signed:
/// `status` is one of its tags, and clients read that tag to decide whether a
/// board can be edited and whether it belongs in an archived filter. Leaving
/// the old projection in place would keep announcing `active` over Nostr while
/// the database said `archived` — the UI would offer an Edit button for a
/// board nobody can edit, and no client could filter archived boards without
/// a separate database read it has no access to. Database state and published
/// state must not disagree.
#[allow(clippy::too_many_arguments)]
async fn handle_moderation_op(
    tx: &mut sqlx::Transaction<'static, sqlx::Postgres>,
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event: &Event,
    envelope: &LabBoardEnvelope,
    current_head: Option<BoardHead>,
    author_pubkey: &[u8; 32],
) -> Result<MutationOutcome, IngestError> {
    let community = tenant.community();
    let Some(head) = current_head else {
        return Err(IngestError::Rejected(format!(
            "invalid: lab board {} does not exist",
            envelope.board_id
        )));
    };
    if head.status != envelope.op.required_source_status() {
        return Err(IngestError::Rejected(format!(
            "invalid: cannot {} a lab board with status '{}' (expected '{}')",
            envelope.op.as_str(),
            head.status,
            envelope.op.required_source_status()
        )));
    }

    let (revision_stored, inserted) = buzz_db::lab::insert_revision_event_tx(tx, community, event)
        .await
        .map_err(|e| IngestError::Internal(format!("error: database error: {e}")))?;
    if !inserted {
        return Ok((None, None, "duplicate:".to_string()));
    }

    // The projection mirrors the head revision's Markdown; read it back rather
    // than duplicating the text into `lab_board_heads`, where it could drift
    // from the event that is the actual record.
    let head_content =
        buzz_db::lab::get_event_content_tx(tx, community, head.head_revision_event_id.as_slice())
            .await
            .map_err(|e| IngestError::Internal(format!("error: database error: {e}")))?
            .ok_or_else(|| {
                IngestError::Internal(
                    "error: lab board head revision event is missing from storage".to_string(),
                )
            })?;

    let new_status = envelope.op.target_status();

    // Re-sign the projection with the new status, reusing the head revision's
    // content and number — this is a status change, not a content change.
    let head_event = build_head_projection_event(
        tenant,
        &state.relay_keypair,
        envelope.board_id,
        &head_content,
        head.revision,
        &head.title,
        head.summary.as_deref(),
        &hex::encode(&head.head_revision_event_id),
        new_status,
        &head.access_scope,
        head.owner_pubkey.as_deref(),
        &head.tags,
    )?;
    let head_stored = buzz_db::lab::replace_head_projection_event_tx(
        tx,
        community,
        &head_event,
        head.head_projection_event_id.as_deref(),
    )
    .await
    .map_err(|e| IngestError::Internal(format!("error: database error: {e}")))?;

    buzz_db::lab::set_board_status_tx(
        tx,
        community,
        envelope.board_id,
        new_status,
        author_pubkey.as_slice(),
        Some(head_event.id.as_bytes()),
    )
    .await
    .map_err(|e| IngestError::Internal(format!("error: database error: {e}")))?;

    Ok((Some(revision_stored), Some(head_stored), String::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn revision_event(tags: impl IntoIterator<Item = Tag>) -> Event {
        EventBuilder::new(Kind::Custom(KIND_LAB_BOARD_REVISION as u16), "body")
            .tags(tags)
            .sign_with_keys(&nostr::Keys::generate())
            .expect("sign test Lab Board event")
    }

    #[test]
    fn v2_envelope_requires_replace_marker_and_keeps_canonical_tags() {
        let board_id = Uuid::new_v4().to_string();
        let event = revision_event([
            Tag::parse(["d", board_id.as_str()]).expect("d tag"),
            Tag::parse(["op", "create_v2"]).expect("op tag"),
            Tag::parse(["title", "Sprint"]).expect("title tag"),
            Tag::parse(["access_scope", "private"]).expect("scope tag"),
            Tag::parse(["tags", "replace"]).expect("tags marker"),
            Tag::parse(["t", "sprint-plan"]).expect("topic tag"),
        ]);
        let envelope = parse_lab_board_envelope(&event).expect("parse V2 envelope");
        assert_eq!(envelope.access_scope.as_deref(), Some("private"));
        assert_eq!(envelope.tags, Some(vec!["sprint-plan".to_string()]));
    }

    #[test]
    fn client_cannot_supply_owner_or_noncanonical_topic_tag() {
        let board_id = Uuid::new_v4().to_string();
        let owner_event = revision_event([
            Tag::parse(["d", board_id.as_str()]).expect("d tag"),
            Tag::parse(["op", "create_v2"]).expect("op tag"),
            Tag::parse(["title", "Private"]).expect("title tag"),
            Tag::parse(["access_scope", "private"]).expect("scope tag"),
            Tag::parse(["tags", "replace"]).expect("tags marker"),
            Tag::parse(["owner", "forged"]).expect("owner tag"),
        ]);
        assert!(parse_lab_board_envelope(&owner_event)
            .err()
            .expect("forged owner must be rejected")
            .contains("owner"));

        let tag_event = revision_event([
            Tag::parse(["d", board_id.as_str()]).expect("d tag"),
            Tag::parse(["op", "create_v2"]).expect("op tag"),
            Tag::parse(["title", "Private"]).expect("title tag"),
            Tag::parse(["access_scope", "private"]).expect("scope tag"),
            Tag::parse(["tags", "replace"]).expect("tags marker"),
            Tag::parse(["t", "Sprint Plan"]).expect("topic tag"),
        ]);
        assert!(parse_lab_board_envelope(&tag_event)
            .err()
            .expect("noncanonical tag must be rejected")
            .contains("canonical"));
    }

    #[test]
    fn tag_normalization_matches_wire_contract() {
        assert_eq!(normalize_lab_tag("  Sprint / Plano  "), "sprint-plano");
        assert_eq!(normalize_lab_tag("Café\u{00a0}Ação"), "café-ação");
        assert_eq!(normalize_lab_tag("---_Roadmap_---"), "roadmap");
    }
}

/// End-to-end moderation-op tests against a real PostgreSQL.
///
/// Why these are not unit tests: `handle_moderation_op` reads the head
/// revision's content back out of `events` inside the CAS transaction, re-signs
/// a kind:30623 projection, and replaces the previous projection row — three
/// steps whose interaction with the schema (partitioned `events`,
/// `lab_board_heads`' FK onto it, the `SELECT ... FOR UPDATE` gate) only
/// exists against Postgres. The sibling precedent is the comment above
/// `record_board_revision_tx`: a `lab_board_revisions` FK ordering bug once
/// survived the whole unit suite and every review, because nothing but a real
/// database can raise it.
///
/// These tests drive the *production* entry point
/// ([`handle_lab_board_revision_event`]) with the exact events a client signs,
/// so a change to the parser, the authorization order, or the projection step
/// fails here.
///
/// Run with a throwaway database — never the live relay's:
/// ```text
/// docker compose -p buzz-modtest -f compose.modtest.yml up -d   # postgres:17-alpine on 127.0.0.1:55433
/// BUZZ_TEST_DATABASE_URL=postgres://buzz:buzz_modtest@127.0.0.1:55433/buzz \
///   cargo test -p buzz-relay --lib handlers::lab::postgres_tests -- --ignored --test-threads=1 --nocapture
/// ```
#[cfg(test)]
mod postgres_tests {
    use super::*;
    use crate::handlers::ingest::{IngestAuth, IngestError};
    use buzz_auth::Scope;
    use nostr::Keys;

    /// Test-only database URL. Deliberately has **no default**: this repo's
    /// relay runs in production on the same host as some developer machines,
    /// and a default of `postgres://…@localhost:5432/buzz` (the convention the
    /// older Postgres tests use) is one port-forward away from writing board
    /// rows into a live community. An unset variable skips the test instead.
    fn test_database_url() -> Option<String> {
        std::env::var("BUZZ_TEST_DATABASE_URL")
            .ok()
            .filter(|u| !u.trim().is_empty())
    }

    /// A relay state wired to `url`, with a deliberately dead Redis
    /// (`127.0.0.1:1`): `dispatch_persistent_event` runs after commit and only
    /// logs a publish failure, so fan-out cannot mask a persistence bug — and
    /// the test needs no broker. Mirrors
    /// `handlers::event::tests::test_state_with_redis_url`.
    ///
    /// Returns `None` when Postgres is unreachable so the test skips rather
    /// than failing for an absent dependency.
    async fn lab_test_state(
        url: &str,
        require_relay_membership: bool,
    ) -> Option<(Arc<AppState>, sqlx::PgPool)> {
        lab_test_state_with(url, require_relay_membership, false).await
    }

    async fn lab_test_state_with(
        url: &str,
        require_relay_membership: bool,
        allow_nip_oa_auth: bool,
    ) -> Option<(Arc<AppState>, sqlx::PgPool)> {
        let mut config = crate::config::Config::from_env().ok()?;
        config.database_url = url.to_string();
        config.redis_url = "redis://127.0.0.1:1".to_string();
        config.require_relay_membership = require_relay_membership;
        config.allow_nip_oa_auth = allow_nip_oa_auth;

        let pool = sqlx::PgPool::connect(url).await.ok()?;
        let db = buzz_db::Db::from_pool(pool.clone());
        db.migrate().await.expect("apply migrations to test DB");

        let redis_pool = deadpool_redis::Config::from_url(&config.redis_url)
            .create_pool(Some(deadpool_redis::Runtime::Tokio1))
            .expect("redis pool");
        let pubsub = Arc::new(
            buzz_pubsub::PubSubManager::new(&config.redis_url, redis_pool.clone())
                .await
                .expect("pubsub manager"),
        );
        let audit = buzz_audit::AuditService::new(pool.clone());
        let auth = buzz_auth::AuthService::new(config.auth.clone());
        let search = buzz_search::SearchService::new(pool.clone());
        let workflow_engine = Arc::new(buzz_workflow::WorkflowEngine::new(
            db.clone(),
            buzz_workflow::WorkflowConfig::default(),
        ));
        let media_storage = buzz_media::MediaStorage::new(&config.media).expect("media storage");
        let (state, _audit_shutdown) = crate::state::AppState::new(
            config,
            db,
            redis_pool,
            audit,
            pubsub,
            auth,
            search,
            workflow_engine,
            Keys::generate(),
            media_storage,
        );
        Some((Arc::new(state), pool))
    }

    /// A fresh community plus its tenant context. Each test gets its own host
    /// so runs never collide on `lab_board_heads`' `(community_id, board_id)`.
    async fn fresh_community(state: &Arc<AppState>) -> TenantContext {
        let host = format!("lab-modtest-{}.example", Uuid::new_v4().simple());
        let community = state
            .db
            .ensure_configured_community(&host)
            .await
            .expect("ensure community")
            .id;
        TenantContext::resolved(community, host)
    }

    async fn grant_role(state: &Arc<AppState>, tenant: &TenantContext, keys: &Keys, role: &str) {
        state
            .db
            .add_relay_member(
                tenant.community(),
                &keys.public_key().to_hex(),
                role,
                Some("modtest"),
            )
            .await
            .expect("add relay member");
    }

    /// The WS-authenticated principal shape Lab writes arrive under.
    fn nip42_auth(keys: &Keys) -> IngestAuth {
        IngestAuth::Nip42 {
            pubkey: keys.public_key(),
            scopes: Scope::all_known(),
            channel_ids: None,
            conn_id: Uuid::new_v4(),
        }
    }

    fn signed(keys: &Keys, content: &str, tags: Vec<Vec<&str>>) -> Event {
        let tags = tags
            .into_iter()
            .map(|t| Tag::parse(t).expect("tag"))
            .collect::<Vec<_>>();
        EventBuilder::new(Kind::Custom(KIND_LAB_BOARD_REVISION as u16), content)
            .tags(tags)
            .sign_with_keys(keys)
            .expect("sign lab board event")
    }

    /// **The exact bytes the desktop client emits** for archive/unarchive:
    /// empty content, `d` + `op` and nothing else. Written as one helper so a
    /// future edit to the client contract has a single place to break.
    fn moderation_event(keys: &Keys, board_id: Uuid, op: &str) -> Event {
        signed(
            keys,
            "",
            vec![vec!["d", &board_id.to_string()], vec!["op", op]],
        )
    }

    /// Create a board through the real handler, returning its id and the
    /// accepted create event.
    async fn create_board(
        state: &Arc<AppState>,
        tenant: &TenantContext,
        keys: &Keys,
        title: &str,
        content: &str,
    ) -> (Uuid, Event) {
        let board_id = Uuid::new_v4();
        let event = signed(
            keys,
            content,
            vec![
                vec!["d", &board_id.to_string()],
                vec!["op", "create"],
                vec!["title", title],
            ],
        );
        let result =
            handle_lab_board_revision_event(tenant, state, event.clone(), &nip42_auth(keys))
                .await
                .expect("create board");
        assert!(result.accepted, "create must be accepted");
        (board_id, event)
    }

    /// Read a stored kind:30623 projection back out of `events` and return its
    /// `status` tag — the single value the desktop's archived/active filter
    /// depends on.
    async fn projection_status(pool: &sqlx::PgPool, event_id: &[u8]) -> String {
        let tags: serde_json::Value = sqlx::query_scalar("SELECT tags FROM events WHERE id = $1")
            .bind(event_id)
            .fetch_one(pool)
            .await
            .expect("read projection event");
        tags.as_array()
            .expect("tags array")
            .iter()
            .find_map(|t| {
                let t = t.as_array()?;
                (t.first()?.as_str()? == "status").then(|| t.get(1)?.as_str().map(str::to_owned))?
            })
            .expect("projection carries a status tag")
    }

    fn err_message(e: &IngestError) -> String {
        match e {
            IngestError::Rejected(m) | IngestError::AuthFailed(m) | IngestError::Internal(m) => {
                m.clone()
            }
        }
    }

    /// `Result::expect_err` needs `IngestResult: Debug`, which the production
    /// type does not derive — and a test is no reason to widen a production
    /// type. This does the same job and prints the accepted outcome's fields
    /// when a write that must be refused is instead accepted.
    fn expect_refusal(
        outcome: Result<crate::handlers::ingest::IngestResult, IngestError>,
        what: &str,
    ) -> IngestError {
        match outcome {
            Ok(r) => panic!(
                "{what}: expected a refusal, but the relay ACCEPTED it \
                 (accepted={}, message={:?}, event_id={})",
                r.accepted, r.message, r.event_id
            ),
            Err(e) => e,
        }
    }

    /// Items 1-3: the client's exact wire shape archives a board, the head
    /// projection is re-signed with the new status, and unarchive round-trips.
    ///
    /// This is also the test for the `prev` claim: the events below carry **no
    /// `prev` tag**. If `prev` were required for moderation ops, the create
    /// would succeed and the archive would be rejected by
    /// `parse_lab_board_envelope` before any database work happened.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn archive_and_unarchive_round_trip_and_resign_the_head_projection() {
        let Some(url) = test_database_url() else {
            eprintln!("SKIP: set BUZZ_TEST_DATABASE_URL to a throwaway database");
            return;
        };
        let Some((state, pool)) = lab_test_state(&url, true).await else {
            panic!("test Postgres unreachable at {url}");
        };
        let tenant = fresh_community(&state).await;
        let owner = Keys::generate();
        grant_role(&state, &tenant, &owner, "owner").await;

        let (board_id, _create) =
            create_board(&state, &tenant, &owner, "Quadro de teste", "# corpo\n").await;

        let before = buzz_db::lab::get_board_head(&pool, tenant.community(), board_id)
            .await
            .expect("read head")
            .expect("head exists");
        assert_eq!(before.status, "active");
        assert!(before.archived_at.is_none() && before.archived_by.is_none());
        let projection_before = before
            .head_projection_event_id
            .clone()
            .expect("create publishes a projection");
        assert_eq!(
            projection_status(&pool, &projection_before).await,
            "active",
            "a fresh board must publish status=active"
        );

        // --- 1. archive, with the client's exact event -------------------
        let archive = moderation_event(&owner, board_id, "archive");
        assert!(
            archive.content.is_empty(),
            "the client sends empty content for a moderation op"
        );
        assert_eq!(archive.tags.len(), 2, "the client sends only `d` and `op`");
        let result = handle_lab_board_revision_event(&tenant, &state, archive, &nip42_auth(&owner))
            .await
            .expect("archive must be accepted");
        assert!(result.accepted);
        assert_eq!(result.message, "", "a first archive is not a duplicate");

        let archived = buzz_db::lab::get_board_head(&pool, tenant.community(), board_id)
            .await
            .expect("read head")
            .expect("head exists");
        assert_eq!(archived.status, "archived");
        assert!(
            archived.archived_at.is_some(),
            "archived_at must be stamped"
        );
        assert_eq!(
            archived.archived_by.as_deref(),
            Some(owner.public_key().to_bytes().as_slice()),
            "archived_by must record the moderator"
        );
        assert_eq!(
            archived.revision, before.revision,
            "a status flip does not consume a revision number"
        );
        assert_eq!(
            archived.head_revision_event_id, before.head_revision_event_id,
            "a status flip does not move the content head"
        );

        // --- 2. the projection IS re-signed ------------------------------
        // The module doc used to claim moderation ops "don't touch the head
        // projection". They do, and the desktop's archived filter depends on
        // it: without a new kind:30623 the client would keep reading
        // status=active forever.
        let projection_archived = archived
            .head_projection_event_id
            .clone()
            .expect("archive must leave a projection in place");
        eprintln!(
            "projection before archive: {} (status=active)\nprojection after  archive: {} (status={})",
            hex::encode(&projection_before),
            hex::encode(&projection_archived),
            projection_status(&pool, &projection_archived).await,
        );
        assert_ne!(
            projection_archived, projection_before,
            "archive must publish a NEW projection, not keep the old one"
        );
        assert_eq!(
            projection_status(&pool, &projection_archived).await,
            "archived",
            "the re-signed projection must announce the new status"
        );
        let (kind, author): (i32, Vec<u8>) =
            sqlx::query_as("SELECT kind, pubkey FROM events WHERE id = $1")
                .bind(&projection_archived)
                .fetch_one(&pool)
                .await
                .expect("read projection row");
        assert_eq!(kind, KIND_LAB_BOARD_HEAD as i32);
        assert_eq!(
            author,
            state.relay_keypair.public_key().to_bytes().to_vec(),
            "the projection must be signed by the relay, not the client"
        );
        let content: String = sqlx::query_scalar("SELECT content FROM events WHERE id = $1")
            .bind(&projection_archived)
            .fetch_one(&pool)
            .await
            .expect("read projection content");
        assert_eq!(
            content, "# corpo\n",
            "the re-signed projection mirrors the head revision's Markdown, \
             not the moderation event's empty body"
        );

        // --- 3. unarchive round-trips ------------------------------------
        let unarchive = moderation_event(&owner, board_id, "unarchive");
        handle_lab_board_revision_event(&tenant, &state, unarchive, &nip42_auth(&owner))
            .await
            .expect("unarchive must be accepted");

        let restored = buzz_db::lab::get_board_head(&pool, tenant.community(), board_id)
            .await
            .expect("read head")
            .expect("head exists");
        eprintln!(
            "head after archive:   status={} archived_at={:?} archived_by={}",
            archived.status,
            archived.archived_at,
            hex::encode(archived.archived_by.as_deref().unwrap_or_default()),
        );
        eprintln!("head after unarchive: status={}", restored.status);
        assert_eq!(restored.status, "active");
        assert!(
            restored.archived_at.is_some(),
            "archived_at is a breadcrumb and is never cleared (see BoardHead docs)"
        );
        let projection_restored = restored
            .head_projection_event_id
            .clone()
            .expect("unarchive must leave a projection in place");
        assert_ne!(projection_restored, projection_archived);
        assert_eq!(
            projection_status(&pool, &projection_restored).await,
            "active",
            "unarchive must re-announce status=active"
        );

        // A second archive of an already-active board is legal again.
        handle_lab_board_revision_event(
            &tenant,
            &state,
            moderation_event(&owner, board_id, "archive"),
            &nip42_auth(&owner),
        )
        .await
        .expect("re-archive after unarchive");
    }

    /// Item 4a — closed relay: an actor with **no `relay_members` row** is
    /// refused with `restricted: not a relay member`.
    ///
    /// This is the case for every NIP-OA managed agent: an agent's own pubkey
    /// is never materialized in `relay_members`, only its owner's. The desktop
    /// matches this string in `isBoardModerationDeniedError`; if the wording
    /// here changes, the UI silently degrades to a raw relay error.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn non_member_moderation_is_denied_on_a_closed_relay() {
        let Some(url) = test_database_url() else {
            eprintln!("SKIP: set BUZZ_TEST_DATABASE_URL to a throwaway database");
            return;
        };
        let Some((state, pool)) = lab_test_state(&url, true).await else {
            panic!("test Postgres unreachable at {url}");
        };
        let tenant = fresh_community(&state).await;
        let owner = Keys::generate();
        grant_role(&state, &tenant, &owner, "owner").await;
        let (board_id, _) = create_board(&state, &tenant, &owner, "Board", "body").await;

        let stranger = Keys::generate();
        let err = expect_refusal(
            handle_lab_board_revision_event(
                &tenant,
                &state,
                moderation_event(&stranger, board_id, "archive"),
                &nip42_auth(&stranger),
            )
            .await,
            "a non-member must not archive a board",
        );
        let message = err_message(&err);
        eprintln!("DENIAL (closed relay, no relay_members row): {message}");
        assert!(
            matches!(err, IngestError::AuthFailed(_)),
            "denial must be an auth failure, got {err:?}"
        );
        assert_eq!(message, "restricted: not a relay member");
        assert!(
            message.to_lowercase().contains("not a relay member"),
            "desktop `isBoardModerationDeniedError` matches this substring"
        );

        let head = buzz_db::lab::get_board_head(&pool, tenant.community(), board_id)
            .await
            .expect("read head")
            .expect("head exists");
        assert_eq!(head.status, "active", "the refused write must not land");
    }

    /// Item 4b — open relay (`require_relay_membership = false`): the
    /// membership gate short-circuits to `Ok`, so the refusal comes from
    /// `authorize_moderation_action` instead, with a *different* string. Both
    /// strings are load-bearing for the desktop helper, which is why both are
    /// pinned. A plain `member` is refused the same way on a closed relay.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn moderation_without_owner_or_admin_role_is_denied() {
        let Some(url) = test_database_url() else {
            eprintln!("SKIP: set BUZZ_TEST_DATABASE_URL to a throwaway database");
            return;
        };

        // Open relay, no relay_members row at all.
        let Some((open_state, _)) = lab_test_state(&url, false).await else {
            panic!("test Postgres unreachable at {url}");
        };
        let open_tenant = fresh_community(&open_state).await;
        let author = Keys::generate();
        let (open_board, _) = create_board(&open_state, &open_tenant, &author, "B", "b").await;
        let err = expect_refusal(
            handle_lab_board_revision_event(
                &open_tenant,
                &open_state,
                moderation_event(&author, open_board, "archive"),
                &nip42_auth(&author),
            )
            .await,
            "an actor with no community role must not archive a board",
        );
        let message = err_message(&err);
        eprintln!("DENIAL (open relay, no role): {message}");
        assert!(matches!(err, IngestError::AuthFailed(_)));
        assert_eq!(message, "restricted: moderator access required");

        // Closed relay, a real `member` row — membership passes, role does not.
        let Some((state, _)) = lab_test_state(&url, true).await else {
            panic!("test Postgres unreachable at {url}");
        };
        let tenant = fresh_community(&state).await;
        let owner = Keys::generate();
        grant_role(&state, &tenant, &owner, "owner").await;
        let member = Keys::generate();
        grant_role(&state, &tenant, &member, "member").await;
        let (board_id, _) = create_board(&state, &tenant, &owner, "B", "b").await;

        let err = expect_refusal(
            handle_lab_board_revision_event(
                &tenant,
                &state,
                moderation_event(&member, board_id, "archive"),
                &nip42_auth(&member),
            )
            .await,
            "a plain member must not archive a board",
        );
        let message = err_message(&err);
        eprintln!("DENIAL (closed relay, role=member): {message}");
        assert_eq!(message, "restricted: moderator access required");

        // An `admin` may, so the denial above is about role and not about
        // "anyone other than the creator".
        let admin = Keys::generate();
        grant_role(&state, &tenant, &admin, "admin").await;
        handle_lab_board_revision_event(
            &tenant,
            &state,
            moderation_event(&admin, board_id, "archive"),
            &nip42_auth(&admin),
        )
        .await
        .expect("a community admin may archive");
    }

    /// Item 4c — the population the desktop's denial copy actually names: a
    /// **NIP-OA managed agent whose owner IS a community owner**.
    ///
    /// This is the asymmetry worth pinning. [`is_lab_board_member`] resolves
    /// the agent through `users.agent_owner_pubkey`, so the agent passes the
    /// membership gate — it may create and edit boards. But
    /// `moderation_authz::authorize_moderation_action` looks up
    /// `relay_members` for the **actor's own pubkey** with no owner fallback,
    /// so the same agent is refused every moderation op. Delegation carries
    /// write authority and does not carry moderator authority.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn a_managed_agent_inherits_membership_but_never_moderator_authority() {
        let Some(url) = test_database_url() else {
            eprintln!("SKIP: set BUZZ_TEST_DATABASE_URL to a throwaway database");
            return;
        };
        let Some((state, pool)) = lab_test_state_with(&url, true, true).await else {
            panic!("test Postgres unreachable at {url}");
        };
        let tenant = fresh_community(&state).await;
        let community = tenant.community();

        let human_owner = Keys::generate();
        grant_role(&state, &tenant, &human_owner, "owner").await;

        // The durable NIP-OA mapping the AUTH handshake would have persisted.
        let agent = Keys::generate();
        state
            .db
            .ensure_user(community, &agent.public_key().to_bytes())
            .await
            .expect("ensure agent user");
        state
            .db
            .ensure_user(community, &human_owner.public_key().to_bytes())
            .await
            .expect("ensure owner user");
        assert!(
            state
                .db
                .set_agent_owner(
                    community,
                    &agent.public_key().to_bytes(),
                    &human_owner.public_key().to_bytes(),
                )
                .await
                .expect("set agent owner"),
            "the agent must be durably owned by the community owner"
        );
        assert!(
            !state
                .db
                .is_relay_member(community, &agent.public_key().to_hex())
                .await
                .expect("membership lookup"),
            "an agent's own pubkey is never materialized in relay_members"
        );

        // Membership: inherited. The agent can create a board.
        let (board_id, _) = create_board(&state, &tenant, &agent, "Agent board", "body").await;

        // Moderation: NOT inherited.
        let err = expect_refusal(
            handle_lab_board_revision_event(
                &tenant,
                &state,
                moderation_event(&agent, board_id, "archive"),
                &nip42_auth(&agent),
            )
            .await,
            "a managed agent must not archive a board even when its owner is a community owner",
        );
        let message = err_message(&err);
        eprintln!("DENIAL (NIP-OA agent, owner is community owner): {message}");
        assert!(matches!(err, IngestError::AuthFailed(_)));
        assert_eq!(
            message, "restricted: moderator access required",
            "the agent passes the membership gate (so not the `not a relay member` \
             wording) and is stopped by the role gate"
        );

        // The owner itself may archive the agent's board, isolating the
        // refusal above to the actor's identity.
        handle_lab_board_revision_event(
            &tenant,
            &state,
            moderation_event(&human_owner, board_id, "archive"),
            &nip42_auth(&human_owner),
        )
        .await
        .expect("the human community owner may archive");
        let head = buzz_db::lab::get_board_head(&pool, community, board_id)
            .await
            .expect("read head")
            .expect("head exists");
        assert_eq!(head.status, "archived");
    }

    /// Item 5 — the shapes the desktop asserts it never emits really are
    /// refused, so "we don't send them" is a guarantee and not a preference.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn moderation_ops_reject_content_only_tags() {
        let Some(url) = test_database_url() else {
            eprintln!("SKIP: set BUZZ_TEST_DATABASE_URL to a throwaway database");
            return;
        };
        let Some((state, pool)) = lab_test_state(&url, true).await else {
            panic!("test Postgres unreachable at {url}");
        };
        let tenant = fresh_community(&state).await;
        let owner = Keys::generate();
        grant_role(&state, &tenant, &owner, "owner").await;
        let (board_id, _) = create_board(&state, &tenant, &owner, "Board", "body").await;
        let d = board_id.to_string();

        let cases: Vec<(&str, Vec<Vec<&str>>, &str)> = vec![
            (
                "access_scope",
                vec![
                    vec!["d", &d],
                    vec!["op", "archive"],
                    vec!["access_scope", "private"],
                ],
                "create_v2/update_v2",
            ),
            (
                "t (topic tag)",
                vec![vec!["d", &d], vec!["op", "archive"], vec!["t", "sprint"]],
                "create_v2/update_v2",
            ),
            (
                "restored_from",
                vec![
                    vec!["d", &d],
                    vec!["op", "archive"],
                    vec!["restored_from", "1"],
                ],
                "only valid on `restore`",
            ),
        ];

        for (label, tags, expected_fragment) in cases {
            let outcome = handle_lab_board_revision_event(
                &tenant,
                &state,
                signed(&owner, "", tags),
                &nip42_auth(&owner),
            )
            .await;
            let err = expect_refusal(outcome, &format!("a moderation op carrying `{label}`"));
            let message = err_message(&err);
            eprintln!("REJECTED `{label}` on a moderation op: {message}");
            assert!(
                matches!(err, IngestError::Rejected(_)),
                "`{label}` must be a client-side rejection, got {err:?}"
            );
            assert!(
                message.contains(expected_fragment),
                "`{label}` rejection should name the rule ({expected_fragment:?}), got {message:?}"
            );
        }

        // None of the refused shapes may have moved the board.
        let head = buzz_db::lab::get_board_head(&pool, tenant.community(), board_id)
            .await
            .expect("read head")
            .expect("head exists");
        assert_eq!(head.status, "active");
        assert_eq!(head.revision, 1);
    }

    /// Item 6 — **documents current relay behavior, does not endorse it.**
    ///
    /// `handle_content_mutation` gates edits on `status == "frozen"` only, so a
    /// content update to an *archived* board is accepted. The desktop blocks
    /// this client-side; the CLI and any agent speaking the wire protocol are
    /// not blocked. If that is ever changed to refuse archived boards too, this
    /// test fails — which is the point: the change should be deliberate, not a
    /// side effect.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn archived_boards_still_accept_content_edits_today() {
        let Some(url) = test_database_url() else {
            eprintln!("SKIP: set BUZZ_TEST_DATABASE_URL to a throwaway database");
            return;
        };
        let Some((state, pool)) = lab_test_state(&url, true).await else {
            panic!("test Postgres unreachable at {url}");
        };
        let tenant = fresh_community(&state).await;
        let owner = Keys::generate();
        grant_role(&state, &tenant, &owner, "owner").await;
        let (board_id, create) = create_board(&state, &tenant, &owner, "Board", "v1").await;

        handle_lab_board_revision_event(
            &tenant,
            &state,
            moderation_event(&owner, board_id, "archive"),
            &nip42_auth(&owner),
        )
        .await
        .expect("archive");

        let d = board_id.to_string();
        let prev = create.id.to_hex();
        let update = signed(
            &owner,
            "v2 written while archived",
            vec![vec!["d", &d], vec!["op", "update"], vec!["prev", &prev]],
        );
        let result =
            handle_lab_board_revision_event(&tenant, &state, update, &nip42_auth(&owner)).await;
        match &result {
            Ok(r) => eprintln!(
                "content edit on an ARCHIVED board -> ACCEPTED (message={:?})",
                r.message
            ),
            Err(e) => eprintln!(
                "content edit on an ARCHIVED board -> REFUSED ({})",
                err_message(e)
            ),
        }
        assert!(
            result.is_ok(),
            "CURRENT behavior: only `frozen` blocks content edits, `archived` does not. \
             If this now fails, the relay gained an archived-write gate — update the \
             desktop/CLI notes and this test together."
        );

        let head = buzz_db::lab::get_board_head(&pool, tenant.community(), board_id)
            .await
            .expect("read head")
            .expect("head exists");
        assert_eq!(head.revision, 2, "the edit really landed");
        assert_eq!(
            head.status, "archived",
            "and the board is still archived afterwards"
        );

        // The contrast case: `frozen` IS enforced.
        let (frozen_board, frozen_create) =
            create_board(&state, &tenant, &owner, "Frozen", "v1").await;
        handle_lab_board_revision_event(
            &tenant,
            &state,
            moderation_event(&owner, frozen_board, "freeze"),
            &nip42_auth(&owner),
        )
        .await
        .expect("freeze");
        let fd = frozen_board.to_string();
        let fprev = frozen_create.id.to_hex();
        let err = expect_refusal(
            handle_lab_board_revision_event(
                &tenant,
                &state,
                signed(
                    &owner,
                    "v2",
                    vec![vec!["d", &fd], vec!["op", "update"], vec!["prev", &fprev]],
                ),
                &nip42_auth(&owner),
            )
            .await,
            "a frozen board must refuse content edits",
        );
        eprintln!("content edit on a FROZEN board -> {}", err_message(&err));
        assert!(err_message(&err).contains("frozen"));
    }
}
