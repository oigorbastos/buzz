import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MOCK_LAB_COMMUNITY_BOARD_ID,
  MOCK_LAB_OTHER_PRIVATE_BOARD_ID,
  MOCK_LAB_OWN_PRIVATE_BOARD_ID,
  MOCK_LAB_READONLY_BOARD_ID,
  publishMockLabRevision,
  queryMockLabBoards,
  resetMockLabBoards,
} from "./mockLabBoards.ts";
import {
  KIND_LAB_BOARD_HEAD,
  KIND_LAB_BOARD_REVISION,
} from "../shared/constants/kinds.ts";

const VIEWER = "deadbeef".repeat(8);
const OTHER_OWNER = "a".repeat(64);
const VIEWER_AGENT = "b".repeat(64);
const OTHER_AGENT = "c".repeat(64);

function tagValue(event, name) {
  return event.tags.find((tag) => tag[0] === name)?.[1] ?? null;
}

function revisionEvent(head, overrides = {}) {
  return {
    id: overrides.id ?? "9".repeat(64),
    pubkey: VIEWER,
    created_at: Math.floor(Date.now() / 1_000),
    kind: KIND_LAB_BOARD_REVISION,
    tags: [
      ["d", tagValue(head, "d")],
      ["op", "update_v2"],
      ["prev", tagValue(head, "head")],
      ["revision", String(Number(tagValue(head, "revision")) + 1)],
      ["tags", "replace"],
      ["t", "aprovado"],
    ],
    content: "# Conteúdo atualizado",
    sig: "0".repeat(128),
    ...overrides,
  };
}

