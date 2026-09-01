import * as React from "react";
import { toast } from "sonner";

import {
  applyTaskToggles,
  queueTaskToggle,
  type TaskToggle,
} from "@/features/lab/taskToggles";
import type { TimelineMessage } from "@/features/messages/types";

const IDLE_FLUSH_MS = 2_000;
const MAX_BATCH_AGE_MS = 10_000;
const RETAINED_EDIT_TAG_PREFIXES = new Set(["imeta", "emoji", "mention"]);

export type MessageTaskToggleEdit = {
  content: string;
  eventId: string;
  mediaTags: string[][];
  mentionPubkeys: string[];
};

type UpdateMessage = (input: MessageTaskToggleEdit) => Promise<unknown>;

type ConfirmedEdit = {
  content: string;
  sourceContent: string;
};

type MessageTaskToggleConsumer = {
  enabled: boolean;
  message: TimelineMessage;
  notify: () => void;
};

type MessageTaskToggleBatch = {
  confirmedEdit: ConfirmedEdit | null;
  consumers: Map<symbol, MessageTaskToggleConsumer>;
  desiredByLine: Map<number, boolean>;
  eventId: string;
  flushPromise: Promise<boolean> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  isFlushing: boolean;
  maxAgeTimer: ReturnType<typeof setTimeout> | null;
  message: TimelineMessage;
};

type MessageTaskToggleView = {
  hasPending: boolean;
  isFlushing: boolean;
  optimisticContent: string;
};

function togglesFrom(
  desiredByLine: ReadonlyMap<number, boolean>,
): TaskToggle[] {
  return Array.from(desiredByLine, ([line, nextChecked]) => ({
    line,
    nextChecked,
  }));
}

function retainedEditTags(tags: string[][] | undefined): string[][] {
  return (tags ?? []).filter((tag) =>
    RETAINED_EDIT_TAG_PREFIXES.has(tag[0] ?? ""),
  );
}

function displayedContent(
  message: TimelineMessage,
  confirmedEdit: ConfirmedEdit | null,
): string {
  return confirmedEdit?.sourceContent === message.body
    ? confirmedEdit.content
    : message.body;
}

function droppedLinesMessage(lines: readonly number[]): string {
  const label = lines.length === 1 ? "line" : "lines";
  return `Task ${label} ${lines.join(", ")} changed before it could be saved. Other task updates were kept.`;
}

/**
 * Provider-owned queue registry. A message can appear in the timeline and its
 * thread at the same time, so the batch must be keyed by event id rather than
 * by an individual MessageRow instance.
 */
class MessageTaskToggleStore {
  private readonly batches = new Map<string, MessageTaskToggleBatch>();
  private updateMessage: UpdateMessage | null;

  constructor(updateMessage: UpdateMessage | null) {
    this.updateMessage = updateMessage;
  }

  setUpdateMessage(updateMessage: UpdateMessage) {
    this.updateMessage = updateMessage;
  }

  register(input: {
    consumerId: symbol;
    enabled: boolean;
    eventId: string;
    message: TimelineMessage;
    notify: () => void;
  }): () => void {
    const batch = this.getOrCreateBatch(input.eventId, input.message);
    batch.consumers.set(input.consumerId, {
      enabled: input.enabled,
      message: input.message,
      notify: input.notify,
    });
    if (this.syncBatchMessage(batch, input.message)) this.notify(batch);
    return () => this.unregister(input.eventId, input.consumerId);
  }

  syncConsumer(input: {
    consumerId: symbol;
    enabled: boolean;
    eventId: string;
    message: TimelineMessage;
  }) {
    const batch = this.batches.get(input.eventId);
    const consumer = batch?.consumers.get(input.consumerId);
    if (!batch || !consumer) return;

    const wasEnabled = this.hasEnabledConsumer(batch);
    consumer.enabled = input.enabled;
    consumer.message = input.message;
    const contentChanged = this.syncBatchMessage(batch, input.message);
    if (contentChanged) this.notify(batch);
    if (
      wasEnabled &&
      !this.hasEnabledConsumer(batch) &&
      batch.desiredByLine.size > 0 &&
      batch.flushPromise === null
    ) {
      void this.flushBatch(batch);
    }
  }

