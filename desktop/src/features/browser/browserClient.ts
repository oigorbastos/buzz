import { invoke } from "@tauri-apps/api/core";

import type {
  BrowserAction,
  BrowserActionResult,
  BrowserPresetId,
  BrowserSecurityStatus,
} from "./browserTypes";

type BrowserInvoker = <T>(
  command: string,
  args: Record<string, unknown>,
) => Promise<T>;

export async function invokeBrowserAction(
  action: BrowserAction,
  invokeCommand: BrowserInvoker = invoke,
): Promise<BrowserActionResult> {
  return invokeCommand<BrowserActionResult>("browser_action", { action });
}

export async function getBrowserSecurityStatus(
  invokeCommand?: BrowserInvoker,
): Promise<BrowserSecurityStatus> {
  const result = await invokeBrowserAction(
    { type: "security_status" },
    invokeCommand,
  );
  if (result.type !== "security_status") {
    throw new Error("Unexpected Browser security response");
  }
  return result;
}

export async function copyApprovedPresetUrl(
  preset: BrowserPresetId,
  invokeCommand?: BrowserInvoker,
): Promise<void> {
  const result = await invokeBrowserAction(
    { type: "copy_url", preset },
    invokeCommand,
  );
  if (result.type !== "completed" || result.action !== "copy_url") {
    throw new Error("Unexpected Browser copy response");
  }
}

export async function openApprovedPresetExternally(
  preset: BrowserPresetId,
  invokeCommand?: BrowserInvoker,
): Promise<void> {
  const result = await invokeBrowserAction(
    { type: "open_external", preset },
    invokeCommand,
  );
  if (result.type !== "completed" || result.action !== "open_external") {
    throw new Error("Unexpected Browser external-open response");
  }
}
