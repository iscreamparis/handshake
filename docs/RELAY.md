# GameNet relay protocol reference

Source: `reference/pwaphaser-relay/relay.mjs` and `relay.test.mjs`. Fields below are JSON fields; all message types use `t`. Source line references identify the behavior (`relay.mjs` unless stated otherwise).

## 1. Endpoint

- The source comments identify the WebSocket route as `/ws` (relay.mjs:274-275); `new WebSocketServer({ server })` does not configure a path filter (relay.mjs:420). There are no relay query parameters or query handling; the server attaches to HTTP upgrades without examining their URL.
- The server does not set a `maxPayload` option (relay.mjs:420). Application input is limited to 4 KiB (`MAX_MSG_BYTES`, relay.mjs:152, 617-618). Binary or larger messages count as invalid and are ignored; the tenth invalid message closes the socket (relay.mjs:604-606, 618).
- Protocol field: `t` (relay.mjs:173, 623-626).
- WebSocket heartbeat: every 30,000 ms the server sends a control ping; a pong marks the socket alive. A socket still marked dead on the next interval is terminated (relay.mjs:598, 769-776).

## 2. Client and server messages

Client messages (validation and handling: relay.mjs:173-229, 623-762):

- `create` `{ t, players?, cadence?, payload? }`. `players` is 2–4 (default 2); `cadence` is boolean; payload is stored as the creator's seat payload. Reply: `{ t:'room', code }`, or `{ t:'error', reason:'server full' }`.
- `join` `{ t, code, payload? }`. Reply on a missing code: `error` reason `room not found`; no free seat or already-started room: `error` reason `room full`; an incomplete room: `{ t:'waiting', seat, players }`; when full, all seats receive `matched` (fields below).
- `queue` `{ t, players?, cadence?, payload? }`. Same player-count and cadence constraints as `create`; payload may be absent/null or a shallow-enough object. A waiting caller receives `{ t:'queued', estimateMs }` (estimate is null until there are completed pairings). When the format queue reaches `players`, all seats receive `matched`. Invalid payload gives error reason `bad queue payload`; room capacity gives `server full`.
- `unqueue` `{ t }`. Reply: `{ t:'unqueued' }`.
- `act` `{ t, a, n? }`. `a` must be a bounded JSON object/array; optional `n` is an integer from 0 through 1,000,000. The sender receives `{ t:'ack', n }`; other seats receive `{ t:'act', a, n, from }`. An omitted sequence number is assigned as that seat's previous receive number plus one.
- `resume` `{ t, token, have? }`. `token` is a nonempty string up to 64 characters; `have` is an integer sequence or an array of up to four sequence integers. Reply is `resumed` and any replayed `act` messages; see sections 6–7. Invalid/expired token replies `{ t:'error', reason:'resume expired' }`.
- `ping` `{ t }`. Reply: `{ t:'pong' }`.
- `bye` `{ t }`. No direct reply; departure notifications follow the rules in section 3 (relay.mjs:757-762).

Server messages:

- `room` `{ t, code }`: private room created; code is four decimal digits (relay.mjs:433-437, 629-649).
- `waiting` `{ t, seat, players }`: seat taken, room still incomplete (relay.mjs:658-663).
- `queued` `{ t, estimateMs }`: caller entered the public queue (relay.mjs:679-680).
- `unqueued` `{ t }`: caller removed from every queue (relay.mjs:694-696).
- `matched` `{ t, seed, hostStarts, youAre, token, players, opps, opp? }`: one per seated client. `youAre` is its seat index; `token` is its unique resume token; `opps` is the payload array by seat. For two players, `opp` is the other seat's payload (relay.mjs:510-527).
- `act` `{ t, a, n, from }`: action relayed to every other seat; `from` is sender's seat (relay.mjs:737-747).
- `ack` `{ t, n }`: action sequence acknowledged to sender, including a duplicate sequence (relay.mjs:725-727, 734).
- `resumed` `{ t, ack }`: `ack` is the reconnecting seat's last accepted action sequence (relay.mjs:583).
- `opp_dropped` `{ t, graceMs }` and `opp_back` `{ t }`: two-player disconnect and return notifications (relay.mjs:491-494, 589).
- `opp_left` `{ t }`: no opponent remains, or the other two-player seat leaves/expires (relay.mjs:450-453).
- `player_dropped` `{ t, seat, graceMs }`, `player_back` `{ t, seat }`, and `player_left` `{ t, seat }`: corresponding multiplayer seat notifications (relay.mjs:492-494, 590, 459-462).
- `pong` `{ t }`: response to application `ping` (relay.mjs:751-753).
- `error` `{ t, reason }`: errors described in section 8 (all emitted error sites: relay.mjs:539, 544, 594, 630, 632, 653, 655, 671, 686).

