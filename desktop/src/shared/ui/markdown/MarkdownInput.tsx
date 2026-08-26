import * as React from "react";

import { cn } from "@/shared/lib/cn";
import { Checkbox } from "@/shared/ui/checkbox";
import { useMarkdownRuntime } from "./runtimeContext";

type MarkdownInputProps = React.ComponentProps<"input"> & {
  node?: unknown;
};

type MarkdownTaskListItemProps = {
  children?: React.ReactNode;
  node?: unknown;
};

const TaskListLineContext = React.createContext<number | null>(null);

function taskListLine(node: unknown): number | null {
  if (typeof node !== "object" || node === null) return null;
  const candidate = node as {
    properties?: { className?: unknown };
    position?: { start?: { line?: unknown } };
  };
  const className = candidate.properties?.className;
  const classNames = Array.isArray(className)
    ? className
    : typeof className === "string"
      ? className.split(/\s+/)
      : [];
  const line = candidate.position?.start?.line;
  return classNames.includes("task-list-item") &&
    typeof line === "number" &&
    Number.isSafeInteger(line) &&
    line > 0
    ? line
    : null;
}

/** Creates a cache-safe list-item renderer with only parse-derived state. */
export function createTaskListItem(listItemClassName: string) {
  return function MarkdownTaskListItem({
    children,
    node,
  }: MarkdownTaskListItemProps) {
    return (
      <TaskListLineContext.Provider value={taskListLine(node)}>
        <li className={listItemClassName}>{children}</li>
      </TaskListLineContext.Provider>
    );
  };
}

export function MarkdownInput({
  checked,
  className,
  node: _node,
  type,
  ...props
}: MarkdownInputProps) {
  const taskLine = React.useContext(TaskListLineContext);
  const { onToggleTask } = useMarkdownRuntime();
  if (type === "checkbox") {
    const canToggleTask = taskLine !== null && onToggleTask !== undefined;
    return (
      <Checkbox
        aria-label={checked ? "Completed task" : "Incomplete task"}
        checked={Boolean(checked)}
        className={cn(
          "mr-1.5 inline-flex align-[-0.125rem] disabled:opacity-45",
          !canToggleTask && "pointer-events-none",
          className,
        )}
        disabled={!canToggleTask}
        onCheckedChange={
          canToggleTask
            ? (nextChecked) => {
                if (taskLine !== null) {
                  onToggleTask(taskLine, nextChecked === true);
                }
              }
            : undefined
        }
        tabIndex={canToggleTask ? 0 : -1}
      />
    );
  }

  return <input {...props} className={className} type={type} />;
}
