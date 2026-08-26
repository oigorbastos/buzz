import * as React from "react";

import { boardReference, type LabBoardHead } from "@/features/lab/api";
import { useLabBoardsQuery } from "@/features/lab/hooks";
import { filterLabBoards } from "@/features/lab/model";
import { useUserProfileQuery } from "@/features/profile/hooks";
import { useIdentityQuery } from "@/shared/api/hooks";
import { detectPrefixQuery } from "@/shared/lib/detectPrefixQuery";
import type { AutocompleteEdit } from "@/features/messages/lib/useRichTextEditor";

export type LabBoardSuggestion = Pick<LabBoardHead, "boardId" | "title">;

const LAB_BOARD_QUERY_DEBOUNCE_MS = 120;

/** Escape a board title for the label position of a Markdown inline link. */
export function escapeLabBoardReferenceLabel(title: string): string {
  return title.replace(/[\r\n]+/g, " ").replace(/[\\[\]()]/g, "\\$&");
}

/** Build the canonical Markdown reference inserted by the composer. */
export function labBoardReferenceMarkdown(
  suggestion: LabBoardSuggestion,
): string {
  const label = escapeLabBoardReferenceLabel(suggestion.title);
  return `[${label}](${boardReference(suggestion.boardId)}) `;
}

/** Build the plain-text edit that replaces the complete `[[query` range. */
export function labBoardAutocompleteEdit(
  suggestion: LabBoardSuggestion,
  startIndex: number,
  selectionEnd: number,
): AutocompleteEdit {
  return {
    replaceFromOffset: startIndex,
    replaceToOffset: selectionEnd,
    insertText: labBoardReferenceMarkdown(suggestion),
  };
}

export function getLabBoardSuggestions(
  boards: readonly LabBoardHead[],
  query: string,
  currentPubkey: string | null | undefined,
  currentOwnerPubkey?: string | null,
): LabBoardSuggestion[] {
  const lowerQuery = query.toLowerCase();
  return filterLabBoards({
    boards,
    currentPubkey,
    currentOwnerPubkey,
    filter: "all",
    tag: null,
  })
    .filter((board) => board.title.toLowerCase().includes(lowerQuery))
    .slice(0, 8)
    .map(({ boardId, title }) => ({ boardId, title }));
}

export function useLabLinks() {
  const boardsQuery = useLabBoardsQuery();
  const identityQuery = useIdentityQuery();
  const currentProfileQuery = useUserProfileQuery(identityQuery.data?.pubkey);
  const [labBoardQuery, setLabBoardQuery] = React.useState<string | null>(null);
  const [labBoardStartIndex, setLabBoardStartIndex] = React.useState(0);
  const [labBoardSelectedIndex, setLabBoardSelectedIndex] = React.useState(0);
  const debounceTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const latestValueRef = React.useRef("");
  const latestCursorRef = React.useRef(0);

  const readableBoards = React.useMemo(
    () =>
      filterLabBoards({
        boards: boardsQuery.data ?? [],
        currentPubkey: identityQuery.data?.pubkey,
        currentOwnerPubkey: currentProfileQuery.data?.ownerPubkey,
        filter: "all",
        tag: null,
      }).map(({ boardId, title }) => ({ boardId, title })),
    [
      boardsQuery.data,
      identityQuery.data?.pubkey,
      currentProfileQuery.data?.ownerPubkey,
    ],
  );
  const knownTitlesLower = React.useMemo(
    () => readableBoards.map((board) => board.title.toLowerCase()),
    [readableBoards],
  );
  const knownTitlesLowerRef = React.useRef(knownTitlesLower);
  React.useEffect(() => {
    knownTitlesLowerRef.current = knownTitlesLower;
  }, [knownTitlesLower]);

  React.useEffect(
    () => () => {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
      }
    },
    [],
  );

  const labBoardSuggestions = React.useMemo(() => {
    if (labBoardQuery === null) return [];
    const lowerQuery = labBoardQuery.toLowerCase();
    return readableBoards
      .filter((board) => board.title.toLowerCase().includes(lowerQuery))
      .slice(0, 8);
  }, [labBoardQuery, readableBoards]);
  const isLabBoardOpen =
    labBoardQuery !== null && labBoardSuggestions.length > 0;

  const insertLabBoard = React.useCallback(
    (
      suggestion: LabBoardSuggestion,
      selectionEnd: number,
    ): AutocompleteEdit => {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      setLabBoardQuery(null);
      setLabBoardSelectedIndex(0);
      return labBoardAutocompleteEdit(
        suggestion,
        labBoardStartIndex,
        selectionEnd,
      );
    },
    [labBoardStartIndex],
  );

  const updateLabBoardQuery = React.useCallback(
    (value: string, cursorPosition: number) => {
      latestValueRef.current = value;
      latestCursorRef.current = cursorPosition;
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        const match = detectPrefixQuery(
          "[[",
          latestValueRef.current,
          latestCursorRef.current,
          knownTitlesLowerRef.current,
        );
        if (match) {
          setLabBoardQuery(match.query);
          setLabBoardStartIndex(match.startIndex);
          setLabBoardSelectedIndex(0);
        } else {
          setLabBoardQuery(null);
        }
      }, LAB_BOARD_QUERY_DEBOUNCE_MS);
    },
    [],
  );

  const clearLabBoards = React.useCallback(() => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    setLabBoardQuery(null);
    setLabBoardSelectedIndex(0);
  }, []);

  const handleLabBoardKeyDown = React.useCallback(
    (
      event: React.KeyboardEvent,
    ): { handled: boolean; suggestion?: LabBoardSuggestion } => {
      if (!isLabBoardOpen) return { handled: false };
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setLabBoardSelectedIndex((current) =>
          current < labBoardSuggestions.length - 1 ? current + 1 : 0,
        );
        return { handled: true };
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setLabBoardSelectedIndex((current) =>
          current > 0 ? current - 1 : labBoardSuggestions.length - 1,
        );
        return { handled: true };
      }
      if (
        event.key === "Tab" ||
        (event.key === "Enter" &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          !event.shiftKey)
      ) {
        event.preventDefault();
        return {
          handled: true,
          suggestion: labBoardSuggestions[labBoardSelectedIndex],
        };
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setLabBoardQuery(null);
        return { handled: true };
      }
      return { handled: false };
    },
    [isLabBoardOpen, labBoardSelectedIndex, labBoardSuggestions],
  );

  return {
    clearLabBoards,
    handleLabBoardKeyDown,
    insertLabBoard,
    isLabBoardOpen,
    labBoardQuery,
    labBoardSelectedIndex,
    labBoardSuggestions,
    updateLabBoardQuery,
  };
}

export type UseLabLinksResult = ReturnType<typeof useLabLinks>;
