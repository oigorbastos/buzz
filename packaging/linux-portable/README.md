# buzz-alis — portable Linux build

Same six executables as the Windows portable package, built for
`x86_64-unknown-linux-gnu` and unbundled: no installer, no auto-updater, no
signature. The app links against the host's GTK 3 / WebKitGTK 4.1 stack rather
than shipping its own, which is why the package is small and why
`check-deps.sh` exists.

## Install

```bash
tar xzf buzz-alis-<label>-linux-portable-x64.tar.gz
cd buzz-alis-<label>-linux-portable-x64
./install.sh
```

Installs under `~/.local` (no root): binaries in `~/.local/share/buzz-alis`,
launcher `~/.local/bin/buzz-alis`, desktop entry + `buzz://` scheme handler in
`~/.local/share/applications`. Run it again over an existing install to upgrade.

Or skip the installer entirely — `./buzz-desktop` runs straight from the
extracted directory, as long as the sidecars stay next to it.

## Requirements

Arch / Omarchy — a stock Omarchy 4 install already has the GTK/WebKit stack, so
in practice this line is about GStreamer:

```bash
sudo pacman -S --needed gst-plugins-good gst-libav
```

`gst-plugins-good` is **not optional**. WebKit looks up the `autoaudiosink`
element by name at startup; without it WebKit gets a null element, connects a
signal to it, and the web process aborts — the window opens empty and dies,
with one line of stderr as the only clue. `ldd` cannot see this coming, which
is why `check-deps.sh` checks the elements separately. `gst-libav` is the AAC
and general media decoder: without it the app runs fine but audio and video
messages will not play. `gst-plugins-bad` is not needed.

Debian / Ubuntu: `gstreamer1.0-plugins-good gstreamer1.0-libav`, plus
`libwebkit2gtk-4.1-0 libgtk-3-0 libsoup-3.0-0 librsvg2-2 libasound2` if the
GTK/WebKit stack is not already there.

Run `./check-deps.sh` — it reports both the shared libraries and the GStreamer
elements, and prints the exact pacman line for whatever is missing.

## Blank or black window

First rule out GStreamer with `./check-deps.sh` — a missing `autoaudiosink`
looks exactly like a rendering failure. If that is clean, the app has its own
rendering escape hatch, which the launcher passes straight through:

```bash
buzz-alis --safe-rendering   # WEBKIT_DMABUF_RENDERER_FORCE_SHM=1 + no compositing
buzz-alis --x11              # last resort: GDK_BACKEND=x11, via XWayland
```

Do **not** set `WEBKIT_DISABLE_DMABUF_RENDERER=1`, the switch older guides
recommend. On current WebKitGTK it empties the buffer transport set and crashes
the web process instead of fixing it; `--safe-rendering` uses the supported
replacement.

## What is in the package

| File | Role |
|---|---|
| `buzz-desktop` | the app |
| `buzz` | CLI (`buzz --help`) |
| `buzz-acp` | ACP bridge sidecar |
| `buzz-agent` | agent runtime sidecar |
| `buzz-backend-kubernetes` | Kubernetes backend sidecar (Linux only) |
| `buzz-dev-mcp` | dev MCP server sidecar |
| `git-credential-nostr` | git credential helper |
| `BUILD-MANIFEST.txt` | source SHA, toolchains, and every gate the build ran |

The sidecars are resolved next to `buzz-desktop`, so keep them together.
