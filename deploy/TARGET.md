# Target: one Linux VM running the KartRacer rooms server + GameNet relay

This document describes the deployment target for the Handshake server
(KartRacer rooms + GameNet relay + matchmaking). It is the human-readable
companion to `deploy/deploy.ts`; the dry run of that script renders exactly the
files named here and executes nothing.

## Host

- One Linux VM (x86-64 or arm64).
- Node.js >= 22.18 installed at `/usr/bin/node` (type stripping is used, so the
  server runs straight from TypeScript source).
- A system user `rooms` (`--system --no-create-home --shell /usr/sbin/nologin`).
- Application path `/opt/kart-rooms`, owned by `rooms`.
- TLS certificate material for the chosen domain (Caddy obtains it automatically;
  nginx expects Let's Encrypt files).

## Service (systemd)

- Unit name `kart-rooms`, installed from `deploy/rooms.service` to
  `/etc/systemd/system/kart-rooms.service`.
- `ExecStart` stays `/usr/bin/node --experimental-strip-types src/main.ts`.
- `EnvironmentFile=/etc/kart-rooms.env`.
- The unit is enabled and (re)started with `systemctl daemon-reload` followed by
  `systemctl restart kart-rooms`.

## Environment

`/etc/kart-rooms.env`, mode `640`, created from `deploy/rooms.env.example`.
It holds every `loadConfig` variable (defaults from `src/config.ts`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Plain HTTP/WS port; TLS is terminated by the proxy |
| `HOST` | `127.0.0.1` | Bind address; localhost only |
| `STUN_URLS` | `stun:stun.l.google.com:19302` | Comma-separated STUN urls sent to clients |
| `TURN_URLS` | (empty) | Comma-separated TURN urls; used only with `TURN_SECRET` |
| `TURN_SECRET` | (unset) | coturn `static-auth-secret`; enables TURN REST credentials |
| `MAX_ROOMS` | `500` | Maximum number of rooms |
| `MAX_CLIENTS` | `2000` | Maximum number of connected clients |
| `ALLOWED_ORIGINS` | (empty = any) | Comma-separated allowed `Origin` values |
| `LOG_LEVEL` | `info` | `error`, `info` or `debug` |

The deploy script installs this file only when `/etc/kart-rooms.env` is absent,
so an operator's edits are never overwritten.

## Reverse proxy with TLS

Caddy (`/etc/caddy/Caddyfile`, from `deploy/Caddyfile.example`) or nginx
(`/etc/nginx/conf.d/kart-rooms.conf`, from `deploy/nginx.conf.example`).
The proxy terminates TLS on 443, redirects HTTP to HTTPS, and proxies:

- `/ws` with the `Upgrade` / `Connection` headers (the GameNet relay uses
  `RELAY_PATH` from `src/relay/protocol.ts`, which is `/ws` today and is shared
  with KartRacer; if `RELAY_PATH` ever differs, add that path too);
- `/health`.

Port `8787` stays localhost only and is never exposed by the firewall.

## coturn

coturn runs on the same VM from `deploy/turnserver.conf.example`
(installed to `/etc/turnserver.conf` by hand; the deploy script only stages it).
Set `static-auth-secret = TURN_SECRET` so the REST credentials match the env
file. TURN is disabled when `TURN_SECRET` is empty.

## Firewall

Open:

- `80/tcp` and `443/tcp` (proxy);
- `3478/udp` and `3478/tcp` (STUN/TURN);
- `5349/tcp` (TURN over TLS);
- `49152-65535/udp` (TURN relay range).

Keep `8787` closed.

## Deploy script

```sh
node --experimental-strip-types deploy/deploy.ts \
  --host <ssh target> --domain <name> [--proxy caddy|nginx] \
  (--dry-run --out <dir> | --apply)
```

Steps, in order:

1. Back up `/opt/kart-rooms` to `/opt/kart-rooms.prev`.
2. `rsync` the tree without `node_modules`, `dist` and `.git`.
3. Upload the rendered files (unit, env, proxy config, staged coturn config).
4. `npm install --omit=dev` in `/opt/kart-rooms`.
5. Install the systemd unit.
6. Install `/etc/kart-rooms.env` (only when it is absent) and the proxy files.
7. `systemctl daemon-reload`, then `systemctl restart kart-rooms`.
8. Reload the proxy (Caddy or nginx).

A dry run writes the rendered files and `plan.txt` to `--out` and runs no
command at all.

## Rollback

1. Restore the previous tree: `mv /opt/kart-rooms.prev /opt/kart-rooms` (or copy
   it back over the current one).
2. `systemctl restart kart-rooms`.
3. Check `curl https://<domain>/health` for `{"ok":true,...}`.

## Warning

**`--apply` is never run by this project.** The live KartRacer server must not
change. Only the dry run (`--dry-run --out <dir>`) is used, so the rendered plan
can be reviewed without touching any host.
