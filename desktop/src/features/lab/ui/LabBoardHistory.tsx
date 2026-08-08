import { History, RotateCcw } from "lucide-react";
import * as React from "react";

import type { LabBoardRevision } from "@/features/lab/api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/shared/ui/alert-dialog";
import { Button } from "@/shared/ui/button";

function formatTimestamp(seconds: number): string {
  return new Date(seconds * 1_000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

type LabBoardHistoryProps = {
  canRestore?: boolean;
  currentRevision: number;
  isRestoring: boolean;
  onRestore: (revision: LabBoardRevision) => void;
  revisions: LabBoardRevision[];
};

export function LabBoardHistory({
  canRestore = true,
  currentRevision,
  isRestoring,
  onRestore,
  revisions,
}: LabBoardHistoryProps) {
  if (revisions.length === 0) {
    return (
      <p className="px-4 py-6 text-sm text-muted-foreground">
        No revisions recorded yet.
      </p>
    );
  }

  // Newest first reads better as a log, even though the relay's order is
  // oldest-first (revision numbers ascend).
  const ordered = [...revisions].reverse();

  return (
    <ul className="divide-y divide-border/60" data-testid="lab-board-history">
      {ordered.map((revision) => (
        <li
          className="flex items-center gap-3 px-4 py-3"
          key={revision.eventId}
        >
          <History className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-foreground">
              {revision.revision === null
                ? "Unnumbered revision"
                : `Revision ${revision.revision}`}
              <span className="ml-2 text-xs uppercase tracking-wide text-muted-foreground">
                {revision.op}
              </span>
              {revision.restoredFrom !== null ? (
                <span className="ml-2 text-xs text-muted-foreground">
                  from revision {revision.restoredFrom}
                </span>
              ) : null}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {formatTimestamp(revision.createdAt)}
            </p>
          </div>
          {revision.revision !== null &&
          revision.revision !== currentRevision &&
          canRestore ? (
            <RestoreButton
              disabled={isRestoring}
              onRestore={() => onRestore(revision)}
              revision={revision}
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function RestoreButton({
  disabled,
  onRestore,
  revision,
}: {
  disabled: boolean;
  onRestore: () => void;
  revision: LabBoardRevision;
}) {
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  return (
    <AlertDialog onOpenChange={setConfirmOpen} open={confirmOpen}>
      <AlertDialogTrigger asChild>
        <Button
          data-testid={`lab-restore-${revision.revision}`}
          disabled={disabled}
          size="sm"
          type="button"
          variant="outline"
        >
          <RotateCcw className="h-4 w-4" />
          Restore
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Restore revision {revision.revision}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This publishes that revision's content as a new revision on top of
            the history. Nothing is erased — the current version stays in the
            log, and everyone sees the board change.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button disabled={disabled} type="button" variant="outline">
              Cancel
            </Button>
          </AlertDialogCancel>
          <AlertDialogAction asChild>
            <Button
              data-testid={`lab-restore-confirm-${revision.revision}`}
              disabled={disabled}
              onClick={(event) => {
                event.preventDefault();
                onRestore();
                setConfirmOpen(false);
              }}
              type="button"
            >
              {disabled ? "Restoring..." : "Restore"}
            </Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
