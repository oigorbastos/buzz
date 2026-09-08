#!/usr/bin/env bash
# Reports which shared libraries buzz-desktop needs and cannot find on this
# machine. Portable builds link against the host's GTK/WebKit stack, so a
# missing library shows up as a silent launch failure rather than an error.
set -uo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="${1:-$PKG_DIR/buzz-desktop}"

if [[ ! -f "$BIN" ]]; then
    echo "check-deps: $BIN not found" >&2
    exit 1
fi
if ! command -v ldd >/dev/null 2>&1; then
    echo "check-deps: ldd unavailable, skipping" >&2
    exit 0
fi

missing=$(ldd "$BIN" 2>/dev/null | awk '/not found/ {print $1}' | sort -u)
if [[ -z "$missing" ]]; then
    echo "Dependency check: OK — every shared library resolves."
    exit 0
fi

echo "Dependency check: MISSING shared libraries:"
printf '  %s\n' $missing
echo
# Package names for the distros this build actually gets run on.
echo "Install them with (Arch/Omarchy):"
pkgs=""
for lib in $missing; do
    case "$lib" in
        libwebkit2gtk-4.1*|libjavascriptcoregtk-4.1*) pkgs="$pkgs webkit2gtk-4.1" ;;
        libgtk-3*|libgdk-3*)                          pkgs="$pkgs gtk3" ;;
        libsoup-3*)                                   pkgs="$pkgs libsoup3" ;;
        libayatana-appindicator3*|libayatana-indicator3*) pkgs="$pkgs libayatana-appindicator" ;;
        libxdo*)                                      pkgs="$pkgs xdotool" ;;
        librsvg-2*)                                   pkgs="$pkgs librsvg" ;;
        libasound*)                                   pkgs="$pkgs alsa-lib" ;;
        libssl*|libcrypto*)                           pkgs="$pkgs openssl" ;;
        *)                                            pkgs="$pkgs # unknown: $lib" ;;
    esac
done
echo "  sudo pacman -S --needed$(printf '%s' "$pkgs" | tr ' ' '\n' | sort -u | tr '\n' ' ' | sed 's/^/ /')"
exit 1
