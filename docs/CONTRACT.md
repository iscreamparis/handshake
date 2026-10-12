# Etcito online contract (r1)

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
(to be written by the Handshake project)

## Changelog
- r1 (2026-10-12): first version.
