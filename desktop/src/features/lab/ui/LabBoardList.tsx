import { FlaskConical, UserRound, Users } from "lucide-react";

import type { LabBoardHead } from "@/features/lab/api";
import { cn } from "@/shared/lib/cn";
import { Badge } from "@/shared/ui/badge";
import { Card } from "@/shared/ui/card";

function StatusPill({ status }: { status: string }) {
  if (status === "active") return null;
  return <Badge variant="outline">{status}</Badge>;
}

function EditPolicyPill({ board }: { board: LabBoardHead }) {
  if (board.editPolicy === "owner_agents") {
    return (
      <Badge className="gap-1 normal-case tracking-normal" variant="info">
        <UserRound className="h-3 w-3" />
        Personal editing
      </Badge>
    );
  }
  return (
    <Badge className="gap-1 normal-case tracking-normal" variant="secondary">
      <Users className="h-3 w-3" />
      Community
    </Badge>
  );
}

function formatUpdatedAt(seconds: number): string {
  return new Date(seconds * 1_000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function LabBoardEmptyState({
  filtered = false,
}: {
  filtered?: boolean;
}) {
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-16 text-center"
      data-testid={filtered ? "lab-filter-empty-state" : "lab-empty-state"}
    >
      <FlaskConical className="h-10 w-10 text-muted-foreground/40" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">
          {filtered ? "No boards match these filters" : "No boards yet"}
        </p>
        <p className="text-sm text-muted-foreground">
          {filtered
            ? "Try another editing mode or tag."
            : "Create a community board or one with personal editing."}
        </p>
      </div>
    </div>
  );
}

type LabBoardListProps = {
  activeTag: string | null;
  boards: LabBoardHead[];
  isFiltered: boolean;
  onOpen: (boardId: string) => void;
  onTagSelect: (tag: string) => void;
};

export function LabBoardList({
  activeTag,
  boards,
  isFiltered,
  onOpen,
  onTagSelect,
}: LabBoardListProps) {
  if (boards.length === 0) return <LabBoardEmptyState filtered={isFiltered} />;

  return (
    <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
      {boards.map((board) => (
        <Card
          className="group relative flex min-h-44 flex-col overflow-hidden border-border/60 bg-transparent shadow-none transition-colors duration-150 hover:bg-muted/20"
          key={board.boardId}
        >
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
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
                {board.title}
              </span>
              <StatusPill status={board.status} />
            </div>

            <div className="flex flex-wrap items-center gap-1.5 px-4 pt-2">
              <EditPolicyPill board={board} />
              {board.tags.slice(0, 3).map((tag) => (
                <button
                  className={cn(
                    "pointer-events-auto relative z-20 rounded-full border px-2 py-0.5 text-xs transition-colors",
                    activeTag === tag
                      ? "border-primary/40 bg-primary/12 text-foreground"
                      : "border-border/60 bg-muted/30 text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                  )}
                  data-testid={`lab-card-tag-${tag}`}
                  key={tag}
                  onClick={() => onTagSelect(tag)}
                  type="button"
                >
                  #{tag}
                </button>
              ))}
              {board.tags.length > 3 ? (
                <span className="text-xs text-muted-foreground">
                  +{board.tags.length - 3}
                </span>
              ) : null}
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
