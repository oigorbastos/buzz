import { useNavigate } from "@tanstack/react-router";
import { Plus, Tag } from "lucide-react";
import * as React from "react";

import {
  useCreateLabBoardMutation,
  useLabBoardsQuery,
} from "@/features/lab/hooks";
import {
  availableBoardTags,
  filterLabBoards,
  type LabBoardListFilter,
} from "@/features/lab/model";
import { CreateLabBoardDialog } from "@/features/lab/ui/CreateLabBoardDialog";
import { LabBoardList } from "@/features/lab/ui/LabBoardList";
import { LabBoardViewModeToggle } from "@/features/lab/ui/LabBoardViewModeToggle";
import { isLabV2Preview } from "@/features/lab/previewMode";
import { LabPreviewBanner } from "@/features/lab/ui/LabPreviewBanner";
import {
  readStoredLabBoardViewMode,
  type LabBoardViewMode,
  writeStoredLabBoardViewMode,
} from "@/features/lab/viewPreference";
import { useIdentityQuery } from "@/shared/api/hooks";
import { useUserProfileQuery } from "@/features/profile/hooks";
import { cn } from "@/shared/lib/cn";
import {
  isRelayUnreachableError,
  RELAY_UNREACHABLE_SHORT,
} from "@/shared/lib/relayError";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";

const FILTERS: Array<{ label: string; value: LabBoardListFilter }> = [
  { label: "All", value: "all" },
  { label: "Community", value: "community" },
  { label: "Read-only", value: "community_readonly" },
  { label: "Private", value: "private" },
];

export function LabScreen() {
  const boardsQuery = useLabBoardsQuery();
  const createMutation = useCreateLabBoardMutation();
  const identityQuery = useIdentityQuery();
  const currentProfileQuery = useUserProfileQuery(identityQuery.data?.pubkey);
  const [isCreateOpen, setIsCreateOpen] = React.useState(false);
  const [listFilter, setListFilter] = React.useState<LabBoardListFilter>("all");
  const [tagFilter, setTagFilter] = React.useState<string | null>(null);
  const [viewMode, setViewMode] = React.useState<LabBoardViewMode>(() =>
    readStoredLabBoardViewMode(),
  );
  const navigate = useNavigate();
  const preview = isLabV2Preview();

  const boards = boardsQuery.data ?? [];
  const availableTags = React.useMemo(
    () =>
      availableBoardTags(
        boards,
        identityQuery.data?.pubkey,
        currentProfileQuery.data?.ownerPubkey,
      ),
    [boards, identityQuery.data?.pubkey, currentProfileQuery.data?.ownerPubkey],
  );
  const filteredBoards = React.useMemo(
    () =>
      filterLabBoards({
        boards,
        currentPubkey: identityQuery.data?.pubkey,
        currentOwnerPubkey: currentProfileQuery.data?.ownerPubkey,
        filter: listFilter,
        tag: tagFilter,
      }),
    [
      boards,
      identityQuery.data?.pubkey,
      currentProfileQuery.data?.ownerPubkey,
      listFilter,
      tagFilter,
    ],
  );

  React.useEffect(() => {
    if (tagFilter && !availableTags.includes(tagFilter)) setTagFilter(null);
  }, [availableTags, tagFilter]);

  const openBoard = React.useCallback(
    (boardId: string) =>
      void navigate({ to: "/lab/boards/$boardId", params: { boardId } }),
    [navigate],
  );

  const handleViewModeChange = React.useCallback(
    (nextViewMode: LabBoardViewMode) => {
      setViewMode(nextViewMode);
      writeStoredLabBoardViewMode(nextViewMode);
    },
    [],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-semibold text-foreground">Lab</h1>
            {preview ? <Badge variant="warning">UX preview</Badge> : null}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            Markdown boards for people and agents
          </p>
        </div>
        <Button
          data-testid="lab-create-board"
          onClick={() => setIsCreateOpen(true)}
          size="sm"
          type="button"
        >
          <Plus className="h-4 w-4" />
          New board
        </Button>
      </div>

      <LabPreviewBanner />

      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 bg-muted/10 px-4 py-2.5">
        <fieldset className="flex rounded-lg border border-border/60 bg-background p-0.5">
          <legend className="sr-only">Filter boards by access scope</legend>
          {FILTERS.map((filter) => (
            <button
              aria-pressed={listFilter === filter.value}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                listFilter === filter.value
                  ? "bg-muted text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
              data-testid={`lab-filter-${filter.value}`}
              key={filter.value}
              onClick={() => setListFilter(filter.value)}
              type="button"
            >
              {filter.label}
            </button>
          ))}
        </fieldset>

        <label className="relative flex items-center" htmlFor="lab-tag-filter">
          <Tag className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <select
            className="h-8 min-w-40 appearance-none rounded-lg border border-border/60 bg-background py-1 pl-8 pr-7 text-xs text-foreground outline-none transition-colors focus:border-ring"
            data-testid="lab-tag-filter"
            id="lab-tag-filter"
            onChange={(event) => setTagFilter(event.target.value || null)}
            value={tagFilter ?? ""}
          >
            <option value="">All tags</option>
            {availableTags.map((tag) => (
              <option key={tag} value={tag}>
                #{tag}
              </option>
            ))}
          </select>
        </label>

        <div className="ml-auto flex items-center gap-2">
          <span
            className="text-xs text-muted-foreground"
            title="Sorted by last edited"
          >
            {filteredBoards.length}{" "}
            {filteredBoards.length === 1 ? "board" : "boards"}
          </span>
          <LabBoardViewModeToggle
            onViewModeChange={handleViewModeChange}
            viewMode={viewMode}
          />
        </div>
      </div>

      {boardsQuery.isLoading ? (
        <p className="p-4 text-sm text-muted-foreground">Loading boards...</p>
      ) : boardsQuery.error instanceof Error ? (
        <div className="p-4">
          <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {isRelayUnreachableError(boardsQuery.error)
              ? RELAY_UNREACHABLE_SHORT
              : boardsQuery.error.message}
          </p>
        </div>
      ) : (
        <LabBoardList
          activeTag={tagFilter}
          boards={filteredBoards}
          isFiltered={listFilter !== "all" || tagFilter !== null}
          onOpen={openBoard}
          onTagSelect={setTagFilter}
          viewMode={viewMode}
        />
      )}

      <CreateLabBoardDialog
        isCreating={createMutation.isPending}
        onCreate={async (input) => {
          const result = await createMutation.mutateAsync(input);
          openBoard(result.boardId);
          return result;
        }}
        onOpenChange={setIsCreateOpen}
        open={isCreateOpen}
      />
    </div>
  );
}
