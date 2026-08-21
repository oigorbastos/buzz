import { PanelsTopLeft } from "lucide-react";
import * as React from "react";

import type { LabBoardSuggestion } from "@/features/lab/lib/useLabLinks";
import { cn } from "@/shared/lib/cn";
import {
  POPOVER_CUSTOM_ENTER_MOTION_CLASS,
  POPOVER_SHADOW_STYLE,
  POPOVER_SURFACE_CLASS,
} from "@/shared/ui/popoverSurface";

type LabBoardAutocompleteProps = {
  suggestions: LabBoardSuggestion[];
  selectedIndex: number;
  onSelect: (suggestion: LabBoardSuggestion) => void;
  position?: "above" | "below";
};

export const LabBoardAutocomplete = React.memo(function LabBoardAutocomplete({
  suggestions,
  selectedIndex,
  onSelect,
  position = "above",
}: LabBoardAutocompleteProps) {
  const listRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const activeItem = listRef.current?.children[selectedIndex] as
      | HTMLElement
      | undefined;
    activeItem?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (suggestions.length === 0) return null;

  return (
    <div
      className={cn(
        "absolute left-0 right-0 z-50 px-3 sm:px-4",
        position === "below" ? "top-full mt-1" : "bottom-full mb-1",
      )}
    >
      <div
        className={cn(
          "max-h-48 overflow-y-auto rounded-xl p-1",
          POPOVER_CUSTOM_ENTER_MOTION_CLASS,
          position === "below"
            ? "origin-top slide-in-from-top-1"
            : "origin-bottom slide-in-from-bottom-1",
          POPOVER_SURFACE_CLASS,
        )}
        ref={listRef}
        style={POPOVER_SHADOW_STYLE}
      >
        {suggestions.map((suggestion, index) => (
          <button
            className={cn(
              "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 text-left text-sm",
              index === selectedIndex
                ? "bg-accent text-accent-foreground"
                : "text-popover-foreground hover:bg-accent/50",
            )}
            key={suggestion.boardId}
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect(suggestion);
            }}
            tabIndex={-1}
            type="button"
          >
            <PanelsTopLeft className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span
              className="min-w-0 truncate font-medium"
              title={suggestion.title}
            >
              {suggestion.title}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
});
