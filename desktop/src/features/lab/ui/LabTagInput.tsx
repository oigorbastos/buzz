import { Plus, X } from "lucide-react";
import * as React from "react";

import { MAX_BOARD_TAGS, normalizeBoardTags } from "@/features/lab/model";
import { cn } from "@/shared/lib/cn";
import { Input } from "@/shared/ui/input";

type LabTagInputProps = {
  disabled?: boolean;
  id: string;
  onChange: (tags: string[]) => void;
  tags: string[];
};

export function LabTagInput({
  disabled = false,
  id,
  onChange,
  tags,
}: LabTagInputProps) {
  const [draft, setDraft] = React.useState("");

  function commitDraft() {
    if (!draft.trim()) return;
    onChange(normalizeBoardTags([...tags, ...draft.split(",")]));
    setDraft("");
  }

  return (
    <div className="space-y-2">
      <div
        className={cn(
          "flex min-h-11 flex-wrap items-center gap-1.5 rounded-xl border border-input bg-muted/40 px-2 py-1.5 transition-colors focus-within:border-muted-foreground/50",
          disabled && "opacity-60",
        )}
      >
        {tags.map((tag) => (
          <span
            className="inline-flex h-7 items-center gap-1 rounded-full border border-primary/20 bg-primary/8 px-2.5 text-xs font-medium text-foreground"
            data-testid={`lab-tag-input-${tag}`}
            key={tag}
          >
            #{tag}
            <button
              aria-label={`Remove tag ${tag}`}
              className="rounded-full text-muted-foreground transition-colors hover:text-foreground"
              disabled={disabled}
              onClick={() =>
                onChange(tags.filter((candidate) => candidate !== tag))
              }
              type="button"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        {tags.length < MAX_BOARD_TAGS ? (
          <div className="flex min-w-28 flex-1 items-center gap-1 px-1">
            <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <Input
              className="h-7 min-w-24 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
              data-testid="lab-tag-input"
              disabled={disabled}
              id={id}
              onBlur={commitDraft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === ",") {
                  event.preventDefault();
                  commitDraft();
                } else if (
                  event.key === "Backspace" &&
                  !draft &&
                  tags.length > 0
                ) {
                  onChange(tags.slice(0, -1));
                }
              }}
              placeholder={
                tags.length === 0 ? "Type a tag and press Enter" : "Add tag"
              }
              value={draft}
            />
          </div>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        Up to {MAX_BOARD_TAGS} tags. Press Enter or comma to add.
      </p>
    </div>
  );
}
