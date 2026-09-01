import assert from "node:assert/strict";
import { after, afterEach, before, mock, test } from "node:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import * as React from "react";

import { useEditMessageMutation } from "@/features/messages/hooks";
import { canManageMessageForCurrentUser } from "./canManageMessage.ts";
import {
  MessageTaskToggleProvider,
  useMessageTaskToggleBatch,
} from "./useMessageTaskToggleBatch.ts";

const CHANNEL_ID = "0f2b8a1c-1111-4222-8333-444455556666";
const SELF_PUBKEY = "a".repeat(64);
const OWNED_AGENT_PUBKEY = "b".repeat(64);
const THIRD_PARTY_PUBKEY = "c".repeat(64);
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

before(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
  });
  dom.window.__TAURI_INTERNALS__ = {
    invoke: async (command) => {
      if (command === "get_relay_self") return null;
      throw new Error(`Unexpected Tauri command: ${command}`);
    },
  };
});

afterEach(async () => {
  mock.timers.reset();
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});

after(() => dom.window.close());

function message(overrides = {}) {
  return {
    author: "Alice",
    body: "- [ ] first\n- [ ] second\n- [ ] third\n- [ ] fourth",
    createdAt: 1,
    depth: 0,
    id: "message-1",
    pubkey: SELF_PUBKEY,
    tags: [],
    time: "now",
    ...overrides,
  };
}

test("a burst saves one message edit with desired checkbox states", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const updates = [];
  const updateMessage = async (input) => updates.push(input);
  const { act, renderHook } = await import("@testing-library/react");
  const { result, unmount } = renderHook(() =>
    useMessageTaskToggleBatch({
      enabled: true,
      message: message(),
      updateMessage,
    }),
  );

  act(() => {
    result.current.onToggleTask(1, true);
    result.current.onToggleTask(2, true);
  });
  assert.match(result.current.optimisticContent, /- \[x\] first/);
  assert.match(result.current.optimisticContent, /- \[x\] second/);
  mock.timers.tick(1_999);
  assert.equal(updates.length, 0);

  await act(async () => {
    mock.timers.tick(1);
    await result.current.flush();
  });

  assert.equal(updates.length, 1);
  assert.equal(
    updates[0].content,
    "- [x] first\n- [x] second\n- [ ] third\n- [ ] fourth",
  );
  unmount();
});

test("timeline and thread consumers share one event batch", async () => {
  const updates = [];
  const updateMessage = async (input) => updates.push(input);
  const wrapper = ({ children }) =>
    React.createElement(MessageTaskToggleProvider, { updateMessage }, children);
  const { act, renderHook } = await import("@testing-library/react");
  const { result, unmount } = renderHook(
    () => [
      useMessageTaskToggleBatch({ enabled: true, message: message() }),
      useMessageTaskToggleBatch({ enabled: true, message: message() }),
    ],
    { wrapper },
  );

  act(() => {
    result.current[0].onToggleTask(1, true);
    result.current[1].onToggleTask(2, true);
  });
  assert.match(result.current[0].optimisticContent, /- \[x\] first/);
  assert.match(result.current[1].optimisticContent, /- \[x\] second/);

  await act(async () => {
    await result.current[0].flush();
  });

  assert.equal(updates.length, 1);
  assert.equal(
    updates[0].content,
    "- [x] first\n- [x] second\n- [ ] third\n- [ ] fourth",
  );
  unmount();
});

test("a late stale surface cannot undo a confirmed checkbox update", async () => {
  const updateMessage = async () => undefined;
  const wrapper = ({ children }) =>
    React.createElement(MessageTaskToggleProvider, { updateMessage }, children);
  const staleMessage = message();
  const cachedMessage = message({
    body: "- [x] first\n- [ ] second\n- [ ] third\n- [ ] fourth",
  });
  const { act, renderHook } = await import("@testing-library/react");
  const { result, rerender, unmount } = renderHook(
    (input) => [
      useMessageTaskToggleBatch({
        enabled: true,
        message: input.timelineMessage,
      }),
      useMessageTaskToggleBatch({
        enabled: true,
        message: input.threadMessage,
      }),
    ],
    {
      initialProps: {
        threadMessage: staleMessage,
        timelineMessage: staleMessage,
      },
      wrapper,
    },
  );

  act(() => result.current[0].onToggleTask(1, true));
  await act(async () => {
    await result.current[0].flush();
  });
  act(() => {
    rerender({
      threadMessage: cachedMessage,
      timelineMessage: cachedMessage,
    });
  });
  act(() => {
    rerender({
      threadMessage: staleMessage,
      timelineMessage: cachedMessage,
    });
  });

  assert.match(result.current[0].optimisticContent, /- \[x\] first/);
  assert.match(result.current[1].optimisticContent, /- \[x\] first/);
  unmount();
});

