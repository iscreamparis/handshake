# rooms

The kart game's rooms server. It keeps rooms (5-char codes, up to 8 machines and
8 human players), the lobby state (members, their local players, the room
settings, the start seed) and relays WebRTC signaling (offers, answers, ICE
candidates) between the members of a room. It also hands out ICE servers,
with short-lived TURN credentials for our own coturn.

It NEVER relays race data: once the lobby starts, race traffic flows peer to
peer over WebRTC DataChannels.

The wire protocol is described in [PROTOCOL.md](PROTOCOL.md).

## Requirements

- Node 22.18+ (TypeScript runs directly through type stripping, no build step).
- `ws`, the only runtime dependency.

## Install, run, test

```sh
npm install --omit=dev
npm start        # node --experimental-strip-types src/main.ts
npm test         # node:test over test/**/*.test.ts
```

The ws integration test (`test/server.test.ts`) reports its tests as skipped
with 'ws not installed' when the `ws` package cannot be imported; every other
test runs with in-process fakes and no network.

`GET /health` answers `{"ok":true,"rooms":n,"clients":n,"version":"..."}`.
WebSocket clients connect to `/ws`.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| PORT | `8787` | HTTP/WS port (plain, TLS is done by the proxy) |
| HOST | `127.0.0.1` | Listen address |
| STUN_URLS | `stun:stun.l.google.com:19302` | Comma-separated STUN urls sent in `welcome` |
| TURN_URLS | (empty) | Comma-separated TURN urls, used only when TURN_SECRET is set |
| TURN_SECRET | (unset) | coturn `static-auth-secret`; enables TURN REST credentials |
| MAX_ROOMS | `500` | Maximum number of rooms |
| MAX_CLIENTS | `2000` | Maximum number of connected clients |
| ALLOWED_ORIGINS | (empty = any) | Comma-separated allowed `Origin` values for `/ws` |
| LOG_LEVEL | `info` | `error`, `info` or `debug` |

See `deploy/rooms.env.example`.

## Deploy (one VM, systemd + reverse proxy + coturn)

1. Copy the repository to `/opt/kart-rooms` and install it:
   ```sh
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin rooms
   sudo cp -r . /opt/kart-rooms
   cd /opt/kart-rooms && sudo npm install --omit=dev
   ```
2. Configure: `sudo cp deploy/rooms.env.example /etc/kart-rooms.env` and edit it
   (TURN_SECRET, TURN_URLS, ALLOWED_ORIGINS...).
3. Service:
   ```sh
   sudo cp deploy/rooms.service /etc/systemd/system/kart-rooms.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now kart-rooms
   ```
4. Reverse proxy with TLS and the WebSocket upgrade on `/ws`:
   - Caddy: `deploy/Caddyfile.example` (automatic TLS, WebSocket passes through);
   - or nginx: `deploy/nginx.conf.example` (Upgrade/Connection headers,
     `proxy_read_timeout 75s`).
5. coturn on the same VM: install it and start from
   `deploy/turnserver.conf.example`. Set `static-auth-secret` equal to
   TURN_SECRET, then in `/etc/kart-rooms.env`:
   ```sh
   TURN_URLS=turn:<host>:3478?transport=udp,turn:<host>:3478?transport=tcp,turns:<host>:5349?transport=tcp
   ```
6. Firewall: open 80/443 TCP (proxy), 3478 UDP and TCP, 5349 TCP, and the relay
   range 49152-65535 UDP. Port 8787 stays closed (localhost only).
7. Check: `curl https://<host>/health`.

## Game

Build the game with `VITE_ROOMS_URL=wss://<host>/ws` (it can also be changed in
the game's settings menu).
