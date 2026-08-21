# ADR: preview Web Workspace

Status: accepted for Windows canary behind the preview gate (2026-08-21).

## Decision

Buzz Desktop gains one global `/browser` surface backed on Windows by one native
child WebView (`browser-main`). It is a preset workspace, not a general browser. The
trusted React renderer owns the toolbar; Rust owns policy, child lifecycle, bounds
and the dedicated profile. Local telemetry remains renderer-side and machine-local.

The implementation is based on fork commit `247ad412` without mixing the current
upstream convergence into the security changes. Upstream convergence remains a
separate review because the fork is already materially divergent and currently has
textual conflicts in `AppSidebarPinnedHeader.tsx` and
`ViewLoadingFallback.tsx`.

The preview has two generic distribution profiles:

| Profile | Sidebar label | Presets | Home |
| --- | --- | --- | --- |
| `operator` | Web | Mission Control, Sessions | Mission Control |
| `collaborator` | Meu Trabalho | Meu Trabalho | Meu Trabalho |
| default/unconfigured | hidden | none | none |

The profile is a compile-time distribution policy, not a person selector. `operator`
keeps the standard Buzz shell and still requires the `browser` preview override.
`collaborator` is itself an explicit preview distribution: it skips Buzz
identity/community onboarding, mounts a task-only shell and redirects every route
except `/browser` back to that surface. It does not mount search, channels, Agents,
Settings, terminal, relay diagnostics, community controls or their dialogs. This is
UX containment; the remote server remains the authority for identity, role, axis and
case access.

Both build halves consume the single `BUZZ_BUILD_WEB_WORKSPACE_PROFILE` variable:
Vite injects that exact value into the trusted renderer and Rust reads it with
`option_env!`. The renderer also compares its compiled value with Rust's runtime
security status and fails closed on any mismatch. Collaborator presets require HTTPS
even in debug builds.

The portable workflow compiles either profile from explicit dispatch inputs. A
collaborator dispatch requires one canonical, non-loopback
`https://host[:port]/work` URL; a compile-time Rust test requires exactly one Work
preset, preventing a green artifact whose input was silently discarded. Push builds
remain operator-only.

## Trust boundaries

- `main` is the local privileged renderer. App and plugin capabilities are scoped to
  its webview label.
- `huddle-*` remains trusted local content and preserves the existing local
  capability set shared with `main`; only `browser-main` is deliberately excluded.
- `browser-main` is untrusted remote content. It is a raw Wry/WebView2 child outside
  Tauri's webview manager and has no Tauri capability, app command, remote URL
  capability, init script, postMessage bridge, host object or custom protocol access.
- Rust accepts preset IDs, never renderer-provided URLs. Exact HTTP(S) origins and
  allowed top-level paths are compiled/validated fail-closed. Redirects use the same
  policy.
- Every HTTP(S) resource request is restricted to the selected preset's exact
  origin, including worker and WebSocket contexts exposed by WebView2. Popups,
  downloads, file choosers, external URI schemes and browser permissions are denied.
  External opening is possible only after an explicit local-toolbar action.
- Cookies/history stay in a dedicated `web-workspace-webview2-v1` directory below
  Buzz `app_local_data_dir`; they never enter relay, Nostr, community state or logs.
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

### Current gate outcome

The stock Tauri 2.11.5 / Wry 0.55 child path remains rejected because it injects the
Tauri IPC bootstrap before capability checks. The Windows canary instead uses a
pinned, separately named Wry 0.56.1 source dependency with a narrow audited patch:
the upstream IPC script is installed only when an IPC receiver exists, and Buzz never
configures one. The patch also installs exact-origin resource interception,
fail-closed file-chooser interception and external-scheme cancellation before the
first navigation. Buzz production code adds no `unsafe`; native FFI stays inside the
vendored library boundary.

Static adversarial checks and the standalone Windows-target Wry compile are green.
The portable Windows artifact remains a canary until the Gringo run exercises the
fixture's IPC/internal-origin probes plus DPI, z-order, login persistence and clear
data against the actual WebView2 runtime. Any failed probe closes the preview again;
it does not justify relaxing CSP, adding an iframe fallback or exposing a bridge.

## Non-goals

No free address bar, tabs, extensions, internal downloads, page automation, token
injection, URL/content logging, relay sync, new database, iframe fallback or claim that
Mission Control data became native Buzz data. The external browser remains the escape
hatch. Production deploy, merge and live Tailscale/ACL changes are outside this ADR.

## Operations and measurement

The Gringo defaults are the Mission Control and session-monitor presets. Prata exposes
only `/work` over its eventual HTTPS ingress and uses the separately compiled
`collaborator` artifact. Dogfood telemetry is machine-local and stores only
preset/event counters and timestamps, never full URLs, query strings or page content.
Final DPI, z-order, permissions, persistent-login, clear-data and revocation checks
are external gates on Gringo/Prata.
