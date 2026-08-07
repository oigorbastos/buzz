import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import * as React from "react";

import {
  useCreateLabBoardMutation,
  useLabBoardsQuery,
} from "@/features/lab/hooks";
import { CreateLabBoardDialog } from "@/features/lab/ui/CreateLabBoardDialog";
import { LabBoardList } from "@/features/lab/ui/LabBoardList";
import {
  isRelayUnreachableError,
  RELAY_UNREACHABLE_SHORT,
} from "@/shared/lib/relayError";
import { Button } from "@/shared/ui/button";

/**
 * The Lab surface: a list of shared boards, or one open board.
 *
 * Which board is open is local state rather than a route param — V1 has no
 * deep links into a board, so keeping it here avoids adding a route whose URL
 * shape we would have to keep stable before knowing what a board link should
 * look like.
 */
export function LabScreen() {
  const boardsQuery = useLabBoardsQuery();
  const createMutation = useCreateLabBoardMutation();
  const [isCreateOpen, setIsCreateOpen] = React.useState(false);
  const navigate = useNavigate();

  // Opening a board is a navigation, not local state: the id belongs in the
  // URL so the board can be linked to and survives a reload.
  const openBoard = React.useCallback(
    (boardId: string) =>
      void navigate({ to: "/lab/boards/$boardId", params: { boardId } }),
    [navigate],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold text-foreground">Lab</h1>
          <p className="truncate text-xs text-muted-foreground">
            Shared boards everyone here can read and edit
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
        <LabBoardList boards={boardsQuery.data ?? []} onOpen={openBoard} />
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
