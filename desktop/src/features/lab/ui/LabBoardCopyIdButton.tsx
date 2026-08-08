import { Copy } from "lucide-react";
import type * as React from "react";

import { copyTextToClipboard } from "@/shared/lib/clipboard";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";

type LabBoardCopyIdButtonProps = {
  boardId: string;
  boardTitle: string;
  className?: string;
  compact?: boolean;
};

export function LabBoardCopyIdButton({
  boardId,
  boardTitle,
  className,
  compact = false,
}: LabBoardCopyIdButtonProps) {
  function handleClick(event: React.MouseEvent<HTMLButtonElement>) {
    // Cards are themselves clickable. Copying an ID must never navigate into
    // the board or trigger any other action behind this button.
    event.preventDefault();
    event.stopPropagation();
    copyTextToClipboard(boardId, "Board ID copied");
  }

  return (
    <Button
      aria-label={`Copy board ID for ${boardTitle}`}
      className={cn(compact && "pointer-events-auto relative z-20", className)}
      data-testid={`lab-board-copy-id-${boardId}`}
      onClick={handleClick}
      size={compact ? "icon-xs" : "sm"}
      title="Copy board ID"
      type="button"
      variant={compact ? "ghost" : "outline"}
    >
      <Copy />
      {compact ? null : "Copy ID"}
    </Button>
  );
}