## 3. Pairing by code

- `create` allocates a private room and returns its code to seat 0. `join` takes the next free seat; a joining client gets `waiting` until every seat is occupied. The last join starts the room. Private rooms support 2–4 seats (relay.mjs:629-669).
- On start, every seat gets the same randomly generated 32-bit `seed` and `hostStarts`, its own `youAre`, and a unique UUID `token`. Payloads are retained by seat (relay.mjs:504-527).
- `bye` ends that seat immediately, without a grace period. In a two-seat room the other receives `opp_left`, and the room is destroyed. With 3–4 seats, others receive `player_left`; the room ends when at most one remains, and that remaining player receives `opp_left` (relay.mjs:445-468, 757-762).

## 4. Legacy quick queue

- `queue` pairs first-in, first-out within a `(players, cadence)` queue; `players` defaults to 2. The seat order is arrival order. Different player counts and cadence settings use separate queues (relay.mjs:105-130, 662-692).
- Before a match, a queued caller receives `queued` with `estimateMs`: rounded mean wait across up to the latest 10 formed matches, or null when none exist (relay.mjs:139-143, 679-680).
- Pairing creates a `q`-prefixed internal room and sends the same `matched` fields described in section 2 (relay.mjs:697-719, 504-527). Repeated queue requests while already waiting have no reply; `unqueue` removes the socket from all queues and replies `unqueued` (relay.mjs:675-676, 694-696).

## 5. Action relay

- `act.a` must be an object or array. Nested values are bounded to depth 6, object key count 24, and array length 512; raw message size is capped at 4 KiB (relay.mjs:152, 188-208, 618).
- Sequence numbers are tracked independently per seat. An omitted `n` increments that seat's number; a repeated or lower number is not relayed but is acknowledged again. Accepted actions are acknowledged to their sender and broadcast unchanged as `act` with `n` and `from` to all other occupied seats (relay.mjs:720-747).
- The ordered replay log stores `{ side, n, a }` for accepted actions only. It retains at most 4,000 entries normally or 20,000 in cadence rooms, dropping the oldest entry beyond the bound (relay.mjs:68-75, 732-737).

## 6. Reconnection token

- At room start, the relay creates one `randomUUID()` token per seat and sends it in that seat's `matched` message (relay.mjs:504-520).
- A `resume` token replaces the socket occupying its seat; the previous socket, if different, is terminated. The relay sends `resumed` with that seat's accepted sequence in `ack`, replays eligible actions, then notifies other seats with `opp_back` or `player_back` (relay.mjs:531-590).
- A sudden disconnect starts a `RESUME_GRACE_MS` timer, default 60,000 ms (override `RESUME_GRACE_MS`); `opp_dropped`/`player_dropped` reports the same `graceMs`. Expiry marks the seat gone. A voluntary `bye` has no grace (relay.mjs:68, 445-468, 478-498).

## 7. Replay log

- Each accepted action records its seat (`side`), sequence (`n`) and action (`a`), in order. The log is capped at 4,000 entries, or 20,000 for cadence rooms; oldest entries are shifted out on overflow (relay.mjs:68-75, 732-737).
- `resume.have` says what the returning client has applied: a scalar applies to every other seat, while an array gives per-seat values. The relay first sends `resumed`; it then replays logged actions from other seats whose `n` is greater than that seat's `have`, as `{ t:'act', a, n, from:side }`. The returning seat's own actions are never replayed to it (relay.mjs:572-588).

## 8. Error shape and codes

- Shape: `{ t:'error', reason: string }` (relay.mjs:539, 594, 612-613, 630-632, 653, 655, 671, 686).
- `server full`: socket ceiling, room ceiling, or inability to allocate a room code (relay.mjs:593-595, 629-632, 683-686).
- `room not found`: join code does not identify a room (relay.mjs:651-653).
- `room full`: no free seat or room already started (relay.mjs:654-655).
- `bad queue payload`: queue payload fails validation (relay.mjs:671).
- `resume expired`: token has no live room or its seat is already gone (relay.mjs:535-544).
- `rate limited`: message rate exceeds its applicable limit; the relay then closes the socket (relay.mjs:611-614). Defaults are 20 messages/second and 400/minute; seated cadence clients get 90/second and 4,000/minute (relay.mjs:154-169, 244-255).
- Unknown `t`, malformed JSON, invalid shape, binary frames, and oversize frames receive no error message: they count as invalid, are silently ignored, and the tenth invalid message closes the socket (relay.mjs:604-606, 617-626).

