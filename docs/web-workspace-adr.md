# ADR: preview Web Workspace

Status: accepted for implementation behind a closed preview gate (2026-08-21).

## Decision

Buzz Desktop gains one global `/browser` surface backed by one native child WebView
(`browser-main`). It is a preset workspace, not a general browser. The trusted React
renderer owns the toolbar; Rust owns the child lifecycle, bounds, navigation policy,
dedicated profile and local telemetry.

The implementation is based on fork commit `247ad412` without mixing the current
upstream convergence into the security changes. Upstream convergence remains a
separate review because the fork is already materially divergent and currently has
sidebar conflicts.

The preview has two generic distribution profiles:

| Profile | Sidebar label | Presets | Home |
| --- | --- | --- | --- |
| `operator` | Web | Mission Control, Sessions | Mission Control |
| `collaborator` | Meu Trabalho | Meu Trabalho | Meu Trabalho |
| default/unconfigured | hidden | none | none |

The profile only changes presentation. The remote server remains the authority for
identity, role, axis and case access.

## Trust boundaries

- `main` is the local privileged renderer. App and plugin capabilities are scoped to
  its webview label.
- `huddle-*` remains local but receives only its own explicitly required capability.
- `browser-main` is untrusted remote content. It has no Tauri capability, app command,
  remote URL capability, init script, postMessage bridge, host object or custom
  protocol access.
- Rust accepts preset IDs, never renderer-provided URLs. Exact HTTP(S) origins and
  allowed top-level paths are compiled/validated fail-closed. Redirects use the same
  policy.
- Popups, downloads and browser permissions are denied. External opening is possible
  only after an explicit local-toolbar action.
- Cookies/history stay in a dedicated directory below Buzz `app_data_dir`; they never
  enter relay, Nostr, community state or logs. Sign-out and clear-data cover that
  directory.
- A native child cannot be covered by CSS. Route exit, identity/community transition,
  boot/onboarding, global overlay, dialog/sheet and huddle occlusion hide it at the
  native layer.

## Security gate

No remote URL may load until capabilities are scoped by webview, every custom command
is inventoried in `AppManifest`, the media protocol rejects `browser-main`, caller and
URL policy tests pass, and an adversarial WebView2 harness proves that IPC, internal
schemes, popups, downloads and camera/microphone/geolocation/notification requests fail
closed. If the real Windows gate is not green, the preview remains locked and only the
renderer/foundation is reviewable.

## Non-goals

No free address bar, tabs, extensions, internal downloads, page automation, token
injection, URL/content logging, relay sync, new database, iframe fallback or claim that
Mission Control data became native Buzz data. The external browser remains the escape
hatch. Production deploy, merge and live Tailscale/ACL changes are outside this ADR.

## Operations and measurement

The Gringo defaults are the Mission Control and session-monitor presets. Prata exposes
only `/work` over its eventual HTTPS ingress. Dogfood telemetry is machine-local and
stores only preset/event counters and timestamps, never full URLs, query strings or
page content. Final DPI, z-order, permissions, persistent-login, clear-data and
revocation checks are external gates on Gringo/Prata.
