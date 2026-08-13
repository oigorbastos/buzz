export type LabBoardViewMode = "grid" | "list";

const LAB_BOARD_VIEW_MODE_STORAGE_KEY = "buzz.lab.viewMode";

export function readStoredLabBoardViewMode(): LabBoardViewMode {
  try {
    const value = globalThis.localStorage?.getItem(
      LAB_BOARD_VIEW_MODE_STORAGE_KEY,
    );
    return value === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

export function writeStoredLabBoardViewMode(viewMode: LabBoardViewMode): void {
  try {
    globalThis.localStorage?.setItem(LAB_BOARD_VIEW_MODE_STORAGE_KEY, viewMode);
  } catch {
    // Persistence is best-effort; the in-memory toggle still works.
  }
}
