import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const shellSource = readFileSync(
  new URL("./CollaboratorWorkspaceShell.tsx", import.meta.url),
  "utf8",
);
const rootRouteSource = readFileSync(
  new URL("../../app/routes/root.tsx", import.meta.url),
  "utf8",
);
const appSource = readFileSync(
  new URL("../../app/App.tsx", import.meta.url),
  "utf8",
);

test("task-only shell contains one workspace destination and no operational surfaces", () => {
  assert.match(shellSource, /workspaceSurfaceLabel/);
  assert.match(shellSource, /<Outlet \/>/);
  for (const forbidden of [
    "Agent",
    "Community",
    "Relay",
    "Settings",
    "Terminal",
    "TopbarSearch",
  ]) {
    assert.equal(shellSource.includes(forbidden), false, forbidden);
  }
});

test("root and app both enforce the task-only distribution boundary", () => {
  assert.match(rootRouteSource, /beforeLoad/);
  assert.match(rootRouteSource, /canAccessDistributionRoute/);
  assert.match(rootRouteSource, /redirect\(\{ to: "\/browser"/);
  assert.match(appSource, /isTaskOnlyDistribution\(buildWorkspaceProfile\)/);
  assert.match(appSource, /function TaskOnlyApp\(\)/);
  assert.match(appSource, /<RouterProvider router=\{router\} \/>/);
});
