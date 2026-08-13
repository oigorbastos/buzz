import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  availableArchiveAction,
  boardAccessBadgeLabel,
  canModerateBoards,
  isBoardLocked,
} from "./boardStatus.ts";

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
