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

export function reduceBrowserMetric(
  current: BrowserMetrics,
  event: BrowserMetricEvent,
  timestamp: number,
  preset?: BrowserPresetId,
): BrowserMetrics {
  return {
    version: 1,
    counters: {
      ...current.counters,
      [event]: current.counters[event] + 1,
    },
    by_preset: preset
      ? {
          ...current.by_preset,
          [preset]: (current.by_preset[preset] ?? 0) + 1,
        }
      : current.by_preset,
    last_event_at: timestamp,
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
    const parsed = raw ? (JSON.parse(raw) as BrowserMetrics) : null;
    const current =
      parsed?.version === 1 && parsed.counters ? parsed : emptyBrowserMetrics();
    const next = reduceBrowserMetric(current, event, timestamp, preset);
    storage.setItem(BROWSER_METRICS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Metrics must never affect navigation or expose a storage failure.
  }
}
