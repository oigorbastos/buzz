import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  availableBoardTags,
  canEditBoard,
  filterLabBoards,
  normalizeBoardTags,
} from "./model.ts";

const VIEWER = "deadbeef".repeat(8);

describe("Lab board model", () => {
  it("normalizes, deduplicates, and keeps Portuguese tags", () => {
    assert.deepEqual(
      normalizeBoardTags([" Operação ", "operação", "Road Map", "#Produto!"]),
      ["operação", "road-map", "produto"],
    );
  });

  it("keeps community writes open and personal writes owner-only", () => {
    assert.equal(
      canEditBoard({ editPolicy: "community", ownerPubkey: null }, null),
      true,
    );
    assert.equal(
      canEditBoard(
        { editPolicy: "owner_agents", ownerPubkey: VIEWER },
        VIEWER.toUpperCase(),
      ),
      true,
    );
    assert.equal(
      canEditBoard(
        { editPolicy: "owner_agents", ownerPubkey: "a".repeat(64) },
        VIEWER,
      ),
      false,
    );
  });

  it("filters by editing mode and tag without hiding readable boards", () => {
    const boards = [
      {
        id: "community",
        editPolicy: "community",
        ownerPubkey: VIEWER,
        tags: ["produto"],
      },
      {
        id: "mine",
        editPolicy: "owner_agents",
        ownerPubkey: VIEWER,
        tags: ["prompts"],
      },
      {
        id: "theirs",
        editPolicy: "owner_agents",
        ownerPubkey: "a".repeat(64),
        tags: ["pesquisa"],
      },
    ];

    assert.deepEqual(availableBoardTags(boards), [
      "pesquisa",
      "produto",
      "prompts",
    ]);
    assert.deepEqual(
      filterLabBoards({
        boards,
        currentPubkey: VIEWER,
        filter: "mine",
        tag: null,
      }).map((board) => board.id),
      ["mine"],
    );
    assert.deepEqual(
      filterLabBoards({
        boards,
        currentPubkey: VIEWER,
        filter: "all",
        tag: "pesquisa",
      }).map((board) => board.id),
      ["theirs"],
    );
  });
});
