# Buzz Web Workspace Wry patch

This directory is a source copy of `wry` 0.56.1 (Apache-2.0 OR MIT), pinned for
the Windows-only Web Workspace child.

Buzz keeps this copy separate from Tauri's own Wry version. The upstream
Windows backend unconditionally installs `window.ipc`, even when the embedding
application did not configure an IPC receiver. Buzz changes that call site to
install the bridge only when `ipc_handler` is present. The Web Workspace never
sets one, so remote documents receive no initialization script or host bridge.

Two narrowly scoped Windows builder controls are also added:

- a resource-request allow/deny callback, used to return a local 403 for every
  request outside the selected preset's exact origin;
- fail-closed HTML file chooser suppression, installed through
  `Page.setInterceptFileChooserDialog` before the first navigation;
- cancellation of external URI-scheme launches before Windows can hand them
  to the operating system;
- completion-aware profile clearing so the local command returns only after
  WebView2 reports that browsing data was removed.

The Cargo manifest is pruned to the Windows and platform-neutral dependencies
used by this target-specific package. No behavior outside the conditional IPC
call is changed. When upstream ships the same behavior, replace this directory
with the released crate and remove the path dependency.
