import type * as React from "react";

import { parseMessageLink } from "@/features/messages/lib/messageLink";
import { cn } from "@/shared/lib/cn";
import {
  MENTION_CHIP_BASE_CLASSES,
  MENTION_CHIP_HOVER_CLASSES,
} from "@/shared/ui/mentionChip";

import { useMarkdownRuntime } from "./runtimeContext";
import type { MessageLinkPillProps } from "./types";

export function MessageLinkPill({
  channels,
  href,
  interactive,
  link,
  onOpenMessageLink,
}: MessageLinkPillProps) {
  const channel = channels.find((c) => c.id === link.channelId);
  const channelLabel = channel?.name ?? "channel";
  const shortId = link.messageId.slice(0, 6);
  const label = (
    <>
      #{channelLabel} · {shortId}
    </>
  );

  if (!interactive) {
    return <span data-message-link="">{label}</span>;
  }

  return (
    <button
      type="button"
      data-message-link=""
      aria-label={`Open message in ${channelLabel}`}
      title={href}
      className={cn(
        "cursor-pointer",
        MENTION_CHIP_BASE_CLASSES,
        MENTION_CHIP_HOVER_CLASSES,
      )}
      onClick={() => {
        onOpenMessageLink(link);
      }}
    >
      {label}
    </button>
  );
}

/**
 * Factory for the markdown `components` map's `"message-link"` entry — the
 * bare pasted-URL case (see `remarkMessageLinks`). A factory rather than a
 * plain component because `interactive` is a build-time flag baked into the
 * whole `components` map (see `createMarkdownComponents` in markdown.tsx),
 * not something available from `MarkdownRuntimeContext`. Mirrored by
 * `createMarkdownLabLinkComponent` in `./labLinks.tsx` for `"lab-link"`.
 */
export function createMarkdownMessageLinkComponent(interactive: boolean) {
  return function MarkdownMessageLink({
    children,
  }: {
    children?: React.ReactNode;
  }) {
    const { channels, onOpenMessageLink } = useMarkdownRuntime();
    const href = String(children ?? "");
    const parsed = parseMessageLink(href);
    if (!parsed.ok) {
      // Malformed `buzz://message?…` — render the raw URL as plain text
      // rather than a misleading clickable pill.
      return <span data-message-link="">{href}</span>;
    }

    return (
      <MessageLinkPill
        channels={channels}
        href={href}
        interactive={interactive}
        link={parsed.value}
        onOpenMessageLink={onOpenMessageLink}
      />
    );
  };
}
