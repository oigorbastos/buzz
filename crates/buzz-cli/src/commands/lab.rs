//! `buzz lab` — Lab Board ("Quadro"): a community-wide, multi-writer
//! Markdown document with compare-and-swap (CAS) concurrency and full
//! revision history.
//!
//! Two kinds, both **PROVISIONAL** (pending upstream RFC — see doc comments
//! on `buzz_core::kind::KIND_LAB_BOARD_REVISION` / `KIND_LAB_BOARD_HEAD`):
//! - `KIND_LAB_BOARD_REVISION` (40101) — client-submitted, ordinary
//!   (non-replaceable, never soft-deleted) event. Every accepted `create`/
//!   `update`/`restore` mutation is one of these, forever queryable by
//!   `#d=<board_id>`. The full Markdown snapshot lives in `event.content`
//!   (not a diff) — a client that wants to restore an old revision must
//!   resubmit its content verbatim, the relay does not copy it forward.
//! - `KIND_LAB_BOARD_HEAD` (30623) — relay-signed, NIP-33
//!   parameterized-replaceable projection of the current live state,
//!   addressed by `d=<board_id>`. Re-signed by the relay on every accepted
//!   content mutation; the previous projection is soft-deleted in the same
//!   transaction, so a `#d` query always returns exactly the live one. This
//!   is how the CLI discovers the current revision number / CAS token
//!   (`head` tag = hex event id of the accepted revision) without the
//!   caller having to track it across invocations.
//!
//! ## Verbs (this round: create/update/history/restore only)
//! - `lab create --title T [--summary S] --content -` — mints a fresh
//!   `board_id` (UUID v4 — matches `channels create`/`workflows create`'s
//!   convention; the workspace `uuid` crate here only has the `v4` feature
//!   enabled, so v7 was never an option), publishes op=create/revision=1.
//! - `lab update <board-id> [--base <event-id>] [--title T] [--summary S]
//!   --content -` — CAS'd against the current head unless `--base`
//!   overrides it (for deliberately testing a stale CAS). `--title`/
//!   `--summary` omitted means "the relay carries the current value
//!   forward"; there is no explicit-clear form (unlike `notes set`) because
//!   the Lab Board wire protocol has no empty-tag-means-clear convention —
//!   `title`/`summary` are only ever present-with-a-value or absent.
//! - `lab history <board-id> [--limit N]` — every accepted revision, sorted
//!   by the `revision` tag (oldest→newest); revisions from a
//!   non-compliant client that never wrote a `revision` tag sort to the end
//!   by `created_at` with a stderr warning, never a hard failure.
//! - `lab restore <board-id> --revision N [--base <event-id>]` — fetches
//!   revision N's content (scanning full history client-side — see the
//!   "community-wide scan" note below) and resubmits it as a new
//!   op=restore/restored_from=N revision.
//!
//! ## `#d` is NOT pushed into SQL for kind:40101 — community-wide client-side scan
//! `KIND_LAB_BOARD_REVISION` (40101) is an ordinary, non-replaceable kind —
//! it is *not* in the NIP-33 parameterized-replaceable range (30000–39999).
//! `filter_to_query_params` in `buzz-relay/src/handlers/req.rs` only pushes
//! a `#d` filter down into the SQL `WHERE` clause when a filter's `kinds`
//! are *exclusively* NIP-33 kinds, because the `d_tag` column is only
//! populated (`extract_d_tag`, `buzz-db/src/event.rs`) for those kinds. For
//! a `{"kinds":[40101],"#d":[board_id]}` filter the SQL layer ignores `#d`
//! entirely and runs `... WHERE community_id = $1 AND kind = 40101 ...
//! ORDER BY created_at DESC LIMIT <page_limit>` across *every* Lab Board in
//! the community; `#d` is then applied only as an in-memory post-filter
//! (`buzz_core::filter::filters_match`, `buzz-relay/src/api/bridge.rs`)
//! *after* that SQL `LIMIT` has already truncated the candidate window.
//!
//! That ordering matters because `BuzzClient::query_pages` (`client.rs`)
//! decides whether it has reached the end of a paginated query by checking
//! whether the page it got back is shorter than the page size it asked for.
//! If `#d` were included in the wire filter, that check would be comparing
//! the *post-filtered* (board-specific) count against a page size that
//! bounds the *pre-filtered* (community-wide) SQL scan — a page with zero
//! or few matches for this board looks exactly like "no more history" even
//! when older matching revisions exist further back, so the loop would stop
//! early and `history`/`restore` could silently return incomplete results
//! or a false "not found" in any community with more than one active Lab
//! Board. (fetch_head's kind:30623 query below does not have this problem —
//! 30623 *is* a NIP-33 kind, so `#d` pushdown genuinely narrows the SQL.)
//!
//! So `fetch_revision_content` and `cmd_history` deliberately omit `#d` from
//! the wire filter and match it client-side instead: the relay never
//! post-filters a `#d`-less query, so the page size the server returns is
//! the *real* SQL page size, and `query_pages`'s exhaustion check is
//! trustworthy again. The cost is that both commands read every kind:40101
//! event ever accepted in the community (via `query_all`, unbounded) rather
//! than only this board's — there is no dedicated per-board read endpoint
//! yet (`buzz_db::lab::list_board_revisions` is not wired up over HTTP/WS).
//! `history`'s `--limit` therefore no longer bounds the wire query; it only
//! caps how many of the (already fully-fetched, already board-matched) most
//! recent revisions are printed — see that command's doc below.
//!
//! ## Explicitly out of scope this round
//! `archive`/`unarchive`/`freeze`/`unfreeze` (moderation ops — no `--tag`/
//! topic-tag support either: `parse_lab_board_envelope` in
//! `buzz-relay/src/handlers/lab.rs` does not recognize a `t` tag at all, so
//! the CLI does not offer one — a flag that silently no-ops on the wire
//! would be worse than no flag), `list` (enumerate boards in a community),
//! `get`/`show` (current content without touching history), `diff`, `ref`
//! (a `buzz://lab?...` URI formatter, following `crate::links`' pattern).
//!
//! ## Open design decisions (not dictated by the relay's wire contract)
//! - `restore` always carries the *current head's* title/summary forward
//!   (by omitting both tags, same as a title/summary-less `update`) rather
//!   than the restored revision's title/summary at the time it was
//!   current. There is no flag to override this yet — add one
//!   (`--restore-title-too`?) if a caller needs it.
//! - `history`'s `--limit` caps the *displayed result*, not the wire query
//!   (see the "`#d` is NOT pushed into SQL for kind:40101" section above —
//!   the query itself is always a full, unbounded, community-wide scan so
//!   that pagination termination stays correct). The fetched rows are
//!   matched to this board, sorted oldest→newest, and then only the last
//!   `--limit` of them are printed. So `--limit 10` means "the 10 most
//!   recent revisions, shown chronologically" — not "the first 10 ever
//!   made".
//! - An empty history (`0` events for a `#d` query) is reported as
//!   `CliError::NotFound`, matching `notes get`'s convention for "nothing
//!   at this address" rather than printing `[]` the way `notes ls` does
//!   for an empty *filter* — a Lab Board's `d` tag is a single specific
//!   address, not a scan.

