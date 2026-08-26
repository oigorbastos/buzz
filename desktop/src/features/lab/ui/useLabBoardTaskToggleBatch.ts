import * as React from "react";

import {
  fetchBoardHead,
  isBoardConflictError,
  type LabBoardHead,
} from "@/features/lab/api";
import {
  applyTaskToggles,
  queueTaskToggle,
  readTaskCheckboxAtLine,
  type TaskToggle,
} from "@/features/lab/taskToggles";

const IDLE_FLUSH_MS = 2_000;
const MAX_BATCH_AGE_MS = 10_000;

type UpdateBoard = (input: {
  head: LabBoardHead;
  content: string;
}) => Promise<unknown>;

type UseLabBoardTaskToggleBatchInput = {
  board: LabBoardHead | null;
  boardId: string;
  enabled: boolean;
  updateBoard: UpdateBoard;
  onMessage: (message: string | null) => void;
};

function togglesFrom(
  desiredByLine: ReadonlyMap<number, boolean>,
): TaskToggle[] {
  return Array.from(desiredByLine, ([line, nextChecked]) => ({
    line,
    nextChecked,
  }));
}

function droppedLinesMessage(lines: readonly number[]): string {
  const label = lines.length === 1 ? "line" : "lines";
  return `Task ${label} ${lines.join(", ")} changed before it could be saved. Other task updates were kept.`;
}

function isHeadCurrent(
  board: LabBoardHead | null,
  confirmedHead: LabBoardHead,
): boolean {
  return (
    board?.boardId === confirmedHead.boardId &&
    (board.headEventId === confirmedHead.headEventId ||
      board.revision >= confirmedHead.revision)
  );
}

function displayedHead(
  board: LabBoardHead | null,
  confirmedHead: LabBoardHead | null,
  boardId: string,
): LabBoardHead | null {
  if (
    confirmedHead?.boardId === boardId &&
    (board === null || board.boardId === boardId) &&
    !isHeadCurrent(board, confirmedHead)
  ) {
    return confirmedHead;
  }
  return board;
}

/**
 * Batches task-list checkbox updates over the live Lab Board head.
 *
 * The queue stores desired states rather than flips, so applying it to a
 * freshly fetched head is safe to repeat after one compare-and-swap conflict.
 */
