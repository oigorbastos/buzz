/**
 * TanStack Query bindings for Lab Boards.
 *
 * Query key roots (`lab-boards`, `lab-board`, `lab-board-history`) are
 * registered in `@/shared/api/relayQueryInvalidation` so the screen refetches
 * after a relay reconnect instead of showing a stale head — which for a
 * compare-and-swap surface would mean every save failing on a conflict the
 * user cannot see the cause of.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createBoard,
  fetchBoardHead,
  fetchBoardHeads,
  fetchBoardHistory,
  type LabBoardHead,
  type LabBoardRevision,
  restoreBoardRevision,
  updateBoard,
} from "@/features/lab/api";

export const labBoardsQueryKey = ["lab-boards"] as const;

export function labBoardQueryKey(boardId: string) {
  return ["lab-board", boardId] as const;
}

export function labBoardHistoryQueryKey(boardId: string) {
  return ["lab-board-history", boardId] as const;
}

export function useLabBoardsQuery() {
  return useQuery({
    queryKey: labBoardsQueryKey,
    queryFn: fetchBoardHeads,
    staleTime: 30_000,
  });
}

/**
 * Read a board's head.
 *
 * `pollWhileEditing` turns on a slow refetch. It exists so the editor can
 * tell the user that someone else advanced the board *while they are still
 * typing*, instead of letting them finish and only then be refused. Without
 * it the staleness banner could never fire — `refetchOnWindowFocus` is off
 * globally, so nothing else would move this query.
 *
 * The polled value is only ever used to warn and to render; the revision a
 * draft is saved against is captured separately when editing begins and must
 * not come from here (see `LabBoardView`).
 */
export function useLabBoardQuery(
  boardId: string | null,
  pollWhileEditing = false,
) {
  return useQuery({
    enabled: boardId !== null,
    queryKey: labBoardQueryKey(boardId ?? "none"),
    queryFn: () => {
      if (!boardId) throw new Error("No board selected.");
      return fetchBoardHead(boardId);
    },
    // No staleTime: the head doubles as the CAS token, so a cached one that
    // has been superseded turns the next save into a conflict.
    staleTime: 0,
    refetchInterval: pollWhileEditing ? 15_000 : false,
  });
}

export function useLabBoardHistoryQuery(
  boardId: string | null,
  enabled: boolean,
) {
  return useQuery({
    enabled: enabled && boardId !== null,
    queryKey: labBoardHistoryQueryKey(boardId ?? "none"),
    queryFn: () => {
      if (!boardId) throw new Error("No board selected.");
      return fetchBoardHistory(boardId);
    },
    staleTime: 30_000,
  });
}

export function useCreateLabBoardMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createBoard,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: labBoardsQueryKey });
    },
  });
}

export function useUpdateLabBoardMutation(boardId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      head: LabBoardHead;
      content: string;
      title?: string;
      summary?: string;
    }) => updateBoard(input),
    onSuccess: () => invalidateBoard(queryClient, boardId),
  });
}

export function useRestoreLabBoardMutation(boardId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { head: LabBoardHead; revision: LabBoardRevision }) =>
      restoreBoardRevision(input),
    onSuccess: () => invalidateBoard(queryClient, boardId),
  });
}

/**
 * After any accepted mutation the head advanced, so the cached head, the
 * history, and the board list are all stale together — invalidate as a set.
 */
function invalidateBoard(
  queryClient: ReturnType<typeof useQueryClient>,
  boardId: string | null,
) {
  void queryClient.invalidateQueries({ queryKey: labBoardsQueryKey });
  if (!boardId) return;
  void queryClient.invalidateQueries({ queryKey: labBoardQueryKey(boardId) });
  void queryClient.invalidateQueries({
    queryKey: labBoardHistoryQueryKey(boardId),
  });
}