use nostr::{Event, EventBuilder, EventId, Kind, Tag};
use uuid::Uuid;

use buzz_core::kind::{KIND_LAB_BOARD_HEAD, KIND_LAB_BOARD_REVISION};

use crate::client::BuzzClient;
use crate::error::CliError;
use crate::validate::{parse_event_id, parse_uuid, read_or_stdin};

/// Title cap (spec §8 / `buzz-relay/src/handlers/lab.rs::MAX_TITLE_CHARS`):
/// 160 characters, `.chars().count()` not bytes. Duplicated here (rather
/// than shared) so this file stays readable against the relay source it
/// mirrors — see the module doc's "matches the relay" framing throughout.
const MAX_TITLE_CHARS: usize = 160;
/// Summary cap, same convention — mirrors `MAX_SUMMARY_CHARS` in the relay.
const MAX_SUMMARY_CHARS: usize = 500;
/// Markdown content cap in **bytes** (not chars) — mirrors
/// `MAX_MARKDOWN_BYTES` in the relay: 64 KiB.
const MAX_MARKDOWN_BYTES: usize = 64 * 1024;

/// Default / hard-cap page size for `lab history`. A Lab Board's revision
/// history has no natural bound the way a note or a channel roster does, so
/// this is deliberately larger than `notes ls`'s 50/200.
const HISTORY_DEFAULT_LIMIT: u32 = 100;
const HISTORY_MAX_LIMIT: u32 = 1000;

fn tag_err(e: impl std::fmt::Display) -> CliError {
    CliError::Other(format!("failed to build tag: {e}"))
}

fn validate_title_len(title: &str) -> Result<(), CliError> {
    let n = title.chars().count();
    if n > MAX_TITLE_CHARS {
        return Err(CliError::Usage(format!(
            "--title exceeds {MAX_TITLE_CHARS} characters (got {n})"
        )));
    }
    Ok(())
}

fn validate_summary_len(summary: &str) -> Result<(), CliError> {
    let n = summary.chars().count();
    if n > MAX_SUMMARY_CHARS {
        return Err(CliError::Usage(format!(
            "--summary exceeds {MAX_SUMMARY_CHARS} characters (got {n})"
        )));
    }
    Ok(())
}

fn validate_markdown_size(content: &str) -> Result<(), CliError> {
    if content.len() > MAX_MARKDOWN_BYTES {
        return Err(CliError::Usage(format!(
            "lab board markdown exceeds the relay's {MAX_MARKDOWN_BYTES}-byte limit (got {} bytes)",
            content.len()
        )));
    }
    Ok(())
}

fn tag_value<'a>(event: &'a Event, name: &str) -> Option<&'a str> {
    event
        .tags
        .iter()
        .find(|t| t.as_slice().first().map(String::as_str) == Some(name))
        .and_then(|t| t.as_slice().get(1).map(String::as_str))
}

/// Client-side `#d` match for kind:40101 queries. The wire filter
/// deliberately never carries `#d` for this kind — see the module doc's
/// "`#d` is NOT pushed into SQL for kind:40101" section — so every reader
/// of the community-wide kind:40101 stream must re-check board membership
/// itself before trusting an event belongs to `board_id`.
fn event_matches_board(event: &Event, board_id: &str) -> bool {
    tag_value(event, "d") == Some(board_id)
}

fn parse_events(json: &str) -> Result<Vec<Event>, CliError> {
    serde_json::from_str::<Vec<Event>>(json)
        .map_err(|e| CliError::Other(format!("failed to parse relay response: {e}")))
}

/// Parse the relay's `{event_id, accepted, message}` write response.
fn parse_accept(raw: &str) -> Result<(bool, String), CliError> {
    let parsed: serde_json::Value = serde_json::from_str(raw)
        .map_err(|e| CliError::Other(format!("relay response is not JSON: {e} ({raw})")))?;
    let accepted = parsed
        .get("accepted")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let message = parsed
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok((accepted, message))
}

// ---------------------------------------------------------------------
// kind:30623 head projection — read-before-write for update/restore
// ---------------------------------------------------------------------

/// Parsed view of the current live kind:30623 head projection for a board.
#[derive(Debug)]
struct BoardHead {
    revision: i32,
    title: String,
    /// The `head` tag: hex event id of the kind:40101 revision this
    /// projection reflects — the CAS token for the next `prev` tag.
    head_event_id: EventId,
    #[allow(dead_code)] // not surfaced yet — no `lab get`/`show` this round.
    status: String,
}

