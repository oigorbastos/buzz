import { LockKeyhole } from "lucide-react";
import * as React from "react";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import { useLabBoardsQuery } from "@/features/lab/hooks";
import { type ParsedLabLink, parseLabLink } from "@/features/lab/lib/labLink";
import { canReadBoard } from "@/features/lab/model";
import { useUserProfileQuery } from "@/features/profile/hooks";
import { useIdentityQuery } from "@/shared/api/hooks";
import { cn } from "@/shared/lib/cn";
import {
  MENTION_CHIP_BASE_CLASSES,
  MENTION_CHIP_HOVER_CLASSES,
} from "@/shared/ui/mentionChip";

import { LabLinkPill } from "./LabLinkPill";
import { useMarkdownRuntime } from "./runtimeContext";

/**
 * Navigate to a Lab Board for a `buzz://lab?board=…&revision=…` link. When a
 * revision is present, `goLabBoard` sets the route's `revision` search param
 * so `LabBoardView` opens that historical revision read-only; otherwise the
 * board opens at its live head. Mirrors `useOpenEntityLink`.
 */
export function useOpenLabLink(): (link: ParsedLabLink) => void {
  const { goLabBoard } = useAppNavigation();
  return React.useCallback(
    (link: ParsedLabLink) => {
      void goLabBoard(link.boardId, {
        revision: link.revision ?? undefined,
      });
    },
    [goLabBoard],
  );
}

/**
 * Resolve an explicit Lab reference against the ACL-filtered board list. The
 * literal Markdown label is the fail-closed fallback while the query loads,
 * after deletion, or when the reader cannot access the board.
 */
export function LabBoardReference({
  children,
  href,
  link,
  onOpenLabLink,
}: {
  children: React.ReactNode;
  href: string;
  link: ParsedLabLink;
  onOpenLabLink: (link: ParsedLabLink) => void;
}) {
  const boardsQuery = useLabBoardsQuery();
  const identityQuery = useIdentityQuery();
  const currentProfileQuery = useUserProfileQuery(identityQuery.data?.pubkey);
  const candidate = boardsQuery.isSuccess
    ? boardsQuery.data.find((candidate) => candidate.boardId === link.boardId)
    : undefined;
  const board =
    candidate &&
    canReadBoard(
      candidate,
      identityQuery.data?.pubkey,
      currentProfileQuery.data?.ownerPubkey,
    )
      ? candidate
      : undefined;

  if (!board) {
    return (
      <span
        aria-disabled="true"
        className={cn(
          MENTION_CHIP_BASE_CLASSES,
          "cursor-not-allowed opacity-60",
        )}
        data-lab-link=""
        data-lab-link-state="unavailable"
        title="Lab board unavailable"
      >
        <LockKeyhole
          aria-hidden="true"
          className="mr-1 inline-block h-3 w-3 align-[-0.08em]"
        />
        {children}
      </span>
    );
  }

  return (
    <button
      aria-label={`Open Lab board ${board.title}`}
      className={cn(
        MENTION_CHIP_BASE_CLASSES,
        MENTION_CHIP_HOVER_CLASSES,
        "cursor-pointer",
      )}
      data-lab-link=""
      data-lab-link-state="resolved"
      onClick={() => onOpenLabLink(link)}
      title={href}
      type="button"
    >
      {board.title}
    </button>
  );
}

/**
 * Render an explicit `[label](buzz://lab?…)` as a UUID-resolved chip. Returns
 * `null` for malformed hrefs so the generic anchor renderer can take over.
 */
export function renderLabLinkAnchor({
  children,
  href,
  onOpenLabLink,
}: {
  anchorProps: React.ComponentPropsWithoutRef<"a">;
  children: React.ReactNode;
  href: string | undefined;
  onOpenLabLink: (link: ParsedLabLink) => void;
}): React.ReactElement | null {
  if (!href) return null;

  const parsed = parseLabLink(href);
  if (!parsed.ok) return null;

  return (
    <LabBoardReference
      href={href}
      link={parsed.value}
      onOpenLabLink={onOpenLabLink}
    >
      {children}
    </LabBoardReference>
  );
}

/**
 * Factory for the markdown `components` map's `"lab-link"` entry — the bare
 * pasted-URL case (see `remarkLabLinks`). A factory rather than a plain
 * component because `interactive` is a build-time flag baked into the whole
 * `components` map (see `createMarkdownComponents` in markdown.tsx), not
 * something available from `MarkdownRuntimeContext`. Mirrored by
 * `createMarkdownMessageLinkComponent` in `./MessageLinkPill.tsx` for
 * `"message-link"`.
 */
export function createMarkdownLabLinkComponent(interactive: boolean) {
  return function MarkdownLabLink({
    children,
  }: {
    children?: React.ReactNode;
  }) {
    const { onOpenLabLink } = useMarkdownRuntime();
    const href = String(children ?? "");
    const parsed = parseLabLink(href);
    if (!parsed.ok) {
      // Malformed `buzz://lab?…` — render the raw URL as plain text rather
      // than a misleading clickable pill.
      return <span data-lab-link="">{href}</span>;
    }

    return (
      <LabLinkPill
        href={href}
        interactive={interactive}
        link={parsed.value}
        onOpenLabLink={onOpenLabLink}
      />
    );
  };
}
