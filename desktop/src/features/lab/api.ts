/**
 * Lab Boards ("Quadros") — relay access layer.
 *
 * A Lab Board is a community-readable Markdown document. Community boards are
 * multi-writer; personal-editing boards can be changed only by their owner and
 * that owner's managed agents. Concurrency is settled by the relay with
 * compare-and-swap rather than by last-write-wins: each mutation names the
 * revision it was based on (`prev`), and the relay rejects it with
 * `BOARD_HEAD_MISMATCH` if that is no longer the head.
 *
 * Two kinds (see `@/shared/constants/kinds` for the full contract):
 * - 40101 `KIND_LAB_BOARD_REVISION` — client-signed, ordinary event. Every
 *   accepted create/update/restore is one, kept forever; this is the history.
 * - 30623 `KIND_LAB_BOARD_HEAD` — relay-signed NIP-33 projection keyed by
 *   `d=board_id`, re-signed on every accepted mutation. It carries the current
 *   Markdown in `content`, so opening a board costs exactly one query, and its
 *   `head` tag is the CAS token for the next write.
 */

import { getRelaySelf } from "@/features/moderation/lib/relaySelf";
import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";
import type { RelayEvent } from "@/shared/api/types";
import {
  KIND_LAB_BOARD_HEAD,
  KIND_LAB_BOARD_REVISION,
} from "@/shared/constants/kinds";
import {
  type LabBoardEditPolicy,
  normalizeBoardTags,
} from "@/features/lab/model";

/** Relay-enforced caps, mirrored so the UI can fail before a round trip. */
export const MAX_TITLE_CHARS = 160;
export const MAX_SUMMARY_CHARS = 500;
export const MAX_MARKDOWN_BYTES = 64 * 1024;

const BOARD_LIST_LIMIT = 500;
const HISTORY_FETCH_LIMIT = 1000;

export type LabBoardStatus = "active" | "archived" | "frozen";

/** The live head projection of one board (parsed from a kind:30623 event). */
export type LabBoardHead = {
  boardId: string;
  title: string;
  summary: string | null;
  content: string;
  revision: number;
  status: LabBoardStatus;
  /** Who may write. Reading remains community-wide in both modes. */
  editPolicy: LabBoardEditPolicy;
  /** Canonical human owner, derived and signed by the relay. */
  ownerPubkey: string | null;
  tags: string[];
  /** Event id of the kind:40101 revision this projection reflects — the CAS token. */
  headEventId: string;
  updatedAt: number;
};

/** One entry of a board's revision history (parsed from a kind:40101 event). */
export type LabBoardRevision = {
  eventId: string;
  boardId: string;
  /** Absent only for events from a client that did not follow the convention. */
  revision: number | null;
  op: string;
  author: string;
  createdAt: number;
  restoredFrom: number | null;
  content: string;
};

function tagValue(event: RelayEvent, name: string): string | null {
  const tag = event.tags.find((entry) => entry[0] === name);
  return tag?.[1] ?? null;
}

function tagValues(event: RelayEvent, name: string): string[] {
  return event.tags
    .filter((entry) => entry[0] === name && entry[1])
    .map((entry) => entry[1] as string);
}

