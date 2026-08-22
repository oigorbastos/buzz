import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./BrowserScreen.tsx", import.meta.url),
  "utf8",
);
const webview2Source = readFileSync(
  new URL("../../../vendor/wry-browser/src/webview2/mod.rs", import.meta.url),
  "utf8",
);

test("native child lifecycle is serialized and fails closed around overlays", () => {
  for (const selector of [
    "boot-splash-overlay",
    "onboarding-entering-curtain",
    "community-change-overlay",
    "relay-connection-overlay",
    "relay-error-overlay",
    "data-huddle-open",
    "data-sonner-toast",
  ]) {
    assert.match(source, new RegExp(selector));
  }

  assert.match(source, /epoch: 0/);
  assert.match(source, /queue: Promise\.resolve\(\)/);
  assert.match(source, /hasBlockingOverlay\(\)[\s\S]*hideBrowserChild/);
  assert.match(source, /lifecycleRef\.current\.epoch !== epoch/);
  assert.match(source, /new MutationObserver\(scheduleBounds\)/);
});

test("native invoke string errors remain visible to the operator", () => {
  assert.match(source, /typeof error === "string" && error\.trim\(\)/);
  assert.match(source, /browserErrorMessage\(\s*error,/);
});

test("WebView2 uses current clipboard descriptors and a response policy", () => {
  assert.match(webview2Source, /\["clipboard-read", "clipboard-write"\]/);
  assert.doesNotMatch(webview2Source, /"clipboardReadWrite"/);
  assert.doesNotMatch(webview2Source, /"clipboardSanitizedWrite"/);
  assert.match(webview2Source, /"Permissions-Policy"/);
  assert.match(webview2Source, /clipboard-read=\(\), clipboard-write=\(\)/);
});
