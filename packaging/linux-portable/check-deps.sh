#!/usr/bin/env bash
# Reports what buzz-desktop needs from this machine and cannot find.
#
# Two independent checks, because they fail in completely different ways:
#
#   1. Shared libraries. A portable build links against the host's GTK/WebKit
#      stack, and a missing .so means the binary never starts at all.
#   2. GStreamer elements. WebKit looks these up BY NAME at runtime, so `ldd`
#      is blind to them. When `autoaudiosink` is absent, WebKit gets a null
#      element, connects a signal to it, and the whole web process aborts --
#      the window stays empty and the only clue is one line of stderr. That is
#      a real failure on a fresh Arch/Omarchy box, where gst-plugins-good is
#      not part of the base install.
set -uo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="${1:-$PKG_DIR/buzz-desktop}"
status=0

if [[ ! -f "$BIN" ]]; then
    echo "check-deps: $BIN not found" >&2
    exit 1
fi

# --- 1. shared libraries ------------------------------------------------
if command -v ldd >/dev/null 2>&1; then
    missing=$(ldd "$BIN" 2>/dev/null | awk '/not found/ {print $1}' | sort -u)
    if [[ -z "$missing" ]]; then
        echo "Shared libraries: OK — every library buzz-desktop links resolves."
    else
        status=1
        echo "Shared libraries: MISSING"
        printf '  %s\n' $missing
        pkgs=""
        for lib in $missing; do
            case "$lib" in
                libwebkit2gtk-4.1*|libjavascriptcoregtk-4.1*) pkgs="$pkgs webkit2gtk-4.1" ;;
                libgtk-3*|libgdk-3*)                          pkgs="$pkgs gtk3" ;;
                libsoup-3*)                                   pkgs="$pkgs libsoup3" ;;
                libayatana-appindicator3*)                    pkgs="$pkgs libayatana-appindicator" ;;
                libxdo*)                                      pkgs="$pkgs xdotool" ;;
                librsvg-2*)                                   pkgs="$pkgs librsvg" ;;
                libasound*)                                   pkgs="$pkgs alsa-lib" ;;
                libssl*|libcrypto*)                           pkgs="$pkgs openssl" ;;
                libgst*)                                      pkgs="$pkgs gst-plugins-base-libs" ;;
                *)                                            echo "  (no known package for $lib)" ;;
            esac
        done
        [[ -n "$pkgs" ]] && echo "  Arch/Omarchy: sudo pacman -S --needed$(printf '%s' "$pkgs" | tr ' ' '\n' | sort -u | tr '\n' ' ' | sed 's/^/ /')"
    fi
else
    echo "Shared libraries: skipped (no ldd on this machine)"
fi

# --- 2. GStreamer elements ----------------------------------------------
if ! command -v gst-inspect-1.0 >/dev/null 2>&1; then
    status=1
    echo "GStreamer: MISSING — gst-inspect-1.0 not found, so GStreamer itself is absent."
    echo "  Arch/Omarchy: sudo pacman -S --needed gstreamer gst-plugins-base gst-plugins-good gst-libav"
else
    # autoaudiosink is the one that decides whether the app runs or aborts.
    if gst-inspect-1.0 autoaudiosink >/dev/null 2>&1; then
        echo "GStreamer autoaudiosink: OK"
    else
        status=1
        echo "GStreamer autoaudiosink: MISSING — this CRASHES the WebKit web process,"
        echo "  which looks like the app opening an empty window and dying."
        echo "  Arch/Omarchy: sudo pacman -S --needed gst-plugins-good"
    fi
    # Not fatal: without a decoder, audio and video attachments simply will not
    # play, and WebKit logs "Missing decoder" instead of aborting.
    if gst-inspect-1.0 avdec_aac >/dev/null 2>&1 || gst-inspect-1.0 faad >/dev/null 2>&1; then
        echo "GStreamer AAC decoder: OK"
    else
        echo "GStreamer AAC decoder: absent (not fatal) — audio/video messages will not play."
        echo "  Arch/Omarchy: sudo pacman -S --needed gst-libav"
    fi
fi

exit $status
