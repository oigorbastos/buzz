import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MOCK_LAB_COMMUNITY_BOARD_ID,
  MOCK_LAB_OTHER_PRIVATE_BOARD_ID,
  MOCK_LAB_OWN_PRIVATE_BOARD_ID,
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
  it("seeds three boards but exposes only community and the viewer's private board", () => {
    resetMockLabBoards({ enabled: true, viewerPubkey: VIEWER });
    const heads = queryMockLabBoards([{ kinds: [KIND_LAB_BOARD_HEAD] }]);
    assert.equal(heads.length, 2);
    assert.deepEqual(
      heads.map((head) => tagValue(head, "access_scope")).sort(),
      ["community", "private"],
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
    assert.deepEqual(queryMockLabBoards([{ authors: [OTHER_OWNER] }]), []);

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
              ["d", "44444444-4444-4444-8444-444444444444"],
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
