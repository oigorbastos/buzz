import { Indent, Outdent } from "lucide-react";
import * as React from "react";

import {
  computeIndentEdit,
  type IndentDirection,
} from "@/features/lab/ui/labMarkdownEditorIndent";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Markdown } from "@/shared/ui/markdown";
import { Textarea } from "@/shared/ui/textarea";

type LabMarkdownEditorProps = {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  "aria-label"?: string;
  className?: string;
  "data-testid"?: string;
  id?: string;
  placeholder?: string;
};

/**
 * Markdown editor for Lab Boards: a plain `<textarea>` with Tab/Shift+Tab
 * line-indent support and a live side-by-side (or stacked, on narrow
 * screens) preview via the same `<Markdown>` renderer used for the read-only
 * board view — so what you see while editing is exactly what everyone else
 * will see.
 *
 * Indent policy (two-space unit): Tab with no selection indents the current
 * line unconditionally — including plain paragraph text, not just inside a
 * list — UNLESS the whole document is empty, in which case Tab is left alone
 * to do its normal job (move focus to the next control); an empty editor has
 * nothing to indent and this is the only way to Tab out of it. Tab/Shift+Tab
 * with a selection indents/dedents every touched line. Alt+Tab always
 * indents/dedents regardless of the empty-document exception — wired as a
 * best-effort alternative since window managers usually intercept plain
 * Alt+Tab before it reaches the browser; the Indent/Dedent buttons are the
 * reliable non-keyboard path.
 */
export function LabMarkdownEditor({
  value,
  onChange,
  disabled = false,
  "aria-label": ariaLabel,
  className,
  "data-testid": dataTestId,
  id,
  placeholder,
}: LabMarkdownEditorProps) {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  const applyIndent = React.useCallback(
    (direction: IndentDirection) => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const edit = computeIndentEdit(
        textarea.value,
        textarea.selectionStart,
        textarea.selectionEnd,
        direction,
      );
      // `setRangeText` mutates the DOM directly and integrates with the
      // browser's native undo stack, unlike replacing the whole controlled
      // `value` via setState — which would clobber Ctrl+Z right after a Tab.
      // The mode argument barely matters here since selection is set
      // explicitly on the next line; "preserve" keeps intermediate state
      // sane if that line were ever removed.
      textarea.setRangeText(
        edit.replacement,
        edit.blockStart,
        edit.blockEnd,
        "preserve",
      );
      textarea.setSelectionRange(edit.selectionStart, edit.selectionEnd);
      // Read the DOM back into React's controlled state so the two stay in
      // sync — this does not touch the undo stack, only `setRangeText` did.
      onChange(textarea.value);
    },
    [onChange],
  );

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Tab") return;
    const direction: IndentDirection = event.shiftKey ? "dedent" : "indent";

    if (event.altKey) {
      // Best-effort: most window managers intercept Alt+Tab before it ever
      // reaches the browser, so this branch may simply never fire — the
      // Indent/Dedent buttons below are the dependable alternative.
      event.preventDefault();
      applyIndent(direction);
      return;
    }

    // An empty editor has no line worth indenting; let plain Tab do its
    // normal job (move focus to the next control) instead.
    if (event.currentTarget.value.length === 0) return;

    event.preventDefault();
    applyIndent(direction);
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center gap-1.5">
        <Button
          aria-label="Indent"
          data-testid={dataTestId ? `${dataTestId}-indent` : undefined}
          disabled={disabled}
          onClick={() => applyIndent("indent")}
          // Keep focus (and selection) on the textarea instead of moving it
          // to the button — `applyIndent` reads selectionStart/End off it.
          onMouseDown={(event) => event.preventDefault()}
          size="sm"
          type="button"
          variant="outline"
        >
          <Indent className="h-4 w-4" />
          Indent
        </Button>
        <Button
          aria-label="Dedent"
          data-testid={dataTestId ? `${dataTestId}-dedent` : undefined}
          disabled={disabled}
          onClick={() => applyIndent("dedent")}
          onMouseDown={(event) => event.preventDefault()}
          size="sm"
          type="button"
          variant="outline"
        >
          <Outdent className="h-4 w-4" />
          Dedent
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Textarea
          aria-label={ariaLabel}
          className="min-h-64 resize-y font-mono text-sm"
          data-testid={dataTestId}
          disabled={disabled}
          id={id}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          ref={textareaRef}
          value={value}
        />
        <div
          className="min-h-64 overflow-auto rounded-lg border border-input/40 bg-muted/20 p-3"
          data-testid={dataTestId ? `${dataTestId}-preview` : undefined}
        >
          {value ? (
            <Markdown content={value} />
          ) : (
            <p className="text-sm text-muted-foreground">
              Nothing to preview yet.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
