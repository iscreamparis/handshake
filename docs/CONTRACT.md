# Etcito online contract (r2)

The shared rules of the Etcito game server, Handshake, the AI residents and every game client (first: Kekkai).
One authority: this file. A change = a new revision number + one changelog line at the bottom. Written in English.

## 1. Components
- **Handshake** (this repository): a Node module. `createHandshake(options)` returns the HTTP + WebSocket server: rooms and signaling (the existing KartRacer protocol, unchanged), the GameNet relay protocol (moved here from PwaPhaser `server/relay.mjs`, unchanged on the wire), matchmaking queues, and the player API. Persistence goes through a `PlayerStore` interface. The standalone `npm start` keeps running it with an in-memory store, so KartRacer keeps working exactly as today.
- **EtcitoGameServer**: a custom tenant of the CRM (repository Q:/CRM). It implements `PlayerStore` on the tenant database, embeds Handshake, and has the backoffice. One database for every game and every player, whatever platform they come from.
- **Residents** (new repository, game-agnostic): persistent AI players. A game plugs in through a `GameAdapter` (Kekkai's adapter reuses Kekkai's own rules engine and AI).
- **Game clients**: the same build on itch.io, Wavedash and the standalone web page. The platform only changes the login identity and how real money is spent.

## 2. Accounts
- `player_id`: a UUID issued by the server. `display_name`: 3..16 chars.
- `identities[]`: `{provider: "wavedash" | "itch" | "guest", external_id}`. One player can link several identities. The provider never changes gameplay, rating, collection or matchmaking.
- An AI resident is a player like any other (`kind: "resident"` is stored, never shown to players, visible in the backoffice only).

## 3. Rating (elastic ELO) and tiers
- Each player has a rating `r` per game and queue (`ranked`). Start: `r = 2500`.
- Expected score `E = 1 / (1 + 10^((r_opp - r) / 400))`. After a match: `r = max(0, r + K * (S - E))`, `S` = 1 win, 0.5 draw, 0 loss.
- Elastic K: `K = max(32, 160 - 16 * ranked_games_played)` (big moves while the rating is unknown, stable later). The 5 placement matches use K = 160 and show no tier and no number.
- Tiers (the distribution forms a bell curve centred on 2500 = Platinum; defaults, editable in the backoffice):
  | Tier | Rating |
  |---|---|
  | Bronze | 0 – 1599 |
  | Gold | 1600 – 2199 |
  | Platinum | 2200 – 2799 |
  | Diamond | 2800 – 3399 |
  | Master | 3400+ |
- Displayed rating: the number is shown only from 500 up; below 500 the client shows "< 500". The stored rating is never capped except at 0.
- Residents use the same formula; their matches count for both sides.

## 4. Matches
- Queues per game: `quick` (unrated) and `ranked`.
- One ranked match at a time per player (residents too): `active_ranked_match` is set atomically when a ranked match is created and cleared at its result. A client that disconnects for more than 90 s loses the match.
- Ranked pairing: rating window ±100, widened by 100 every 5 s.
- When no human is found after 15 s (ranked) or 8 s (quick), the queue takes the free resident with the nearest rating. A resident is never paired with a resident.
- Results are reported by both clients (deterministic lockstep: they agree); a disagreement is recorded and the match is void (no rating change).

