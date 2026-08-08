#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DESKTOP_DIR="$REPO_ROOT/desktop"

if [[ ! -x "$DESKTOP_DIR/node_modules/.bin/tsc" || ! -x "$DESKTOP_DIR/node_modules/.bin/vite" ]]; then
  echo "Desktop dependencies are missing; install them before building the preview." >&2
  exit 1
fi

SOURCE_REV=$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)
if [[ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]]; then
  SOURCE_REV="${SOURCE_REV}+dirty"
fi

cd "$DESKTOP_DIR"
VITE_LAB_PREVIEW=1 VITE_PREVIEW_COMMIT="$SOURCE_REV" \
  ./node_modules/.bin/tsc
VITE_LAB_PREVIEW=1 VITE_PREVIEW_COMMIT="$SOURCE_REV" \
  ./node_modules/.bin/vite build --mode e2e

echo "Built isolated Lab preview from ${SOURCE_REV}."