  view(
    eventId: string,
    fallbackMessage: TimelineMessage,
  ): MessageTaskToggleView {
    const batch = this.batches.get(eventId);
    if (!batch) {
      return {
        hasPending: false,
        isFlushing: false,
        optimisticContent: fallbackMessage.body,
      };
    }
    return {
      hasPending: batch.desiredByLine.size > 0 || batch.isFlushing,
      isFlushing: batch.isFlushing,
      optimisticContent: applyTaskToggles(
        displayedContent(batch.message, batch.confirmedEdit),
        togglesFrom(batch.desiredByLine),
      ).content,
    };
  }

  queue(eventId: string, line: number, nextChecked: boolean) {
    const batch = this.batches.get(eventId);
    if (!batch || batch.isFlushing || !this.hasEnabledConsumer(batch)) {
      return;
    }

    const queued = queueTaskToggle({
      content: displayedContent(batch.message, batch.confirmedEdit),
      inFlightLines: new Map(),
      line,
      nextChecked,
      toggles: batch.desiredByLine,
    });
    if (!queued.accepted) {
      toast.error(
        `Task line ${line} changed before it could be updated. Nothing was saved.`,
      );
      return;
    }

    batch.desiredByLine = queued.toggles;
    this.notify(batch);
    this.scheduleFlush(batch);
  }

  flush(eventId: string): Promise<boolean> {
    const batch = this.batches.get(eventId);
    return batch ? this.flushBatch(batch) : Promise.resolve(true);
  }

  flushAll() {
    for (const batch of this.batches.values()) {
      this.clearFlushTimers(batch);
      if (batch.desiredByLine.size > 0 && batch.flushPromise === null) {
        void this.flushBatch(batch);
      }
    }
  }

  private getOrCreateBatch(
    eventId: string,
    message: TimelineMessage,
  ): MessageTaskToggleBatch {
    const existing = this.batches.get(eventId);
    if (existing) return existing;
    const batch: MessageTaskToggleBatch = {
      confirmedEdit: null,
      consumers: new Map(),
      desiredByLine: new Map(),
      eventId,
      flushPromise: null,
      idleTimer: null,
      isFlushing: false,
      maxAgeTimer: null,
      message,
    };
    this.batches.set(eventId, batch);
    return batch;
  }

  private unregister(eventId: string, consumerId: symbol) {
    const batch = this.batches.get(eventId);
    if (!batch) return;

    batch.consumers.delete(consumerId);
    if (
      batch.consumers.size === 0 &&
      batch.desiredByLine.size > 0 &&
      batch.flushPromise === null
    ) {
      void this.flushBatch(batch);
      return;
    }
    this.disposeUnusedBatch(batch);
  }

  private hasEnabledConsumer(batch: MessageTaskToggleBatch): boolean {
    return Array.from(batch.consumers.values()).some(
      (consumer) => consumer.enabled,
    );
  }

  private syncBatchMessage(
    batch: MessageTaskToggleBatch,
    message: TimelineMessage,
  ): boolean {
    const contentBefore = displayedContent(batch.message, batch.confirmedEdit);
    const confirmed = batch.confirmedEdit;

    if (confirmed !== null) {
      if (message.body === confirmed.sourceContent) {
        // Do not let a late-rendering stale surface replace the optimistic
        // success that another surface has already received from the cache.
        if (batch.message.body === confirmed.content) return false;
        batch.message = message;
      } else if (message.body === confirmed.content) {
        // The cache has caught up with this write. Keep the confirmation so a
        // virtualized sibling still carrying sourceContent cannot regress it.
        batch.message = message;
      } else {
        // A body unrelated to this write is an authoritative external edit.
        batch.message = message;
        batch.confirmedEdit = null;
      }
    } else {
      batch.message = message;
    }
    return (
      contentBefore !== displayedContent(batch.message, batch.confirmedEdit)
    );
  }

