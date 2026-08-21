import assert from "node:assert/strict";
import test from "node:test";

import {
  copyApprovedPresetUrl,
  getBrowserSecurityStatus,
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
    return {
      type: "completed",
      action: args.action.type,
      preset: args.action.preset,
    };
  };

  await getBrowserSecurityStatus(invoke);
  await copyApprovedPresetUrl("mission-control", invoke);
  await openApprovedPresetExternally("sessions", invoke);

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
  ]);
  assert.equal(JSON.stringify(calls).includes("http"), false);
});