impl BoardHead {
    fn from_event(event: &Event) -> Result<Self, CliError> {
        if event.kind != Kind::Custom(KIND_LAB_BOARD_HEAD as u16) {
            return Err(CliError::Other(format!(
                "expected kind:{KIND_LAB_BOARD_HEAD}, got {}",
                event.kind.as_u16()
            )));
        }
        let revision = tag_value(event, "revision")
            .and_then(|s| s.parse::<i32>().ok())
            .ok_or_else(|| {
                CliError::Other("lab board head event is missing a valid `revision` tag".into())
            })?;
        let title = tag_value(event, "title").unwrap_or("").to_string();
        let head_hex = tag_value(event, "head").ok_or_else(|| {
            CliError::Other("lab board head event is missing the `head` tag".into())
        })?;
        let head_event_id = EventId::parse(head_hex).map_err(|e| {
            CliError::Other(format!(
                "lab board head `head` tag is not a valid event id: {e}"
            ))
        })?;
        let status = tag_value(event, "status").unwrap_or("active").to_string();
        Ok(Self {
            revision,
            title,
            head_event_id,
            status,
        })
    }
}

/// Read-before-write: fetch the current live head projection for a board.
/// `Ok(None)` means the board id has no accepted revisions (never created,
/// or the id was mistyped).
async fn fetch_head(client: &BuzzClient, board_id: Uuid) -> Result<Option<BoardHead>, CliError> {
    let filter = serde_json::json!({
        "kinds": [KIND_LAB_BOARD_HEAD],
        "#d": [board_id.to_string()],
        "limit": 1,
    });
    let raw = client.query(&filter).await?;
    let mut events = parse_events(&raw)?;
    // Defensive: the relay soft-deletes the previous projection in the same
    // transaction that publishes a new one, so at most one should be live —
    // but if more come back, take the newest.
    events.sort_by_key(|e| std::cmp::Reverse(e.created_at));
    events
        .into_iter()
        .next()
        .map(|e| BoardHead::from_event(&e))
        .transpose()
}

/// Scan every accepted revision of a board for the one whose `revision` tag
/// equals `target`. Full-history scan is unavoidable: there is no
/// `revision`-tag pushdown (`revision` isn't a single-letter NIP-01 tag, so
/// it can never be expressed as a filter constraint at all), and — per the
/// module doc's "`#d` is NOT pushed into SQL for kind:40101" section — `#d`
/// itself isn't pushed for this kind either, so the query is intentionally
/// community-wide (not board-scoped) with the board match done client-side,
/// to keep `BuzzClient::query_pages`'s pagination-exhaustion check honest.
async fn fetch_revision_content(
    client: &BuzzClient,
    board_id: Uuid,
    target: i32,
) -> Result<Option<String>, CliError> {
    let board_id = board_id.to_string();
    let filter = serde_json::json!({
        "kinds": [KIND_LAB_BOARD_REVISION],
    });
    let raw_events = client.query_all(filter).await?;
    for v in raw_events {
        let event: Event = serde_json::from_value(v)
            .map_err(|e| CliError::Other(format!("failed to parse relay response: {e}")))?;
        if !event_matches_board(&event, &board_id) {
            continue;
        }
        if tag_value(&event, "revision").and_then(|s| s.parse::<i32>().ok()) == Some(target) {
            return Ok(Some(event.content));
        }
    }
    Ok(None)
}

// ---------------------------------------------------------------------
// kind:40101 event builders — pure, unit-testable (mirrors
// `notes::build_set_event` / `notes::build_rm_event`)
// ---------------------------------------------------------------------

fn build_create_event(
    board_id: Uuid,
    title: &str,
    summary: Option<&str>,
    content: &str,
) -> Result<EventBuilder, CliError> {
    let title = title.trim();
    if title.is_empty() {
        return Err(CliError::Usage("--title cannot be empty".into()));
    }
    validate_title_len(title)?;
    if let Some(s) = summary {
        validate_summary_len(s)?;
    }
    validate_markdown_size(content)?;

    let mut tags: Vec<Tag> = vec![
        Tag::parse(["d", &board_id.to_string()]).map_err(tag_err)?,
        Tag::parse(["op", "create"]).map_err(tag_err)?,
        Tag::parse(["revision", "1"]).map_err(tag_err)?,
        Tag::parse(["title", title]).map_err(tag_err)?,
    ];
    if let Some(s) = summary {
        tags.push(Tag::parse(["summary", s]).map_err(tag_err)?);
    }
    Ok(EventBuilder::new(Kind::Custom(KIND_LAB_BOARD_REVISION as u16), content).tags(tags))
}

#[allow(clippy::too_many_arguments)]
fn build_update_event(
    board_id: Uuid,
    prev: EventId,
    revision: i32,
    title: Option<&str>,
    summary: Option<&str>,
    content: &str,
) -> Result<EventBuilder, CliError> {
    if let Some(t) = title {
        validate_title_len(t)?;
    }
    if let Some(s) = summary {
        validate_summary_len(s)?;
    }
    validate_markdown_size(content)?;

    let mut tags: Vec<Tag> = vec![
        Tag::parse(["d", &board_id.to_string()]).map_err(tag_err)?,
        Tag::parse(["op", "update"]).map_err(tag_err)?,
        Tag::parse(["prev", &prev.to_hex()]).map_err(tag_err)?,
        Tag::parse(["revision", &revision.to_string()]).map_err(tag_err)?,
    ];
    if let Some(t) = title {
        tags.push(Tag::parse(["title", t]).map_err(tag_err)?);
    }
    if let Some(s) = summary {
        tags.push(Tag::parse(["summary", s]).map_err(tag_err)?);
    }
    Ok(EventBuilder::new(Kind::Custom(KIND_LAB_BOARD_REVISION as u16), content).tags(tags))
}