  private notify(batch: MessageTaskToggleBatch) {
    for (const { notify } of batch.consumers.values()) {
      notify();
    }
  }

  private clearFlushTimers(batch: MessageTaskToggleBatch) {
    if (batch.idleTimer !== null) {
      clearTimeout(batch.idleTimer);
      batch.idleTimer = null;
    }
    if (batch.maxAgeTimer !== null) {
      clearTimeout(batch.maxAgeTimer);
      batch.maxAgeTimer = null;
    }
  }

  private scheduleFlush(batch: MessageTaskToggleBatch) {
    if (batch.desiredByLine.size === 0) {
      this.clearFlushTimers(batch);
      return;
    }
    if (batch.idleTimer !== null) clearTimeout(batch.idleTimer);
    batch.idleTimer = setTimeout(() => {
      batch.idleTimer = null;
      void this.flushBatch(batch);
    }, IDLE_FLUSH_MS);
    if (batch.maxAgeTimer === null) {
      batch.maxAgeTimer = setTimeout(() => {
        batch.maxAgeTimer = null;
        void this.flushBatch(batch);
      }, MAX_BATCH_AGE_MS);
    }
  }

  private flushBatch(batch: MessageTaskToggleBatch): Promise<boolean> {
    if (batch.flushPromise !== null) return batch.flushPromise;
    if (batch.desiredByLine.size === 0) {
      this.clearFlushTimers(batch);
      this.disposeUnusedBatch(batch);
      return Promise.resolve(true);
    }
    const update = this.updateMessage;
    if (!update) return Promise.resolve(false);

    this.clearFlushTimers(batch);
    batch.isFlushing = true;
    this.notify(batch);
    const run = async (): Promise<boolean> => {
      const latestMessage = batch.message;
      const sourceContent = displayedContent(
        latestMessage,
        batch.confirmedEdit,
      );
      const result = applyTaskToggles(
        sourceContent,
        togglesFrom(batch.desiredByLine),
      );
      let changed = false;

      for (const { line } of result.alreadyApplied) {
        changed = batch.desiredByLine.delete(line) || changed;
      }
      for (const line of result.droppedLines) {
        changed = batch.desiredByLine.delete(line) || changed;
      }

      if (result.applied.length === 0) {
        if (changed) this.notify(batch);
        if (result.droppedLines.length > 0) {
          toast.error(droppedLinesMessage([...result.droppedLines].sort()));
        }
        return true;
      }

      try {
        await update({
          content: result.content,
          eventId: batch.eventId,
          mediaTags: retainedEditTags(latestMessage.tags),
          // A checkbox toggle never adds a mention. Sending original p tags
          // would re-notify everyone referenced by the message.
          mentionPubkeys: [],
        });
        for (const { line, nextChecked } of result.applied) {
          if (batch.desiredByLine.get(line) === nextChecked) {
            batch.desiredByLine.delete(line);
            changed = true;
          }
        }
        batch.confirmedEdit = { content: result.content, sourceContent };
        if (changed) this.notify(batch);
        if (result.droppedLines.length > 0) {
          toast.error(droppedLinesMessage([...result.droppedLines].sort()));
        }
        return true;
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Failed to save task checkbox updates.",
        );
        return false;
      }
    };

    const promise = run().finally(() => {
      batch.flushPromise = null;
      batch.isFlushing = false;
      this.notify(batch);
      this.disposeUnusedBatch(batch);
    });
    batch.flushPromise = promise;
    return promise;
  }

  private disposeUnusedBatch(batch: MessageTaskToggleBatch) {
    if (batch.consumers.size === 0 && batch.flushPromise === null) {
      this.clearFlushTimers(batch);
      this.batches.delete(batch.eventId);
    }
  }
}

