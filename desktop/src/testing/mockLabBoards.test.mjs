import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  publishMockLabRevision,
  queryMockLabBoards,
  resetMockLabBoards,
} from "./mockLabBoards.ts";
import {
  KIND_LAB_BOARD_HEAD,
  KIND_LAB_BOARD_REVISION,
} from "../shared/constants/kinds.ts";

const VIEWER = "deadbeef".repeat(8);

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
  it("seeds community, own-personal, and readable other-personal boards", () => {
    resetMockLabBoards({ enabled: true, viewerPubkey: VIEWER });
    const heads = queryMockLabBoards([{ kinds: [KIND_LAB_BOARD_HEAD] }]);
    assert.equal(heads.length, 3);
    assert.deepEqual(
      heads.map((head) => tagValue(head, "edit_policy")).sort(),
      ["community", "owner_agents", "owner_agents"],
    );
  });

  it("accepts owner edits and atomically replaces tags", () => {
    resetMockLabBoards({ enabled: true, viewerPubkey: VIEWER });
    const [head] = queryMockLabBoards([
      {
        kinds: [KIND_LAB_BOARD_HEAD],
        "#d": ["22222222-2222-4222-8222-222222222222"],
      },
    ]);
    const result = publishMockLabRevision(revisionEvent(head), VIEWER);
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
  });

  it("preserves tags when a legacy agent updates only Markdown", () => {
    resetMockLabBoards({ enabled: true, viewerPubkey: VIEWER });
    const [head] = queryMockLabBoards([
      {
        kinds: [KIND_LAB_BOARD_HEAD],
        "#d": ["22222222-2222-4222-8222-222222222222"],
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

  it("rejects direct writes to another person's personal board", () => {
    resetMockLabBoards({ enabled: true, viewerPubkey: VIEWER });
    const [head] = queryMockLabBoards([
      {
        kinds: [KIND_LAB_BOARD_HEAD],
        "#d": ["33333333-3333-4333-8333-333333333333"],
      },
    ]);
    assert.deepEqual(publishMockLabRevision(revisionEvent(head), VIEWER), {
      accepted: false,
      message: "restricted: board is owner-editable",
    });
  });
});
