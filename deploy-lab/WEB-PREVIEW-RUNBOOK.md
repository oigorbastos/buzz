# Buzz · Alis Lab web preview

This environment is a UX review surface, not a production relay staging.

## Safety contract

- It contains fictional, disposable boards only.
- Browser bootstrap is locked to the mock bridge.
- No `.env`, API token, Nostr key, production database, or production relay is loaded.
- Static assets run from root-owned `/srv/buzz-alis-preview` under the dedicated
  `buzz-preview` system user, which has no login or home.
- `ProtectHome=true` makes user homes inaccessible to the service.
- The service has no IP networking (`AF_UNIX` only) and listens on the Unix
  socket `/run/buzz-alis-preview/http.sock`.
- Tailscale Serve publishes it to the tailnet over HTTPS; Funnel is not used.
- The static server accepts only the public tailnet hostname and Tailscale
  Serve's internal `localhost` host on that root-only Unix socket.
- CSP blocks browser connections outside the preview origin.

## Review URL

```text
https://hermes-vps.taild6a99a.ts.net:8444/?preview=lab-v2#/lab
```

The preview store is fictional and resets on every page load. `resetDevState=1`
also clears this origin's local/session storage before startup.

## Rebuild after a UI change

```bash
cd /home/codexdev/projects/buzz-alis-preview
./scripts/deploy-lab-web-preview.sh
```

This compiles TypeScript and Vite assets only. It does not build Rust, Tauri,
sidecars, an installer, or a Windows executable. Before publishing, it also
tests the static server's host lock, read-only methods, CSP, path containment,
and symlink containment.

## Checks

```bash
systemctl status buzz-alis-preview --no-pager
tailscale serve status
curl -I 'https://hermes-vps.taild6a99a.ts.net:8444/?preview=lab-v2'
```

## Disable

```bash
sudo systemctl disable --now buzz-alis-preview
sudo tailscale serve --https=8444 off
```
