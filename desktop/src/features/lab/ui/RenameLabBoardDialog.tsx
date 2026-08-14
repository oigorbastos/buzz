import * as React from "react";

import {
  describeBoardRenameError,
  type LabBoardHead,
  MAX_TITLE_CHARS,
  validateBoardRename,
} from "@/features/lab/api";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { ChooserDialogContent } from "@/shared/ui/chooser-dialog-content";
import { Dialog } from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";

const FIELD_SHELL_CLASS =
  "rounded-xl border border-input bg-muted/40 transition-colors duration-150 ease-out hover:border-muted-foreground/40 focus-within:border-muted-foreground/50";
const FIELD_CONTROL_CLASS =
  "border-0 bg-transparent shadow-none outline-none ring-0 transition-colors duration-150 ease-out focus:bg-transparent focus:text-foreground focus:outline-hidden focus-visible:ring-0";

type RenameLabBoardDialogProps = {
  /** The head the rename compare-and-swaps against — see `boardRenamePayload`
   * for why the whole head travels together rather than just its title. */
  board: LabBoardHead;
  isRenaming: boolean;
  onOpenChange: (open: boolean) => void;
  /** Rejects with whatever the relay said; the dialog translates it. */
  onRename: (title: string) => Promise<unknown>;
  open: boolean;
};

export function RenameLabBoardDialog({
  board,
  isRenaming,
  onOpenChange,
  onRename,
  open,
}: RenameLabBoardDialogProps) {
  const [title, setTitle] = React.useState(board.title);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const titleInputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!open) return;
    // Seeded with the current name so the common case — fixing a typo — starts
    // from the text being fixed rather than from an empty box.
    setTitle(board.title);
    setErrorMessage(null);
    const timerId = globalThis.setTimeout(() => {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }, 50);
    return () => globalThis.clearTimeout(timerId);
  }, [board.title, open]);

  const trimmedTitle = title.trim();
  const isUnchanged = trimmedTitle === board.title;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validationError = validateBoardRename({ head: board, title });
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }

    setErrorMessage(null);
    try {
      await onRename(trimmedTitle);
      onOpenChange(false);
    } catch (error) {
      // Stay open, keeping the typed name. A conflict here means the board
      // moved and the rename was refused — the user has to be told, and made
      // to retype nothing.
      setErrorMessage(describeBoardRenameError(error));
    }
  }

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!nextOpen && isRenaming) return;
        onOpenChange(nextOpen);
      }}
      open={open}
    >
      <ChooserDialogContent
        className="max-w-lg"
        contentClassName="pt-3"
        data-testid="rename-lab-board-dialog"
        footer={
          <div className="flex w-full items-center justify-end gap-3">
            <Button
              data-testid="rename-lab-board-cancel"
              disabled={isRenaming}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              data-testid="rename-lab-board-submit"
              disabled={isRenaming || trimmedTitle.length === 0 || isUnchanged}
              form="rename-lab-board-form"
              type="submit"
            >
              {isRenaming ? "Renaming..." : "Rename board"}
            </Button>
          </div>
        }
        footerClassName="border-t-0 pt-0"
        headerClassName="pb-2"
        headerSubtitle="Only the name changes. The board's text, tags, and history stay exactly as they are."
        title="Rename board"
      >
        <form
          className="space-y-4"
          id="rename-lab-board-form"
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
        >
          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="rename-lab-board-title"
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
                data-testid="rename-lab-board-title"
                disabled={isRenaming}
                id="rename-lab-board-title"
                // Mirrors the relay's own cap so the field stops where the
                // relay would refuse, instead of paying a round trip to learn.
                maxLength={MAX_TITLE_CHARS}
                onChange={(event) => setTitle(event.target.value)}
                ref={titleInputRef}
                value={title}
              />
            </div>
          </div>

          {errorMessage ? (
            <p
              className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              data-testid="rename-lab-board-error"
            >
              {errorMessage}
            </p>
          ) : null}
        </form>
      </ChooserDialogContent>
    </Dialog>
  );
}
