import assert from "node:assert/strict";
import { after, afterEach, before, mock, test } from "node:test";

import { JSDOM } from "jsdom";

import { relayClient } from "@/shared/api/relayClient";
import {
  applyTaskToggles,
  queueTaskToggle,
  readTaskCheckboxAtLine,
} from "../taskToggles.ts";
import { useLabBoardTaskToggleBatch } from "./useLabBoardTaskToggleBatch.ts";

const BOARD_ID = "0f2b8a1c-1111-4222-8333-444455556666";
const RELAY_PUBKEY = "a".repeat(64);
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

function head(overrides = {}) {
  return {
    access: "community",
    boardId: BOARD_ID,
    content: "- [ ] first\n- [ ] second\n- [ ] third\n- [ ] fourth",
    headEventId: "head-1",
    ownerPubkey: null,
    revision: 1,
    status: "active",
    summary: null,
    tags: [],
    title: "Task board",
    updatedAt: 1,
    ...overrides,
  };
}

function rawHead(board) {
  return {
    content: board.content,
    created_at: board.updatedAt,
    id: `projection-${board.headEventId}`,
    kind: 30623,
    pubkey: RELAY_PUBKEY,
    sig: "0".repeat(128),
    tags: [
      ["d", board.boardId],
      ["head", board.headEventId],
      ["revision", String(board.revision)],
      ["access_scope", board.access],
      ["status", board.status],
      ["title", board.title],
    ],
  };
}

function mockBoardHead(readCurrentHead) {
  const originalFetchEvents = relayClient.fetchEvents;
  relayClient.fetchEvents = async () => {
    const currentHead = readCurrentHead();
    return currentHead ? [rawHead(currentHead)] : [];
  };
  return () => {
    relayClient.fetchEvents = originalFetchEvents;
  };
}

function nextHead(previous, content) {
  const revision = previous.revision + 1;
  return {
    ...previous,
    content,
    headEventId: `head-${revision}`,
    revision,
    updatedAt: previous.updatedAt + 1,
  };
}

test("task toggle helpers use one-based source lines and desired states", () => {
  const content = "- [ ] first\r\n- [X] second\r\nplain text";
  assert.equal(readTaskCheckboxAtLine(content, 1), false);
  assert.equal(readTaskCheckboxAtLine(content, 2), true);
  assert.equal(readTaskCheckboxAtLine(content, 3), null);
  assert.equal(readTaskCheckboxAtLine(content, 0), null);

  const result = applyTaskToggles(content, [
    { line: 1, nextChecked: true },
    { line: 2, nextChecked: false },
    { line: 3, nextChecked: true },
    { line: 1, nextChecked: true },
  ]);
  assert.equal(result.content, "- [x] first\r\n- [ ] second\r\nplain text");
  assert.deepEqual(result.applied, [
    { line: 1, nextChecked: true },
    { line: 2, nextChecked: false },
  ]);
  assert.deepEqual(result.alreadyApplied, []);
  assert.deepEqual(result.droppedLines, [3]);

  const idempotent = applyTaskToggles(result.content, [
    { line: 1, nextChecked: true },
    { line: 2, nextChecked: false },
  ]);
  assert.equal(idempotent.content, result.content);
  assert.deepEqual(idempotent.applied, []);
  assert.deepEqual(idempotent.alreadyApplied, [
    { line: 1, nextChecked: true },
    { line: 2, nextChecked: false },
  ]);
});

test("queueTaskToggle cancels an unsent double toggle but retains an in-flight compensation", () => {
  const first = queueTaskToggle({
    content: "- [ ] task",
    inFlightLines: new Map(),
    line: 1,
    nextChecked: true,
    toggles: new Map(),
  });
  const second = queueTaskToggle({
    content: "- [ ] task",
    inFlightLines: new Map(),
    line: 1,
    nextChecked: false,
    toggles: first.toggles,
  });
  assert.equal(first.accepted, true);
  assert.deepEqual([...second.toggles], []);

  const compensating = queueTaskToggle({
    content: "- [ ] task",
    inFlightLines: new Map([[1, true]]),
    line: 1,
    nextChecked: false,
    toggles: first.toggles,
  });
  assert.deepEqual([...compensating.toggles], [[1, false]]);
});