test("a newly mounted surface repaints an external edit for every consumer", async () => {
  const updateMessage = async () => undefined;
  const tasks = new Map();
  const staleMessage = message();
  const externalMessage = message({ body: "- [ ] edited elsewhere" });

  function TaskConsumer({ surface, taskMessage }) {
    const task = useMessageTaskToggleBatch({
      enabled: true,
      message: taskMessage,
    });
    React.useLayoutEffect(() => {
      tasks.set(surface, task);
      return () => tasks.delete(surface);
    }, [surface, task]);
    return null;
  }

  function Surfaces({ includeThread }) {
    return React.createElement(
      MessageTaskToggleProvider,
      { updateMessage },
      React.createElement(TaskConsumer, {
        surface: "timeline",
        taskMessage: staleMessage,
      }),
      includeThread
        ? React.createElement(TaskConsumer, {
            surface: "thread",
            taskMessage: externalMessage,
          })
        : null,
    );
  }

  const { act, render } = await import("@testing-library/react");
  const rendered = render(
    React.createElement(Surfaces, { includeThread: false }),
  );

  act(() => tasks.get("timeline").onToggleTask(1, true));
  await act(async () => {
    await tasks.get("timeline").flush();
  });
  act(() => {
    rendered.rerender(React.createElement(Surfaces, { includeThread: true }));
  });

  assert.match(tasks.get("timeline").optimisticContent, /edited elsewhere/);
  assert.match(tasks.get("thread").optimisticContent, /edited elsewhere/);
  rendered.unmount();
});

test("the maximum batch age saves while clicks keep resetting idle time", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const updates = [];
  const { act, renderHook } = await import("@testing-library/react");
  const { result, unmount } = renderHook(() =>
    useMessageTaskToggleBatch({
      enabled: true,
      message: message(),
      updateMessage: async (input) => updates.push(input),
    }),
  );

  act(() => result.current.onToggleTask(1, true));
  for (const line of [2, 3, 4, 1, 2, 3]) {
    mock.timers.tick(1_500);
    act(() => result.current.onToggleTask(line, true));
  }
  assert.equal(updates.length, 0);

  await act(async () => {
    mock.timers.tick(1_000);
    await result.current.flush();
  });

  assert.equal(updates.length, 1);
  unmount();
});

test("a net-zero toggle produces no message edit", async () => {
  const updates = [];
  const { act, renderHook } = await import("@testing-library/react");
  const { result, unmount } = renderHook(() =>
    useMessageTaskToggleBatch({
      enabled: true,
      message: message(),
      updateMessage: async (input) => updates.push(input),
    }),
  );

  act(() => {
    result.current.onToggleTask(1, true);
    result.current.onToggleTask(1, false);
  });
  await act(async () => {
    await result.current.flush();
  });

  assert.equal(updates.length, 0);
  assert.match(result.current.optimisticContent, /- \[ \] first/);
  unmount();
});

test("a fresh message body drops only invalid task lines and saves the rest", async () => {
  const updates = [];
  const initialMessage = message({ body: "- [ ] first\n- [ ] second" });
  const updateMessage = async (input) => updates.push(input);
  const { act, renderHook } = await import("@testing-library/react");
  const { result, rerender, unmount } = renderHook(
    (input) => useMessageTaskToggleBatch(input),
    {
      initialProps: {
        enabled: true,
        message: initialMessage,
        updateMessage,
      },
    },
  );

  act(() => {
    result.current.onToggleTask(1, true);
    result.current.onToggleTask(2, true);
  });
  rerender({
    enabled: true,
    message: message({ body: "- [ ] first\n- plain text" }),
    updateMessage,
  });
  await act(async () => {
    await result.current.flush();
  });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].content, "- [x] first\n- plain text");
  unmount();
});

test("unmount flushes a pending message batch", async () => {
  const updates = [];
  let resolveStarted;
  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  const { act, renderHook } = await import("@testing-library/react");
  const { result, unmount } = renderHook(() =>
    useMessageTaskToggleBatch({
      enabled: true,
      message: message(),
      updateMessage: async (input) => {
        updates.push(input);
        resolveStarted();
      },
    }),
  );

  act(() => result.current.onToggleTask(1, true));
  unmount();
  await started;

  assert.equal(updates.length, 1);
  assert.match(updates[0].content, /- \[x\] first/);
});

test("an event identity swap flushes the old message, never the new one", async () => {
  const updates = [];
  let resolveStarted;
  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  const updateMessage = async (input) => {
    updates.push(input);
    resolveStarted();
  };
  const firstMessage = message({ id: "message-a" });
  const secondMessage = message({ id: "message-b" });
  const { act, renderHook } = await import("@testing-library/react");
  const { result, rerender, unmount } = renderHook(
    (input) => useMessageTaskToggleBatch(input),
    {
      initialProps: {
        enabled: true,
        message: firstMessage,
        updateMessage,
      },
    },
  );

  act(() => result.current.onToggleTask(1, true));
  act(() => {
    rerender({
      enabled: true,
      message: secondMessage,
      updateMessage,
    });
  });
  await act(async () => {
    await started;
  });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].eventId, firstMessage.id);
  assert.notEqual(updates[0].eventId, secondMessage.id);
  unmount();
});

