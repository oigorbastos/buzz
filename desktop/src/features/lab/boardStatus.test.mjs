import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  availableArchiveAction,
  boardAccessBadgeLabel,
  canModerateBoards,
  canRenameBoard,
  isBoardLocked,
} from "./boardStatus.ts";
import { canEditBoard } from "./model.ts";

describe("Lab board status rules", () => {
  it("locks editing for frozen AND archived boards", () => {
    assert.equal(isBoardLocked("active"), false);
    assert.equal(isBoardLocked("frozen"), true);
    // The relay accepts an update to an archived board — only this client-side
    // rule stops archiving from being undone by the next Edit click.
    assert.equal(isBoardLocked("archived"), true);
  });

  it("offers only the transition the relay accepts from each status", () => {
    assert.equal(availableArchiveAction("active"), "archive");
    assert.equal(availableArchiveAction("archived"), "unarchive");
    // `required_source_status` is 'active' for archive and 'archived' for
    // unarchive, so a frozen board has no legal move here.
    assert.equal(availableArchiveAction("frozen"), null);
  });

  it("treats only community owner and admin as board moderators", () => {
    assert.equal(canModerateBoards("owner"), true);
    assert.equal(canModerateBoards("admin"), true);
    assert.equal(canModerateBoards("member"), false);
    // A managed (NIP-OA) agent has no `relay_members` row at all, so the
    // membership query resolves to null/undefined for it.
    assert.equal(canModerateBoards(null), false);
    assert.equal(canModerateBoards(undefined), false);
  });
});

describe("Lab board rename affordance", () => {
  const offered = {
    canWrite: true,
    isEditing: false,
    status: "active",
    viewingRevision: null,
  };

  it("is offered on a live, unlocked board the viewer can write", () => {
    assert.equal(canRenameBoard(offered), true);
  });

  it("is withheld from anyone who may not write the board", () => {
    // Fed by `canEditBoard` — the audited ACL — rather than re-derived here.
    // A non-owner looking at a read-only board is the case that matters: the
    // relay would answer "lab board not found", so offering the button at all
    // would be a lie.
    const readOnlyBoard = { access: "community_readonly", ownerPubkey: "a" };
    const stranger = canEditBoard(readOnlyBoard, "b");
    assert.equal(stranger, false);
    assert.equal(canRenameBoard({ ...offered, canWrite: stranger }), false);
  });

  it("is withheld from a frozen or archived board", () => {
    // Same widened lock the Edit button uses: the relay refuses a frozen
    // board outright, and renaming an archived one would resurrect it into
    // the default list under a new name.
    assert.equal(canRenameBoard({ ...offered, status: "frozen" }), false);
    assert.equal(canRenameBoard({ ...offered, status: "archived" }), false);
  });

  it("is withheld while a draft is open", () => {
    // A rename is itself a compare-and-swap against the head, so allowing one
    // mid-edit would invalidate the draft's frozen `prev` and turn the user's
    // own save into a conflict.
    assert.equal(canRenameBoard({ ...offered, isEditing: true }), false);
  });

  it("is withheld on a revision-pinned deep link", () => {
    // Revision 0 is a real revision, not "no revision" — the guard tests
    // against null on purpose.
    assert.equal(canRenameBoard({ ...offered, viewingRevision: 3 }), false);
    assert.equal(canRenameBoard({ ...offered, viewingRevision: 0 }), false);
  });
});

describe("Lab board access badge", () => {
  it("tells a read-only board's writer that they can still edit", () => {
    // The bug this fixes: "Read-only" sat next to an enabled Edit button.
    assert.equal(
      boardAccessBadgeLabel({ access: "community_readonly", canWrite: true }),
      "Read-only · you can edit",
    );
  });

  it("keeps the plain label for everyone who cannot write", () => {
    assert.equal(
      boardAccessBadgeLabel({ access: "community_readonly", canWrite: false }),
      "Read-only",
    );
  });

  it("leaves the unambiguous scopes untouched", () => {
    for (const canWrite of [true, false]) {
      assert.equal(
        boardAccessBadgeLabel({ access: "community", canWrite }),
        "Community",
      );
      assert.equal(
        boardAccessBadgeLabel({ access: "private", canWrite }),
        "Private",
      );
    }
  });
});
