import { cn } from "@/shared/lib/cn";
import {
  MENTION_CHIP_BASE_CLASSES,
  MENTION_CHIP_HOVER_CLASSES,
} from "@/shared/ui/mentionChip";

import type { LabLinkPillProps } from "./types";

/**
 * Inline pill for a bare pasted `buzz://lab?board=…` URL (see
 * `remarkLabLinks`). Unlike `MessageLinkPill`, there is no board list
 * threaded through the markdown runtime to resolve a title from — showing
 * one would mean fetching board metadata on every markdown render, most of
 * which never reference a board. The truncated board id + revision is enough
 * to recognize the link at a glance; the click still opens the real board.
 */
export function LabLinkPill({
  href,
  interactive,
  link,
  onOpenLabLink,
}: LabLinkPillProps) {
  const shortId = link.boardId.slice(0, 8);
  const label = (
    <>
      Board {shortId}
      {link.revision !== null ? ` · rev ${link.revision}` : ""}
    </>
  );

  if (!interactive) {
    return <span data-lab-link="">{label}</span>;
  }

  return (
    <button
      type="button"
      data-lab-link=""
      aria-label="Open Lab board"
      title={href}
      className={cn(
        "cursor-pointer",
        MENTION_CHIP_BASE_CLASSES,
        MENTION_CHIP_HOVER_CLASSES,
      )}
      onClick={() => {
        onOpenLabLink(link);
      }}
    >
      {label}
    </button>
  );
}
