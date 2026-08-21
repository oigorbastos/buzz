import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fromMarkdown } from "mdast-util-from-markdown";

import { parseLabLink } from "./labLink.ts";
import {
  getLabBoardSuggestions,
  labBoardAutocompleteEdit,
  labBoardReferenceMarkdown,
} from "./useLabLinks.ts";
import { detectPrefixQuery } from "../../../shared/lib/detectPrefixQuery.ts";

const BOARD = "0f2b8a1c-1111-4222-8333-444455556666";
const READER = "a".repeat(64);
const OWNER = "b".repeat(64);

function board(overrides = {}) {
  return {
    boardId: BOARD,
    title: "Adaimon - weekly notes",
    access: "community",
    ownerPubkey: null,
    ...overrides,
  };
}

function applyEdit(value, edit) {
  return (
    value.slice(0, edit.replaceFromOffset) +
    edit.insertText +
    value.slice(edit.replaceToOffset)
  );
}

describe("Lab board composer references", () => {
  it("replaces the complete [[ multi-word query without an orphan bracket", () => {
    const value = "See [[Adaimon - week";
    const match = detectPrefixQuery("[[", value, value.length, [
      "adaimon - weekly notes",
    ]);
    assert.ok(match);

    const edit = labBoardAutocompleteEdit(
      { boardId: BOARD, title: "Adaimon - weekly notes" },
      match.startIndex,
      value.length,
    );
    const result = applyEdit(value, edit);
    assert.equal(
      result,
      `See [Adaimon - weekly notes](buzz://lab?board=${BOARD}) `,
    );

    const tree = fromMarkdown(result);
    const link = tree.children[0].children.find((node) => node.type === "link");
    assert.ok(link);
    assert.deepEqual(parseLabLink(link.url), {
      ok: true,
      value: { boardId: BOARD, revision: null },
    });
  });

  it("escapes [, ], ), (, and backslash without changing the visible title", () => {
    const title = String.raw`Plan [Q3] (draft) \\ review`;
    const markdown = labBoardReferenceMarkdown({ boardId: BOARD, title });
    const tree = fromMarkdown(markdown);
    const link = tree.children[0].children[0];

    assert.equal(link.type, "link");
    assert.equal(link.url, `buzz://lab?board=${BOARD}`);
    assert.equal(link.children[0].value, title);
    assert.equal(parseLabLink(link.url).ok, true);
  });

  it("offers only boards readable by the current identity or its owner", () => {
    const suggestions = getLabBoardSuggestions(
      [
        board({ boardId: "community", title: "Community plan" }),
        board({
          boardId: "other-private",
          title: "Private secret",
          access: "private",
          ownerPubkey: "c".repeat(64),
        }),
        board({
          boardId: "owner-private",
          title: "Owner plan",
          access: "private",
          ownerPubkey: OWNER,
        }),
      ],
      "",
      READER,
      OWNER,
    );

    assert.deepEqual(
      suggestions.map(({ boardId }) => boardId),
      ["community", "owner-private"],
    );
    assert.equal(
      suggestions.some(({ title }) => title === "Private secret"),
      false,
    );
  });
});
