import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  availableBoardTags,
  canEditBoard,
  canReadBoard,
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

  it("keeps community access open and private access owner-only", () => {
    assert.equal(
      canEditBoard({ access: "community", ownerPubkey: null }, null),
      true,
    );
    assert.equal(
      canEditBoard(
        { access: "private", ownerPubkey: VIEWER },
        VIEWER.toUpperCase(),
      ),
      true,
    );
    assert.equal(
      canEditBoard({ access: "private", ownerPubkey: "a".repeat(64) }, VIEWER),
      false,
    );
    assert.equal(
      canReadBoard({ access: "private", ownerPubkey: VIEWER }, VIEWER),
      true,
    );
    assert.equal(
      canReadBoard({ access: "private", ownerPubkey: "a".repeat(64) }, VIEWER),
      false,
    );
  });

  it("filters already-authorized boards by access scope and tag", () => {
    const boards = [
      {
        id: "community",
        access: "community",
        ownerPubkey: VIEWER,
        tags: ["produto"],
      },
      {
        id: "mine",
        access: "private",
        ownerPubkey: VIEWER,
        tags: ["prompts"],
      },
      {
        id: "theirs",
        access: "private",
        ownerPubkey: "a".repeat(64),
        tags: ["pesquisa"],
      },
    ];

    assert.deepEqual(availableBoardTags(boards, VIEWER), [
      "produto",
      "prompts",
    ]);
    assert.deepEqual(
      filterLabBoards({
        boards,
        currentPubkey: VIEWER,
        filter: "private",
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
      [],
    );
  });
});
