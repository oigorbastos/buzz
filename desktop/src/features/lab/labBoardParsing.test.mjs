import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  boardReference,
  eventMatchesBoard,
  isBoardConflictError,
  MAX_MARKDOWN_BYTES,
  MAX_SUMMARY_CHARS,
  MAX_TITLE_CHARS,
  parseBoardHead,
  parseBoardRevision,
  sortRevisions,
  validateBoardInput,
} from "./api.ts";

const KIND_HEAD = 30623;
const KIND_REVISION = 40101;
const BOARD = "0f2b8a1c-1111-4222-8333-444455556666";
const EVENT_ID = "a".repeat(64);
const PUBKEY = "b".repeat(64);

function headEvent(tags, content = "# hello") {
  return {
    id: EVENT_ID,
    pubkey: PUBKEY,
    created_at: 1_700_000_000,
    kind: KIND_HEAD,
    tags,
    content,
    sig: "c".repeat(128),
  };
}

function revisionEvent(tags, content = "body") {
  return { ...headEvent(tags, content), kind: KIND_REVISION };
}

describe("parseBoardHead", () => {
  it("reads every field the CAS flow depends on", () => {
    const head = parseBoardHead(
      headEvent([
        ["d", BOARD],
        ["revision", "7"],
        ["title", "Sprint plan"],
        ["summary", "what we are doing"],
        ["head", EVENT_ID],
        ["status", "active"],
      ]),
    );

    assert.equal(head.boardId, BOARD);
    assert.equal(head.revision, 7);
    assert.equal(head.title, "Sprint plan");
    assert.equal(head.summary, "what we are doing");
    // The `head` tag is the CAS token for the next write — losing it would
    // make every subsequent save fail as a conflict.
    assert.equal(head.headEventId, EVENT_ID);
    assert.equal(head.status, "active");
    assert.equal(head.content, "# hello");
  });

  it("rejects an event of the wrong kind", () => {
    const event = headEvent([["d", BOARD]]);
    event.kind = 1;
    assert.equal(parseBoardHead(event), null);
  });

  it("drops a projection missing d, revision, or head rather than throwing", () => {
    // A malformed projection must cost that one board, not the whole screen.
    assert.equal(
      parseBoardHead(
        headEvent([
          ["revision", "1"],
          ["head", EVENT_ID],
        ]),
      ),
      null,
    );
    assert.equal(
      parseBoardHead(
        headEvent([
          ["d", BOARD],
          ["head", EVENT_ID],
        ]),
      ),
      null,
    );
    assert.equal(
      parseBoardHead(
        headEvent([
          ["d", BOARD],
          ["revision", "1"],
        ]),
      ),
      null,
    );
  });

  it("falls back to active for an unknown status", () => {
    const head = parseBoardHead(
      headEvent([
        ["d", BOARD],
        ["revision", "1"],
        ["head", EVENT_ID],
        ["status", "banana"],
      ]),
    );
    assert.equal(head.status, "active");
  });

  it("treats a non-numeric revision as missing", () => {
    assert.equal(
      parseBoardHead(
        headEvent([
          ["d", BOARD],
          ["revision", "not-a-number"],
          ["head", EVENT_ID],
        ]),
      ),
      null,
    );
  });
});

describe("parseBoardRevision", () => {
  it("reads op, revision, and restored_from", () => {
    const revision = parseBoardRevision(
      revisionEvent([
        ["d", BOARD],
        ["op", "restore"],
        ["revision", "9"],
        ["restored_from", "3"],
      ]),
    );
    assert.equal(revision.op, "restore");
    assert.equal(revision.revision, 9);
    assert.equal(revision.restoredFrom, 3);
    assert.equal(revision.author, PUBKEY);
  });

  it("keeps a revision that omitted the revision tag", () => {
    const revision = parseBoardRevision(
      revisionEvent([
        ["d", BOARD],
        ["op", "update"],
      ]),
    );
    assert.equal(revision.revision, null);
    assert.equal(revision.restoredFrom, null);
  });
});

