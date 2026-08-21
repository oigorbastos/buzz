import assert from "node:assert/strict";
import test from "node:test";

import {
  canAccessDistributionRoute,
  canMountBrowserSurface,
  isTaskOnlyDistribution,
  normalizeWorkspaceProfile,
  workspaceProfilesMatch,
  workspaceSurfaceLabel,
} from "./browserProfile.ts";

test("workspace profile is generic and fails closed", () => {
  assert.equal(normalizeWorkspaceProfile("operator"), "operator");
  assert.equal(normalizeWorkspaceProfile("collaborator"), "collaborator");
  assert.equal(normalizeWorkspaceProfile("barbara"), "disabled");
  assert.equal(normalizeWorkspaceProfile(undefined), "disabled");
});

test("collaborator distribution exposes only the task-oriented route", () => {
  assert.equal(isTaskOnlyDistribution("collaborator"), true);
  assert.equal(isTaskOnlyDistribution("operator"), false);
  assert.equal(canAccessDistributionRoute("collaborator", "/browser"), true);
  for (const path of [
    "/",
    "/agents",
    "/channels/secret",
    "/lab",
    "/projects",
    "/pulse",
    "/settings",
    "/workflows",
  ]) {
    assert.equal(canAccessDistributionRoute("collaborator", path), false, path);
  }
  assert.equal(canAccessDistributionRoute("operator", "/agents"), true);
  assert.equal(canAccessDistributionRoute("disabled", "/settings"), true);
});

test("operator needs the preview flag while collaborator build is an explicit opt-in", () => {
  assert.equal(canMountBrowserSurface(false, "operator"), false);
  assert.equal(canMountBrowserSurface(true, "disabled"), false);
  assert.equal(canMountBrowserSurface(true, "operator"), true);
  assert.equal(canMountBrowserSurface(false, "collaborator"), true);
  assert.equal(canMountBrowserSurface(true, "collaborator"), true);
});

test("collaborator distribution uses the task-oriented label", () => {
  assert.equal(workspaceSurfaceLabel("collaborator"), "Meu Trabalho");
  assert.equal(workspaceSurfaceLabel("operator"), "Web");
});

test("renderer and native distribution profiles must match exactly", () => {
  assert.equal(workspaceProfilesMatch("operator", "operator"), true);
  assert.equal(workspaceProfilesMatch("collaborator", "collaborator"), true);
  assert.equal(workspaceProfilesMatch("collaborator", "operator"), false);
  assert.equal(workspaceProfilesMatch("operator", "collaborator"), false);
  assert.equal(workspaceProfilesMatch("disabled", "disabled"), false);
});
