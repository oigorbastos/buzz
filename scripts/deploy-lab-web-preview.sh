#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DIST_DIR="$REPO_ROOT/desktop/dist"
RUNTIME_ROOT=/srv/buzz-alis-preview
SERVICE_USER=buzz-preview
STAGING_DIR=""

hash_tree() {
  local tree_root=$1
  (
    cd "$tree_root"
    find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-12
  )
}

cleanup_staging() {
  if [[ -n "$STAGING_DIR" && "$STAGING_DIR" == "$RUNTIME_ROOT/releases/."* ]]; then
    sudo rm -rf -- "$STAGING_DIR"
  fi
}
trap cleanup_staging EXIT

node --test "$REPO_ROOT/deploy-lab/static-preview-server.test.mjs"
"$REPO_ROOT/scripts/build-lab-web-preview.sh"

FIRST_DIST_SYMLINK=$(find "$DIST_DIR" -type l -print -quit)
if [[ -n "$FIRST_DIST_SYMLINK" ]]; then
  echo "Refusing to deploy a dist tree containing symlinks: $FIRST_DIST_SYMLINK" >&2
  exit 1
fi

SOURCE_REV=$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)
ASSET_HASH=$(hash_tree "$DIST_DIR")
RELEASE_ID="${SOURCE_REV}-${ASSET_HASH}"
RELEASE_DIR="$RUNTIME_ROOT/releases/$RELEASE_ID"

if ! getent passwd "$SERVICE_USER" >/dev/null; then
  sudo useradd --system --user-group --home-dir /nonexistent \
    --shell /usr/sbin/nologin "$SERVICE_USER"
fi

sudo install -d -o root -g root -m 0755 \
  "$RUNTIME_ROOT/releases" "$RUNTIME_ROOT/server"
if [[ ! -d "$RELEASE_DIR" ]]; then
  STAGING_DIR=$(sudo mktemp -d \
    "$RUNTIME_ROOT/releases/.${RELEASE_ID}.staging.XXXXXX")
  sudo cp -a "$DIST_DIR/." "$STAGING_DIR/"
  sudo chown -R root:root "$STAGING_DIR"
  sudo find "$STAGING_DIR" -type d -exec chmod 0755 {} +
  sudo find "$STAGING_DIR" -type f -exec chmod 0644 {} +
  sudo -u "$SERVICE_USER" test -r "$STAGING_DIR/index.html"
  STAGING_HASH=$(hash_tree "$STAGING_DIR")
  if [[ "$STAGING_HASH" != "$ASSET_HASH" ]]; then
    echo "Staged release hash mismatch; refusing to publish." >&2
    exit 1
  fi
  sudo mv -T "$STAGING_DIR" "$RELEASE_DIR"
  STAGING_DIR=""
elif [[ "$(hash_tree "$RELEASE_DIR")" != "$ASSET_HASH" ]]; then
  echo "Existing release is incomplete or corrupted: $RELEASE_DIR" >&2
  exit 1
fi
sudo -u "$SERVICE_USER" test -r "$RELEASE_DIR/index.html"
sudo install -o root -g root -m 0644 \
  "$REPO_ROOT/deploy-lab/static-preview-server.mjs" \
  "$RUNTIME_ROOT/server/static-preview-server.mjs"
CURRENT_LINK_TMP="$RUNTIME_ROOT/.current.${RELEASE_ID}.$$"
sudo ln -s "$RELEASE_DIR" "$CURRENT_LINK_TMP"
sudo mv -Tf "$CURRENT_LINK_TMP" "$RUNTIME_ROOT/current"
sudo install -o root -g root -m 0644 \
  "$REPO_ROOT/deploy-lab/buzz-alis-preview.service" \
  /etc/systemd/system/buzz-alis-preview.service

sudo systemctl daemon-reload
sudo systemctl enable buzz-alis-preview
sudo systemctl restart buzz-alis-preview

PREVIEW_SOCKET=/run/buzz-alis-preview/http.sock
PREVIEW_HOST=hermes-vps.taild6a99a.ts.net
SERVICE_READY=0
for _ in {1..50}; do
  if sudo curl --fail --silent --show-error --unix-socket "$PREVIEW_SOCKET" \
    --header "Host: $PREVIEW_HOST" http://localhost/ >/dev/null; then
    SERVICE_READY=1
    break
  fi
  sleep 0.2
done
if [[ "$SERVICE_READY" != "1" ]]; then
  sudo systemctl status buzz-alis-preview --no-pager >&2 || true
  exit 1
fi

sudo tailscale serve --yes --bg --https=8444 \
  "unix:$PREVIEW_SOCKET"
curl --fail --silent --show-error \
  "https://${PREVIEW_HOST}:8444/?preview=lab-v2" >/dev/null

echo "Deployed Lab preview release ${RELEASE_ID}."
