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

The hooks are called by the match service: `verifyIdentity` on every `auth` (it receives the `game` of the message as a 4th argument), `pickResident` when a waiter is due for a resident (8 s quick, 15 s ranked) and `onMatchEnd` at every match end. Without `verifyIdentity`, guest tokens are verified by the built-in `guestIdentity` and the other providers answer `auth_unavailable`.

## Player store: one game = one mission = one service key

`store` is either one `PlayerStore` (every game name shares it: memory store, tests) or a `GameRouter` (one store per game). The standalone `npm start` chooses from the environment:

| Variable | Default | Meaning |
|---|---|---|
| PLAYER_STORE | `memory` | `memory` (nothing persisted) or `http` (the Etcito CRM tenant) |
| ETCITO_URL | (required for `http`) | Base URL of the tenant, e.g. `https://<tenant-host>` (http or https, no credentials in the URL) |
| ETCITO_GAME_KEYS | (required for `http`) | JSON object `{"<handshake_game>":"gsk_..."}`: the service key of each game |

```sh
PLAYER_STORE=http
ETCITO_URL=https://<tenant-host>
ETCITO_GAME_KEYS={"<handshake_game>":"gsk_...","<other_game>":"gsk_..."}
```

- A game is a CRM mission. A `gsk_` key belongs to a CRM user and the CRM routes the request to that user's ACTIVE mission, so each game needs its own service user (admin, active mission = the game's mission) and its own key. The same key for two games is refused at start-up. The names in `ETCITO_GAME_KEYS` are the `etc_game.handshake_game` values of the missions.
- Each game has its own players: the same Wavedash user id in two games is two unrelated profiles, ratings and wallets.
- The `game` of the messages picks the store. `auth` takes an optional `game` (1..64 chars): it is required when several games are configured, and optional (the only game is used) when there is one. A later `match_queue` must name the same game. An unknown game, a missing game with several games, or a `match_queue` for another game than the authenticated one is answered `bad_message`. A queue the game does not offer (`etc_game.queues`) is answered `bad_queue`.
- Start-up validates the three variables (the error names the variable and never prints a key; keys are never logged) and reads each game's `etc_game` row. A key whose mission has another `etc_game.handshake_game` is a wrong-mission key and stops the start-up.
- Game parameters come from the mission's single `etc_game` row: `elo_start` (default 2500), `elo_k_floor` (32), `placement_games` (5) and `queues` (`["quick","ranked"]`). They are read at start-up and refreshed every 60 s; a failed read, a missing row or an invalid value keeps the previous values (the defaults before the first good read), with an `error` log line. A refreshed `elo_start` applies to players with no rated match yet, the others apply to the next result. The K formula is `K = 160` while `games < placement_games`, then `max(elo_k_floor, 160 - 16 * games)`.
- If the tenant is down at start-up the server still starts with the defaults; players then get `store_unavailable` until it answers.

### Identity verification (providers)

`src/identity.ts` defines `IdentityVerifier { verify(token, name, game) }` per provider, and `verifyIdentityHook(verifiers)` builds the `verifyIdentity` hook from them. `npm start` uses `defaultVerifiers()`:

- `guest`: real (token of 16..128 chars; the id is its SHA-256).
- `wavedash` and `itch`: NOT configured. They throw `ProviderNotConfiguredError` ("provider non configure"), the player gets `auth_unavailable` and the log says which provider. Nothing is trusted without a real verifier.

To enable them, inject a verifier (`createHandshake({ hooks: { verifyIdentity: verifyIdentityHook(defaultVerifiers({ wavedash, itch })) } })` in an own entry point) that:

- Wavedash: validates the token the client obtains from the Wavedash SDK on the SERVER side (Wavedash user-token verification endpoint and the game's credentials, held by the server, per game: the `game` argument tells which), then returns `{ provider: 'wavedash', external_id: <wavedash user id>, display_name }`. The exact endpoint and credentials come from the Wavedash developer documentation and are not assumed here.
- itch.io: validates the player with the itch.io server API (for example an API key / OAuth token check, or the download key for the game), and returns `{ provider: 'itch', external_id: <itch user id>, display_name }`. Not specified here either; it needs a decision on what the client sends as `token`.
- A verifier returns `null` (or throws) to refuse; an identity whose `provider` differs from the requested one is refused.

Residents: `pickResident` is not set by `npm start`. Resident AI players are a separate game-agnostic service that embeds Handshake and supplies the hook; no resident is invented here.

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
