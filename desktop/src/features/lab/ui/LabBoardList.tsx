import { FlaskConical } from "lucide-react";

import type { LabBoardHead } from "@/features/lab/api";
import { Card } from "@/shared/ui/card";

function StatusPill({ status }: { status: string }) {
  if (status === "active") return null;
  return (
    <span className="shrink-0 rounded-full border border-border/60 bg-muted/40 px-2 pb-[3px] pt-[5px] text-2xs font-semibold uppercase leading-none tracking-[0.18em] text-muted-foreground">
      {status}
    </span>
  );
}

function formatUpdatedAt(seconds: number): string {
  return new Date(seconds * 1_000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function LabBoardEmptyState() {
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-16 text-center"
      data-testid="lab-empty-state"
    >
      <FlaskConical className="h-10 w-10 text-muted-foreground/40" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">No boards yet</p>
        <p className="text-sm text-muted-foreground">
          Boards are shared documents. Everyone in this community can read and
          edit them.
        </p>
      </div>
    </div>
  );
}

type LabBoardListProps = {
  boards: LabBoardHead[];
  onOpen: (boardId: string) => void;
};

export function LabBoardList({ boards, onOpen }: LabBoardListProps) {
  if (boards.length === 0) return <LabBoardEmptyState />;

  return (
    <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
      {boards.map((board) => (
        <Card
          className="group relative flex min-h-32 flex-col overflow-hidden border-border/60 bg-transparent shadow-none transition-colors duration-150 hover:bg-muted/20"
          key={board.boardId}
        >
          {/* Full-surface button with the content layered above it — keeps the
              whole card clickable without nesting interactive elements. */}
          <button
            aria-label={`Open ${board.title}`}
            className="absolute inset-0 z-0 cursor-pointer"
            data-testid={`lab-board-card-${board.boardId}`}
            onClick={() => onOpen(board.boardId)}
            type="button"
          />
          <div className="pointer-events-none relative z-10 flex min-h-0 flex-1 flex-col">
            <div className="flex min-w-0 items-center gap-2 px-4 pt-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40">
                <FlaskConical className="h-4.5 w-4.5 text-muted-foreground" />
              </span>
              <span className="min-w-0 truncate text-sm font-semibold text-foreground">
                {board.title}
              </span>
              <StatusPill status={board.status} />
            </div>
            <p className="line-clamp-2 min-h-10 px-4 py-2 text-sm text-muted-foreground">
              {board.summary || "No summary."}
            </p>
            <div className="mt-auto flex items-center gap-2 px-4 pb-3 text-xs text-muted-foreground">
              <span>Revision {board.revision}</span>
              <span aria-hidden="true">·</span>
              <span>{formatUpdatedAt(board.updatedAt)}</span>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
