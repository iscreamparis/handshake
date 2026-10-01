# Rooms protocol (v4, JSON over WebSocket)

This file is the rooms repository's copy of the shared rooms protocol from the game's architecture contract.
The game repository keeps its own typed copy in src/online/roomsProtocol.ts; src/protocol.ts is this repository's typed copy.

Written once here. rooms/PROTOCOL.md is its word-for-word copy. rooms/src/protocol.ts (server) and game src/online/roomsProtocol.ts (client) are each repository's own typed copy that follows it.

## Transport
- WebSocket at path `/ws` on the rooms server (wss:// through the proxy).
- Text frames. Each frame holds one JSON object with field `t` (the type) and an optional `rid` (a client request id, echoed in the reply or error).
- Maximum 65536 bytes per message. Unknown fields are ignored.
- PROTOCOL_VERSION = 1. HTTP `GET /health` returns 200 `{"ok":true,"rooms":n,"clients":n,"version":"<package version>"}`.

## Shared shapes
- LocalPlayer = { name: string (1..16 chars after trim), build: { characterId, bodyId, wheelId, gliderId } }. Each build id is 1..24 chars of [a-z0-9-].
- RoomSettings = { kind: 'cup' | 'track', cupId: string, trackId: string, cc: 50 | 100 | 150 | 200, items: boolean }. Ids are 1..32 chars of [a-z0-9-].
- Member = { peer: 0..7, name: string, players: LocalPlayer[] (1..4) }.
- IceServer = { urls: string[], username?: string, credential?: string }.

## Client to server
- `hello` { v: 1, game: string (1..64: the client's build id), name: string (1..16) }. Must be the first message. Reply: `welcome`.
- `create` { players: LocalPlayer[] (1..4), settings?: RoomSettings, private?: boolean }. Reply: `room`. The creator is the owner, with peer 0. A private room is never listed: it is joined by code only.
- `list` {}. Reply: `rooms`. Public rooms in the lobby with the same `game` as the caller, not full.
- `join` { code: string, players: LocalPlayer[] }. Reply: `room`, and `room` is broadcast to the others.
- `leave` {}. Reply: `left`, and `room` is broadcast to the others.
- `players` { players: LocalPlayer[] }. Lobby only. Broadcasts `room`.
- `settings` { settings: RoomSettings }. Owner only, lobby only. Broadcasts `room`.
- `start` {}. Owner only, lobby only. The server sets status 'racing', draws a u32 seed with node:crypto and broadcasts `started`.
- `end` {}. Owner only, racing only. Back to 'lobby'; broadcasts `room`.
- `signal` { to: number, data: SignalData }. Forwarded as `signal` { from, data } to the member with that peer id in the same room. data is an object of at most 16384 bytes:
  - { kind: 'offer' | 'answer', sdp: string }
  - { kind: 'ice', candidate: string, sdpMid: string | null, sdpMLineIndex: number | null }
  - { kind: 'ice-end' }
- `ping` { id: number }. Reply: `pong` { id }.

## Server to client
- `welcome` { v: 1, client: string (an opaque session id), iceServers: IceServer[], maxHumans: 8, maxLocal: 4 }.
- `room` { rid?, code: string, you: number, owner: number, status: 'lobby' | 'racing', members: Member[] (sorted by peer), settings: RoomSettings, humans: number, private?: true }.
- `started` { code, seed: number, settings: RoomSettings, members: Member[] }. The frozen roster of the race or cup.
- `rooms` { rid?, rooms: RoomListing[] (max 50, fullest first) }. RoomListing = { code, owner: string (the owner's name), humans: number, settings: RoomSettings }.
- `left` {}.
- `peerLeft` { peer }. Always followed by a `room` message.
- `signal` { from: number, data: SignalData }.
- `pong` { id }.
- `error` { rid?, code: ErrorCode, message: string }.

## Error codes
| code | meaning |
|---|---|
| bad_message | not JSON, missing/invalid fields, unknown t |
| bad_version | hello.v is not 1 (the connection then closes with 4001) |
| hello_required | any message before hello |
| game_mismatch | join: hello.game differs from the room creator's |
| room_not_found | unknown or malformed code |
| room_full | more than 8 machines, or more than 8 humans in total |
| room_started | join or players or settings while racing |
| not_in_room | the message needs a room |
| already_in_room | create/join while in a room |
| not_owner | owner-only message |
| bad_players | invalid players list |
| bad_settings | invalid settings |
| peer_not_found | signal to an unknown peer or to self |
| rate_limited | over 40 msgs/s (burst 80); the message is dropped |
| server_full | MAX_ROOMS or MAX_CLIENTS reached |
| too_large | a message over 65536 bytes (the connection then closes with 4009) |
| internal | unexpected server failure |

## Rules
- **Room codes:** 5 chars from 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'. Joins accept any case and surrounding spaces.
- **Peer ids:** the lowest free id in 0..7. When the owner leaves, ownership passes to the lowest remaining peer. An empty room is deleted.
- **Timeouts:** hello within 10 s (else close 4000). The server pings every 20 s and terminates after 40 s without a pong. A lobby with no message for 30 min is closed. Sustained rate abuse (over the limit for 5 s) closes with 4008.
- **ICE:** iceServers holds the STUN urls (default stun:stun.l.google.com:19302). With TURN_SECRET set it adds TURN urls with coturn REST credentials: username = `<unix expiry = now + 86400>:<client>`, credential = base64(HMAC-SHA1(TURN_SECRET, username)).
- **No relay:** the server never relays race data. Race traffic flows peer to peer only.
