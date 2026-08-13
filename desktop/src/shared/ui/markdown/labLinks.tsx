import * as React from "react";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import { type ParsedLabLink, parseLabLink } from "@/features/lab/lib/labLink";

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
 * Render an inline anchor for an explicit `[label](buzz://lab?…)` link that
 * navigates in-app instead of handing the URL to the OS. Returns `null` when
 * the href does not parse so the caller can fall through to its default
 * anchor. Mirrors `renderEntityLinkAnchor`.
 */
export function renderLabLinkAnchor({
  anchorProps,
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
    <a
      {...anchorProps}
      className="font-medium text-primary underline underline-offset-4 transition-colors hover:text-primary/80 cursor-pointer"
      href={href}
      onClick={(event) => {
        event.preventDefault();
        onOpenLabLink(parsed.value);
      }}
    >
      {children}
    </a>
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