## 5. Economy (server-authoritative once online)
- Coins are earned by matches and story progress (amounts are game data).
- Packs are bought with coins, singly or by 5 or 10 at a discount (prices are backoffice settings; default: the game's current single price, 5 = 4.5x, 10 = 8x).
- Story card rewards are granted as unopened packs.
- `open_pack` is a server action: the server rolls the cards (the client never decides drops) and records them.
- Real money buys coins only, never cards directly. Minimum bundle: 2 EUR = 250 coins (payment fees). Larger bundles are degressive (defaults, backoffice settings): 5 EUR = 700, 10 EUR = 1500, 20 EUR = 3200.
- Wavedash: the Wavedash purchase API; coins are credited only after the server verifies the purchase. itch.io: to be explored; fallback Stripe Checkout (web), same server crediting rule.

## 6. Protocol
- JSON over WebSocket, the existing framing. New message types are additive: old KartRacer and Kekkai clients keep working.
- The exact list of new messages (auth, queue, match result, economy) is section 7, written by the Handshake project's milestone that introduces them.

## 7. Messages

Messages use the GameNet relay WebSocket at `/ws`, the same path as rooms. On the shared path, the first JSON text frame is routed by its `t`: relay types and the match types below go to the relay, while a rooms `hello` goes to rooms. Frames are JSON text objects with the type field `t`; errors use `{ t:'error', reason }`. A queue match pairs both players straight into a relay session on that same connection. The unchanged relay messages (`create`, `join`, `act`, `bye`, `queue`, `unqueue`, `resume`, `ping`) and their replies are documented in [docs/RELAY.md](RELAY.md). These additions are additive only: old KartRacer and GameNet clients keep working. Economy (wallet, packs) has no socket message in this revision; the host reaches it through the PlayerStore.

### Client to server
- `auth` { provider: `wavedash` | `itch` | `guest`, token: string (guest: 16..128 chars of [A-Za-z0-9_-]; wavedash/itch: 1..4096 chars), name?: string (3..16 chars after trim; used only when the player is created) }. No auth required. Replies `authed` or error `already_authed`, `auth_failed`, `auth_unavailable`, `bad_message`, `store_unavailable` (or relay `internal`).
- `match_queue` { game: string (1..64 chars), queue: `quick` | `ranked` }. Needs auth. Replies `match_queued`, then `match` when paired; errors `auth_required`, `already_queued`, `in_match`, `ranked_busy`, `resident_cannot_queue`, `bad_queue`, `bad_message`, `store_unavailable` (or relay `internal`). These `match_queue` / `match_unqueue` messages are distinct from the relay's legacy `queue` / `unqueue`.
- `match_unqueue` {}. No auth required. Replies `match_unqueued`; error `not_queued` when the caller is not queued.
- `result` { match_id: string (1..128 chars), outcome: `win` | `loss` | `draw` }. Needs auth. Replies `result_ack` { match_id } when the caller reports for a match; errors `unknown_match`, `already_reported`, `bad_message` (or relay `internal`).

### Server to client
- `authed` { player_id, display_name, provider }.
- `match_queued` { game, queue, rating: number, games: number, placement: boolean }.
- `match_unqueued` {}.
- `match` { match_id, game, queue, seat: 0 | 1, opponent: { player_id, display_name } }. Sent immediately before the relay's `matched`, on the same session and with the same reconnection token.
- `result_ack` { match_id }.
- `match_end` { match_id, status: `complete` | `void` | `forfeit`, outcome: `win` | `loss` | `draw` | null, rating?: { before, after, games, placement } }. `rating` appears only on ranked complete/forfeit; `outcome` is null when void.

### Error codes
| code | meaning |
|---|---|
| `auth_required` | Match queue requires authentication. |
| `already_authed` | This connection is already authenticated. |
| `auth_failed` | Identity verification failed. |
| `auth_unavailable` | No verifier is available for this provider. |
| `already_queued` | This connection is already queued or pairing. |
| `not_queued` | This connection is not queued. |
| `in_match` | This connection is already in a match. |
| `ranked_busy` | The player already has a ranked match lock, or a lock could not be taken. |
| `resident_cannot_queue` | A resident player cannot join a queue. |
| `bad_queue` | Queue must be `quick` or `ranked`. |
| `unknown_match` | This authenticated player is not in the named match. |
| `already_reported` | This player already reported an outcome for the match. |
| `store_unavailable` | A PlayerStore operation failed. |

`bad_message` (invalid fields) and `internal` are the relay's existing codes, reused as docs/RELAY.md names them.

### Rules
- Auth: guest authentication is built in when there is no `verifyIdentity` hook; wavedash and itch answer `auth_unavailable` without the hook. With the hook, it decides every provider; a null result or thrown error answers `auth_failed`. Built-in guest identity hashes the token for its external id and uses a valid trimmed name, or `Guest-` plus four uppercase hash characters.
- Quick queue pairs FIFO.
- Ranked window is `100 + 100 * floor(wait/5000)`; pairing uses the maximum window of the two waiters. The smallest rating gap wins, then the earliest arrival; the same player is never paired with themselves.
- Residents are offered after 8000 ms (quick) or 15000 ms (ranked) through `hooks.pickResident`; a resident never queues and is never paired with a resident.
- Ranked lock: one ranked match at a time; a player with an active lock gets `ranked_busy`.
- Results: both seats report; agreement means `complete`, disagreement means `void`; if the second report does not arrive within 60000 ms after the first, the match is void (`no_report`).
- Forfeit: a seat not resumed with its token within 90000 ms loses; both seats absent means void. The relay session then ends.
- Every match end calls `hooks.onMatchEnd`.

## Changelog
- r1 (2026-10-12): first version.
- r2 (2026-10-14): section 7 Messages written by the Handshake project.
