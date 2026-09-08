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

Arch / Omarchy:

```bash
sudo pacman -S --needed webkit2gtk-4.1 gtk3 libsoup3 libayatana-appindicator xdotool librsvg alsa-lib
```

Debian / Ubuntu: `libwebkit2gtk-4.1-0 libgtk-3-0 libsoup-3.0-0
libayatana-appindicator3-1 libxdo3 librsvg2-2 libasound2`.

`./check-deps.sh` reports anything still missing and prints the pacman line.

## Blank or black window

WebKitGTK's DMABUF renderer is the usual culprit under a Wayland compositor:

```bash
buzz-alis --compat   # WEBKIT_DISABLE_DMABUF_RENDERER=1 + no compositing
buzz-alis --x11      # last resort: GDK_BACKEND=x11, via XWayland
```

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