fn build_restore_event(
    board_id: Uuid,
    prev: EventId,
    revision: i32,
    restored_from: i32,
    content: &str,
) -> Result<EventBuilder, CliError> {
    validate_markdown_size(content)?;

    // Deliberately no `title`/`summary` tags — the relay carries the
    // current head's forward (see module doc's "Open design decisions").
    let tags: Vec<Tag> = vec![
        Tag::parse(["d", &board_id.to_string()]).map_err(tag_err)?,
        Tag::parse(["op", "restore"]).map_err(tag_err)?,
        Tag::parse(["prev", &prev.to_hex()]).map_err(tag_err)?,
        Tag::parse(["revision", &revision.to_string()]).map_err(tag_err)?,
        Tag::parse(["restored_from", &restored_from.to_string()]).map_err(tag_err)?,
    ];
    Ok(EventBuilder::new(Kind::Custom(KIND_LAB_BOARD_REVISION as u16), content).tags(tags))
}

// ---------------------------------------------------------------------
// Friendly error mapping
// ---------------------------------------------------------------------

/// Which write command hit a relay rejection — only used to tailor the
/// `BOARD_HEAD_MISMATCH` hint text in [`friendly_lab_error`].
enum LabWriteOp {
    Create,
    Update { explicit_base: bool },
    Restore { explicit_base: bool },
}

/// Rewrite a relay rejection into the CLI's own vocabulary, without losing
/// the underlying HTTP status where that still matters for exit codes.
///
/// Every content-mutation rejection from `buzz-relay/src/handlers/lab.rs`
/// arrives here as `CliError::Relay { status, body }` — a non-2xx HTTP
/// response, not a `200 {"accepted": false}` body (see `client.rs`'s
/// `handle_response`: `IngestError::Rejected` → HTTP 400, `AuthFailed` →
/// 401/403, `Internal` → 500). Two cases:
///
/// - `body` contains the `BOARD_HEAD_MISMATCH` marker (the relay's CAS
///   conflict signal, per `board_head_mismatch()` in the relay handler):
///   remapped to `CliError::Conflict` (exit 5, matching every other
///   NIP-33/CAS conflict this CLI surfaces) with an actionable hint instead
///   of the raw protocol string.
/// - Anything else: the `invalid: `/`restricted: `/`error: ` wire prefix is
///   stripped. The relay's message after that prefix is already a complete
///   English sentence (see `parse_lab_board_envelope`'s error strings), so
///   showing it verbatim beats re-explaining it — the task's "don't hide
///   actionable information" bar is met by *not* re-wording it, just
///   trimming the protocol jargon in front of it. The HTTP status (and
///   therefore exit code) is preserved either way.
fn friendly_lab_error(e: CliError, op: LabWriteOp) -> CliError {
    match e {
        CliError::Relay { body, .. } if body.contains("BOARD_HEAD_MISMATCH") => {
            let hint = match op {
                LabWriteOp::Create => {
                    "the generated board id collided with an existing board — vanishingly \
                     unlikely with a fresh UUID; just re-run the command to mint a new one"
                }
                LabWriteOp::Update {
                    explicit_base: true,
                }
                | LabWriteOp::Restore {
                    explicit_base: true,
                } => {
                    "the --base event id you passed is not this board's current head (or never \
                     was) — drop --base to let the CLI resolve the latest head automatically, \
                     or check `buzz lab history` for the right one"
                }
                LabWriteOp::Update {
                    explicit_base: false,
                }
                | LabWriteOp::Restore {
                    explicit_base: false,
                } => {
                    "someone else wrote to this board between your read and this write — \
                     re-run the command to resolve against the latest head"
                }
            };
            CliError::Conflict(format!("lab board write conflict: {hint}"))
        }
        CliError::Relay { status, body } => {
            let cleaned = body
                .strip_prefix("invalid: ")
                .or_else(|| body.strip_prefix("restricted: "))
                .or_else(|| body.strip_prefix("error: "))
                .unwrap_or(body.as_str())
                .to_string();
            CliError::Relay {
                status,
                body: cleaned,
            }
        }
        other => other,
    }
}

// ---------------------------------------------------------------------
// lab history — output shaping
// ---------------------------------------------------------------------

/// One row of `lab history` output. Built entirely from a single
/// kind:40101 event's own tags — no cross-referencing `lab_board_revisions`
/// or the head projection needed (per the task: "o evento cru já carrega
/// isso").
#[derive(Debug, Clone, serde::Serialize)]
struct RevisionOutput {
    revision: Option<i32>,
    op: String,
    event_id: String,
    author: String,
    created_at: u64,
    restored_from: Option<i32>,
    title: Option<String>,
    summary: Option<String>,
}

impl RevisionOutput {
    fn from_event(event: &Event) -> Result<Self, CliError> {
        if event.kind != Kind::Custom(KIND_LAB_BOARD_REVISION as u16) {
            return Err(CliError::Other(format!(
                "expected kind:{KIND_LAB_BOARD_REVISION}, got {}",
                event.kind.as_u16()
            )));
        }
        Ok(Self {
            revision: tag_value(event, "revision").and_then(|s| s.parse::<i32>().ok()),
            op: tag_value(event, "op").unwrap_or("unknown").to_string(),
            event_id: event.id.to_hex(),
            author: event.pubkey.to_hex(),
            created_at: event.created_at.as_secs(),
            restored_from: tag_value(event, "restored_from").and_then(|s| s.parse::<i32>().ok()),
            title: tag_value(event, "title").map(str::to_string),
            summary: tag_value(event, "summary").map(str::to_string),
        })
    }
}