const MessageTaskToggleContext =
  React.createContext<MessageTaskToggleStore | null>(null);

type MessageTaskToggleProviderProps = {
  children: React.ReactNode;
  updateMessage: UpdateMessage;
};

/** Shares one event-keyed task queue across the channel's message surfaces. */
export function MessageTaskToggleProvider({
  children,
  updateMessage,
}: MessageTaskToggleProviderProps) {
  const storeRef = React.useRef<MessageTaskToggleStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = new MessageTaskToggleStore(updateMessage);
  }
  const store = storeRef.current;
  store.setUpdateMessage(updateMessage);

  React.useEffect(() => () => store.flushAll(), [store]);

  return React.createElement(
    MessageTaskToggleContext.Provider,
    { value: store },
    children,
  );
}

type UseMessageTaskToggleBatchInput = {
  enabled: boolean;
  message: TimelineMessage;
  /** Test seam; production callers use MessageTaskToggleProvider. */
  updateMessage?: UpdateMessage;
};

/**
 * Batches owned-message task checkbox edits by desired source-line state.
 * The provider centralizes an event's state so timeline and thread views stay
 * optimistic together and never issue competing last-write-wins edits.
 */
export function useMessageTaskToggleBatch({
  enabled,
  message,
  updateMessage: injectedUpdateMessage,
}: UseMessageTaskToggleBatchInput) {
  const providerStore = React.useContext(MessageTaskToggleContext);
  const standaloneStoreRef = React.useRef<MessageTaskToggleStore | null>(null);
  if (injectedUpdateMessage !== undefined) {
    if (standaloneStoreRef.current === null) {
      standaloneStoreRef.current = new MessageTaskToggleStore(
        injectedUpdateMessage,
      );
    } else {
      standaloneStoreRef.current.setUpdateMessage(injectedUpdateMessage);
    }
  }
  const store =
    injectedUpdateMessage !== undefined
      ? standaloneStoreRef.current
      : providerStore;
  const eventId = message.id;
  const consumerIdRef = React.useRef<symbol | null>(null);
  if (consumerIdRef.current === null) {
    consumerIdRef.current = Symbol("message-task-toggle-consumer");
  }
  const consumerId = consumerIdRef.current;
  const [, forceRender] = React.useReducer((version: number) => version + 1, 0);
  const notify = React.useCallback(() => forceRender(), []);
  const canToggle = enabled && store !== null;
  const latestConsumerRef = React.useRef({ enabled, message });
  latestConsumerRef.current = { enabled, message };

  React.useLayoutEffect(() => {
    if (!store) return;
    const latestConsumer = latestConsumerRef.current;
    return store.register({
      consumerId,
      enabled: latestConsumer.enabled,
      eventId,
      message: latestConsumer.message,
      notify,
    });
  }, [consumerId, eventId, notify, store]);

  React.useLayoutEffect(() => {
    store?.syncConsumer({
      consumerId,
      enabled,
      eventId,
      message,
    });
  }, [consumerId, enabled, eventId, message, store]);

  const flush = React.useCallback(
    () => store?.flush(eventId) ?? Promise.resolve(false),
    [eventId, store],
  );
  const onToggleTask = React.useCallback(
    (line: number, nextChecked: boolean) => {
      if (!canToggle || !store) return;
      store.queue(eventId, line, nextChecked);
    },
    [canToggle, eventId, store],
  );
  const view = store?.view(eventId, message) ?? {
    hasPending: false,
    isFlushing: false,
    optimisticContent: message.body,
  };

  return {
    canToggle,
    flush,
    hasPending: view.hasPending,
    isFlushing: view.isFlushing,
    onToggleTask,
    optimisticContent: view.optimisticContent,
  };
}
