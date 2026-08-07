import { ArrowLeft, History, Pencil, Save, Users, X } from "lucide-react";
import * as React from "react";

import {
  BOARD_CONFLICT_MESSAGE,
  isBoardConflictError,
  type LabBoardHead,
  type LabBoardRevision,
  validateBoardInput,
} from "@/features/lab/api";
import {
  useLabBoardHistoryQuery,
  useLabBoardQuery,
  useRestoreLabBoardMutation,
  useUpdateLabBoardMutation,
} from "@/features/lab/hooks";
import { LabBoardHistory } from "@/features/lab/ui/LabBoardHistory";
import {
  isRelayUnreachableError,
  RELAY_UNREACHABLE_SHORT,
} from "@/shared/lib/relayError";
import { Button } from "@/shared/ui/button";
import { Markdown } from "@/shared/ui/markdown";
import { Textarea } from "@/shared/ui/textarea";

type LabBoardViewProps = {
  boardId: string;
  onBack: () => void;
};

export function LabBoardView({ boardId, onBack }: LabBoardViewProps) {
  const boardQuery = useLabBoardQuery(boardId);
  const [showHistory, setShowHistory] = React.useState(false);
  const historyQuery = useLabBoardHistoryQuery(boardId, showHistory);
  const updateMutation = useUpdateLabBoardMutation(boardId);
  const restoreMutation = useRestoreLabBoardMutation(boardId);

  const [isEditing, setIsEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  const board = boardQuery.data ?? null;
  // Defer the single large Markdown parse so navigating into a board commits
  // the surrounding chrome immediately (boards can hold up to 64 KB).
  const deferredContent = React.useDeferredValue(board?.content ?? "");

  function handleStartEditing(head: LabBoardHead) {
    setDraft(head.content);
    setErrorMessage(null);
    setIsEditing(true);
  }

  function handleCancelEditing() {
    setIsEditing(false);
    setDraft("");
    setErrorMessage(null);
  }

  async function handleSave(head: LabBoardHead) {
    const validationError = validateBoardInput({ content: draft });
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }
    setErrorMessage(null);
    try {
      // Re-read the head immediately before writing so a board someone else
      // advanced while this editor was open is caught here rather than by a
      // relay rejection the user cannot interpret.
      const fresh = await boardQuery.refetch();
      const latest = fresh.data ?? head;
      await updateMutation.mutateAsync({ head: latest, content: draft });
      setIsEditing(false);
      setDraft("");
    } catch (error) {
      // The draft is deliberately NOT cleared on failure — losing someone's
      // writing to a conflict would be the worst possible outcome here.
      setErrorMessage(
        isBoardConflictError(error)
          ? BOARD_CONFLICT_MESSAGE
          : error instanceof Error
            ? error.message
            : "Failed to save this board.",
      );
    }
  }

  function handleRestore(head: LabBoardHead, revision: LabBoardRevision) {
    setErrorMessage(null);
    restoreMutation.mutate(
      { head, revision },
      {
        onError: (error) => {
          setErrorMessage(
            isBoardConflictError(error)
              ? BOARD_CONFLICT_MESSAGE
              : error instanceof Error
                ? error.message
                : "Failed to restore this revision.",
          );
        },
      },
    );
  }

  if (boardQuery.isLoading) {
    return (
      <p className="p-4 text-sm text-muted-foreground">Loading board...</p>
    );
  }

  if (boardQuery.error instanceof Error) {
    return (
      <div className="p-4">
        <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {isRelayUnreachableError(boardQuery.error)
            ? RELAY_UNREACHABLE_SHORT
            : boardQuery.error.message}
        </p>
      </div>
    );
  }

  if (!board) {
    return (
      <div className="p-4">
        <Button onClick={onBack} size="sm" type="button" variant="outline">
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
        <p className="mt-4 text-sm text-muted-foreground">
          This board no longer exists on the relay.
        </p>
      </div>
    );
  }

  const isFrozen = board.status === "frozen";
  const isSaving = updateMutation.isPending;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-3">
        <Button
          data-testid="lab-board-back"
          onClick={onBack}
          size="sm"
          type="button"
          variant="ghost"
        >
          <ArrowLeft className="h-4 w-4" />
          Boards
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold text-foreground">
            {board.title}
          </h1>
          <p className="truncate text-xs text-muted-foreground">
            Revision {board.revision}
            {board.summary ? ` · ${board.summary}` : ""}
          </p>
        </div>
        <Button
          data-testid="lab-board-history-toggle"
          onClick={() => setShowHistory((value) => !value)}
          size="sm"
          type="button"
          variant="outline"
        >
          <History className="h-4 w-4" />
          {showHistory ? "Hide history" : "History"}
        </Button>
        {!isEditing && !isFrozen ? (
          <Button
            data-testid="lab-board-edit"
            onClick={() => handleStartEditing(board)}
            size="sm"
            type="button"
            variant="outline"
          >
            <Pencil className="h-4 w-4" />
            Edit
          </Button>
        ) : null}
      </div>

      <p className="flex items-center gap-2 border-b border-border/60 bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
        <Users className="h-3.5 w-3.5 shrink-0" />
        Everyone in this community can edit this board.
        {isFrozen ? " It is frozen, so edits are disabled." : ""}
      </p>

      {errorMessage ? (
        <p
          className="mx-4 mt-3 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="lab-board-error"
        >
          {errorMessage}
        </p>
      ) : null}

      {showHistory ? (
        <div className="border-b border-border/60">
          {historyQuery.isLoading ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">
              Loading history...
            </p>
          ) : (
            <LabBoardHistory
              currentRevision={board.revision}
              isRestoring={restoreMutation.isPending}
              onRestore={(revision) => handleRestore(board, revision)}
              revisions={historyQuery.data ?? []}
            />
          )}
        </div>
      ) : null}

      {isEditing ? (
        <div className="space-y-3 p-4">
          <Textarea
            aria-label="Board content"
            className="min-h-64 font-mono text-sm"
            data-testid="lab-board-editor"
            disabled={isSaving}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Write in Markdown..."
            value={draft}
          />
          <div className="flex gap-2">
            <Button
              data-testid="lab-board-save"
              disabled={isSaving}
              onClick={() => {
                void handleSave(board);
              }}
              size="sm"
              type="button"
            >
              <Save className="h-4 w-4" />
              {isSaving ? "Saving..." : "Save"}
            </Button>
            <Button
              data-testid="lab-board-cancel"
              disabled={isSaving}
              onClick={handleCancelEditing}
              size="sm"
              type="button"
              variant="outline"
            >
              <X className="h-4 w-4" />
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="p-4" data-testid="lab-board-content">
          {board.content ? (
            <Markdown content={deferredContent} />
          ) : (
            <p className="text-sm text-muted-foreground">
              This board is empty.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