/// Sort ascending by `revision` tag (oldest→newest); rows with no
/// `revision` tag (only possible from a non-compliant client) sort to the
/// end by `created_at`. Returns the count of such rows so the caller can
/// warn without failing the command.
fn sort_revisions(rows: &mut [RevisionOutput]) -> usize {
    rows.sort_by(|a, b| match (a.revision, b.revision) {
        (Some(x), Some(y)) => x.cmp(&y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.created_at.cmp(&b.created_at),
    });
    rows.iter().filter(|r| r.revision.is_none()).count()
}

// ---------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------

pub async fn cmd_create(
    client: &BuzzClient,
    title: &str,
    summary: Option<&str>,
    content: &str,
) -> Result<(), CliError> {
    let body = read_or_stdin(content)?;
    let board_id = Uuid::new_v4();

    let builder = build_create_event(board_id, title, summary, &body)?;
    let event = client.sign_event(builder)?;
    let event_id = event.id;

    let raw = client
        .submit_event(event)
        .await
        .map_err(|e| friendly_lab_error(e, LabWriteOp::Create))?;
    let (accepted, message) = parse_accept(&raw)?;
    if !accepted {
        return Err(CliError::Other(format!("relay rejected event: {message}")));
    }

    println!("board_id   {board_id}");
    println!("event_id   {}", event_id.to_hex());
    println!("revision   1");
    println!("title      {}", title.trim());
    Ok(())
}

pub async fn cmd_update(
    client: &BuzzClient,
    board_id_raw: &str,
    base: Option<&str>,
    title: Option<&str>,
    summary: Option<&str>,
    content: &str,
) -> Result<(), CliError> {
    let board_id = parse_uuid(board_id_raw)?;
    let body = read_or_stdin(content)?;

    let head = fetch_head(client, board_id).await?.ok_or_else(|| {
        CliError::NotFound(format!(
            "lab board {board_id} not found (no accepted revisions yet) — use `buzz lab create` first"
        ))
    })?;

    let prev = match base {
        Some(raw) => parse_event_id(raw)?,
        None => head.head_event_id,
    };
    let next_revision = head.revision + 1;

    let builder = build_update_event(board_id, prev, next_revision, title, summary, &body)?;
    let event = client.sign_event(builder)?;
    let event_id = event.id;

    let raw = client.submit_event(event).await.map_err(|e| {
        friendly_lab_error(
            e,
            LabWriteOp::Update {
                explicit_base: base.is_some(),
            },
        )
    })?;
    let (accepted, message) = parse_accept(&raw)?;
    if !accepted {
        return Err(CliError::Other(format!("relay rejected event: {message}")));
    }

    let resolved_title = title.unwrap_or(head.title.as_str());
    println!("board_id   {board_id}");
    println!("event_id   {}", event_id.to_hex());
    println!("revision   {next_revision}");
    println!("title      {resolved_title}");
    if message.starts_with("duplicate:") {
        println!("note       relay recognized this as a retry of an already-accepted revision");
    }
    Ok(())
}

pub async fn cmd_history(
    client: &BuzzClient,
    board_id_raw: &str,
    limit: Option<u32>,
) -> Result<(), CliError> {
    let board_id = parse_uuid(board_id_raw)?;
    let board_id_str = board_id.to_string();
    let limit = limit
        .unwrap_or(HISTORY_DEFAULT_LIMIT)
        .min(HISTORY_MAX_LIMIT) as usize;

    // Deliberately no `#d` on the wire filter and no wire-level `limit` tied
    // to `--limit` — see the module doc's "`#d` is NOT pushed into SQL for
    // kind:40101" section. `query_all` scans the full community kind:40101
    // stream (server never post-filters it, so pagination termination is
    // honest); the board match and the `--limit` cap are both applied here,
    // client-side, after the fetch.
    let filter = serde_json::json!({
        "kinds": [KIND_LAB_BOARD_REVISION],
    });
    let raw_events = client.query_all(filter).await?;
    let mut rows: Vec<RevisionOutput> = raw_events
        .into_iter()
        .map(|v| {
            let event: Event = serde_json::from_value(v)
                .map_err(|e| CliError::Other(format!("failed to parse relay response: {e}")))?;
            Ok(event)
        })
        .collect::<Result<Vec<Event>, CliError>>()?
        .into_iter()
        .filter(|event| event_matches_board(event, &board_id_str))
        .map(|event| RevisionOutput::from_event(&event))
        .collect::<Result<Vec<_>, _>>()?;

    if rows.is_empty() {
        return Err(CliError::NotFound(format!(
            "no revisions found for lab board {board_id}"
        )));
    }

    let missing = sort_revisions(&mut rows);
    if missing > 0 {
        eprintln!(
            "warning: {missing} revision event(s) for lab board {board_id} have no `revision` \
             tag (from a non-compliant client); sorted to the end by timestamp"
        );
    }

    // `rows` is sorted oldest→newest; keep only the `limit` most recent.
    if rows.len() > limit {
        rows.drain(0..rows.len() - limit);
    }

    println!(
        "{}",
        serde_json::to_string_pretty(&rows)
            .map_err(|e| CliError::Other(format!("failed to serialize history: {e}")))?
    );
    Ok(())
}

pub async fn cmd_restore(
    client: &BuzzClient,
    board_id_raw: &str,
    revision: i32,
    base: Option<&str>,
) -> Result<(), CliError> {
    let board_id = parse_uuid(board_id_raw)?;
    if revision < 1 {
        return Err(CliError::Usage("--revision must be >= 1".into()));
    }

    let head = fetch_head(client, board_id).await?.ok_or_else(|| {
        CliError::NotFound(format!(
            "lab board {board_id} not found (no accepted revisions yet)"
        ))
    })?;

    // The relay does not copy content on restore — the client resubmits the
    // target revision's full Markdown snapshot as a new revision.
    let target_content = fetch_revision_content(client, board_id, revision)
        .await?
        .ok_or_else(|| {
            CliError::NotFound(format!("lab board {board_id} has no revision {revision}"))
        })?;

    let prev = match base {
        Some(raw) => parse_event_id(raw)?,
        None => head.head_event_id,
    };
    let next_revision = head.revision + 1;

    let builder = build_restore_event(board_id, prev, next_revision, revision, &target_content)?;
    let event = client.sign_event(builder)?;
    let event_id = event.id;

    let raw = client.submit_event(event).await.map_err(|e| {
        friendly_lab_error(
            e,
            LabWriteOp::Restore {
                explicit_base: base.is_some(),
            },
        )
    })?;
    let (accepted, message) = parse_accept(&raw)?;
    if !accepted {
        return Err(CliError::Other(format!("relay rejected event: {message}")));
    }

    println!("board_id      {board_id}");
    println!("event_id      {}", event_id.to_hex());
    println!("revision      {next_revision}");
    println!("restored_from {revision}");
    println!("title         {}", head.title);
    if message.starts_with("duplicate:") {
        println!("note          relay recognized this as a retry of an already-accepted revision");
    }
    Ok(())
}

pub async fn dispatch(cmd: crate::LabCmd, client: &BuzzClient) -> Result<(), CliError> {
    use crate::LabCmd;
    match cmd {
        LabCmd::Create {
            title,
            summary,
            content,
        } => cmd_create(client, &title, summary.as_deref(), &content).await,
        LabCmd::Update {
            board_id,
            base,
            title,
            summary,
            content,
        } => {
            cmd_update(
                client,
                &board_id,
                base.as_deref(),
                title.as_deref(),
                summary.as_deref(),
                &content,
            )
            .await
        }
        LabCmd::History { board_id, limit } => cmd_history(client, &board_id, limit).await,
        LabCmd::Restore {
            board_id,
            revision,
            base,
        } => cmd_restore(client, &board_id, revision, base.as_deref()).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{Keys, Timestamp};

    fn sign(builder: EventBuilder) -> Event {
        builder.sign_with_keys(&Keys::generate()).unwrap()
    }

    // -- build_create_event --

    #[test]
    fn create_event_has_expected_tags_and_no_prev() {
        let board_id = Uuid::new_v4();
        let event =
            sign(build_create_event(board_id, "My Board", Some("a summary"), "# hello").unwrap());
        assert_eq!(event.kind, Kind::Custom(KIND_LAB_BOARD_REVISION as u16));
        assert_eq!(tag_value(&event, "d"), Some(board_id.to_string().as_str()));
        assert_eq!(tag_value(&event, "op"), Some("create"));
        assert_eq!(tag_value(&event, "revision"), Some("1"));
        assert_eq!(tag_value(&event, "title"), Some("My Board"));
        assert_eq!(tag_value(&event, "summary"), Some("a summary"));
        assert!(tag_value(&event, "prev").is_none());
        assert_eq!(event.content, "# hello");
    }

    #[test]
    fn create_event_omits_summary_tag_when_none() {
        let event = sign(build_create_event(Uuid::new_v4(), "T", None, "").unwrap());
        assert!(tag_value(&event, "summary").is_none());
    }

    #[test]
    fn create_event_rejects_empty_title() {
        let err = build_create_event(Uuid::new_v4(), "  ", None, "x").unwrap_err();
        assert!(matches!(err, CliError::Usage(m) if m.contains("--title cannot be empty")));
    }

    #[test]
    fn create_event_rejects_overlong_title() {
        let title = "a".repeat(MAX_TITLE_CHARS + 1);
        let err = build_create_event(Uuid::new_v4(), &title, None, "x").unwrap_err();
        assert!(matches!(err, CliError::Usage(m) if m.contains("--title exceeds")));
    }

    #[test]
    fn create_event_rejects_overlong_summary() {
        let summary = "a".repeat(MAX_SUMMARY_CHARS + 1);
        let err = build_create_event(Uuid::new_v4(), "T", Some(&summary), "x").unwrap_err();
        assert!(matches!(err, CliError::Usage(m) if m.contains("--summary exceeds")));
    }

    #[test]
    fn create_event_rejects_oversized_markdown() {
        let content = "x".repeat(MAX_MARKDOWN_BYTES + 1);
        let err = build_create_event(Uuid::new_v4(), "T", None, &content).unwrap_err();
        assert!(matches!(err, CliError::Usage(m) if m.contains("exceeds the relay's")));
    }

    #[test]
    fn create_event_accepts_markdown_at_exact_limit() {
        let content = "x".repeat(MAX_MARKDOWN_BYTES);
        assert!(build_create_event(Uuid::new_v4(), "T", None, &content).is_ok());
    }

    // -- build_update_event --

    #[test]
    fn update_event_has_expected_tags() {
        let board_id = Uuid::new_v4();
        let prev = sign(EventBuilder::new(Kind::TextNote, "")).id;
        let event =
            sign(build_update_event(board_id, prev, 4, Some("New Title"), None, "body").unwrap());
        assert_eq!(tag_value(&event, "d"), Some(board_id.to_string().as_str()));
        assert_eq!(tag_value(&event, "op"), Some("update"));
        assert_eq!(tag_value(&event, "prev"), Some(prev.to_hex().as_str()));
        assert_eq!(tag_value(&event, "revision"), Some("4"));
        assert_eq!(tag_value(&event, "title"), Some("New Title"));
        assert!(tag_value(&event, "summary").is_none());
    }

    #[test]
    fn update_event_omits_title_and_summary_when_both_none() {
        let prev = sign(EventBuilder::new(Kind::TextNote, "")).id;
        let event = sign(build_update_event(Uuid::new_v4(), prev, 2, None, None, "").unwrap());
        assert!(tag_value(&event, "title").is_none());
        assert!(tag_value(&event, "summary").is_none());
    }

    #[test]
    fn update_event_rejects_overlong_title() {
        let prev = sign(EventBuilder::new(Kind::TextNote, "")).id;
        let title = "a".repeat(MAX_TITLE_CHARS + 1);
        let err = build_update_event(Uuid::new_v4(), prev, 2, Some(&title), None, "").unwrap_err();
        assert!(matches!(err, CliError::Usage(m) if m.contains("--title exceeds")));
    }

    // -- build_restore_event --

    #[test]
    fn restore_event_has_expected_tags_and_no_title_or_summary() {
        let board_id = Uuid::new_v4();
        let prev = sign(EventBuilder::new(Kind::TextNote, "")).id;
        let event = sign(build_restore_event(board_id, prev, 6, 3, "old body").unwrap());
        assert_eq!(tag_value(&event, "op"), Some("restore"));
        assert_eq!(tag_value(&event, "prev"), Some(prev.to_hex().as_str()));
        assert_eq!(tag_value(&event, "revision"), Some("6"));
        assert_eq!(tag_value(&event, "restored_from"), Some("3"));
        assert!(tag_value(&event, "title").is_none());
        assert!(tag_value(&event, "summary").is_none());
        assert_eq!(event.content, "old body");
    }

    #[test]
    fn restore_event_rejects_oversized_markdown() {
        let prev = sign(EventBuilder::new(Kind::TextNote, "")).id;
        let content = "x".repeat(MAX_MARKDOWN_BYTES + 1);
        let err = build_restore_event(Uuid::new_v4(), prev, 2, 1, &content).unwrap_err();
        assert!(matches!(err, CliError::Usage(_)));
    }

    // -- BoardHead::from_event --

    fn build_head_event(
        board_id: Uuid,
        revision: i32,
        title: &str,
        head_hex: &str,
        status: &str,
        summary: Option<&str>,
    ) -> Event {
        let mut tags = vec![
            Tag::parse(["d", &board_id.to_string()]).unwrap(),
            Tag::parse(["community", &Uuid::new_v4().to_string()]).unwrap(),
            Tag::parse(["revision", &revision.to_string()]).unwrap(),
            Tag::parse(["title", title]).unwrap(),
            Tag::parse(["head", head_hex]).unwrap(),
            Tag::parse(["status", status]).unwrap(),
        ];
        if let Some(s) = summary {
            tags.push(Tag::parse(["summary", s]).unwrap());
        }
        EventBuilder::new(Kind::Custom(KIND_LAB_BOARD_HEAD as u16), "markdown")
            .tags(tags)
            .custom_created_at(Timestamp::from(1_000_u64))
            .sign_with_keys(&Keys::generate())
            .unwrap()
    }

    #[test]
    fn board_head_parses_all_fields() {
        let board_id = Uuid::new_v4();
        let head_hex = sign(EventBuilder::new(Kind::TextNote, "")).id.to_hex();
        let event = build_head_event(board_id, 3, "Title", &head_hex, "active", Some("sum"));
        let head = BoardHead::from_event(&event).expect("parse");
        assert_eq!(head.revision, 3);
        assert_eq!(head.title, "Title");
        assert_eq!(head.head_event_id.to_hex(), head_hex);
        assert_eq!(head.status, "active");
    }

    #[test]
    fn board_head_rejects_wrong_kind() {
        let event = sign(EventBuilder::new(Kind::TextNote, "hi"));
        let err = BoardHead::from_event(&event).unwrap_err();
        assert!(matches!(err, CliError::Other(m) if m.contains("expected kind:30623")));
    }

    #[test]
    fn board_head_missing_revision_is_err() {
        let board_id = Uuid::new_v4();
        let event = EventBuilder::new(Kind::Custom(KIND_LAB_BOARD_HEAD as u16), "md")
            .tags(vec![
                Tag::parse(["d", &board_id.to_string()]).unwrap(),
                Tag::parse(["title", "T"]).unwrap(),
                Tag::parse(["head", &"a".repeat(64)]).unwrap(),
            ])
            .sign_with_keys(&Keys::generate())
            .unwrap();
        let err = BoardHead::from_event(&event).unwrap_err();
        assert!(matches!(err, CliError::Other(m) if m.contains("`revision` tag")));
    }

    // -- RevisionOutput::from_event --

    fn build_revision_event(
        board_id: Uuid,
        op: &str,
        revision: Option<i32>,
        restored_from: Option<i32>,
        ts: u64,
    ) -> Event {
        let mut tags = vec![
            Tag::parse(["d", &board_id.to_string()]).unwrap(),
            Tag::parse(["op", op]).unwrap(),
        ];
        if op != "create" {
            tags.push(Tag::parse(["prev", &"a".repeat(64)]).unwrap());
        }
        if let Some(r) = revision {
            tags.push(Tag::parse(["revision", &r.to_string()]).unwrap());
        }
        if let Some(rf) = restored_from {
            tags.push(Tag::parse(["restored_from", &rf.to_string()]).unwrap());
        }
        EventBuilder::new(Kind::Custom(KIND_LAB_BOARD_REVISION as u16), "md")
            .tags(tags)
            .custom_created_at(Timestamp::from(ts))
            .sign_with_keys(&Keys::generate())
            .unwrap()
    }

    #[test]
    fn revision_output_parses_op_and_revision() {
        let event = build_revision_event(Uuid::new_v4(), "update", Some(5), None, 1_000);
        let row = RevisionOutput::from_event(&event).expect("parse");
        assert_eq!(row.op, "update");
        assert_eq!(row.revision, Some(5));
        assert_eq!(row.restored_from, None);
        assert_eq!(row.created_at, 1_000);
    }

    #[test]
    fn revision_output_restore_carries_restored_from() {
        let event = build_revision_event(Uuid::new_v4(), "restore", Some(7), Some(3), 2_000);
        let row = RevisionOutput::from_event(&event).expect("parse");
        assert_eq!(row.op, "restore");
        assert_eq!(row.restored_from, Some(3));
    }

    #[test]
    fn revision_output_missing_revision_tag_is_none_not_err() {
        let event = build_revision_event(Uuid::new_v4(), "update", None, None, 3_000);
        let row = RevisionOutput::from_event(&event).expect("parse");
        assert_eq!(row.revision, None);
    }

    #[test]
    fn revision_output_rejects_wrong_kind() {
        let event = sign(EventBuilder::new(Kind::TextNote, "hi"));
        let err = RevisionOutput::from_event(&event).unwrap_err();
        assert!(matches!(err, CliError::Other(m) if m.contains("expected kind:40101")));
    }

    // -- sort_revisions --

    fn row(revision: Option<i32>, created_at: u64) -> RevisionOutput {
        RevisionOutput {
            revision,
            op: "update".into(),
            event_id: "e".into(),
            author: "a".into(),
            created_at,
            restored_from: None,
            title: None,
            summary: None,
        }
    }

    #[test]
    fn sort_revisions_orders_ascending_by_revision() {
        let mut rows = vec![row(Some(3), 300), row(Some(1), 100), row(Some(2), 200)];
        let missing = sort_revisions(&mut rows);
        assert_eq!(missing, 0);
        let revisions: Vec<_> = rows.iter().map(|r| r.revision).collect();
        assert_eq!(revisions, vec![Some(1), Some(2), Some(3)]);
    }

    #[test]
    fn sort_revisions_pushes_missing_revision_to_end() {
        let mut rows = vec![row(None, 50), row(Some(2), 200), row(Some(1), 100)];
        let missing = sort_revisions(&mut rows);
        assert_eq!(missing, 1);
        let revisions: Vec<_> = rows.iter().map(|r| r.revision).collect();
        assert_eq!(revisions, vec![Some(1), Some(2), None]);
    }

    #[test]
    fn sort_revisions_orders_missing_entries_by_created_at() {
        let mut rows = vec![row(None, 200), row(None, 100)];
        let missing = sort_revisions(&mut rows);
        assert_eq!(missing, 2);
        let timestamps: Vec<_> = rows.iter().map(|r| r.created_at).collect();
        assert_eq!(timestamps, vec![100, 200]);
    }

    // -- friendly_lab_error --

    #[test]
    fn friendly_error_maps_board_head_mismatch_to_conflict() {
        let e = CliError::Relay {
            status: 400,
            body: "invalid: BOARD_HEAD_MISMATCH — submitted prev ... does not match".into(),
        };
        let mapped = friendly_lab_error(
            e,
            LabWriteOp::Update {
                explicit_base: false,
            },
        );
        assert!(matches!(mapped, CliError::Conflict(m) if m.contains("someone else wrote")));
    }

    #[test]
    fn friendly_error_explicit_base_gets_base_specific_hint() {
        let e = CliError::Relay {
            status: 400,
            body: "invalid: BOARD_HEAD_MISMATCH — mismatch".into(),
        };
        let mapped = friendly_lab_error(
            e,
            LabWriteOp::Update {
                explicit_base: true,
            },
        );
        assert!(
            matches!(mapped, CliError::Conflict(m) if m.contains("--base event id you passed"))
        );
    }

    #[test]
    fn friendly_error_create_collision_gets_create_specific_hint() {
        let e = CliError::Relay {
            status: 400,
            body: "invalid: BOARD_HEAD_MISMATCH — board ... already exists".into(),
        };
        let mapped = friendly_lab_error(e, LabWriteOp::Create);
        assert!(matches!(mapped, CliError::Conflict(m) if m.contains("collided")));
    }

    #[test]
    fn friendly_error_strips_invalid_prefix() {
        let e = CliError::Relay {
            status: 400,
            body: "invalid: lab board `d` tag must be a valid UUID".into(),
        };
        let mapped = friendly_lab_error(e, LabWriteOp::Create);
        assert!(
            matches!(mapped, CliError::Relay { status: 400, body } if body == "lab board `d` tag must be a valid UUID")
        );
    }

    #[test]
    fn friendly_error_strips_restricted_prefix() {
        let e = CliError::Relay {
            status: 400,
            body: "restricted: lab board is frozen and cannot be edited".into(),
        };
        let mapped = friendly_lab_error(
            e,
            LabWriteOp::Update {
                explicit_base: false,
            },
        );
        assert!(
            matches!(mapped, CliError::Relay { body, .. } if body == "lab board is frozen and cannot be edited")
        );
    }

    #[test]
    fn friendly_error_leaves_non_relay_errors_untouched() {
        let e = CliError::NotFound("nope".into());
        let mapped = friendly_lab_error(e, LabWriteOp::Create);
        assert!(matches!(mapped, CliError::NotFound(m) if m == "nope"));
    }

    // -- parse_accept --

    #[test]
    fn parse_accept_reads_accepted_and_message() {
        let (accepted, message) =
            parse_accept(r#"{"event_id":"abc","accepted":true,"message":"duplicate:"}"#).unwrap();
        assert!(accepted);
        assert_eq!(message, "duplicate:");
    }

    #[test]
    fn parse_accept_defaults_when_fields_absent() {
        let (accepted, message) = parse_accept(r#"{"event_id":"abc"}"#).unwrap();
        assert!(!accepted);
        assert_eq!(message, "");
    }

    #[test]
    fn parse_accept_errs_on_non_json() {
        assert!(parse_accept("not json").is_err());
    }
}
