import * as React from "react";

import {
  MAX_SUMMARY_CHARS,
  MAX_TITLE_CHARS,
  validateBoardInput,
} from "@/features/lab/api";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { ChooserDialogContent } from "@/shared/ui/chooser-dialog-content";
import { Dialog } from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";

const FIELD_SHELL_CLASS =
  "rounded-xl border border-input bg-muted/40 transition-colors duration-150 ease-out hover:border-muted-foreground/40 focus-within:border-muted-foreground/50";
const FIELD_CONTROL_CLASS =
  "border-0 bg-transparent shadow-none outline-none ring-0 transition-colors duration-150 ease-out focus:bg-transparent focus:text-foreground focus:outline-hidden focus-visible:ring-0";

type CreateLabBoardDialogProps = {
  isCreating: boolean;
  onCreate: (input: {
    title: string;
    summary?: string;
    content: string;
  }) => Promise<unknown>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
};

export function CreateLabBoardDialog({
  isCreating,
  onCreate,
  onOpenChange,
  open,
}: CreateLabBoardDialogProps) {
  const [title, setTitle] = React.useState("");
  const [summary, setSummary] = React.useState("");
  const [content, setContent] = React.useState("");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const titleInputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!open) return;
    setTitle("");
    setSummary("");
    setContent("");
    setErrorMessage(null);
    const timerId = globalThis.setTimeout(() => {
      titleInputRef.current?.focus();
    }, 50);
    return () => globalThis.clearTimeout(timerId);
  }, [open]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;

    const validationError = validateBoardInput({
      title: trimmedTitle,
      summary: summary.trim() || undefined,
      content,
    });
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }

    setErrorMessage(null);
    try {
      await onCreate({
        title: trimmedTitle,
        summary: summary.trim() || undefined,
        content,
      });
      onOpenChange(false);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to create board.",
      );
    }
  }

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!nextOpen && isCreating) return;
        onOpenChange(nextOpen);
      }}
      open={open}
    >
      <ChooserDialogContent
        className="max-w-lg"
        contentClassName="pt-3"
        data-testid="create-lab-board-dialog"
        description="Boards are shared: everyone in this community can read and edit them."
        footer={
          <div className="flex w-full items-center justify-end gap-3">
            <Button
              data-testid="create-lab-board-submit"
              disabled={isCreating || title.trim().length === 0}
              form="create-lab-board-form"
              type="submit"
            >
              {isCreating ? "Creating..." : "Create board"}
            </Button>
          </div>
        }
        footerClassName="border-t-0 pt-0"
        headerClassName="pb-2"
        title="Create a board"
      >
        <form
          className="space-y-5"
          id="create-lab-board-form"
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
        >
          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="create-lab-board-title"
            >
              Title
            </label>
            <div
              className={cn(
                "flex min-h-11 items-center px-3",
                FIELD_SHELL_CLASS,
              )}
            >
              <Input
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect="off"
                className={cn("h-8 px-0 py-0 leading-6", FIELD_CONTROL_CLASS)}
                data-testid="create-lab-board-title"
                id="create-lab-board-title"
                maxLength={MAX_TITLE_CHARS}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Onboarding notes"
                ref={titleInputRef}
                value={title}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="create-lab-board-summary"
            >
              Summary
              <span className="ml-1 text-xs font-normal text-muted-foreground/50">
                optional
              </span>
            </label>
            <div
              className={cn(
                "flex min-h-11 items-center px-3",
                FIELD_SHELL_CLASS,
              )}
            >
              <Input
                className={cn("h-8 px-0 py-0 leading-6", FIELD_CONTROL_CLASS)}
                data-testid="create-lab-board-summary"
                id="create-lab-board-summary"
                maxLength={MAX_SUMMARY_CHARS}
                onChange={(event) => setSummary(event.target.value)}
                placeholder="What this board is for"
                value={summary}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="create-lab-board-content"
            >
              Content
            </label>
            <Textarea
              className="min-h-40 font-mono text-sm"
              data-testid="create-lab-board-content"
              id="create-lab-board-content"
              onChange={(event) => setContent(event.target.value)}
              placeholder="Write in Markdown..."
              value={content}
            />
          </div>

          {errorMessage ? (
            <p
              className="text-sm text-destructive"
              data-testid="create-lab-board-error"
            >
              {errorMessage}
            </p>
          ) : null}
        </form>
      </ChooserDialogContent>
    </Dialog>
  );
}
