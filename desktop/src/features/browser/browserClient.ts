import { invoke } from "@tauri-apps/api/core";

import type {
  BrowserAction,
  BrowserActionResult,
  BrowserBounds,
  BrowserPresetId,
  BrowserRuntimeState,
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

async function performRuntimeAction(
  action: BrowserAction,
  invokeCommand?: BrowserInvoker,
): Promise<BrowserRuntimeState> {
  const result = await invokeBrowserAction(action, invokeCommand);
  if (result.type !== "runtime_state") {
    throw new Error("Unexpected Browser runtime response");
  }
  return result;
}

export function mountBrowserChild(
  preset: BrowserPresetId,
  bounds: BrowserBounds,
  invokeCommand?: BrowserInvoker,
) {
  return performRuntimeAction({ type: "mount", preset, bounds }, invokeCommand);
}

export function setBrowserChildBounds(
  bounds: BrowserBounds,
  invokeCommand?: BrowserInvoker,
) {
  return performRuntimeAction({ type: "set_bounds", bounds }, invokeCommand);
}

export function selectBrowserPreset(
  preset: BrowserPresetId,
  invokeCommand?: BrowserInvoker,
) {
  return performRuntimeAction({ type: "select_preset", preset }, invokeCommand);
}

export function navigateBrowserBack(invokeCommand?: BrowserInvoker) {
  return performRuntimeAction({ type: "back" }, invokeCommand);
}

export function navigateBrowserForward(invokeCommand?: BrowserInvoker) {
  return performRuntimeAction({ type: "forward" }, invokeCommand);
}

export function reloadBrowser(invokeCommand?: BrowserInvoker) {
  return performRuntimeAction({ type: "reload" }, invokeCommand);
}

export function navigateBrowserHome(
  preset: BrowserPresetId,
  invokeCommand?: BrowserInvoker,
) {
  return performRuntimeAction({ type: "home", preset }, invokeCommand);
}

export function showBrowserChild(invokeCommand?: BrowserInvoker) {
  return performRuntimeAction({ type: "show" }, invokeCommand);
}

export function hideBrowserChild(invokeCommand?: BrowserInvoker) {
  return performRuntimeAction({ type: "hide" }, invokeCommand);
}

export function focusBrowserChild(invokeCommand?: BrowserInvoker) {
  return performRuntimeAction({ type: "focus" }, invokeCommand);
}

export function clearBrowserData(invokeCommand?: BrowserInvoker) {
  return performRuntimeAction({ type: "clear_data" }, invokeCommand);
}

export function getBrowserRuntimeState(invokeCommand?: BrowserInvoker) {
  return performRuntimeAction({ type: "runtime_state" }, invokeCommand);
}
