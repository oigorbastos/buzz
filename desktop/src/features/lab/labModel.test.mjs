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

  it("separates community reads from owner-family writes for read-only boards", () => {
    assert.equal(
      canEditBoard({ access: "community", ownerPubkey: null }, null),
      true,
    );
    assert.equal(
      canReadBoard(
        { access: "community_readonly", ownerPubkey: "a".repeat(64) },
        VIEWER,
      ),
      true,
    );
    assert.equal(
      canEditBoard(
        { access: "community_readonly", ownerPubkey: VIEWER },
        VIEWER.toUpperCase(),
      ),
      true,
    );
    assert.equal(
      canEditBoard(
        { access: "community_readonly", ownerPubkey: "a".repeat(64) },
        VIEWER,
      ),
      false,
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
        id: "published",
        access: "community_readonly",
        ownerPubkey: "a".repeat(64),
        tags: ["pesquisa", "referência"],
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
      "pesquisa",
      "produto",
      "prompts",
      "referência",
    ]);
    assert.deepEqual(
      filterLabBoards({
        boards,
        currentPubkey: VIEWER,
        filter: "community_readonly",
        tag: null,
      }).map((board) => board.id),
      ["published"],
    );
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
      ["published"],
    );
  });
});

describe("Lab board archive visibility", () => {
  const boards = [
    {
      id: "live",
      access: "community",
      ownerPubkey: null,
      status: "active",
      tags: ["roadmap"],
    },
    {
      id: "smoke-test",
      access: "community",
      ownerPubkey: null,
      status: "archived",
      tags: ["roadmap"],
    },
    {
      id: "frozen",
      access: "community",
      ownerPubkey: null,
      status: "frozen",
      tags: [],
    },
    // A V1 head with no status tag at all must not vanish from the list.
    { id: "legacy", access: "community", ownerPubkey: null, tags: [] },
  ];

  function ids(input) {
    return filterLabBoards({
      boards,
      currentPubkey: VIEWER,
      filter: "all",
      tag: null,
      ...input,
    }).map((board) => board.id);
  }

  it("hides archived boards by default and keeps every other status", () => {
    assert.deepEqual(ids({}), ["live", "frozen", "legacy"]);
    assert.deepEqual(ids({ includeArchived: false }), [
      "live",
      "frozen",
      "legacy",
    ]);
  });

  it("reveals archived boards when the toggle is on", () => {
    assert.deepEqual(ids({ includeArchived: true }), [
      "live",
      "smoke-test",
      "frozen",
      "legacy",
    ]);
  });

  it("still applies access and tag filters to revealed archived boards", () => {
    // Archiving must not become a way to escape the ACL or the tag filter.
    assert.deepEqual(ids({ includeArchived: true, tag: "roadmap" }), [
      "live",
      "smoke-test",
    ]);
    assert.deepEqual(ids({ includeArchived: true, filter: "private" }), []);
  });
});
