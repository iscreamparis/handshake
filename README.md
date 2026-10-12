# Handshake

Handshake is an embeddable Node game-server module (npm package `kart-rooms`, with a typed `dist/`) and also the standalone KartRacer rooms server.

The kart game's rooms server. It keeps rooms (5-char codes, up to 8 machines and
8 human players), the lobby state (members, their local players, the room
settings, the start seed) and relays WebRTC signaling (offers, answers, ICE
candidates) between the members of a room. It also hands out ICE servers,
with short-lived TURN credentials for our own coturn.

It NEVER relays race data: once the lobby starts, race traffic flows peer to
peer over WebRTC DataChannels.

The wire protocol is described in [PROTOCOL.md](PROTOCOL.md).

## Embedding

```ts
import { createHandshake, createMemoryStore, guestIdentity } from 'kart-rooms'

const handshake = createHandshake({
  config: { port: 8787, host: '127.0.0.1' },
  store: createMemoryStore(),
  hooks: {
    verifyIdentity: async (provider, token, name) =>
      provider === 'guest' ? guestIdentity(token, name) : null,
    pickResident: async () => null,
    onMatchEnd: (record) => console.log(`match ${record.match_id}: ${record.status}`),
  },
})

await handshake.listen()
process.once('SIGTERM', () => {
  handshake.close().then(() => process.exit(0))
})
```

The `store` must implement the Promise-based `PlayerStore`: every method returns a Promise and the caller awaits it. A database implementation can therefore replace `createMemoryStore()` without other changes.

- `verifyIdentity` turns a provider token into a verified identity, or returns `null` to refuse the player. The example delegates guest tokens to `guestIdentity`.
- `pickResident` supplies a resident opponent for a waiting ranked or quick player, or returns `null` to decline.
- `onMatchEnd` receives the `MatchRecord` of every finished match.

The relay and matchmaking hooks are wired by later milestones: in this version the hooks are stored on the instance but not yet called.

## Store contract suite

The contract suite checks a `PlayerStore` implementation. It is exported from the `kart-rooms/contract` subpath, never from the main entry. Run it with `node:test`:

```ts
import { playerStoreContract } from 'kart-rooms/contract'
import { createMemoryStore } from 'kart-rooms'

playerStoreContract('memory store', () => createMemoryStore())
```

## Build

- `npm run build` compiles `src/` with `tsc` into `dist/`, emitting JavaScript and `.d.ts` files.
- `npm run typecheck` runs the strict type check without emitting files.

Both need the dev dependencies, so run `npm install` first. A server that only runs the module can use `npm install --omit=dev`: `npm start` still runs from source and needs no build.

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