test("a burst publishes one fresh-head revision after the idle debounce", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let currentHead = head();
  const restoreRelay = mockBoardHead(() => currentHead);
  const updates = [];
  const messages = [];
  const props = {
    board: currentHead,
    boardId: BOARD_ID,
    enabled: true,
    onMessage: (message) => messages.push(message),
    updateBoard: async (input) => {
      updates.push(input);
      currentHead = nextHead(input.head, input.content);
    },
  };

  try {
    const { act, renderHook } = await import("@testing-library/react");
    const { result, rerender, unmount } = renderHook(
      (input) => useLabBoardTaskToggleBatch(input),
      { initialProps: props },
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

    assert.equal(updates.length, 1, "one revision for the whole burst");
    assert.equal(
      updates[0].content,
      "- [x] first\n- [x] second\n- [ ] third\n- [ ] fourth",
    );
    assert.equal(result.current.hasPending, true);
    rerender({ ...props, board: currentHead });
    await act(async () => {});
    assert.equal(result.current.hasPending, false);
    assert.equal(messages.at(-1), null);
    unmount();
  } finally {
    restoreRelay();
  }
});

test("the maximum batch age flushes even while new clicks keep resetting idle time", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let currentHead = head();
  const restoreRelay = mockBoardHead(() => currentHead);
  const updates = [];

  try {
    const { act, renderHook } = await import("@testing-library/react");
    const { result, unmount } = renderHook(() =>
      useLabBoardTaskToggleBatch({
        board: currentHead,
        boardId: BOARD_ID,
        enabled: true,
        onMessage: () => {},
        updateBoard: async (input) => {
          updates.push(input);
          currentHead = nextHead(input.head, input.content);
        },
      }),
    );

    act(() => result.current.onToggleTask(1, true));
    for (const [line, nextChecked] of [
      [2, true],
      [3, true],
      [4, true],
      [1, false],
      [2, false],
      [3, false],
    ]) {
      mock.timers.tick(1_500);
      act(() => result.current.onToggleTask(line, nextChecked));
    }
    assert.equal(updates.length, 0);

    await act(async () => {
      mock.timers.tick(1_000);
      await result.current.flush();
    });
    assert.equal(updates.length, 1);
    assert.match(updates[0].content, /- \[x\] fourth/);
    unmount();
  } finally {
    restoreRelay();
  }
});

test("a fresh head drops only an invalid line and preserves the rest of the batch", async () => {
  let currentHead = head({ content: "- [ ] first\n- plain text" });
  const renderedBoard = head({ content: "- [ ] first\n- [ ] second" });
  const restoreRelay = mockBoardHead(() => currentHead);
  const messages = [];
  const updates = [];

  try {
    const { act, renderHook } = await import("@testing-library/react");
    const { result, unmount } = renderHook(() =>
      useLabBoardTaskToggleBatch({
        board: renderedBoard,
        boardId: BOARD_ID,
        enabled: true,
        onMessage: (message) => messages.push(message),
        updateBoard: async (input) => {
          updates.push(input);
          currentHead = nextHead(input.head, input.content);
        },
      }),
    );

    act(() => {
      result.current.onToggleTask(1, true);
      result.current.onToggleTask(2, true);
    });
    let saved;
    await act(async () => {
      saved = await result.current.flush();
    });

    assert.equal(saved, true);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].content, "- [x] first\n- plain text");
    assert.match(messages.at(-1), /line 2 changed before it could be saved/i);
    unmount();
  } finally {
    restoreRelay();
  }
});

test("a CAS retry reapplies desired states that were already present on the first read", async () => {
  const renderedBoard = head({ content: "- [ ] first\n- [ ] second" });
  let currentHead = head({
    content: "- [x] first\n- [ ] second",
    headEventId: "head-2",
    revision: 2,
    updatedAt: 2,
  });
  const restoreRelay = mockBoardHead(() => currentHead);
  const updates = [];
  let attempts = 0;

  try {
    const { act, renderHook } = await import("@testing-library/react");
    const { result, unmount } = renderHook(() =>
      useLabBoardTaskToggleBatch({
        board: renderedBoard,
        boardId: BOARD_ID,
        enabled: true,
        onMessage: () => {},
        updateBoard: async (input) => {
          updates.push(input);
          attempts += 1;
          if (attempts === 1) {
            currentHead = head({
              content: "- [ ] first\n- [ ] second",
              headEventId: "head-3",
              revision: 3,
              updatedAt: 3,
            });
            throw new Error("BOARD_HEAD_MISMATCH");
          }
          currentHead = nextHead(input.head, input.content);
        },
      }),
    );

    act(() => {
      result.current.onToggleTask(1, true);
      result.current.onToggleTask(2, true);
    });
    let saved;
    await act(async () => {
      saved = await result.current.flush();
    });

    assert.equal(saved, true);
    assert.equal(updates.length, 2);
    assert.equal(updates[1].content, "- [x] first\n- [x] second");
    unmount();
  } finally {
    restoreRelay();
  }
});

