export type TaskToggle = {
  line: number;
  nextChecked: boolean;
};

export type AppliedTaskToggles = {
  content: string;
  /** Toggles that changed a checkbox marker in this content. */
  applied: TaskToggle[];
  /** Toggles whose requested value was already present in this content. */
  alreadyApplied: TaskToggle[];
  /** Source lines that no longer contain a task checkbox marker. */
  droppedLines: number[];
};

const TASK_CHECKBOX_MARKER = /\[([ xX])\]/;

/**
 * Read the task marker on a one-based Markdown source line.
 *
 * The renderer has already established that this line belonged to a GFM task
 * list item. This deliberately checks only the marker here: the board can
 * change between render and flush, and this is the narrow guard that prevents
 * replacing unrelated text when that happens.
 */
export function readTaskCheckboxAtLine(
  content: string,
  line: number,
): boolean | null {
  if (!Number.isSafeInteger(line) || line < 1) return null;
  const sourceLine = content.split("\n")[line - 1];
  if (sourceLine === undefined) return null;
  const marker = sourceLine.match(TASK_CHECKBOX_MARKER);
  if (!marker) return null;
  return marker[1].toLowerCase() === "x";
}

/**
 * Apply desired checkbox states by source line without flipping any marker.
 * Setting the requested state makes a replay against a newer head idempotent.
 */
export function applyTaskToggles(
  content: string,
  toggles: Iterable<TaskToggle>,
): AppliedTaskToggles {
  const desiredByLine = new Map<number, boolean>();
  for (const toggle of toggles) {
    if (Number.isSafeInteger(toggle.line) && toggle.line > 0) {
      desiredByLine.set(toggle.line, toggle.nextChecked);
    }
  }

  const lines = content.split("\n");
  const applied: TaskToggle[] = [];
  const alreadyApplied: TaskToggle[] = [];
  const droppedLines: number[] = [];

  for (const [line, nextChecked] of desiredByLine) {
    const index = line - 1;
    const sourceLine = lines[index];
    if (sourceLine === undefined) {
      droppedLines.push(line);
      continue;
    }
    const marker = sourceLine.match(TASK_CHECKBOX_MARKER);
    if (!marker) {
      droppedLines.push(line);
      continue;
    }

    const currentChecked = marker[1].toLowerCase() === "x";
    const toggle = { line, nextChecked };
    if (currentChecked === nextChecked) {
      alreadyApplied.push(toggle);
      continue;
    }

    lines[index] = sourceLine.replace(
      TASK_CHECKBOX_MARKER,
      nextChecked ? "[x]" : "[ ]",
    );
    applied.push(toggle);
  }

  return {
    content: lines.join("\n"),
    applied,
    alreadyApplied,
    droppedLines,
  };
}

export type QueuedTaskToggle = {
  accepted: boolean;
  toggles: Map<number, boolean>;
};

/**
 * Queue a desired state and collapse a double-toggle before it has been sent.
 * A line that is currently in flight is intentionally retained even when it
 * matches the cached head: the already-sent write may still change that head
 * and needs a compensating batch afterwards.
 */
export function queueTaskToggle(input: {
  content: string;
  toggles: ReadonlyMap<number, boolean>;
  inFlightLines: ReadonlyMap<number, boolean>;
  line: number;
  nextChecked: boolean;
}): QueuedTaskToggle {
  const currentChecked = readTaskCheckboxAtLine(input.content, input.line);
  if (currentChecked === null) {
    return { accepted: false, toggles: new Map(input.toggles) };
  }

  const toggles = new Map(input.toggles);
  toggles.set(input.line, input.nextChecked);
  if (
    !input.inFlightLines.has(input.line) &&
    currentChecked === input.nextChecked
  ) {
    toggles.delete(input.line);
  }
  return { accepted: true, toggles };
}
