import { Eye, FlaskConical, LockKeyhole, Users } from "lucide-react";

import type { LabBoardHead } from "@/features/lab/api";
import { LabBoardCopyIdButton } from "@/features/lab/ui/LabBoardCopyIdButton";
import type { LabBoardViewMode } from "@/features/lab/viewPreference";
import { cn } from "@/shared/lib/cn";
import { Badge } from "@/shared/ui/badge";
import { Card } from "@/shared/ui/card";

function StatusPill({ status }: { status: string }) {
  if (status === "active") return null;
  return <Badge variant="outline">{status}</Badge>;
}

function AccessPill({ board }: { board: LabBoardHead }) {
  if (board.access === "private") {
    return (
      <Badge className="gap-1 normal-case tracking-normal" variant="info">
        <LockKeyhole className="h-3 w-3" />
        Private
      </Badge>
    );
  }
  if (board.access === "community_readonly") {
    return (
      <Badge className="gap-1 normal-case tracking-normal" variant="outline">
        <Eye className="h-3 w-3" />
        Read-only
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

function BoardTagPills({
  activeTag,
  board,
  limit,
  onTagSelect,
}: {
  activeTag: string | null;
  board: LabBoardHead;
  limit: number;
  onTagSelect: (tag: string) => void;
}) {
  return (
    <>
      {board.tags.slice(0, limit).map((tag) => (
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
      {board.tags.length > limit ? (
        <span className="text-xs text-muted-foreground">
          +{board.tags.length - limit}
        </span>
      ) : null}
    </>
  );
}

type BoardItemProps = {
  activeTag: string | null;
  board: LabBoardHead;
  onOpen: (boardId: string) => void;
  onTagSelect: (tag: string) => void;
};

function LabBoardGridCard({
  activeTag,
  board,
  onOpen,
  onTagSelect,
}: BoardItemProps) {
  return (
    <Card className="group relative flex min-h-44 flex-col overflow-hidden border-border/60 bg-transparent shadow-none transition-colors duration-150 hover:bg-muted/20">
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
          <LabBoardCopyIdButton
            boardId={board.boardId}
            boardTitle={board.title}
            compact
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5 px-4 pt-2">
          <AccessPill board={board} />
          <BoardTagPills
            activeTag={activeTag}
            board={board}
            limit={3}
            onTagSelect={onTagSelect}
          />
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
  );
}

function LabBoardListRow({
  activeTag,
  board,
  onOpen,
  onTagSelect,
}: BoardItemProps) {
  return (
    <Card className="group relative overflow-hidden border-border/60 bg-transparent shadow-none transition-colors duration-150 hover:bg-muted/20">
      <button
        aria-label={`Open ${board.title}`}
        className="absolute inset-0 z-0 cursor-pointer"
        data-testid={`lab-board-card-${board.boardId}`}
        onClick={() => onOpen(board.boardId)}
        type="button"
      />
      <div className="pointer-events-none relative z-10 flex min-h-24 items-center gap-3 px-4 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40">
          <FlaskConical className="h-4.5 w-4.5 text-muted-foreground" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold text-foreground">
              {board.title}
            </span>
            <StatusPill status={board.status} />
            <AccessPill board={board} />
          </div>
          <p className="mt-1 truncate text-sm text-muted-foreground">
            {board.summary || "No summary."}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <BoardTagPills
              activeTag={activeTag}
              board={board}
              limit={4}
              onTagSelect={onTagSelect}
            />
            <span className="text-xs text-muted-foreground sm:hidden">
              Revision {board.revision} · {formatUpdatedAt(board.updatedAt)}
            </span>
          </div>
        </div>
        <div className="relative z-20 ml-auto flex shrink-0 items-center gap-3 self-stretch">
          <div className="hidden flex-col items-end justify-center text-xs text-muted-foreground sm:flex">
            <span>Revision {board.revision}</span>
            <span>{formatUpdatedAt(board.updatedAt)}</span>
          </div>
          <LabBoardCopyIdButton
            boardId={board.boardId}
            boardTitle={board.title}
            compact
          />
        </div>
      </div>
    </Card>
  );
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
            ? "Try another access scope or tag."
            : "Create a community, read-only, or private board."}
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
  viewMode: LabBoardViewMode;
};

export function LabBoardList({
  activeTag,
  boards,
  isFiltered,
  onOpen,
  onTagSelect,
  viewMode,
}: LabBoardListProps) {
  if (boards.length === 0) return <LabBoardEmptyState filtered={isFiltered} />;

  return (
    <div
      className={cn(
        "gap-3 p-4",
        viewMode === "grid"
          ? "grid sm:grid-cols-2 xl:grid-cols-3"
          : "flex flex-col",
      )}
      data-testid="lab-board-list"
      data-view-mode={viewMode}
    >
      {boards.map((board) =>
        viewMode === "grid" ? (
          <LabBoardGridCard
            activeTag={activeTag}
            board={board}
            key={board.boardId}
            onOpen={onOpen}
            onTagSelect={onTagSelect}
          />
        ) : (
          <LabBoardListRow
            activeTag={activeTag}
            board={board}
            key={board.boardId}
            onOpen={onOpen}
            onTagSelect={onTagSelect}
          />
        ),
      )}
    </div>
  );
}