test("a second CAS conflict stays visible without starting another automatic retry", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let currentHead = head();
  const restoreRelay = mockBoardHead(() => currentHead);
  const messages = [];
  let updates = 0;

  try {
    const { act, renderHook } = await import("@testing-library/react");
    const { result, unmount } = renderHook(() =>
      useLabBoardTaskToggleBatch({
        board: currentHead,
        boardId: BOARD_ID,
        enabled: true,
        onMessage: (message) => messages.push(message),
        updateBoard: async (input) => {
          updates += 1;
          currentHead = nextHead(input.head, input.head.content);
          throw new Error("BOARD_HEAD_MISMATCH");
        },
      }),
    );

    act(() => result.current.onToggleTask(1, true));
    let saved;
    await act(async () => {
      saved = await result.current.flush();
    });
    assert.equal(saved, false);
    assert.equal(updates, 2);
    assert.match(
      messages.at(-1),
      /changed again while task updates were being saved/i,
    );

    mock.timers.tick(20_000);
    assert.equal(
      updates,
      2,
      "no unbounded automatic retry after retry failure",
    );
    unmount();
  } finally {
    restoreRelay();
  }
});

test("a later head does not trigger another automatic write after a successful batch", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let currentHead = head();
  const restoreRelay = mockBoardHead(() => currentHead);
  const messages = [];
  const updates = [];

  try {
    const { act, renderHook } = await import("@testing-library/react");
    const { result, unmount } = renderHook(() =>
      useLabBoardTaskToggleBatch({
        board: currentHead,
        boardId: BOARD_ID,
        enabled: true,
        onMessage: (message) => messages.push(message),
        updateBoard: async (input) => {
          updates.push(input);
          // The write was accepted, but another author immediately restored
          // the source state before the follow-up read reaches the relay.
          currentHead = nextHead(input.head, input.head.content);
        },
      }),
    );

    act(() => result.current.onToggleTask(1, true));
    let saved;
    await act(async () => {
      saved = await result.current.flush();
    });

    assert.equal(saved, false);
    assert.equal(updates.length, 1);
    assert.match(
      messages.at(-1),
      /changed again after the task update was saved/i,
    );
    mock.timers.tick(20_000);
    assert.equal(updates.length, 1, "no write loop after a successful batch");

    // Cancel the retained visual intent before cleanup, whose documented
    // unmount behavior otherwise performs a last user-initiated flush.
    act(() => result.current.onToggleTask(1, false));
    unmount();
  } finally {
    restoreRelay();
  }
});

test("disabled boards do not queue writes, while unmount flushes a pending batch", async () => {
  let currentHead = head();
  const restoreRelay = mockBoardHead(() => currentHead);
  const updates = [];
  let resolveUpdate;
  const updateStarted = new Promise((resolve) => {
    resolveUpdate = resolve;
  });

  try {
    const { act, renderHook } = await import("@testing-library/react");
    const disabled = renderHook(() =>
      useLabBoardTaskToggleBatch({
        board: currentHead,
        boardId: BOARD_ID,
        enabled: false,
        onMessage: () => {},
        updateBoard: async (input) => updates.push(input),
      }),
    );
    act(() => disabled.result.current.onToggleTask(1, true));
    assert.equal(disabled.result.current.hasPending, false);
    disabled.unmount();

    const enabled = renderHook(() =>
      useLabBoardTaskToggleBatch({
        board: currentHead,
        boardId: BOARD_ID,
        enabled: true,
        onMessage: () => {},
        updateBoard: async (input) => {
          updates.push(input);
          currentHead = nextHead(input.head, input.content);
          resolveUpdate();
        },
      }),
    );
    act(() => enabled.result.current.onToggleTask(1, true));
    enabled.unmount();
    await updateStarted;

    assert.equal(updates.length, 1);
    assert.match(updates[0].content, /- \[x\] first/);
  } finally {
    restoreRelay();
  }
});