## 9. Close behavior and codes

- Invalid-message threshold and rate limit call `ws.close()` without an explicit code or reason; socket-capacity rejection also calls `ws.close()` after its error. No custom WebSocket close code is specified (relay.mjs:594-595, 606, 612-614).
- Replacing an old connection on resume and missing heartbeat use `ws.terminate()` (relay.mjs:563, 771-772); these do not send an explicit close code.

## 10. Timers and limits expressed as time

- Resume grace: 60,000 ms by default (`RESUME_GRACE_MS` override), started on ungraceful disconnect (relay.mjs:68, 488-495).
- WebSocket heartbeat interval: 30,000 ms (relay.mjs:769-776).
- Rate windows: 1,000 ms and 60,000 ms; default thresholds 20/sec and 400/minute, cadence-seat thresholds 90/sec and 4,000/minute (relay.mjs:154-169, 244-255).
- No other timer is created by `relay.mjs` for the relay protocol.

## 11. Shared `/ws` path

- The path is `/ws` per the source comments, so it shares the rooms path. A discriminator can claim a first frame when its parsed JSON object has `t` equal to one of the relay message names: `create`, `join`, `act`, `bye`, `queue`, `unqueue`, `resume`, or `ping` (relay.mjs:173). No valid rooms hello `{t:'hello', v, game, name}` satisfies this rule, because its `t` value is `hello`, which is absent from that set.

## 12. Test scenario names

The reference uses a custom `ok(name, …)` scenario reporter rather than `node:test`/Mocha. It reports **51 scenarios**, in call order (`relay.test.mjs`):

1. appariement : les deux pairs reçoivent la même seed
2. la charge utile de mise en file est transmise telle quelle au pair
3. action relayée hôte -> invité
4. action relayée invité -> hôte
5. act non-objet non relayé (pair silencieux)
6. act trop profond non relayé
7. message géant (>4 Ko) ignoré
8. jeton de reprise fourni à l'appariement
9. coupure brutale -> opp_dropped (partie en sursis)
10. coupure brutale -> PAS de opp_left immédiat
11. reprise acceptée (resumed + ack de mes actions reçues)
12. actions manquées rejouées au revenant
13. le pair est prévenu du retour (opp_back)
14. action renvoyée après reprise -> dédoublonnée
15. duel relayé normalement après reprise
16. liste de 30 entiers relayée (deck)
17. tableau de 900 éléments refusé
18. action acceptée -> ack avec son n°
19. doublon -> ré-acquitté (l'outbox du client se vide quand même)
20. ping -> pong
21. reprise -> l'ancienne socket est TUÉE (plus de zombie)
22. action venue d'une socket zombie -> jamais relayée
23. le duel continue après la reprise
24. jeton inconnu -> « resume expired »
25. bye -> opp_left immédiat (pas de sursis)
26. fenêtre de reprise expirée -> opp_left
27. 10 acts malformés -> socket fermée
28. flood > 20 msg/s -> erreur « rate limited »
29. flood > 20 msg/s -> socket fermée
30. unqueue -> unqueued
31. file à 3 : deux joueurs ne suffisent pas à démarrer
32. appariement à 3 : sièges 0/1/2 distincts
33. appariement à 3 : une seule et même seed
34. appariement à 3 : `players` annoncé
35. appariement à 3 : `opps` porte la charge des trois sièges
36. appariement à 3 : jetons de reprise tous différents
37. les files sont séparées par format (1v1 pas aspiré par une file à 4)
38. action diffusée aux DEUX autres sièges
39. action estampillée du siège émetteur (`from`)
40. n° de séquence indépendants par siège (n=1 des sièges 1 ET 2 passent)
41. coupure à 3 -> `player_dropped` avec le siège concerné
42. reprise à 3 acceptée
43. rejeu sélectif : seule l'action du siège NON couvert par `have` revient
44. rejeu sélectif : l'action déjà couverte n'est PAS rejouée
45. reprise à 3 : les autres sont prévenus (`player_back`)
46. départ d'un joueur sur 3 -> `player_left` avec son siège
47. départ d'un joueur sur 3 -> la partie N'EST PAS finie
48. la partie continue entre les survivants
49. dernier joueur debout -> `opp_left` (fin de partie)
50. salle cadencée : 45 actions d'affilée passent sans coupure
51. salle cadencée : le plafond existe toujours (200 msg d'un coup -> coupé)
