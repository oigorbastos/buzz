import { History, RotateCcw } from "lucide-react";
import * as React from "react";

import type { LabBoardRevision } from "@/features/lab/api";
import { MessageAgentOwner } from "@/features/messages/ui/MessageAgentOwner";
import { useUsersBatchQuery } from "@/features/profile/hooks";
import {
  formatOwnerLabel,
  resolveUserLabel,
  type UserProfileLookup,
} from "@/features/profile/lib/identity";
import { useIdentityQuery } from "@/shared/api/hooks";
import { normalizePubkey } from "@/shared/lib/pubkey";
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
  currentRevision: number;
  isRestoring: boolean;
  onRestore: (revision: LabBoardRevision) => void;
  revisions: LabBoardRevision[];
};

/**
 * Fetches every revision signer's profile in one batch (never once per
 * row), then a second batch for whichever of those signers turn out to be
 * verified NIP-OA-owned agents — mirrors
 * `@/features/channels/useMessageOwnerProfiles`'s two-step shape, kept local
 * here rather than imported cross-feature since it is ~10 lines either way.
 */
function useRevisionAuthorProfiles(revisions: LabBoardRevision[]): {
  authorProfiles: UserProfileLookup | undefined;
  ownerProfiles: UserProfileLookup | undefined;
} {
  const authorPubkeys = React.useMemo(
    () => [...new Set(revisions.map((revision) => revision.author))],
    [revisions],
  );
  const authorProfilesQuery = useUsersBatchQuery(authorPubkeys, {
    enabled: authorPubkeys.length > 0,
  });
  const authorProfiles = authorProfilesQuery.data?.profiles;

  const ownerPubkeys = React.useMemo(
    () => [
      ...new Set(
        Object.values(authorProfiles ?? {})
          .map((profile) => profile.ownerPubkey)
          .filter((pubkey): pubkey is string => Boolean(pubkey)),
      ),
    ],
    [authorProfiles],
  );
  const ownerProfilesQuery = useUsersBatchQuery(ownerPubkeys, {
    enabled: ownerPubkeys.length > 0,
  });

  return { authorProfiles, ownerProfiles: ownerProfilesQuery.data?.profiles };
}

export function LabBoardHistory({
  currentRevision,
  isRestoring,
  onRestore,
  revisions,
}: LabBoardHistoryProps) {
  const currentPubkey = useIdentityQuery().data?.pubkey;
  const { authorProfiles, ownerProfiles } =
    useRevisionAuthorProfiles(revisions);

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
      {ordered.map((revision) => {
        const authorProfile =
          authorProfiles?.[normalizePubkey(revision.author)];
        const signerLabel = resolveUserLabel({
          currentPubkey,
          pubkey: revision.author,
          profiles: authorProfiles,
        });
        // `ownerPubkey` here is the signer's OWN profile field, already
        // server-side NIP-OA-verified (see nostr_convert.rs
        // profile_valid_oa_owner_pubkey) — a human signer simply has none.
        const ownerLabel = authorProfile?.ownerPubkey
          ? formatOwnerLabel(
              authorProfile.ownerPubkey,
              currentPubkey,
              ownerProfiles,
            )
          : null;

        return (
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
              <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                <span className="truncate">
                  {formatTimestamp(revision.createdAt)} · signed by{" "}
                  {signerLabel}
                </span>
                {ownerLabel ? (
                  <MessageAgentOwner
                    ownerLabel={ownerLabel}
                    ownerPubkey={authorProfile?.ownerPubkey}
                  />
                ) : null}
              </p>
            </div>
            {revision.revision !== null &&
            revision.revision !== currentRevision ? (
              <RestoreButton
                disabled={isRestoring}
                onRestore={() => onRestore(revision)}
                revision={revision}
              />
            ) : null}
          </li>
        );
      })}
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
