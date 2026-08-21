import * as React from "react";

import {
  type LabBoardSuggestion,
  useLabLinks,
} from "@/features/lab/lib/useLabLinks";
import {
  type ChannelSuggestion,
  useChannelLinks,
} from "@/features/messages/lib/useChannelLinks";
import type { AutocompleteEdit } from "@/features/messages/lib/useRichTextEditor";

export type ComposerLinkSuggestion =
  | { kind: "channel"; suggestion: ChannelSuggestion }
  | { kind: "lab-board"; suggestion: LabBoardSuggestion };

export function useComposerLinks() {
  const rawChannelLinks = useChannelLinks();
  const labLinks = useLabLinks();
  const clearLinks = React.useCallback(() => {
    rawChannelLinks.clearChannels();
    labLinks.clearLabBoards();
  }, [rawChannelLinks.clearChannels, labLinks.clearLabBoards]);
  // useMentionSendFlow already owns the post-send channel cleanup. Extending
  // that same call to Lab closes a pending [[ popup after a successful send.
  const channelLinks = React.useMemo(
    () => ({ ...rawChannelLinks, clearChannels: clearLinks }),
    [rawChannelLinks, clearLinks],
  );

  const updateLinkQueries = React.useCallback(
    (value: string, cursorPosition: number) => {
      rawChannelLinks.updateChannelQuery(value, cursorPosition);
      labLinks.updateLabBoardQuery(value, cursorPosition);
    },
    [rawChannelLinks.updateChannelQuery, labLinks.updateLabBoardQuery],
  );

  const insertLink = React.useCallback(
    (target: ComposerLinkSuggestion, selectionEnd: number): AutocompleteEdit =>
      target.kind === "channel"
        ? rawChannelLinks.insertChannel(target.suggestion, selectionEnd)
        : labLinks.insertLabBoard(target.suggestion, selectionEnd),
    [rawChannelLinks.insertChannel, labLinks.insertLabBoard],
  );

  const handleLinkKeyDown = React.useCallback(
    (
      event: React.KeyboardEvent,
    ): { handled: boolean; suggestion?: ComposerLinkSuggestion } => {
      const labResult = labLinks.handleLabBoardKeyDown(event);
      if (labResult.handled) {
        return {
          handled: true,
          ...(labResult.suggestion
            ? {
                suggestion: {
                  kind: "lab-board" as const,
                  suggestion: labResult.suggestion,
                },
              }
            : {}),
        };
      }
      const channelResult = rawChannelLinks.handleChannelKeyDown(event);
      return {
        handled: channelResult.handled,
        ...(channelResult.suggestion
          ? {
              suggestion: {
                kind: "channel" as const,
                suggestion: channelResult.suggestion,
              },
            }
          : {}),
      };
    },
    [labLinks.handleLabBoardKeyDown, rawChannelLinks.handleChannelKeyDown],
  );

  return {
    channelLinks,
    clearLinks,
    handleLinkKeyDown,
    insertLink,
    isLinkOpen: channelLinks.isChannelOpen || labLinks.isLabBoardOpen,
    labLinks,
    updateLinkQueries,
  };
}

export type UseComposerLinksResult = ReturnType<typeof useComposerLinks>;