test("a channel provider remount flushes through its old channel mutation", async () => {
  const oldChannelUpdates = [];
  const newChannelUpdates = [];
  let resolveOldUpdate;
  const oldUpdateStarted = new Promise((resolve) => {
    resolveOldUpdate = resolve;
  });
  const oldUpdateMessage = async (input) => {
    oldChannelUpdates.push(input);
    resolveOldUpdate();
  };
  const newUpdateMessage = async (input) => newChannelUpdates.push(input);
  let currentTask = null;

  function TaskConsumer({ taskMessage }) {
    const task = useMessageTaskToggleBatch({
      enabled: true,
      message: taskMessage,
    });
    React.useLayoutEffect(() => {
      currentTask = task;
    }, [task]);
    return null;
  }

  function ChannelHarness({ channelId, taskMessage, updateMessage }) {
    return React.createElement(
      MessageTaskToggleProvider,
      { key: channelId, updateMessage },
      React.createElement(TaskConsumer, { taskMessage }),
    );
  }

  const channelAMessage = message({ id: "channel-a-message" });
  const channelBMessage = message({ id: "channel-b-message" });
  const { act, render } = await import("@testing-library/react");
  const rendered = render(
    React.createElement(ChannelHarness, {
      channelId: "channel-a",
      taskMessage: channelAMessage,
      updateMessage: oldUpdateMessage,
    }),
  );

  act(() => currentTask.onToggleTask(1, true));
  act(() => {
    rendered.rerender(
      React.createElement(ChannelHarness, {
        channelId: "channel-b",
        taskMessage: channelBMessage,
        updateMessage: newUpdateMessage,
      }),
    );
  });
  await act(async () => {
    await oldUpdateStarted;
  });

  assert.equal(oldChannelUpdates.length, 1);
  assert.equal(oldChannelUpdates[0].eventId, channelAMessage.id);
  assert.equal(newChannelUpdates.length, 0);
  rendered.unmount();
});

test("authorization admits self and owned-agent messages but never queues a third party", () => {
  const ownMessage = message();
  const ownedAgentMessage = message({ pubkey: OWNED_AGENT_PUBKEY });
  const thirdPartyMessage = message({ pubkey: THIRD_PARTY_PUBKEY });
  const profiles = {
    [OWNED_AGENT_PUBKEY]: {
      avatarUrl: null,
      displayName: "Owned bot",
      isAgent: true,
      name: null,
      nip05Handle: null,
      ownerPubkey: SELF_PUBKEY,
    },
  };

  assert.equal(
    canManageMessageForCurrentUser(ownMessage, SELF_PUBKEY, profiles),
    true,
  );
  assert.equal(
    canManageMessageForCurrentUser(ownedAgentMessage, SELF_PUBKEY, profiles),
    true,
  );
  assert.equal(
    canManageMessageForCurrentUser(thirdPartyMessage, SELF_PUBKEY, profiles),
    false,
  );
});

test("disabled task toggles stay inert and do not attempt an edit", async () => {
  const updates = [];
  const { act, renderHook } = await import("@testing-library/react");
  const { result, unmount } = renderHook(() =>
    useMessageTaskToggleBatch({
      enabled: false,
      message: message({ pubkey: THIRD_PARTY_PUBKEY }),
      updateMessage: async (input) => updates.push(input),
    }),
  );

  act(() => result.current.onToggleTask(1, true));
  await act(async () => {
    await result.current.flush();
  });

  assert.equal(result.current.canToggle, false);
  assert.equal(updates.length, 0);
  unmount();
});

test("a toggle preserves edit-safe tags and emits no new mention p tag", async () => {
  const commands = [];
  dom.window.__TAURI_INTERNALS__ = {
    invoke: async (command, payload) => {
      commands.push({ command, payload });
      return null;
    },
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  const taggedMessage = message({
    tags: [
      ["imeta", "url https://example.test/file.pdf"],
      ["emoji", "buzz", "https://example.test/buzz.png"],
      ["mention", "agent reference"],
      ["p", OWNED_AGENT_PUBKEY],
      ["h", CHANNEL_ID],
      ["e", "older-event"],
    ],
  });
  const { act, renderHook } = await import("@testing-library/react");
  const { result, unmount } = renderHook(
    () => {
      const editMutation = useEditMessageMutation({ id: CHANNEL_ID });
      return useMessageTaskToggleBatch({
        enabled: true,
        message: taggedMessage,
        updateMessage: editMutation.mutateAsync,
      });
    },
    { wrapper },
  );

  act(() => result.current.onToggleTask(1, true));
  await act(async () => {
    await result.current.flush();
  });

  const editPayload = commands.find(({ command }) => command === "edit_message")
    ?.payload?.input;
  assert.deepEqual(editPayload.mentionPubkeys, []);
  assert.deepEqual(editPayload.mediaTags, [taggedMessage.tags[0]]);
  assert.deepEqual(editPayload.emojiTags, [taggedMessage.tags[1]]);
  assert.deepEqual(editPayload.mentionTags, [taggedMessage.tags[2]]);
  unmount();
});
