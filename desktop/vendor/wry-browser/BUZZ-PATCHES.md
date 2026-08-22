# Buzz Web Workspace Wry patch

This directory is a source copy of `wry` 0.56.1 (Apache-2.0 OR MIT), pinned for
the Windows-only Web Workspace child. The upstream crates.io archive is
`wry-0.56.1.crate`, SHA-256
`375becb4aded9913f736443cf88000c6311478db69814cc06070465e4cc44c98`.

Buzz keeps this copy separate from Tauri's own Wry version. The upstream
Windows backend unconditionally installs `window.ipc`, even when the embedding
application did not configure an IPC receiver. Buzz changes that call site to
install the bridge only when `ipc_handler` is present. The Web Workspace never
sets one, so remote documents receive no initialization script or host bridge.

The Windows fork adds the following fail-closed controls:

- a resource-request allow/deny callback, used to return a local 403 for every
  request outside the selected preset's exact origin;
- fail-closed HTML file chooser suppression, installed through
  `Page.setInterceptFileChooserDialog` before the first navigation;
- cancellation of external URI-scheme launches before Windows can hand them
  to the operating system;
- disabling WebView2 web messages and host objects whenever no IPC receiver is
  configured;
- fail-closed CDP blocking for every `ws://` and `wss://` connection, which
  `WebResourceRequested` does not reliably intercept;
- a response-stage document sandbox (`sandbox`, same-origin-only connections
  and forms, no workers or modals), with service-worker bypass enabled;
- denial of screen capture, clipboard reads/writes, autofill, notifications,
  Basic auth, client certificates, invalid server certificates and Save As UI;
- a document `Permissions-Policy` that independently disables clipboard,
  camera, microphone, geolocation and display capture for remote content;
- suppression of remote `window.close()` and all default script dialogs;
- completion-aware profile clearing so the local command returns only after
  the active document is closed and WebView2 reports that browsing data was
  removed.

The Cargo manifest is pruned to the Windows and platform-neutral dependencies
used by this target-specific package. Buzz compiles this path dependency from
`desktop/src-tauri/Cargo.lock`; the standalone vendor lock is intentionally not
versioned. When upstream ships equivalent controls, replace this directory with
the released crate and remove the path dependency.

Known residual boundary: current stable WebView2 has no supported switch that
removes permissionless `RTCPeerConnection`/RTCDataChannel. The CSP `webrtc`
directive is retained as future defense but is not treated as effective by the
adversarial review. Remote presets therefore remain trusted internal origins;
the release is a canary until the Windows harness and network capture are
reviewed on Gringo.
