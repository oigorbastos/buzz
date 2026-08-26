import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import React from "react";

import { labBoardsQueryKey } from "../../../features/lab/hooks.ts";
import { LabBoardReference } from "./labLinks.tsx";

const BOARD = "0f2b8a1c-1111-4222-8333-444455556666";
const READER = "a".repeat(64);
const OTHER_OWNER = "b".repeat(64);
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
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});

after(() => dom.window.close());

function board(title, boardId = BOARD) {
  return {
    access: "community",
    boardId,
    ownerPubkey: null,
    status: "active",
    tags: [],
    title,
  };
}

function queryClientWith(boards) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(labBoardsQueryKey, boards);
  queryClient.setQueryData(["identity"], { pubkey: READER });
  queryClient.setQueryData(["user-profile", READER], { ownerPubkey: null });
  return queryClient;
}

async function renderReference(queryClient, label, onOpenLabLink = () => {}) {
  const { render } = await import("@testing-library/react");
  return render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(
        LabBoardReference,
        {
          href: `buzz://lab?board=${BOARD}`,
          link: { boardId: BOARD, revision: null },
          onOpenLabLink,
        },
        label,
      ),
    ),
  );
}

describe("LabBoardReference", () => {
  it("updates an old message chip when the board is renamed", async () => {
    const { act, fireEvent, screen } = await import("@testing-library/react");
    const queryClient = queryClientWith([board("Title at send time")]);
    let opened = 0;
    await renderReference(queryClient, "Title at send time", () => {
      opened += 1;
    });

    fireEvent.click(screen.getByRole("button", { name: /Title at send time/ }));
    assert.equal(opened, 1);

    await act(async () => {
      queryClient.setQueryData(labBoardsQueryKey, [
        board("Renamed current title"),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.ok(
      screen.getByRole("button", { name: /Renamed current title/ }),
      "the UUID resolves the current title instead of freezing the sent label",
    );
    assert.equal(
      document.body.textContent.includes("Title at send time"),
      false,
    );
  });

  it("does not navigate or leak the current title without board access", async () => {
    const { fireEvent, screen } = await import("@testing-library/react");
    const currentRestrictedTitle = "Acquisition code names";
    const queryClient = queryClientWith([
      {
        ...board(currentRestrictedTitle),
        access: "private",
        ownerPubkey: OTHER_OWNER,
      },
    ]);
    let opened = 0;
    const view = await renderReference(queryClient, "Old public label", () => {
      opened += 1;
    });

    assert.ok(screen.getByText("Old public label"));
    assert.equal(screen.queryByRole("button"), null);
    assert.equal(view.container.querySelector("a"), null);
    assert.equal(
      document.body.textContent.includes(currentRestrictedTitle),
      false,
    );
    fireEvent.click(screen.getByText("Old public label"));
    assert.equal(opened, 0);
  });

  it("keeps an explicit reference to a readable archived board clickable", async () => {
    const { fireEvent, screen } = await import("@testing-library/react");
    const queryClient = queryClientWith([
      { ...board("Archived planning notes"), status: "archived" },
    ]);
    const opened = [];
    await renderReference(queryClient, "Archived planning notes", (link) => {
      opened.push(link);
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Archived planning notes/ }),
    );
    assert.deepEqual(opened, [{ boardId: BOARD, revision: null }]);
  });

  it("degrades to the literal label when a previously linked board is deleted", async () => {
    const { act, screen } = await import("@testing-library/react");
    const queryClient = queryClientWith([board("Current title")]);
    await renderReference(queryClient, "Literal message label");
    assert.ok(screen.getByRole("button", { name: /Current title/ }));

    await act(async () => {
      queryClient.setQueryData(labBoardsQueryKey, []);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const fallback = document.querySelector(
      '[data-lab-link-state="unavailable"]',
    );
    assert.ok(fallback);
    assert.match(fallback.textContent, /Literal message label/);
    assert.equal(screen.queryByRole("button"), null);
  });
});
