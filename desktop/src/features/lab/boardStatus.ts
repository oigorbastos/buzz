/**
 * Pure status/label rules for Lab Boards.
 *
 * Kept out of `model.ts` on purpose: that module holds the board ACL
 * (`canEditBoard`/`canReadBoard`), which is audited authorization. Nothing
 * here decides who may do what — these are presentation and state-machine
 * rules that happen to read the same fields.
 */

import type { LabBoardAccess } from "@/features/lab/model";

/** Mirrors `lab_board_heads.status` (relay `LabBoardOp::target_status`). */
export type BoardStatus = "active" | "archived" | "frozen";

/**
 * A board whose content must not be edited from this client.
 *
 * `frozen` is refused by the relay itself (`handle_content_mutation` returns
 * "lab board is frozen and cannot be edited"). `archived` is NOT: the relay
 * happily accepts an update to an archived board. That asymmetry is why this
 * predicate exists rather than a bare `status === "frozen"` — archiving is
 * meant to retire a board, and offering an Edit button on something the user
 * just filed away would quietly resurrect it into the default list.
 */
export function isBoardLocked(status: BoardStatus): boolean {
  return status === "frozen" || status === "archived";
}

/**
 * The moderation op available from a board in this state, or `null` when none
 * is.
 *
 * Encodes `LabBoardOp::required_source_status` on the relay: `archive` demands
 * `active` and `unarchive` demands `archived`, so a `frozen` board offers
 * neither. Returning `null` instead of guessing keeps the UI from rendering a
 * button whose only outcome is a rejection.
 */
export function availableArchiveAction(
  status: BoardStatus,
): "archive" | "unarchive" | null {
  if (status === "active") return "archive";
  if (status === "archived") return "unarchive";
  return null;
}

/** Community roles the relay accepts for `ModerationAction::ModerateBoard`. */
export function canModerateBoards(relayRole: string | null | undefined) {
  return relayRole === "owner" || relayRole === "admin";
}

/**
 * The access badge's text.
 *
 * `community_readonly` means read-only *for other people*; the owner still
 * edits, and the Edit button sits right beside this badge. A bare "Read-only"
 * next to an enabled Edit button reads as a contradiction — it confused the
 * product's own owner during testing — so the writer's badge states both
 * halves. Non-writers keep the plain label, which for them is the whole truth.
 */
export function boardAccessBadgeLabel(input: {
  access: LabBoardAccess;
  canWrite: boolean;
}): string {
  if (input.access === "community") return "Community";
  if (input.access === "private") return "Private";
  return input.canWrite ? "Read-only · you can edit" : "Read-only";
}
