import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { boardReference } from "../api.ts";
import { isLabLink, parseLabLink } from "./labLink.ts";

const BOARD = "0f2b8a1c-1111-4222-8333-444455556666";

describe("parseLabLink", () => {
  it("round-trips against boardReference() with no revision", () => {
    const link = boardReference(BOARD);
    const parsed = parseLabLink(link);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.value, { boardId: BOARD, revision: null });
  });

  it("round-trips against boardReference() with a revision", () => {
    const link = boardReference(BOARD, 7);
    const parsed = parseLabLink(link);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.value, { boardId: BOARD, revision: 7 });
  });

  it("round-trips revision 0 as a real revision, not as absent", () => {
    const link = boardReference(BOARD, 0);
    const parsed = parseLabLink(link);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.revision, 0);
  });

  it("lowercases an uppercase board id", () => {
    const parsed = parseLabLink(`buzz://lab?board=${BOARD.toUpperCase()}`);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.boardId, BOARD);
  });

  it("rejects the wrong scheme", () => {
    assert.equal(parseLabLink(`https://lab?board=${BOARD}`).ok, false);
  });

  it("rejects the wrong host", () => {
    assert.equal(parseLabLink(`buzz://message?board=${BOARD}`).ok, false);
  });

  it("rejects a malformed board id", () => {
    assert.equal(parseLabLink("buzz://lab?board=not-a-uuid").ok, false);
  });

  it("rejects a missing board id", () => {
    assert.equal(parseLabLink("buzz://lab?revision=1").ok, false);
  });

  it("rejects a non-numeric revision", () => {
    assert.equal(
      parseLabLink(`buzz://lab?board=${BOARD}&revision=abc`).ok,
      false,
    );
  });

  it("rejects a negative revision", () => {
    assert.equal(
      parseLabLink(`buzz://lab?board=${BOARD}&revision=-1`).ok,
      false,
    );
  });

  it("rejects unknown query params", () => {
    assert.equal(
      parseLabLink(`buzz://lab?board=${BOARD}&extra=ignored`).ok,
      false,
    );
  });

  it("rejects a duplicate param", () => {
    assert.equal(
      parseLabLink(`buzz://lab?board=${BOARD}&board=${BOARD}`).ok,
      false,
    );
  });

  it("rejects a path segment", () => {
    assert.equal(parseLabLink(`buzz://lab/extra?board=${BOARD}`).ok, false);
  });

  it("rejects an invalid URL", () => {
    assert.equal(parseLabLink("not a url").ok, false);
  });
});

describe("isLabLink", () => {
  it("recognizes buzz://lab hrefs", () => {
    assert.equal(isLabLink(`buzz://lab?board=${BOARD}`), true);
    assert.equal(isLabLink("buzz://lab"), true);
  });

  it("rejects everything else", () => {
    assert.equal(isLabLink(`buzz://message?board=${BOARD}`), false);
    assert.equal(isLabLink("https://example.com"), false);
    assert.equal(isLabLink(null), false);
    assert.equal(isLabLink(undefined), false);
  });
});
