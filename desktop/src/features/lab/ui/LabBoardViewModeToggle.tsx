import { LayoutGrid, List } from "lucide-react";

import type { LabBoardViewMode } from "@/features/lab/viewPreference";
import { Button } from "@/shared/ui/button";

export function LabBoardViewModeToggle({
  onViewModeChange,
  viewMode,
}: {
  onViewModeChange: (viewMode: LabBoardViewMode) => void;
  viewMode: LabBoardViewMode;
}) {
  return (
    <fieldset className="flex items-center rounded-lg bg-muted/30 p-0.5">
      <legend className="sr-only">Board layout</legend>
      <Button
        aria-label="Grid layout"
        aria-pressed={viewMode === "grid"}
        className="h-7 w-7 px-0"
        data-testid="lab-view-grid"
        onClick={() => onViewModeChange("grid")}
        size="xs"
        type="button"
        variant={viewMode === "grid" ? "secondary" : "ghost"}
      >
        <LayoutGrid className="h-3.5 w-3.5" />
      </Button>
      <Button
        aria-label="List layout"
        aria-pressed={viewMode === "list"}
        className="h-7 w-7 px-0"
        data-testid="lab-view-list"
        onClick={() => onViewModeChange("list")}
        size="xs"
        type="button"
        variant={viewMode === "list" ? "secondary" : "ghost"}
      >
        <List className="h-3.5 w-3.5" />
      </Button>
    </fieldset>
  );
}
