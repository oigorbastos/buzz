import assert from "node:assert/strict";
import test from "node:test";

import {
  canMountBrowserSurface,
  normalizeWorkspaceProfile,
  workspaceSurfaceLabel,
} from "./browserProfile.ts";

test("workspace profile is generic and fails closed", () => {
  assert.equal(normalizeWorkspaceProfile("operator"), "operator");
  assert.equal(normalizeWorkspaceProfile("collaborator"), "collaborator");
  assert.equal(normalizeWorkspaceProfile("barbara"), "disabled");
  assert.equal(normalizeWorkspaceProfile(undefined), "disabled");
});

test("direct route cannot mount without both preview and build profile", () => {
  assert.equal(canMountBrowserSurface(false, "operator"), false);
  assert.equal(canMountBrowserSurface(true, "disabled"), false);
  assert.equal(canMountBrowserSurface(true, "operator"), true);
  assert.equal(canMountBrowserSurface(true, "collaborator"), true);
});

test("collaborator distribution uses the task-oriented label", () => {
  assert.equal(workspaceSurfaceLabel("collaborator"), "Meu Trabalho");
  assert.equal(workspaceSurfaceLabel("operator"), "Web");
});
