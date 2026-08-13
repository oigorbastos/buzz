/**
 * Pure line-indent/dedent logic for `LabMarkdownEditor`, factored out so it
 * is unit-testable without a DOM `<textarea>`. See `LabMarkdownEditor.tsx`
 * for the DOM-facing half that applies the result via
 * `textarea.setRangeText()` — that's what keeps native browser Ctrl+Z intact
 * (replacing the whole controlled string via `setState` instead would
 * clobber the undo stack).
 *
 * Two-space indent unit, matching this repo's Markdown convention.
 */

const INDENT_UNIT = "  ";

export type IndentDirection = "indent" | "dedent";

export type IndentEdit = {
  /** Start offset (into the original text) of the affected block — the
   * start of the first line touched by the selection. */
  blockStart: number;
  /** End offset (into the original text) of the affected block — the end of
   * the last line touched by the selection (exclusive of its line break). */
  blockEnd: number;
  /** Replacement text for the `[blockStart, blockEnd)` range. */
  replacement: string;
  /** Where the selection should land afterward, as absolute offsets into
   * the NEW full text (i.e. after `replacement` has been substituted in). */
  selectionStart: number;
  selectionEnd: number;
};

function lineStartOffset(text: string, offset: number): number {
  const index = text.lastIndexOf("\n", offset - 1);
  return index === -1 ? 0 : index + 1;
}

function lineEndOffset(text: string, offset: number): number {
  const index = text.indexOf("\n", offset);
  return index === -1 ? text.length : index;
}

function isAtLineStart(text: string, offset: number): boolean {
  return offset === 0 || text[offset - 1] === "\n";
}

/**
 * Compute the multi-line indent/dedent edit for a Tab / Shift+Tab keypress
 * (or the equivalent toolbar button click).
 *
 * Operates on whole lines: every line touched by the selection (or just the
 * current line, when the selection is collapsed to a cursor) gets one indent
 * unit added or removed.
 *
 * - Indent always prefixes exactly `INDENT_UNIT`.
 * - Dedent removes up to one full unit of LEADING whitespace, or whatever is
 *   there if less than a full unit — so a partially-indented line (e.g. one
 *   leading space) still dedents to nothing instead of being skipped.
 *
 * Selection after the edit:
 * - A collapsed cursor stays collapsed, shifted by however much the single
 *   affected line grew/shrank before the cursor's column.
 * - A real (multi-line or not) selection re-selects the whole rewritten
 *   block, so the user can immediately press Tab/Shift+Tab again to keep
 *   adjusting the same lines — the common "select and re-indent" gesture.
 */
export function computeIndentEdit(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  direction: IndentDirection,
): IndentEdit {
  const collapsed = selectionStart === selectionEnd;
  const blockStart = lineStartOffset(text, selectionStart);

  // A selection whose end sits exactly at the start of a line (nothing of
  // that line is actually selected — e.g. selecting through the newline at
  // the end of the previous line) must not pull that next line into the
  // block purely because of where the selection boundary landed.
  const effectiveEnd =
    !collapsed && selectionEnd > blockStart && isAtLineStart(text, selectionEnd)
      ? selectionEnd - 1
      : selectionEnd;
  const blockEnd = lineEndOffset(text, Math.max(effectiveEnd, blockStart));

  const block = text.slice(blockStart, blockEnd);
  const lines = block.split("\n");

  let firstLineDelta = 0;
  const newLines = lines.map((line, index) => {
    if (direction === "indent") {
      if (index === 0) firstLineDelta = INDENT_UNIT.length;
      return INDENT_UNIT + line;
    }
    const leading = line.match(/^[ \t]*/)?.[0] ?? "";
    const removeCount = Math.min(INDENT_UNIT.length, leading.length);
    if (index === 0) firstLineDelta = -removeCount;
    return line.slice(removeCount);
  });
  const replacement = newLines.join("\n");

  if (collapsed) {
    const originalOffsetInLine = selectionStart - blockStart;
    const newCursor =
      blockStart + Math.max(0, originalOffsetInLine + firstLineDelta);
    return {
      blockStart,
      blockEnd,
      replacement,
      selectionStart: newCursor,
      selectionEnd: newCursor,
    };
  }

  return {
    blockStart,
    blockEnd,
    replacement,
    selectionStart: blockStart,
    selectionEnd: blockStart + replacement.length,
  };
}
