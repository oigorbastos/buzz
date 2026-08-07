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
//!    `state.relay_keypair` (content mutations only — see the module doc on
//!    moderation ops below for why status-only transitions skip this step).
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
//! ## Known gaps (foundation round — schema + kinds + CAS transaction only)
//! - **Rate limiting** (spec §8): not wired into `buzz_auth::rate_limit`/
//!   `admission::check_principal` this round. The existing `LimitType`
//!   variants (`Messages`/`ApiCalls`/`WsEvents`/`IpConnections`) don't have an
//!   obvious per-kind extension point from inside `ingest_event_inner` itself
//!   — every current call site lives in `connection.rs`/`bridge.rs`, keyed by
//!   transport, not by kind. A `LimitType::BoardWrites` (or similar) variant
//!   plus a call from this handler is the natural follow-up, not built here
//!   per the task's explicit "don't build a rate limiter from scratch this
//!   round" allowance.
//! - **No read API**: this round only builds the write-side CAS transaction
//!   and the `buzz_db::lab` read helpers (`list_board_heads`,
//!   `get_board_head`, `list_board_revisions`) — no HTTP/WS surface exposes
//!   them yet, and no client (CLI/Desktop) exists to call one. Explicitly
//!   out of scope per the task.
//! - **Moderation ops don't touch the head projection**: archive/unarchive/
//!   freeze/unfreeze update `lab_board_heads.status` (+ audit columns) but
//!   deliberately do not re-sign a new kind:30623 (content/revision are
//!   unchanged by a pure status flip). A live "is this board frozen"
//!   Nostr-visible signal — e.g. echoing `status` in kind:30623 on every
//!   transition — is a reasonable follow-up once a read API exists to make
//!   that distinction observable to a client at all.

use std::sync::Arc;

use nostr::{Event, EventBuilder, Kind, Tag};
use sha2::{Digest, Sha256};
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
    Update,
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
            "update" => Self::Update,
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
            Self::Update => "update",
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
        matches!(self, Self::Create | Self::Update | Self::Restore)
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
            Self::Create => "create",
            Self::Update => "update",
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
        if op == LabBoardOp::Create && prev.is_some() {
            return Err("lab board `create` must not carry a `prev` tag".to_string());
        }
        if op != LabBoardOp::Create && prev.is_none() {
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
    if op == LabBoardOp::Create && title.is_none() {
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

    Ok(LabBoardEnvelope {
        board_id,
        op,
        prev,
        claimed_revision,
        title,
        summary,
        restored_from,
    })
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
) -> Result<Event, IngestError> {
    let mut tags = vec![
        Tag::parse(["d", &board_id.to_string()]),
        Tag::parse(["community", &tenant.community().to_string()]),
        Tag::parse(["revision", &revision.to_string()]),
        Tag::parse(["title", title]),
        Tag::parse(["head", head_revision_event_hex]),
        Tag::parse(["status", status]),
    ]
    .into_iter()
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| IngestError::Internal(format!("error: building lab board head tags: {e}")))?;
    if let Some(summary) = summary {
        tags.push(Tag::parse(["summary", summary]).map_err(|e| {
            IngestError::Internal(format!("error: building lab board head tags: {e}"))
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
    state: &Arc<AppState>,
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
        (LabBoardOp::Create, Some(_)) => {
            return Err(board_head_mismatch(&format!(
                "board {} already exists",
                envelope.board_id
            )));
        }
        (LabBoardOp::Create, None) => {}
        (LabBoardOp::Update | LabBoardOp::Restore, None) => {
            return Err(IngestError::Rejected(format!(
                "invalid: lab board {} does not exist",
                envelope.board_id
            )));
        }
        (LabBoardOp::Update | LabBoardOp::Restore, Some(head)) => {
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