describe("Lab preview mock relay", () => {
  it("seeds four boards but exposes community, read-only, and the viewer's private board", () => {
    resetMockLabBoards({ enabled: true, viewerPubkey: VIEWER });
    const heads = queryMockLabBoards([{ kinds: [KIND_LAB_BOARD_HEAD] }]);
    assert.equal(heads.length, 3);
    assert.deepEqual(
      heads.map((head) => tagValue(head, "access_scope")).sort(),
      ["community", "community_readonly", "private"],
    );
    assert.equal(
      heads.some(
        (head) => tagValue(head, "d") === MOCK_LAB_OTHER_PRIVATE_BOARD_ID,
      ),
      false,
    );
    assert.equal(
      heads
        .flatMap((head) =>
          head.tags.filter((tag) => tag[0] === "t").map((tag) => tag[1]),
        )
        .includes("sigilo-alheio"),
      false,
    );
  });

  it("does not leak a foreign private board through direct, id, history, union, or limit queries", () => {
    resetMockLabBoards({ enabled: true, viewerPubkey: OTHER_OWNER });
    const [foreignHead] = queryMockLabBoards([
      {
        kinds: [KIND_LAB_BOARD_HEAD],
        "#d": [MOCK_LAB_OTHER_PRIVATE_BOARD_ID],
      },
    ]);
    const foreignHistory = queryMockLabBoards([
      {
        kinds: [KIND_LAB_BOARD_REVISION],
        "#d": [MOCK_LAB_OTHER_PRIVATE_BOARD_ID],
      },
    ]);
    assert.ok(foreignHead);
    assert.ok(foreignHistory.length > 0);

    resetMockLabBoards({ enabled: true, viewerPubkey: VIEWER });
    assert.deepEqual(
      queryMockLabBoards([
        {
          kinds: [KIND_LAB_BOARD_HEAD],
          "#d": [MOCK_LAB_OTHER_PRIVATE_BOARD_ID],
        },
      ]),
      [],
    );
    assert.deepEqual(
      queryMockLabBoards([
        {
          kinds: [KIND_LAB_BOARD_REVISION],
          "#d": [MOCK_LAB_OTHER_PRIVATE_BOARD_ID],
        },
      ]),
      [],
    );
    assert.deepEqual(queryMockLabBoards([{ ids: [foreignHead.id] }]), []);
    assert.deepEqual(queryMockLabBoards([{ ids: [foreignHistory[0].id] }]), []);
    const foreignAuthorEvents = queryMockLabBoards([
      { authors: [OTHER_OWNER] },
    ]);
    assert.ok(foreignAuthorEvents.length > 0);
    assert.equal(
      foreignAuthorEvents.every(
        (event) => tagValue(event, "d") === MOCK_LAB_READONLY_BOARD_ID,
      ),
      true,
    );
    assert.equal(
      foreignAuthorEvents.some(
        (event) => tagValue(event, "d") === MOCK_LAB_OTHER_PRIVATE_BOARD_ID,
      ),
      false,
    );

    const union = queryMockLabBoards([
      {
        kinds: [KIND_LAB_BOARD_HEAD],
        "#d": [MOCK_LAB_COMMUNITY_BOARD_ID],
      },
      { ids: [foreignHead.id] },
    ]);
    assert.deepEqual(
      union.map((event) => tagValue(event, "d")),
      [MOCK_LAB_COMMUNITY_BOARD_ID],
    );

    const limited = queryMockLabBoards([
      { kinds: [KIND_LAB_BOARD_HEAD], limit: 1 },
    ]);
    assert.equal(limited.length, 1);
    assert.equal(tagValue(limited[0], "d"), MOCK_LAB_COMMUNITY_BOARD_ID);
  });

  it("accepts owner edits and atomically replaces tags", () => {
    resetMockLabBoards({ enabled: true, viewerPubkey: VIEWER });
    const [head] = queryMockLabBoards([
      {
        kinds: [KIND_LAB_BOARD_HEAD],
        "#d": [MOCK_LAB_OWN_PRIVATE_BOARD_ID],
      },
    ]);
    const event = revisionEvent(head);
    event.tags.push(["access_scope", "community"], ["owner", OTHER_OWNER]);
    const result = publishMockLabRevision(event, VIEWER);
    assert.deepEqual(result, { accepted: true, message: "" });

    const [updated] = queryMockLabBoards([
      {
        kinds: [KIND_LAB_BOARD_HEAD],
        "#d": [tagValue(head, "d")],
      },
    ]);
    assert.equal(updated.content, "# Conteúdo atualizado");
    assert.deepEqual(
      updated.tags.filter((tag) => tag[0] === "t").map((tag) => tag[1]),
      ["aprovado"],
    );
    assert.equal(tagValue(updated, "access_scope"), "private");
    assert.equal(tagValue(updated, "owner"), VIEWER);
  });

  it("preserves tags when a legacy agent updates only Markdown", () => {
    resetMockLabBoards({ enabled: true, viewerPubkey: VIEWER });
    const [head] = queryMockLabBoards([
      {
        kinds: [KIND_LAB_BOARD_HEAD],
        "#d": [MOCK_LAB_OWN_PRIVATE_BOARD_ID],
      },
    ]);
    const event = revisionEvent(head, {
      id: "8".repeat(64),
      tags: [
        ["d", tagValue(head, "d")],
        ["op", "update"],
        ["prev", tagValue(head, "head")],
        ["revision", String(Number(tagValue(head, "revision")) + 1)],
      ],
    });
    assert.deepEqual(publishMockLabRevision(event, VIEWER), {
      accepted: true,
      message: "",
    });

    const [updated] = queryMockLabBoards([
      {
        kinds: [KIND_LAB_BOARD_HEAD],
        "#d": [tagValue(head, "d")],
      },
    ]);
    assert.deepEqual(
      updated.tags.filter((tag) => tag[0] === "t").map((tag) => tag[1]),
      ["agentes", "operação", "prompts"],
    );
  });

  it("returns the same opaque error for unauthorized, stale, and guessed private writes", () => {
    resetMockLabBoards({ enabled: true, viewerPubkey: OTHER_OWNER });
    const [head] = queryMockLabBoards([
      {
        kinds: [KIND_LAB_BOARD_HEAD],
        "#d": [MOCK_LAB_OTHER_PRIVATE_BOARD_ID],
      },
    ]);
    const historyBefore = queryMockLabBoards([
      {
        kinds: [KIND_LAB_BOARD_REVISION],
        "#d": [MOCK_LAB_OTHER_PRIVATE_BOARD_ID],
      },
    ]);
    assert.deepEqual(publishMockLabRevision(revisionEvent(head), VIEWER), {
      accepted: false,
      message: "BOARD_NOT_FOUND",
    });
    assert.deepEqual(
      publishMockLabRevision(
        revisionEvent(head, {
          id: "7".repeat(64),
          tags: [
            ["d", MOCK_LAB_OTHER_PRIVATE_BOARD_ID],
            ["op", "update_v2"],
            ["prev", "0".repeat(64)],
            ["revision", "99"],
          ],
        }),
        VIEWER,
      ),
      { accepted: false, message: "BOARD_NOT_FOUND" },
    );
    assert.deepEqual(
      publishMockLabRevision(
        {
          id: "1".repeat(64),
          pubkey: VIEWER,
          created_at: Math.floor(Date.now() / 1_000),
          kind: KIND_LAB_BOARD_REVISION,
          tags: [
            ["d", MOCK_LAB_OTHER_PRIVATE_BOARD_ID],
            ["op", "create_v2"],
            ["revision", "1"],
            ["title", "UUID adivinhado"],
            ["access_scope", "private"],
          ],
          content: "# tentativa",
          sig: "0".repeat(128),
        },
        VIEWER,
      ),
      { accepted: false, message: "BOARD_NOT_FOUND" },
    );
    assert.deepEqual(
      publishMockLabRevision(
        revisionEvent(
          {
            tags: [
              ["d", "66666666-6666-4666-8666-666666666666"],
              ["head", "1".repeat(64)],
              ["revision", "1"],
            ],
          },
          { id: "6".repeat(64) },
        ),
        VIEWER,
      ),
      { accepted: false, message: "BOARD_NOT_FOUND" },
    );

    const [headAfter] = queryMockLabBoards([
      {
        kinds: [KIND_LAB_BOARD_HEAD],
        "#d": [MOCK_LAB_OTHER_PRIVATE_BOARD_ID],
      },
    ]);
    const historyAfter = queryMockLabBoards([
      {
        kinds: [KIND_LAB_BOARD_REVISION],
        "#d": [MOCK_LAB_OTHER_PRIVATE_BOARD_ID],
      },
    ]);
    assert.equal(tagValue(headAfter, "head"), tagValue(head, "head"));
    assert.equal(tagValue(headAfter, "revision"), tagValue(head, "revision"));
    assert.equal(historyAfter.length, historyBefore.length);
  });

  it("keeps community boards readable and writable across owners", () => {
    resetMockLabBoards({ enabled: true, viewerPubkey: VIEWER });
    const [head] = queryMockLabBoards([
      {
        kinds: [KIND_LAB_BOARD_HEAD],
        "#d": [MOCK_LAB_COMMUNITY_BOARD_ID],
      },
    ]);
    assert.ok(head);
    const communityEdit = revisionEvent(head, {
      id: "2".repeat(64),
      pubkey: OTHER_OWNER,
    });
    assert.deepEqual(
      publishMockLabRevision(communityEdit, OTHER_OWNER, OTHER_OWNER),
      { accepted: true, message: "" },
    );
  });

  it("lets other community members read a read-only board but rejects every write before CAS", () => {
    resetMockLabBoards({ enabled: true, viewerPubkey: VIEWER });
    const [head] = queryMockLabBoards([
      {
        kinds: [KIND_LAB_BOARD_HEAD],
        "#d": [MOCK_LAB_READONLY_BOARD_ID],
      },
    ]);
    const historyBefore = queryMockLabBoards([
      {
        kinds: [KIND_LAB_BOARD_REVISION],
        "#d": [MOCK_LAB_READONLY_BOARD_ID],
      },
    ]);
    assert.ok(head);
    assert.ok(historyBefore.length > 0);

    assert.deepEqual(publishMockLabRevision(revisionEvent(head), VIEWER), {
      accepted: false,
      message: "BOARD_READ_ONLY",
    });
    assert.deepEqual(
      publishMockLabRevision(
        revisionEvent(head, {
          id: "6".repeat(64),
          tags: [
            ["d", MOCK_LAB_READONLY_BOARD_ID],
            ["op", "update_v2"],
            ["prev", "0".repeat(64)],
            ["revision", "99"],
          ],
        }),
        VIEWER,
      ),
      { accepted: false, message: "BOARD_READ_ONLY" },
    );

    const [headAfter] = queryMockLabBoards([
      {
        kinds: [KIND_LAB_BOARD_HEAD],
        "#d": [MOCK_LAB_READONLY_BOARD_ID],
      },
    ]);
    const historyAfter = queryMockLabBoards([
      {
        kinds: [KIND_LAB_BOARD_REVISION],
        "#d": [MOCK_LAB_READONLY_BOARD_ID],
      },
    ]);
    assert.equal(tagValue(headAfter, "head"), tagValue(head, "head"));
    assert.equal(historyAfter.length, historyBefore.length);
  });

  it("lets the owner edit a read-only board without changing its immutable access metadata", () => {
    resetMockLabBoards({ enabled: true, viewerPubkey: OTHER_OWNER });
    const [head] = queryMockLabBoards([
      {
        kinds: [KIND_LAB_BOARD_HEAD],
        "#d": [MOCK_LAB_READONLY_BOARD_ID],
      },
    ]);
    const event = revisionEvent(head, {
      id: "d".repeat(64),
      pubkey: OTHER_OWNER,
    });
    event.tags.push(["access_scope", "community"], ["owner", VIEWER]);
    assert.deepEqual(publishMockLabRevision(event, OTHER_OWNER, OTHER_OWNER), {
      accepted: true,
      message: "",
    });

    const [updated] = queryMockLabBoards([
      {
        kinds: [KIND_LAB_BOARD_HEAD],
        "#d": [MOCK_LAB_READONLY_BOARD_ID],
      },
    ]);
    assert.equal(tagValue(updated, "access_scope"), "community_readonly");
    assert.equal(tagValue(updated, "owner"), OTHER_OWNER);
  });

  it("grants the owner's managed agents read-only-board writes and rejects other agents", () => {
    resetMockLabBoards({
      effectiveOwnerPubkey: OTHER_OWNER,
      enabled: true,
      viewerPubkey: OTHER_AGENT,
    });
    const [head] = queryMockLabBoards([
      {
        kinds: [KIND_LAB_BOARD_HEAD],
        "#d": [MOCK_LAB_READONLY_BOARD_ID],
      },
    ]);
    assert.deepEqual(
      publishMockLabRevision(
        revisionEvent(head, {
          id: "e".repeat(64),
          pubkey: OTHER_AGENT,
        }),
        OTHER_AGENT,
        OTHER_OWNER,
      ),
      { accepted: true, message: "" },
    );

    resetMockLabBoards({
      effectiveOwnerPubkey: VIEWER,
      enabled: true,
      viewerPubkey: VIEWER_AGENT,
    });
    const [foreignHead] = queryMockLabBoards([
      {
        kinds: [KIND_LAB_BOARD_HEAD],
        "#d": [MOCK_LAB_READONLY_BOARD_ID],
      },
    ]);
    assert.deepEqual(
      publishMockLabRevision(
        revisionEvent(foreignHead, {
          id: "f".repeat(64),
          pubkey: VIEWER_AGENT,
        }),
        VIEWER_AGENT,
        VIEWER,
      ),
      { accepted: false, message: "BOARD_READ_ONLY" },
    );
  });

  it("derives the owner on private create and ignores forged authority tags", () => {
    resetMockLabBoards({ enabled: true, viewerPubkey: VIEWER });
    const boardId = "55555555-5555-4555-8555-555555555555";
    const event = {
      id: "5".repeat(64),
      pubkey: VIEWER,
      created_at: Math.floor(Date.now() / 1_000),
      kind: KIND_LAB_BOARD_REVISION,
      tags: [
        ["d", boardId],
        ["op", "create_v2"],
        ["revision", "1"],
        ["title", "Privado novo"],
        ["access_scope", "private"],
        ["owner", OTHER_OWNER],
        ["tags", "replace"],
        ["t", "seguro"],
      ],
      content: "# privado",
      sig: "0".repeat(128),
    };
    assert.deepEqual(publishMockLabRevision(event, VIEWER), {
      accepted: true,
      message: "",
    });
    const [head] = queryMockLabBoards([
      { kinds: [KIND_LAB_BOARD_HEAD], "#d": [boardId] },
    ]);
    assert.equal(tagValue(head, "access_scope"), "private");
    assert.equal(tagValue(head, "owner"), VIEWER);
  });

  it("grants a managed agent the owner's private access but rejects another owner's agent", () => {
    resetMockLabBoards({
      effectiveOwnerPubkey: VIEWER,
      enabled: true,
      viewerPubkey: VIEWER_AGENT,
    });
    const [head] = queryMockLabBoards([
      {
        kinds: [KIND_LAB_BOARD_HEAD],
        "#d": [MOCK_LAB_OWN_PRIVATE_BOARD_ID],
      },
    ]);
    assert.ok(head);
    assert.equal(tagValue(head, "owner"), VIEWER);

    const agentEdit = revisionEvent(head, {
      id: "4".repeat(64),
      pubkey: VIEWER_AGENT,
    });
    assert.deepEqual(publishMockLabRevision(agentEdit, VIEWER_AGENT, VIEWER), {
      accepted: true,
      message: "",
    });

    const updated = queryMockLabBoards([
      {
        kinds: [KIND_LAB_BOARD_HEAD],
        "#d": [MOCK_LAB_OWN_PRIVATE_BOARD_ID],
      },
    ])[0];
    const foreignAgentEdit = revisionEvent(updated, {
      id: "3".repeat(64),
      pubkey: OTHER_AGENT,
    });
    assert.deepEqual(
      publishMockLabRevision(foreignAgentEdit, OTHER_AGENT, OTHER_OWNER),
      { accepted: false, message: "BOARD_NOT_FOUND" },
    );
  });
});

