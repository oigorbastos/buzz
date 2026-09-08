# buzz-alis — portable Linux build

Same seven executables as the Windows portable package (Linux adds the
`buzz-backend-kubernetes` sidecar), built for
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
buzz-alis --x11              # GDK_BACKEND=x11, via XWayland
```

`--x11` is worth trying for a second reason: WebKitGTK media capture is noted
in-code (`desktop/src-tauri/src/linux_media.rs`) as reliable on the X11 backend,
which only the AppImage ever pinned. If the microphone stays silent in a Huddle
under native Wayland, retry the app with `--x11`.

Do **not** set `WEBKIT_DISABLE_DMABUF_RENDERER=1`, the switch older guides
recommend. On current WebKitGTK it empties the buffer transport set and crashes
the web process instead of fixing it; `--safe-rendering` uses the supported
replacement.

## First run

The install is a blank slate — it shares nothing with a Buzz install on another
machine.

1. **Identity.** Onboarding offers *Create a new identity key* or *Use an
   existing key*. A new key is a different pubkey, and relay membership is per
   pubkey, so a fresh key is not a member of anything. To keep the identity from
   another machine, bring its nsec over yourself (or the `ncryptsec` file from
   Settings › Backup, plus its password) and pick *Use an existing key*. There is
   no desktop-to-desktop QR pairing.
2. **Relay.** After the identity, *Join a community* takes the relay address;
   `https://host:3020` is fine, the app normalizes it. A relay saved through the
   UI wins over the `BUZZ_RELAY_URL` environment variable.
3. **Smoke test without the GUI**, if the app cannot reach the relay and you want
   to know which half is broken:

   ```bash
   BUZZ_RELAY_URL=https://<host>:3020 BUZZ_PRIVATE_KEY=<nsec> \
     ~/.local/share/buzz-alis/buzz channels list
   ```

## Known limits on Linux

None of these are packaging bugs — they are places where this app has a macOS or
X11 path and Linux/Wayland has none. Listed so they are not mistaken for a broken
install:

- **No tray icon.** `mod tray_menu` and hide-on-close are `#[cfg(target_os =
  "macos")]`, so closing the main window quits the app.
- **No auto-updater.** This build has the updater disabled by construction. To
  upgrade, extract the new tarball and run `./install.sh` again.
- **Push-to-talk (Ctrl+Space) does nothing on Wayland.** `global-hotkey` routes
  Linux through X11 only, and a failed registration is an `eprintln!` that never
  reaches the UI. Use voice activity detection instead.
- **"Keep awake while agents are active" is a no-op.** The whole of
  `prevent_sleep.rs` is macOS-gated; the toggle still renders.
- **"Open Project Terminal" and non-Claude ACP logins find no terminal.** Both
  call sites try exactly `x-terminal-emulator`, `gnome-terminal`, `konsole`,
  `xterm` and do not read `$TERMINAL` — so a machine whose terminal is `foot`,
  `alacritty` or `kitty` gets nothing. Stopgap: `sudo pacman -S --needed xterm`.
- **`buzz://lab` links do nothing from outside the app.** The scheme handler
  matches `connect`, `join`, `add-community`, `channel`, `message`,
  `repo`/`project`/`pr`/`issue` and `nostr-bind`; there is no `lab` arm, so the
  URL is logged and dropped. Lab links pasted *inside* the app still work — that
  is separate, frontend-side handling. Not Linux-specific.

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