export function useLabBoardTaskToggleBatch({
  board,
  boardId,
  enabled,
  updateBoard,
  onMessage,
}: UseLabBoardTaskToggleBatchInput) {
  const desiredByLineRef = React.useRef(new Map<number, boolean>());
  const idleTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxAgeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const flushPromiseRef = React.useRef<Promise<boolean> | null>(null);
  const flushRef = React.useRef<() => Promise<boolean>>(async () => true);
  const boardRef = React.useRef(board);
  const confirmedHeadRef = React.useRef<LabBoardHead | null>(null);
  const enabledRef = React.useRef(enabled);
  const updateBoardRef = React.useRef(updateBoard);
  const onMessageRef = React.useRef(onMessage);
  const [, bumpQueueVersion] = React.useReducer(
    (version: number) => version + 1,
    0,
  );
  const [isFlushing, setIsFlushing] = React.useState(false);
  const [confirmedHead, setConfirmedHead] = React.useState<LabBoardHead | null>(
    null,
  );
  const wasEnabledRef = React.useRef(enabled);

  boardRef.current = board;
  enabledRef.current = enabled;
  updateBoardRef.current = updateBoard;
  onMessageRef.current = onMessage;

  const clearFlushTimers = React.useCallback(() => {
    if (idleTimerRef.current !== null) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    if (maxAgeTimerRef.current !== null) {
      clearTimeout(maxAgeTimerRef.current);
      maxAgeTimerRef.current = null;
    }
  }, []);

  const reconcileWithHead = React.useCallback(
    (head: LabBoardHead) => {
      if (head.boardId !== boardId) return;
      let changed = false;
      for (const [line, nextChecked] of desiredByLineRef.current) {
        if (readTaskCheckboxAtLine(head.content, line) === nextChecked) {
          desiredByLineRef.current.delete(line);
          changed = true;
        }
      }
      if (changed) bumpQueueVersion();
    },
    [boardId],
  );

  const flush = React.useCallback((): Promise<boolean> => {
    if (flushPromiseRef.current !== null) return flushPromiseRef.current;
    if (desiredByLineRef.current.size === 0) {
      clearFlushTimers();
      return Promise.resolve(true);
    }

    clearFlushTimers();
    setIsFlushing(true);
    const run = async (): Promise<boolean> => {
      const droppedLines = new Set<number>();

      const prepare = (head: LabBoardHead) => {
        const result = applyTaskToggles(
          head.content,
          togglesFrom(desiredByLineRef.current),
        );
        for (const line of result.droppedLines) {
          desiredByLineRef.current.delete(line);
          droppedLines.add(line);
        }
        if (result.droppedLines.length) bumpQueueVersion();
        return result;
      };

      const save = async (head: LabBoardHead): Promise<boolean> => {
        const update = prepare(head);
        if (update.applied.length === 0) return true;
        await updateBoardRef.current({ head, content: update.content });
        return true;
      };

      try {
        let head = await fetchBoardHead(boardId);
        if (!head) {
          onMessageRef.current(
            "This board is no longer available for editing.",
          );
          return false;
        }

        try {
          await save(head);
        } catch (error) {
          if (!isBoardConflictError(error)) throw error;
          head = await fetchBoardHead(boardId);
          if (!head) {
            onMessageRef.current(
              "This board changed and is no longer available for editing.",
            );
            return false;
          }
          try {
            await save(head);
          } catch (retryError) {
            if (isBoardConflictError(retryError)) {
              onMessageRef.current(
                "This board changed again while task updates were being saved. Their checked state remains visible; try again after it reloads.",
              );
              return false;
            }
            throw retryError;
          }
        }

        const settledHead = await fetchBoardHead(boardId);
        if (settledHead) {
          confirmedHeadRef.current = settledHead;
          setConfirmedHead(settledHead);
          reconcileWithHead(settledHead);
          if (desiredByLineRef.current.size > 0) {
            onMessageRef.current(
              "This board changed again after the task update was saved. Their checked state remains visible; reload before trying again.",
            );
            return false;
          }
        } else {
          onMessageRef.current(
            "The task update was sent, but the latest board head could not be confirmed. Its checked state remains visible; try again after it reloads.",
          );
          return false;
        }
        if (droppedLines.size > 0) {
          onMessageRef.current(droppedLinesMessage([...droppedLines].sort()));
        }
        return true;
      } catch (error) {
        onMessageRef.current(
          error instanceof Error
            ? error.message
            : "Failed to save task checkbox updates.",
        );
        return false;
      }
    };

    const promise = run().finally(() => {
      flushPromiseRef.current = null;
      setIsFlushing(false);
    });
    flushPromiseRef.current = promise;
    return promise;
  }, [boardId, clearFlushTimers, reconcileWithHead]);

  flushRef.current = flush;

  const scheduleFlush = React.useCallback(() => {
    if (desiredByLineRef.current.size === 0) {
      clearFlushTimers();
      return;
    }
    if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      idleTimerRef.current = null;
      void flushRef.current();
    }, IDLE_FLUSH_MS);
    if (maxAgeTimerRef.current === null) {
      maxAgeTimerRef.current = setTimeout(() => {
        maxAgeTimerRef.current = null;
        void flushRef.current();
      }, MAX_BATCH_AGE_MS);
    }
  }, [clearFlushTimers]);

  const onToggleTask = React.useCallback(
    (line: number, nextChecked: boolean) => {
      if (!enabledRef.current || flushPromiseRef.current !== null) {
        return;
      }
      const currentBoard = displayedHead(
        boardRef.current,
        confirmedHeadRef.current,
        boardId,
      );
      if (!currentBoard) return;

      const queued = queueTaskToggle({
        content: currentBoard.content,
        toggles: desiredByLineRef.current,
        inFlightLines: new Map(),
        line,
        nextChecked,
      });
      if (!queued.accepted) {
        onMessageRef.current(
          `Task line ${line} changed before it could be updated. Nothing was saved.`,
        );
        return;
      }

      desiredByLineRef.current = queued.toggles;
      onMessageRef.current(null);
      bumpQueueVersion();
      scheduleFlush();
    },
    [boardId, scheduleFlush],
  );

  React.useEffect(() => {
    const wasEnabled = wasEnabledRef.current;
    wasEnabledRef.current = enabled;
    if (
      wasEnabled &&
      !enabled &&
      desiredByLineRef.current.size > 0 &&
      flushPromiseRef.current === null
    ) {
      void flushRef.current();
    }
  }, [enabled]);

  React.useEffect(() => {
    if (!board) return;
    const lastConfirmedHead = confirmedHeadRef.current;
    if (lastConfirmedHead && isHeadCurrent(board, lastConfirmedHead)) {
      confirmedHeadRef.current = null;
      setConfirmedHead(null);
    }
    if (!lastConfirmedHead || isHeadCurrent(board, lastConfirmedHead)) {
      reconcileWithHead(board);
    }
  }, [board, reconcileWithHead]);

  React.useEffect(
    () => () => {
      clearFlushTimers();
      void flushRef.current();
    },
    [clearFlushTimers],
  );

  const currentDisplayedHead = displayedHead(board, confirmedHead, boardId);
  const awaitingBoardSync =
    confirmedHead !== null && currentDisplayedHead === confirmedHead;
  const optimisticContent = applyTaskToggles(
    currentDisplayedHead?.content ?? "",
    togglesFrom(desiredByLineRef.current),
  ).content;

  return {
    flush,
    hasPending: awaitingBoardSync || desiredByLineRef.current.size > 0,
    isFlushing,
    onToggleTask,
    optimisticContent,
  };
}
