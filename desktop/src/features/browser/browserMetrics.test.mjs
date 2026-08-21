import assert from "node:assert/strict";
import test from "node:test";

import {
  BROWSER_METRICS_STORAGE_KEY,
  emptyBrowserMetrics,
  recordBrowserMetric,
  reduceBrowserMetric,
} from "./browserMetrics.ts";

test("dogfood metrics keep only event and preset counters", () => {
  const next = reduceBrowserMetric(
    emptyBrowserMetrics(),
    "opened_external",
    1_777_000_000_000,
    "work",
  );

  assert.equal(next.counters.opened_external, 1);
  assert.equal(next.by_preset.work, 1);
  assert.equal(next.last_event_at, 1_777_000_000_000);
  assert.equal(JSON.stringify(next).includes("https://"), false);
  assert.equal(JSON.stringify(next).includes("content"), false);
});

test("metrics persist locally without affecting the workflow", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };

  recordBrowserMetric("preset_selected", "mission-control", storage, 123);
  const stored = JSON.parse(values.get(BROWSER_METRICS_STORAGE_KEY));
  assert.equal(stored.counters.preset_selected, 1);
  assert.equal(stored.by_preset["mission-control"], 1);

  assert.doesNotThrow(() =>
    recordBrowserMetric(
      "surface_opened",
      undefined,
      {
        getItem: () => {
          throw new Error("storage blocked");
        },
        setItem: () => {
          throw new Error("storage blocked");
        },
      },
      124,
    ),
  );
});
