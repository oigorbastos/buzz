import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";
import React from "react";

import { createTaskListItem, MarkdownInput } from "./MarkdownInput.tsx";
import { clearMarkdownNodeCache, renderCachedMarkdown } from "./nodeCache.ts";
import { MarkdownRuntimeContext } from "./runtimeContext.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
const TASK_CONTENT = "- [ ] parent\n  - [x] nested\n> - [ ] quoted";
const taskComponents = {
  input: MarkdownInput,
  li: createTaskListItem("task-list-item"),
};

before(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
  });
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  clearMarkdownNodeCache();
});

after(() => dom.window.close());

function runtime(overrides = {}) {
  return {
    channels: [],
    onOpenChannel: () => {},
    onOpenEntityLink: () => {},
    onOpenLabLink: () => {},
    onOpenMessageLink: () => {},
    relayOrigin: null,
    ...overrides,
  };
}

function cachedTasks() {
  return renderCachedMarkdown({
    components: taskComponents,
    content: TASK_CONTENT,
    variant: "task-checkbox-test",
  });
}

function provider(value, children) {
  return React.createElement(
    MarkdownRuntimeContext.Provider,
    { value },
    children,
  );
}

test("task-list checkbox callbacks receive their parent, nested, and blockquote source lines", async () => {
  const { fireEvent, render, screen } = await import("@testing-library/react");
  const calls = [];
  const node = cachedTasks();
  assert.equal(node, cachedTasks(), "the parsed node is cacheable");
  const view = render(
    provider(runtime({ onToggleTask: (...args) => calls.push(args) }), node),
  );

  const checkboxes = screen.getAllByRole("checkbox");
  assert.equal(checkboxes.length, 3);
  fireEvent.click(checkboxes[0]);
  fireEvent.click(checkboxes[1]);
  fireEvent.click(checkboxes[2]);
  assert.deepEqual(calls, [
    [1, true],
    [2, false],
    [3, true],
  ]);

  const laterCalls = [];
  view.rerender(
    provider(
      runtime({ onToggleTask: (...args) => laterCalls.push(args) }),
      node,
    ),
  );
  fireEvent.click(screen.getAllByRole("checkbox")[0]);
  assert.deepEqual(
    laterCalls,
    [[1, true]],
    "the cached tree reads the current runtime handler",
  );
  assert.equal(calls.length, 3);
});

test("checkboxes are disabled and unreachable when no board runtime handler is supplied", async () => {
  const { fireEvent, render, screen } = await import("@testing-library/react");
  const calls = [];
  const node = cachedTasks();
  render(provider(runtime(), node));

  for (const checkbox of screen.getAllByRole("checkbox")) {
    assert.equal(checkbox.disabled, true);
    assert.equal(checkbox.tabIndex, -1);
    assert.match(checkbox.className, /pointer-events-none/);
    fireEvent.click(checkbox);
  }
  assert.deepEqual(calls, []);
});
