import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Eye,
  History,
  Link2,
  Pencil,
  Save,
  LockKeyhole,
  TextCursorInput,
  Users,
  X,
} from "lucide-react";
import * as React from "react";

import {
  BOARD_CONFLICT_MESSAGE,
  boardReference,
  describeBoardModerationError,
  isBoardConflictError,
  type LabBoardHead,
  type LabBoardRevision,
  validateBoardInput,
} from "@/features/lab/api";
import { canEditBoard, canReadBoard } from "@/features/lab/model";
import {
  availableArchiveAction,
  boardAccessBadgeLabel,
  canModerateBoards,
  canRenameBoard,
  isBoardLocked,
} from "@/features/lab/boardStatus";
import { useMyRelayMembershipQuery } from "@/features/community-members/hooks";
import {
  useLabBoardHistoryQuery,
  useLabBoardQuery,
  useRenameLabBoardMutation,
  useRestoreLabBoardMutation,
  useSetLabBoardArchivedMutation,
  useUpdateLabBoardMutation,
} from "@/features/lab/hooks";
import { LabBoardHistory } from "@/features/lab/ui/LabBoardHistory";
import { LabBoardCopyIdButton } from "@/features/lab/ui/LabBoardCopyIdButton";
import { LabMarkdownEditor } from "@/features/lab/ui/LabMarkdownEditor";
import { LabPreviewBanner } from "@/features/lab/ui/LabPreviewBanner";
import { LabTagInput } from "@/features/lab/ui/LabTagInput";
import { RenameLabBoardDialog } from "@/features/lab/ui/RenameLabBoardDialog";
import { useLabBoardTaskToggleBatch } from "@/features/lab/ui/useLabBoardTaskToggleBatch";
import { useIdentityQuery } from "@/shared/api/hooks";
import { useUserProfileQuery } from "@/features/profile/hooks";
import {
  isRelayUnreachableError,
  RELAY_UNREACHABLE_SHORT,
} from "@/shared/lib/relayError";
import { Button } from "@/shared/ui/button";
import { Badge } from "@/shared/ui/badge";
import { copyTextToClipboard } from "@/shared/lib/clipboard";
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
  const renameMutation = useRenameLabBoardMutation(boardId);
  const restoreMutation = useRestoreLabBoardMutation(boardId);
  const archiveMutation = useSetLabBoardArchivedMutation(boardId);
  const identityQuery = useIdentityQuery();
  const currentProfileQuery = useUserProfileQuery(identityQuery.data?.pubkey);
  // Board moderation is gated on the community role in the relay's
  // `relay_members` table — the same seam ban/timeout use. This only decides
  // whether to *offer* the action; the relay re-derives it per event and is
  // the authority, so a rejection is still surfaced rather than assumed away.
  const relayMembershipQuery = useMyRelayMembershipQuery();
  const canModerate = canModerateBoards(relayMembershipQuery.data?.role);

  const [isEditing, setIsEditing] = React.useState(false);
  const [isRenameOpen, setIsRenameOpen] = React.useState(false);
  // Poll only while editing — that is the only window where another writer's
  // revision changes what this user should do next.
  const boardQuery = useLabBoardQuery(boardId, isEditing);
  const [draft, setDraft] = React.useState("");
  const [draftTags, setDraftTags] = React.useState<string[]>([]);
  /**
   * The head this draft was started from. Captured once when editing begins
   * and never refreshed — it is the `prev` sent to the relay, i.e. the claim
   * "I wrote this against revision N". Refreshing it would turn every save
   * into an unconditional overwrite.
   */
  const [editBase, setEditBase] = React.useState<LabBoardHead | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  const board = boardQuery.data ?? null;
  const canToggleTasks =
    board !== null &&
    !isEditing &&
    viewingRevision === null &&
    !isBoardLocked(board.status) &&
    canEditBoard(
      board,
      identityQuery.data?.pubkey,
      currentProfileQuery.data?.ownerPubkey,
    );
  const taskToggles = useLabBoardTaskToggleBatch({
    board,
    boardId,
    enabled: canToggleTasks,
    onMessage: setErrorMessage,
    updateBoard: updateMutation.mutateAsync,
  });
  // Defer the single large Markdown parse so navigating into a board commits
  // the surrounding chrome immediately (boards can hold up to 64 KB).
  const deferredContent = React.useDeferredValue(board?.content ?? "");
  const [lastTaskToggleContent, setLastTaskToggleContent] = React.useState<
    string | null
  >(null);
  // Keep the confirmed task state on screen until the deferred Markdown value
  // catches up. Otherwise a successful checkbox update can briefly render the
  // stale deferred source after its query cache has already refreshed.
  React.useEffect(() => {
    if (taskToggles.hasPending) {
      setLastTaskToggleContent(taskToggles.optimisticContent);
    }
  }, [taskToggles.hasPending, taskToggles.optimisticContent]);
  React.useEffect(() => {
    if (!taskToggles.hasPending && deferredContent === (board?.content ?? "")) {
      setLastTaskToggleContent(null);
    }
  }, [board?.content, deferredContent, taskToggles.hasPending]);
  const markdownContent = taskToggles.hasPending
    ? taskToggles.optimisticContent
    : lastTaskToggleContent !== null &&
        deferredContent !== (board?.content ?? "")
      ? lastTaskToggleContent
      : deferredContent;

  function startEditing(head: LabBoardHead) {
    // A rename is a CAS write against this same head, so it must never be
    // pending behind a draft whose `prev` it would invalidate.
    setIsRenameOpen(false);
    setDraft(head.content);
    setDraftTags(head.tags);
    // Freeze the revision this draft is derived from. Everything below depends
    // on this value never being refreshed — see `handleSave`.
    setEditBase(head);
    setErrorMessage(null);
    setIsEditing(true);
  }

  async function handleStartEditing() {
    if (!(await taskToggles.flush())) return;
    const latest = await boardQuery.refetch();
    if (!latest.data) {
      setErrorMessage("This board is no longer available for editing.");
      return;
    }
    startEditing(latest.data);
  }

  async function handleBack() {
    if (await taskToggles.flush()) onBack();
  }

  function handleCancelEditing() {
    setIsEditing(false);
    setDraft("");
    setDraftTags([]);
    setEditBase(null);
    setErrorMessage(null);
  }

  async function handleSave() {
    if (!editBase) return;
    const validationError = validateBoardInput({
      content: draft,
      tags: draftTags,
    });
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
      await updateMutation.mutateAsync({
        head: editBase,
        content: draft,
        tags: draftTags,
      });
      setIsEditing(false);
      setDraft("");
      setDraftTags([]);
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

  function handleSetArchived(head: LabBoardHead, archived: boolean) {
    setErrorMessage(null);
    archiveMutation.mutate(
      { head, archived },
      {
        // The client cannot see `relay_members`, so "you may archive" is only
        // ever a guess. When the relay disagrees, say what it said in prose —
        // a silent no-op here would look like a broken button.
        onError: (error) =>
          setErrorMessage(
            describeBoardModerationError(
              error,
              archived ? "archive" : "unarchive",
            ),
          ),
      },
    );
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

  if (
    !board ||
    !canReadBoard(
      board,
      identityQuery.data?.pubkey,
      currentProfileQuery.data?.ownerPubkey,
    )
  ) {
    return (
      <div className="p-4">
        <Button onClick={onBack} size="sm" type="button" variant="outline">
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
        <p className="mt-4 text-sm text-muted-foreground">
          This board is not available.
        </p>
      </div>
    );
  }

  const isFrozen = board.status === "frozen";
  const isArchived = board.status === "archived";
  // Widens the frozen gate to cover archived too; see `isBoardLocked` for why
  // the relay's own refusal does not already cover this case.
  const isLocked = isBoardLocked(board.status);
  const canWrite = canEditBoard(
    board,
    identityQuery.data?.pubkey,
    currentProfileQuery.data?.ownerPubkey,
  );
  const archiveAction = availableArchiveAction(board.status);
  const canRename = canRenameBoard({
    canWrite,
    isEditing,
    status: board.status,
    viewingRevision,
  });
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
          onClick={() => {
            void handleBack();
          }}
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
            copyTextToClipboard(
              boardReference(board.boardId),
              "Board reference copied",
            );
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          <Link2 className="h-4 w-4" />
          Copy link
        </Button>
        <LabBoardCopyIdButton
          boardId={board.boardId}
          boardTitle={board.title}
        />
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
        {/* Editing requires write access (ACL), a live head (not a pinned
            revision deep link), and a board that is neither frozen nor
            archived. `isLocked` widens the original `!isFrozen` term — the
            other three conditions are unchanged. */}
        {!isEditing && !isLocked && canWrite && viewingRevision === null ? (
          <Button
            data-testid="lab-board-edit"
            onClick={() => {
              void handleStartEditing();
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            <Pencil className="h-4 w-4" />
            Edit
          </Button>
        ) : null}
        {/* Renaming is an ordinary content mutation, so it is offered under
            the same conditions as editing — see `canRenameBoard`, which
            restates that guard rather than reshaping it. */}
        {canRename ? (
          <Button
            data-testid="lab-board-rename"
            disabled={
              renameMutation.isPending ||
              taskToggles.hasPending ||
              taskToggles.isFlushing
            }
            onClick={() => setIsRenameOpen(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            <TextCursorInput className="h-4 w-4" />
            Rename
          </Button>
        ) : null}
        {/* Archiving is a moderation op: it needs a community role rather than
            board write access, and it is offered only from a status the relay
            accepts as its source (active -> archive, archived -> unarchive;
            a frozen board offers neither). Hidden while editing so it cannot
            retire a board out from under an open draft. */}
        {!isEditing && canModerate && archiveAction !== null ? (
          <Button
            data-testid={`lab-board-${archiveAction}`}
            disabled={
              archiveMutation.isPending ||
              taskToggles.hasPending ||
              taskToggles.isFlushing
            }
            onClick={() =>
              handleSetArchived(board, archiveAction === "archive")
            }
            size="sm"
            type="button"
            variant="outline"
          >
            {archiveAction === "archive" ? (
              <Archive className="h-4 w-4" />
            ) : (
              <ArchiveRestore className="h-4 w-4" />
            )}
            {archiveMutation.isPending
              ? "Working..."
              : archiveAction === "archive"
                ? "Archive"
                : "Unarchive"}
          </Button>
        ) : null}
      </div>

      <LabPreviewBanner />

      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
        {board.access === "private" ? (
          <LockKeyhole className="h-3.5 w-3.5 shrink-0" />
        ) : board.access === "community_readonly" ? (
          <Eye className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <Users className="h-3.5 w-3.5 shrink-0" />
        )}
        <span>
          {board.access === "community"
            ? "Everyone in this community can read and edit this board."
            : board.access === "community_readonly"
              ? canWrite
                ? "Everyone in this community can find and read. Only you and your agents can edit."
                : "Everyone in this community can find and read. Only the owner and their agents can edit."
              : "Only you and your agents can find, read, and edit this board."}
          {isFrozen ? " It is frozen, so edits are disabled." : ""}
          {isArchived ? " It is archived, so edits are disabled." : ""}
        </span>
        <Badge
          className="normal-case tracking-normal"
          data-testid="lab-board-access-badge"
          variant={
            board.access === "community"
              ? "secondary"
              : board.access === "community_readonly"
                ? "outline"
                : "info"
          }
        >
          {boardAccessBadgeLabel({ access: board.access, canWrite })}
        </Badge>
        {isArchived ? (
          <Badge className="normal-case tracking-normal" variant="outline">
            Archived
          </Badge>
        ) : null}
        {board.tags.map((tag) => (
          <span
            className="rounded-full border border-border/60 bg-background/70 px-2 py-0.5"
            key={tag}
          >
            #{tag}
          </span>
        ))}
      </div>

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
              canRestore={
                canWrite &&
                !isLocked &&
                !taskToggles.hasPending &&
                !taskToggles.isFlushing
              }
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
          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="edit-lab-board-tags"
            >
              Tags
            </label>
            <LabTagInput
              disabled={isSaving}
              id="edit-lab-board-tags"
              onChange={setDraftTags}
              tags={draftTags}
            />
          </div>
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
            <Markdown
              content={markdownContent}
              onToggleTask={
                canToggleTasks && !taskToggles.isFlushing
                  ? taskToggles.onToggleTask
                  : undefined
              }
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              This board is empty.
            </p>
          )}
        </div>
      )}

      {/* Mounted only behind the same guard as the button, so a reader of a
          board they cannot write has no rename surface at all — not a hidden
          one. `board` is the head this view is rendering, so the content the
          rename resends and the `prev` it swaps against come from one
          snapshot: the property that makes a rename unable to carry stale
          text. */}
      {canRename ? (
        <RenameLabBoardDialog
          board={board}
          isRenaming={renameMutation.isPending}
          onOpenChange={setIsRenameOpen}
          onRename={(title) =>
            renameMutation.mutateAsync({ head: board, title })
          }
          open={isRenameOpen}
        />
      ) : null}
    </div>
  );
}
