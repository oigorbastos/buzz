import {
  ArrowLeft,
  History,
  Link2,
  Pencil,
  Save,
  Users,
  X,
} from "lucide-react";
import * as React from "react";

import {
  BOARD_CONFLICT_MESSAGE,
  boardReference,
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
import { LabMarkdownEditor } from "@/features/lab/ui/LabMarkdownEditor";
import {
  isRelayUnreachableError,
  RELAY_UNREACHABLE_SHORT,
} from "@/shared/lib/relayError";
import { Button } from "@/shared/ui/button";
import { Markdown } from "@/shared/ui/markdown";

type LabBoardViewProps = {
  boardId: string;
  onBack: () => void;
  /** Clears the route's `revision` search param, returning to the live head. */
  onViewCurrentVersion: () => void;
  /** Set from the route's `revision` search param — see `boardReference()`
   * for the deep-link format this addresses. Renders that historical
   * revision read-only instead of the live head. */
  viewingRevision: number | null;
};

export function LabBoardView({
  boardId,
  onBack,
  onViewCurrentVersion,
  viewingRevision,
}: LabBoardViewProps) {
  const [showHistory, setShowHistory] = React.useState(false);
  // Fetch history whenever it's either shown, or needed to resolve a
  // revision-pinned deep link — the historical content lives on each
  // `LabBoardRevision`, so no separate network call is needed for that case.
  const historyQuery = useLabBoardHistoryQuery(
    boardId,
    showHistory || viewingRevision !== null,
  );
  const updateMutation = useUpdateLabBoardMutation(boardId);
  const restoreMutation = useRestoreLabBoardMutation(boardId);

  const [isEditing, setIsEditing] = React.useState(false);
  // Poll only while editing — that is the only window where another writer's
  // revision changes what this user should do next.
  const boardQuery = useLabBoardQuery(boardId, isEditing);
  const [draft, setDraft] = React.useState("");
  /**
   * The head this draft was started from. Captured once when editing begins
   * and never refreshed — it is the `prev` sent to the relay, i.e. the claim
   * "I wrote this against revision N". Refreshing it would turn every save
   * into an unconditional overwrite.
   */
  const [editBase, setEditBase] = React.useState<LabBoardHead | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  const board = boardQuery.data ?? null;
  // Defer the single large Markdown parse so navigating into a board commits
  // the surrounding chrome immediately (boards can hold up to 64 KB).
  const deferredContent = React.useDeferredValue(board?.content ?? "");

  function handleStartEditing(head: LabBoardHead) {
    setDraft(head.content);
    // Freeze the revision this draft is derived from. Everything below depends
    // on this value never being refreshed — see `handleSave`.
    setEditBase(head);
    setErrorMessage(null);
    setIsEditing(true);
  }

  function handleCancelEditing() {
    setIsEditing(false);
    setDraft("");
    setEditBase(null);
    setErrorMessage(null);
  }

  async function handleSave() {
    if (!editBase) return;
    const validationError = validateBoardInput({ content: draft });
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }
    setErrorMessage(null);
    try {
      // Send the head captured when editing STARTED, never a freshly read one.
      //
      // This is the entire point of the feature. `prev` is a claim about which
      // revision this text was written against; re-reading the head just
      // before saving would replace that claim with "whatever is current",
      // which the relay then always accepts — silently destroying any revision
      // published while the editor was open. The CAS transaction, the advisory
      // lock and BOARD_HEAD_MISMATCH all exist to catch exactly that, and are
      // dead weight unless this base stays frozen.
      await updateMutation.mutateAsync({ head: editBase, content: draft });
      setIsEditing(false);
      setDraft("");
      setEditBase(null);
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
  // The polled head has moved past the revision this draft was started from,
  // so saving will (correctly) be refused. Say so now rather than letting the
  // user finish writing and only then hit a conflict.
  const baseIsStale =
    isEditing &&
    editBase !== null &&
    board.headEventId !== editBase.headEventId;
  const viewingRevisionEntry =
    viewingRevision !== null
      ? ((historyQuery.data ?? []).find(
          (revision) => revision.revision === viewingRevision,
        ) ?? null)
      : null;

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
          data-testid="lab-board-copy-reference"
          onClick={() => {
            void navigator.clipboard
              .writeText(boardReference(board.boardId))
              .catch(() => setErrorMessage("Could not copy the reference."));
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          <Link2 className="h-4 w-4" />
          Copy link
        </Button>
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
        {!isEditing && !isFrozen && viewingRevision === null ? (
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

      {viewingRevision !== null ? (
        <div
          className="flex flex-wrap items-center gap-2 border-b border-border/60 bg-amber-500/10 px-4 py-2 text-xs text-amber-600 dark:text-amber-400"
          data-testid="lab-board-viewing-revision"
        >
          <History className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">
            Viewing revision {viewingRevision} (read-only).
          </span>
          <Button
            data-testid="lab-board-copy-revision-reference"
            onClick={() => {
              void navigator.clipboard
                .writeText(boardReference(board.boardId, viewingRevision))
                .catch(() => setErrorMessage("Could not copy the reference."));
            }}
            size="xs"
            type="button"
            variant="outline"
          >
            <Link2 className="h-3.5 w-3.5" />
            Copy link to this revision
          </Button>
          <Button
            data-testid="lab-board-view-current"
            onClick={onViewCurrentVersion}
            size="xs"
            type="button"
            variant="outline"
          >
            Back to current version
          </Button>
        </div>
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

      {viewingRevision !== null ? (
        <div className="p-4" data-testid="lab-board-historical-content">
          {historyQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading revision...</p>
          ) : viewingRevisionEntry ? (
            <Markdown content={viewingRevisionEntry.content} />
          ) : (
            <p className="text-sm text-muted-foreground">
              Revision {viewingRevision} was not found in this board's history.
            </p>
          )}
        </div>
      ) : isEditing ? (
        <div className="space-y-3 p-4">
          {baseIsStale ? (
            <p
              className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400"
              data-testid="lab-board-stale-base"
            >
              This board moved to revision {board.revision} while you were
              writing. Saving will be refused so their work is not lost — copy
              your text, cancel, and reapply it on the new version.
            </p>
          ) : null}
          <LabMarkdownEditor
            aria-label="Board content"
            data-testid="lab-board-editor"
            disabled={isSaving}
            onChange={setDraft}
            placeholder="Write in Markdown..."
            value={draft}
          />
          <div className="flex gap-2">
            <Button
              data-testid="lab-board-save"
              disabled={isSaving}
              onClick={() => {
                void handleSave();
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
