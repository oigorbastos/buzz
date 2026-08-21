import assert from "node:assert/strict";
import test from "node:test";

import {
  BROWSER_METRICS_STORAGE_KEY,
  emptyBrowserMetrics,
  normalizeBrowserMetrics,
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

test("stored metrics are normalized field by field and never propagate invalid numbers", () => {
  assert.deepEqual(normalizeBrowserMetrics(null), emptyBrowserMetrics());
  assert.deepEqual(
    normalizeBrowserMetrics({ version: 2, counters: { surface_opened: 99 } }),
    emptyBrowserMetrics(),
  );

  const normalized = normalizeBrowserMetrics({
    version: 1,
    counters: {
      opened_external: "7",
      preset_selected: -1,
      surface_opened: 4,
      url_copied: null,
    },
    by_preset: {
      "mission-control": 2,
      sessions: "5",
      work: Number.NaN,
      unexpected: 500,
    },
    last_event_at: "yesterday",
  });
  assert.deepEqual(normalized.counters, {
    opened_external: 0,
    preset_selected: 0,
    surface_opened: 4,
    url_copied: 0,
  });
  assert.deepEqual(normalized.by_preset, { "mission-control": 2 });
  assert.equal(normalized.last_event_at, null);
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

  values.set(
    BROWSER_METRICS_STORAGE_KEY,
    JSON.stringify({ version: 1, counters: { surface_opened: "broken" } }),
  );
  recordBrowserMetric("surface_opened", undefined, storage, 124);
  const repaired = JSON.parse(values.get(BROWSER_METRICS_STORAGE_KEY));
  assert.equal(repaired.counters.surface_opened, 1);
  assert.deepEqual(repaired.by_preset, {});

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
