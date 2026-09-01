import type { LabBoardSuggestion } from "@/features/lab/lib/useLabLinks";
import { LabBoardAutocomplete } from "@/features/lab/ui/LabBoardAutocomplete";
import type {
  ComposerLinkSuggestion,
  UseComposerLinksResult,
} from "@/features/messages/lib/useComposerLinks";
import type { ChannelSuggestion } from "@/features/messages/lib/useChannelLinks";

import { ChannelAutocomplete } from "./ChannelAutocomplete";

type ComposerLinkAutocompleteProps = {
  composerOwnsFocus: boolean;
  links: UseComposerLinksResult;
  onSelect: (suggestion: ComposerLinkSuggestion) => void;
};

export function ComposerLinkAutocomplete({
  composerOwnsFocus,
  links,
  onSelect,
}: ComposerLinkAutocompleteProps) {
  const selectChannel = (suggestion: ChannelSuggestion) => {
    onSelect({ kind: "channel", suggestion });
  };
  const selectLabBoard = (suggestion: LabBoardSuggestion) => {
    onSelect({ kind: "lab-board", suggestion });
  };

  return (
    <>
      {composerOwnsFocus ? (
        <LabBoardAutocomplete
          onSelect={selectLabBoard}
          selectedIndex={links.labLinks.labBoardSelectedIndex}
          suggestions={
            links.labLinks.isLabBoardOpen
              ? links.labLinks.labBoardSuggestions
              : []
          }
        />
      ) : null}
      <ChannelAutocomplete
        composerOwnsFocus={composerOwnsFocus}
        onSelect={selectChannel}
        selectedIndex={links.channelLinks.channelSelectedIndex}
        suggestions={
          links.channelLinks.isChannelOpen
            ? links.channelLinks.channelSuggestions
            : []
        }
      />
    </>
  );
}
