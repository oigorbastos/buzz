import type { BrowserPresetId } from "./browserTypes";

export const BROWSER_METRICS_STORAGE_KEY = "buzz.web-workspace.metrics.v1";

export type BrowserMetricEvent =
  | "opened_external"
  | "preset_selected"
  | "surface_opened"
  | "url_copied";

export type BrowserMetrics = {
  version: 1;
  counters: Record<BrowserMetricEvent, number>;
  by_preset: Partial<Record<BrowserPresetId, number>>;
  last_event_at: number | null;
};

const METRIC_EVENTS: readonly BrowserMetricEvent[] = [
  "opened_external",
  "preset_selected",
  "surface_opened",
  "url_copied",
];
const PRESET_IDS: readonly BrowserPresetId[] = [
  "mission-control",
  "sessions",
  "work",
];

export function emptyBrowserMetrics(): BrowserMetrics {
  return {
    version: 1,
    counters: {
      opened_external: 0,
      preset_selected: 0,
      surface_opened: 0,
      url_copied: 0,
    },
    by_preset: {},
    last_event_at: null,
  };
}

function normalizedCounter(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : 0;
}

export function normalizeBrowserMetrics(value: unknown): BrowserMetrics {
  const empty = emptyBrowserMetrics();
  if (
    !value ||
    typeof value !== "object" ||
    (value as { version?: unknown }).version !== 1
  ) {
    return empty;
  }

  const record = value as {
    counters?: Record<string, unknown>;
    by_preset?: Record<string, unknown>;
    last_event_at?: unknown;
  };
  for (const event of METRIC_EVENTS) {
    empty.counters[event] = normalizedCounter(record.counters?.[event]);
  }
  for (const preset of PRESET_IDS) {
    const count = normalizedCounter(record.by_preset?.[preset]);
    if (count > 0) empty.by_preset[preset] = count;
  }
  empty.last_event_at =
    Number.isSafeInteger(record.last_event_at) &&
    (record.last_event_at as number) >= 0
      ? (record.last_event_at as number)
      : null;
  return empty;
}

export function reduceBrowserMetric(
  current: BrowserMetrics,
  event: BrowserMetricEvent,
  timestamp: number,
  preset?: BrowserPresetId,
): BrowserMetrics {
  const normalized = normalizeBrowserMetrics(current);
  const currentEventCount = normalized.counters[event];
  return {
    version: 1,
    counters: {
      ...normalized.counters,
      [event]: Math.min(currentEventCount + 1, Number.MAX_SAFE_INTEGER),
    },
    by_preset: preset
      ? {
          ...normalized.by_preset,
          [preset]: Math.min(
            (normalized.by_preset[preset] ?? 0) + 1,
            Number.MAX_SAFE_INTEGER,
          ),
        }
      : normalized.by_preset,
    last_event_at:
      Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null,
  };
}

export function recordBrowserMetric(
  event: BrowserMetricEvent,
  preset?: BrowserPresetId,
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
  timestamp = Date.now(),
): void {
  try {
    const raw = storage.getItem(BROWSER_METRICS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    const current = normalizeBrowserMetrics(parsed);
    const next = reduceBrowserMetric(current, event, timestamp, preset);
    storage.setItem(BROWSER_METRICS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Metrics must never affect navigation or expose a storage failure.
  }
}