describe("sortRevisions", () => {
  it("orders by revision number, oldest first", () => {
    const rows = sortRevisions([
      { revision: 3, createdAt: 30, eventId: "c" },
      { revision: 1, createdAt: 10, eventId: "a" },
      { revision: 2, createdAt: 20, eventId: "b" },
    ]);
    assert.deepEqual(
      rows.map((row) => row.revision),
      [1, 2, 3],
    );
  });

  it("pushes unnumbered revisions to the end by timestamp", () => {
    const rows = sortRevisions([
      { revision: null, createdAt: 50, eventId: "late" },
      { revision: null, createdAt: 5, eventId: "early" },
      { revision: 1, createdAt: 10, eventId: "a" },
    ]);
    assert.deepEqual(
      rows.map((row) => row.eventId),
      ["a", "early", "late"],
    );
  });

  it("does not mutate its input", () => {
    const input = [
      { revision: 2, createdAt: 20, eventId: "b" },
      { revision: 1, createdAt: 10, eventId: "a" },
    ];
    sortRevisions(input);
    assert.equal(input[0].revision, 2);
  });
});

describe("eventMatchesBoard", () => {
  it("matches on the d tag and rejects another board", () => {
    const event = revisionEvent([["d", BOARD]]);
    assert.equal(eventMatchesBoard(event, BOARD), true);
    assert.equal(eventMatchesBoard(event, "other"), false);
  });

  it("rejects an event with no d tag", () => {
    assert.equal(
      eventMatchesBoard(revisionEvent([["op", "update"]]), BOARD),
      false,
    );
  });
});

describe("validateBoardInput", () => {
  it("accepts input at the exact limits", () => {
    assert.equal(
      validateBoardInput({
        title: "t".repeat(MAX_TITLE_CHARS),
        summary: "s".repeat(MAX_SUMMARY_CHARS),
        content: "x".repeat(MAX_MARKDOWN_BYTES),
      }),
      null,
    );
  });

  it("rejects an over-long title", () => {
    const error = validateBoardInput({
      title: "t".repeat(MAX_TITLE_CHARS + 1),
      content: "",
    });
    assert.match(error, /Title is limited/);
  });

  it("rejects an empty title but allows an absent one", () => {
    assert.match(
      validateBoardInput({ title: "   ", content: "" }),
      /cannot be empty/,
    );
    assert.equal(validateBoardInput({ content: "" }), null);
  });

  it("counts the content cap in bytes, not characters", () => {
    // The relay caps bytes; a multi-byte character must not be counted as one.
    const almostFull = "é".repeat(MAX_MARKDOWN_BYTES / 2);
    assert.equal(validateBoardInput({ content: almostFull }), null);
    assert.match(
      validateBoardInput({ content: `${almostFull}é` }),
      /Content is limited/,
    );
  });

  it("counts the title cap in characters, not bytes", () => {
    // Mirrors the relay, which uses chars for title and bytes for content.
    assert.equal(
      validateBoardInput({ title: "é".repeat(MAX_TITLE_CHARS), content: "" }),
      null,
    );
  });
});

describe("isBoardConflictError", () => {
  it("recognises the relay's CAS rejection marker", () => {
    assert.equal(
      isBoardConflictError(
        new Error("relay rejected event: invalid: BOARD_HEAD_MISMATCH — stale"),
      ),
      true,
    );
  });

  it("does not claim unrelated failures as conflicts", () => {
    assert.equal(isBoardConflictError(new Error("relay unreachable")), false);
    assert.equal(isBoardConflictError("BOARD_HEAD_MISMATCH"), false);
    assert.equal(isBoardConflictError(null), false);
  });
});

describe("boardReference", () => {
  it("addresses the live board when no revision is given", () => {
    assert.equal(boardReference(BOARD), `buzz://lab?board=${BOARD}`);
  });

  it("pins to an exact revision when one is given", () => {
    // The pinned form is what makes a quoted link safe: it keeps meaning the
    // same text after someone else edits the board.
    assert.equal(
      boardReference(BOARD, 7),
      `buzz://lab?board=${BOARD}&revision=7`,
    );
  });

  it("treats revision 0 as a real revision, not as absent", () => {
    assert.match(boardReference(BOARD, 0), /revision=0$/);
  });
});