describe("Lab board archiving", () => {
  function moderationEvent(boardId, op, overrides = {}) {
    return {
      id: overrides.id ?? "7".repeat(64),
      pubkey: overrides.pubkey ?? VIEWER,
      created_at: Math.floor(Date.now() / 1_000),
      kind: KIND_LAB_BOARD_REVISION,
      // Exactly what `boardModerationTags` sends: no prev, no revision.
      tags: [
        ["d", boardId],
        ["op", op],
      ],
      content: "",
      sig: "0".repeat(128),
      ...overrides,
    };
  }

  function headOf(boardId) {
    const [head] = queryMockLabBoards([
      { kinds: [KIND_LAB_BOARD_HEAD], "#d": [boardId] },
    ]);
    return head;
  }

  it("archives without a prev or revision tag and flips the head status", () => {
    resetMockLabBoards({ enabled: true, viewerPubkey: VIEWER });
    const before = headOf(MOCK_LAB_COMMUNITY_BOARD_ID);
    assert.equal(tagValue(before, "status"), "active");

    assert.deepEqual(
      publishMockLabRevision(
        moderationEvent(MOCK_LAB_COMMUNITY_BOARD_ID, "archive"),
        VIEWER,
      ),
      { accepted: true, message: "" },
    );

    const after = headOf(MOCK_LAB_COMMUNITY_BOARD_ID);
    assert.equal(tagValue(after, "status"), "archived");
    // A status flip is not a content change: revision, head token, and
    // Markdown all survive untouched.
    assert.equal(tagValue(after, "revision"), tagValue(before, "revision"));
    assert.equal(tagValue(after, "head"), tagValue(before, "head"));
    assert.equal(after.content, before.content);
  });

  it("round-trips back to active on unarchive", () => {
    resetMockLabBoards({ enabled: true, viewerPubkey: VIEWER });
    publishMockLabRevision(
      moderationEvent(MOCK_LAB_COMMUNITY_BOARD_ID, "archive"),
      VIEWER,
    );
    assert.deepEqual(
      publishMockLabRevision(
        moderationEvent(MOCK_LAB_COMMUNITY_BOARD_ID, "unarchive", {
          id: "8".repeat(64),
        }),
        VIEWER,
      ),
      { accepted: true, message: "" },
    );
    assert.equal(
      tagValue(headOf(MOCK_LAB_COMMUNITY_BOARD_ID), "status"),
      "active",
    );
  });

  it("refuses an identity with no community role, board ownership regardless", () => {
    // The viewer owns this private board outright and can edit it — and still
    // may not archive it. Moderation authority lives in `relay_members`, not
    // in the board ACL. This is the case every managed agent lands in.
    resetMockLabBoards({
      enabled: true,
      moderatorPubkeys: [],
      viewerPubkey: VIEWER,
    });
    assert.deepEqual(
      publishMockLabRevision(
        moderationEvent(MOCK_LAB_OWN_PRIVATE_BOARD_ID, "archive"),
        VIEWER,
      ),
      { accepted: false, message: "restricted: moderator access required" },
    );
    assert.equal(
      tagValue(headOf(MOCK_LAB_OWN_PRIVATE_BOARD_ID), "status"),
      "active",
    );
  });

  it("refuses before disclosing whether an unknown board exists", () => {
    // Role is checked ahead of existence, so a non-moderator cannot probe for
    // board ids by reading the difference between the two errors.
    resetMockLabBoards({
      enabled: true,
      moderatorPubkeys: [],
      viewerPubkey: VIEWER,
    });
    assert.deepEqual(
      publishMockLabRevision(
        moderationEvent("99999999-9999-4999-8999-999999999999", "archive"),
        VIEWER,
      ),
      { accepted: false, message: "restricted: moderator access required" },
    );
  });

  it("rejects a transition the current status does not allow", () => {
    resetMockLabBoards({ enabled: true, viewerPubkey: VIEWER });
    publishMockLabRevision(
      moderationEvent(MOCK_LAB_COMMUNITY_BOARD_ID, "archive"),
      VIEWER,
    );
    const second = publishMockLabRevision(
      moderationEvent(MOCK_LAB_COMMUNITY_BOARD_ID, "archive", {
        id: "b".repeat(64),
      }),
      VIEWER,
    );
    assert.equal(second.accepted, false);
    assert.equal(
      second.message,
      "invalid: cannot archive a lab board with status 'archived' (expected 'active')",
    );

    const unarchiveActive = publishMockLabRevision(
      moderationEvent(MOCK_LAB_READONLY_BOARD_ID, "unarchive", {
        id: "c".repeat(64),
      }),
      VIEWER,
    );
    assert.equal(unarchiveActive.accepted, false);
    assert.equal(
      unarchiveActive.message,
      "invalid: cannot unarchive a lab board with status 'active' (expected 'archived')",
    );
  });

  it("reports a missing board to a moderator", () => {
    resetMockLabBoards({ enabled: true, viewerPubkey: VIEWER });
    const boardId = "88888888-8888-4888-8888-888888888888";
    assert.deepEqual(
      publishMockLabRevision(moderationEvent(boardId, "archive"), VIEWER),
      {
        accepted: false,
        message: `invalid: lab board ${boardId} does not exist`,
      },
    );
  });

  it("keeps an archived board readable so it can be found and restored", () => {
    // Archiving is not deletion: the head must still be queryable, otherwise
    // the "Show archived" toggle would have nothing to reveal.
    resetMockLabBoards({ enabled: true, viewerPubkey: VIEWER });
    publishMockLabRevision(
      moderationEvent(MOCK_LAB_COMMUNITY_BOARD_ID, "archive"),
      VIEWER,
    );
    const heads = queryMockLabBoards([{ kinds: [KIND_LAB_BOARD_HEAD] }]);
    assert.equal(
      heads.some((head) => tagValue(head, "d") === MOCK_LAB_COMMUNITY_BOARD_ID),
      true,
    );
  });
});