function parseIntTag(event: RelayEvent, name: string): number | null {
  const raw = tagValue(event, name);
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseStatus(raw: string | null): LabBoardStatus {
  return raw === "archived" || raw === "frozen" ? raw : "active";
}

function parseEditPolicy(raw: string | null): LabBoardEditPolicy {
  return raw === "owner_agents" ? "owner_agents" : "community";
}

/**
 * Parse a kind:30623 event into a board head.
 *
 * Returns `null` rather than throwing when the event is missing the fields the
 * UI cannot work without (`d`, `revision`, `head`): a single malformed
 * projection should drop that one board from the list, not blank the screen.
 */
export function parseBoardHead(event: RelayEvent): LabBoardHead | null {
  if (event.kind !== KIND_LAB_BOARD_HEAD) return null;
  const boardId = tagValue(event, "d");
  const headEventId = tagValue(event, "head");
  const revision = parseIntTag(event, "revision");
  if (!boardId || !headEventId || revision === null) return null;

  return {
    boardId,
    title: tagValue(event, "title") ?? "Untitled board",
    summary: tagValue(event, "summary"),
    content: event.content,
    revision,
    status: parseStatus(tagValue(event, "status")),
    editPolicy: parseEditPolicy(tagValue(event, "edit_policy")),
    ownerPubkey: tagValue(event, "owner"),
    tags: normalizeBoardTags(tagValues(event, "t")),
    headEventId,
    updatedAt: event.created_at,
  };
}

/** Parse a kind:40101 event into a history entry. */
export function parseBoardRevision(event: RelayEvent): LabBoardRevision | null {
  if (event.kind !== KIND_LAB_BOARD_REVISION) return null;
  const boardId = tagValue(event, "d");
  if (!boardId) return null;

  return {
    eventId: event.id,
    boardId,
    revision: parseIntTag(event, "revision"),
    op: tagValue(event, "op") ?? "unknown",
    author: event.pubkey,
    createdAt: event.created_at,
    restoredFrom: parseIntTag(event, "restored_from"),
    content: event.content,
  };
}

/**
 * Order history oldest-first by `revision`.
 *
 * Events with no `revision` tag can only come from a client that ignored the
 * convention; they sort to the end by timestamp instead of being dropped, so
 * the history stays honest about what the relay actually holds.
 */
export function sortRevisions(
  revisions: LabBoardRevision[],
): LabBoardRevision[] {
  return [...revisions].sort((a, b) => {
    if (a.revision !== null && b.revision !== null) {
      return a.revision - b.revision;
    }
    if (a.revision !== null) return -1;
    if (b.revision !== null) return 1;
    return a.createdAt - b.createdAt;
  });
}

/**
 * The canonical reference to a board, or to one exact revision.
 *
 * Kept identical to the CLI's `board_reference` so a link copied in the app
 * and one printed by `buzz lab ref` are the same string — a reference that
 * differs by client is not a reference.
 */
export function boardReference(boardId: string, revision?: number): string {
  return revision === undefined
    ? `buzz://lab?board=${boardId}`
    : `buzz://lab?board=${boardId}&revision=${revision}`;
}

/** True when this event belongs to `boardId` (client-side `#d` match). */
export function eventMatchesBoard(event: RelayEvent, boardId: string): boolean {
  return tagValue(event, "d") === boardId;
}

/**
 * List every board in the community, most recently updated first.
 *
 * Safe to filter server-side by kind alone: 30623 is NIP-33, and we want all
 * `d` values, so no `#d` constraint is involved.
 */
export async function fetchBoardHeads(): Promise<LabBoardHead[]> {
  const events = await relayClient.fetchEvents({
    kinds: [KIND_LAB_BOARD_HEAD],
    limit: BOARD_LIST_LIMIT,
  });
  return events
    .map(parseBoardHead)
    .filter((head): head is LabBoardHead => head !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Read one board's live head — the read half of every compare-and-swap.
 *
 * Narrowed to the relay's own pubkey when it is known, since kind:30623 is
 * relay-signed. This is defence in depth, not the only barrier: 30623 is
 * registered relay-only, so the relay's own ingest gate refuses a
 * client-submitted projection outright and a forgery never reaches storage.
 * That is why a `null` self pubkey (relay advertises none, or NIP-11 is
 * unreadable) degrades to an unfiltered read rather than failing the screen —
 * the guard that matters is server-side.
 */
export async function fetchBoardHead(
  boardId: string,
): Promise<LabBoardHead | null> {
  const relaySelf = await getRelaySelf().catch(() => null);
  const events = await relayClient.fetchEvents({
    kinds: [KIND_LAB_BOARD_HEAD],
    ...(relaySelf ? { authors: [relaySelf] } : {}),
    "#d": [boardId],
    limit: 1,
  });
  const newest = [...events].sort((a, b) => b.created_at - a.created_at)[0];
  return newest ? parseBoardHead(newest) : null;
}

/**
 * Read one board's revision history, oldest first.
 *
 * The `#d` filter is honoured server-side: kind:40101 is not NIP-33 (that is
 * what lets a board keep history rather than be replaced), but its `d` tag is
 * still materialized into the indexed `events.d_tag` column, so the relay
 * narrows to this board in SQL before applying `LIMIT`. That distinction
 * matters — filtering after the limit would quietly drop older revisions of
 * this board as soon as other boards were busier, which is a wrong history
 * rather than a slow one.
 *
 * `boardMatchesClientSide` is still applied as a cheap assertion: if a relay
 * ever ignores the filter, the caller gets fewer rows rather than another
 * board's content.
 */
export async function fetchBoardHistory(
  boardId: string,
): Promise<LabBoardRevision[]> {
  const events = await relayClient.fetchEvents({
    kinds: [KIND_LAB_BOARD_REVISION],
    "#d": [boardId],
    limit: HISTORY_FETCH_LIMIT,
  });
  const revisions = events
    .filter((event) => eventMatchesBoard(event, boardId))
    .map(parseBoardRevision)
    .filter((entry): entry is LabBoardRevision => entry !== null);
  return sortRevisions(revisions);
}

export function validateBoardInput(input: {
  title?: string;
  summary?: string;
  content: string;
  tags?: string[];
}): string | null {
  if (input.title !== undefined && input.title.trim().length === 0) {
    return "Title cannot be empty.";
  }
  if (input.title !== undefined && [...input.title].length > MAX_TITLE_CHARS) {
    return `Title is limited to ${MAX_TITLE_CHARS} characters.`;
  }
  if (
    input.summary !== undefined &&
    [...input.summary].length > MAX_SUMMARY_CHARS
  ) {
    return `Summary is limited to ${MAX_SUMMARY_CHARS} characters.`;
  }
  if (new TextEncoder().encode(input.content).length > MAX_MARKDOWN_BYTES) {
    return `Content is limited to ${MAX_MARKDOWN_BYTES / 1024} KB.`;
  }
  if (
    input.tags !== undefined &&
    normalizeBoardTags(input.tags).length !== input.tags.length
  ) {
    return "Tags must be unique, non-empty, and within the supported limits.";
  }
  return null;
}

/** True when this error is the relay refusing a write whose base is stale. */
export function isBoardConflictError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("BOARD_HEAD_MISMATCH")
  );
}

export const BOARD_CONFLICT_MESSAGE =
  "Someone else edited this board while you were writing. Your text is kept — reopen the board to see their version before saving again.";

async function publishRevision(
  content: string,
  tags: string[][],
): Promise<string> {
  const event = await signRelayEvent({
    kind: KIND_LAB_BOARD_REVISION,
    content,
    tags,
  });
  await relayClient.publishEvent(
    event,
    "Timed out publishing to this board.",
    "Failed to publish to this board.",
  );
  return event.id;
}

export async function createBoard(input: {
  title: string;
  summary?: string;
  content: string;
  editPolicy: LabBoardEditPolicy;
  tags: string[];
}): Promise<{ boardId: string; eventId: string }> {
  const boardId = crypto.randomUUID();
  const tags: string[][] = [
    ["d", boardId],
    // V2 deliberately fails closed on an older relay instead of letting it
    // ignore a personal-editing policy and create a community-writable board.
    ["op", "create_v2"],
    ["revision", "1"],
    ["title", input.title.trim()],
    ["edit_policy", input.editPolicy],
    ["tags", "replace"],
  ];
  const summary = input.summary?.trim();
  if (summary) tags.push(["summary", summary]);
  for (const tag of normalizeBoardTags(input.tags)) tags.push(["t", tag]);

  const eventId = await publishRevision(input.content, tags);
  return { boardId, eventId };
}

/**
 * Save an edit, compare-and-swapping against `head`.
 *
 * `title`/`summary` are omitted when unchanged: on the wire, an absent tag
 * means "keep the current value", and there is no empty-means-clear form.
 */
export async function updateBoard(input: {
  head: LabBoardHead;
  content: string;
  title?: string;
  summary?: string;
  tags?: string[];
}): Promise<string> {
  const tags: string[][] = [
    ["d", input.head.boardId],
    ["op", input.tags === undefined ? "update" : "update_v2"],
    ["prev", input.head.headEventId],
    ["revision", String(input.head.revision + 1)],
  ];
  if (input.title !== undefined) tags.push(["title", input.title.trim()]);
  if (input.summary !== undefined) tags.push(["summary", input.summary.trim()]);
  if (input.tags !== undefined) {
    tags.push(["tags", "replace"]);
    for (const tag of normalizeBoardTags(input.tags)) tags.push(["t", tag]);
  }

  return publishRevision(input.content, tags);
}

/**
 * Restore an earlier revision by republishing its content as a new one.
 *
 * The relay never copies content on restore — the client resubmits it — and
 * the result is a new revision on top of history, never a rewrite of it.
 */
export async function restoreBoardRevision(input: {
  head: LabBoardHead;
  revision: LabBoardRevision;
}): Promise<string> {
  if (input.revision.revision === null) {
    throw new Error(
      "That revision has no revision number and cannot be restored.",
    );
  }
  const tags: string[][] = [
    ["d", input.head.boardId],
    ["op", "restore"],
    ["prev", input.head.headEventId],
    ["revision", String(input.head.revision + 1)],
    ["restored_from", String(input.revision.revision)],
  ];
  return publishRevision(input.revision.content, tags);
}
