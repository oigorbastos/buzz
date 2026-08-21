import assert from "node:assert/strict";
import test from "node:test";

import {
  copyApprovedPresetUrl,
  getBrowserSecurityStatus,
  mountBrowserChild,
  navigateBrowserBack,
  openApprovedPresetExternally,
} from "./browserClient.ts";

test("browser client sends typed actions and never renderer-provided URLs", async () => {
  const calls = [];
  const invoke = async (command, args) => {
    calls.push({ command, args });
    if (args.action.type === "security_status") {
      return {
        type: "security_status",
        app_manifest_command_count: 315,
        configured: true,
        presets: [],
        profile: "operator",
        remote_child_has_capability: false,
        remote_content_enabled: false,
      };
    }
    if (["copy_url", "open_external"].includes(args.action.type)) {
      return {
        type: "completed",
        action: args.action.type,
        preset: args.action.preset,
      };
    }
    return {
      type: "runtime_state",
      action: args.action.type,
      mounted: true,
      visible: true,
      preset: "mission-control",
      can_go_back: false,
      can_go_forward: false,
    };
  };

  await getBrowserSecurityStatus(invoke);
  await copyApprovedPresetUrl("mission-control", invoke);
  await openApprovedPresetExternally("sessions", invoke);
  await mountBrowserChild(
    "mission-control",
    { x: 12, y: 80, width: 900, height: 600 },
    invoke,
  );
  await navigateBrowserBack(invoke);

  assert.deepEqual(calls, [
    {
      command: "browser_action",
      args: { action: { type: "security_status" } },
    },
    {
      command: "browser_action",
      args: {
        action: { type: "copy_url", preset: "mission-control" },
      },
    },
    {
      command: "browser_action",
      args: {
        action: { type: "open_external", preset: "sessions" },
      },
    },
    {
      command: "browser_action",
      args: {
        action: {
          type: "mount",
          preset: "mission-control",
          bounds: { x: 12, y: 80, width: 900, height: 600 },
        },
      },
    },
    {
      command: "browser_action",
      args: { action: { type: "back" } },
    },
  ]);
  assert.equal(JSON.stringify(calls).includes("http"), false);
});
