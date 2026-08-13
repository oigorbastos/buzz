import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeIndentEdit } from "./labMarkdownEditorIndent.ts";

/** Apply an IndentEdit to `text`, returning the new full text + selection. */
function apply(text, edit) {
  const newText =
    text.slice(0, edit.blockStart) +
    edit.replacement +
    text.slice(edit.blockEnd);
  return { text: newText, start: edit.selectionStart, end: edit.selectionEnd };
}

describe("computeIndentEdit: collapsed cursor, single line", () => {
  it("indents a plain-text line and shifts the cursor by the indent width", () => {
    const text = "hello world";
    const cursor = 5; // "hello| world"
    const edit = computeIndentEdit(text, cursor, cursor, "indent");
    const result = apply(text, edit);
    assert.equal(result.text, "  hello world");
    assert.equal(result.start, 7);
    assert.equal(result.end, 7);
  });

  it("dedents a fully-indented line and shifts the cursor back", () => {
    const text = "  hello world";
    const cursor = 7; // "  hello| world"
    const edit = computeIndentEdit(text, cursor, cursor, "dedent");
    const result = apply(text, edit);
    assert.equal(result.text, "hello world");
    assert.equal(result.start, 5);
    assert.equal(result.end, 5);
  });

  it("dedents a partially-indented line (less than one unit) down to zero, not negative", () => {
    const text = " hello"; // one leading space only
    const cursor = 3;
    const edit = computeIndentEdit(text, cursor, cursor, "dedent");
    const result = apply(text, edit);
    assert.equal(result.text, "hello");
    // Cursor never goes left of the line start.
    assert.equal(result.start, 2);
  });

  it("dedenting a line with no leading whitespace is a no-op", () => {
    const text = "hello";
    const edit = computeIndentEdit(text, 2, 2, "dedent");
    const result = apply(text, edit);
    assert.equal(result.text, "hello");
    assert.equal(result.start, 2);
  });

  it("indents an empty document", () => {
    const edit = computeIndentEdit("", 0, 0, "indent");
    const result = apply("", edit);
    assert.equal(result.text, "  ");
    assert.equal(result.start, 2);
  });

  it("indent always prefixes the line start, regardless of cursor column", () => {
    // Cursor at the very end of the line.
    const text = "hello";
    const edit = computeIndentEdit(text, 5, 5, "indent");
    const result = apply(text, edit);
    assert.equal(result.text, "  hello");
    assert.equal(result.start, 7);
  });
});

describe("computeIndentEdit: cursor on a middle line of a multi-line document", () => {
  it("only touches the current line, not its neighbors", () => {
    const text = "one\ntwo\nthree";
    const cursor = text.indexOf("two") + 1; // inside "two"
    const edit = computeIndentEdit(text, cursor, cursor, "indent");
    const result = apply(text, edit);
    assert.equal(result.text, "one\n  two\nthree");
  });
});

describe("computeIndentEdit: real selection spanning multiple lines", () => {
  it("indents every selected line and selects the whole rewritten block", () => {
    const text = "one\ntwo\nthree";
    const start = 0;
    const end = text.length; // select everything
    const edit = computeIndentEdit(text, start, end, "indent");
    const result = apply(text, edit);
    assert.equal(result.text, "  one\n  two\n  three");
    assert.equal(result.start, 0);
    assert.equal(result.end, result.text.length);
  });

  it("dedents every selected line, each by up to one unit", () => {
    const text = "  one\n    two\n three"; // 2, 4, 1 leading spaces
    const edit = computeIndentEdit(text, 0, text.length, "dedent");
    const result = apply(text, edit);
    assert.equal(result.text, "one\n  two\nthree");
  });

  it("a selection ending exactly at the start of the next line does not pull that line in", () => {
    // Select "one\n" (through the newline, landing at column 0 of "two").
    const text = "one\ntwo";
    const end = text.indexOf("two"); // 4, right after the \n
    const edit = computeIndentEdit(text, 0, end, "indent");
    const result = apply(text, edit);
    assert.equal(result.text, "  one\ntwo");
  });

  it("a selection confined to part of one line still treats that whole line as the block", () => {
    const text = "hello world";
    // Select just "world".
    const edit = computeIndentEdit(text, 6, 11, "indent");
    const result = apply(text, edit);
    assert.equal(result.text, "  hello world");
  });
});

describe("computeIndentEdit: round-trip", () => {
  it("indent then dedent returns the original text", () => {
    const text = "one\ntwo\nthree";
    const indented = computeIndentEdit(text, 0, text.length, "indent");
    const afterIndent = apply(text, indented);
    const dedented = computeIndentEdit(
      afterIndent.text,
      afterIndent.start,
      afterIndent.end,
      "dedent",
    );
    const afterDedent = apply(afterIndent.text, dedented);
    assert.equal(afterDedent.text, text);
  });
});
