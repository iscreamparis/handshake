# Creator rollout (multi-creator runtime, contract r7)

How to deploy branch `feat/multicreator`, how to switch on multi-creator mode later, and how to roll back.
Owner games are `kekkai` and `monsterracer` (`src/store/legacy.ts`); every other game is a creator game.

## 0. What changes, and when

| Part | Without a new env var (deploy day) | With `ETCITO_GAME_KEYS_FILE` (multi-creator mode) |
|---|---|---|
| Games loaded | `ETCITO_GAME_KEYS`, as today | the key file, re-read every 30 s |
| Wrong-mission key | start-up aborts, as today | that game alone is disabled until corrected |
| `hello` with a game not configured | accepted, as today (rooms only) | refused (`bad_message`) |
| Room limit | server-wide `MAX_ROOMS`, as today | creator game: min(`limits.max_rooms`, `ETCITO_CREATOR_MAX_ROOMS`=10); owner games: server-wide only |
| Saves / UGC / catalog | as today | creator game: capped (50 MiB total, 1 MiB catalog) |
| `POST /webhooks/stripe` | owner games' keys only; a session whose `metadata.game` is not an owner game is ignored | same |
| `POST /webhooks/stripe/<game>` | new route; verified with `<game>`'s own service key, `metadata.game` must equal `<game>` | same |
| `POST /webhooks/wavedash[/playtest]` | first match, but an owner game always wins; two creator games claiming one id → 400 `ambiguous_game` | same |
| Publisher, owner games | unchanged: service HOME (stored `wavedash auth login` still works), token optional, mirrored into `etc_deploy_runs` when configured | same |
| Publisher, other games | own `X-Wavedash-Token` required (409 otherwise), private per-run HOME + TMPDIR, never mirrored | same |
| Publisher, all runs | logs redacted; at most `PUBLISHER_MAX_QUEUE` (8) runs pending, then 429 | same |

## 1. Key file (`ETCITO_GAME_KEYS_FILE`)

Format: the same JSON object as `ETCITO_GAME_KEYS`, one entry per game, nothing else.

```json
{
  "kekkai": "gsk_...",
  "monsterracer": "gsk_...",
  "game-17": "gsk_..."
}
```

Rules (checked by `src/store/config.ts`; an invalid file is refused as a whole):
- The name is the mission's `etc_game.handshake_game`. Use `[a-z0-9_-]{1,64}`: only such names can be reached by
  `POST /webhooks/stripe/<game>`. For a creator game `etc_game.handshake_game` MUST equal the name (a blank one
  disables the game).
- Every value is a string starting with `gsk_`; two games never share a key.
- At least one game. The owner games must stay in the file: removing one closes it within 30 s.

Location and rights (the rooms unit has `ProtectSystem=strict`, so it only needs to read):
- `/var/lib/etcito-registry/game-keys.json`, directory `0750`, file `0640`, group `rooms`, owned by the writer
  (see section 2).

Behaviour:
- Read once at start-up: an unreadable or invalid file stops Handshake (the error names the variable, never a key).
- Re-read every 30 s. An unreadable or invalid file keeps the previous registry (one `error` log line, no content).
- Only changed entries are acted on: a new name is opened, a changed key rebuilds that game, a removed name closes
  that game. A game whose key is unchanged keeps its live backend (economy locks, caches, push listeners).
- Write it atomically, never in place: write `game-keys.json.tmp` in the same directory, `fsync`, then `rename`.

```sh
umask 027
tmp=/var/lib/etcito-registry/game-keys.json.tmp
printf '%s\n' "$JSON" > "$tmp" && sync "$tmp" && mv -f "$tmp" /var/lib/etcito-registry/game-keys.json
```

## 2. Who writes it on onboarding (no Handshake restart)

Today `POST /api/etcito-publisher/creators` (CRM bridge, `crm-backend/app/api/etcito_publisher.py`) creates the
mission, the creator account and an `etc_game` row with `code = game-<mission_id>`, and emails a sign-in link. It
creates no game-server key and does not set `handshake_game`, so nothing reaches Handshake yet.

Proposed CRM change (shared CRM code, not in this repo):

1. In `_provision_creator_game`, also set `handshake_game = code` (`game-<mission_id>`) on the inserted row, and make
   both columns read-only for creators (field policy or bridge-only writes). Handshake requires them equal.
2. Create one service user per game: `svc-game-<mission_id>@...`, role `etcito_service` (never admin, never
   `team_manager`), `active_mission_id = mission_id`, exactly one `user_mission_access` row (`can_write`). Mint its
   `gsk_` key with the CRM's existing API-key helper (hashed at rest; the clear key is used once, below).
3. Let that role through the routes Handshake calls with it: `require_etcito_member` must accept an active
   `etcito_service` user on its single mission for `/stripe/verify` and `/stripe/checkout` (today only admin or a
   `creator` passes, so a non-admin service key gets 403 and every creator Stripe webhook answers 503). The table API
   needs `role_permissions` rows for that role on the `etc_*` tables (`PERMISSION_ENFORCEMENT=true` is already
   required by `/creators`).
4. Publish the key to the registry. Recommended: through the publisher sidecar, which already runs on the host and
   already authenticates the bridge (Bearer `etcito_publisher_key`), so the CRM needs no host file access:
   - new publisher route `PUT /registry/games/{game}` body `{"key":"gsk_..."}` and `DELETE /registry/games/{game}`;
   - `{game}` must match `[a-z0-9_-]{1,64}`, the key `^gsk_\S+$` and differ from every other key;
   - it refuses to add, change or delete `kekkai` / `monsterracer` (owner entries are edited by hand only, so a
     leaked publisher key cannot redirect the owner's games);
   - it reads the current file, applies the change, writes `game-keys.json.tmp`, `fsync`, `rename` (section 1);
   - the publisher unit then needs `ReadWritePaths=/var/lib/etcito-publisher /var/lib/etcito-registry`, and the
     directory `etcito:rooms 0750`.
   The bridge calls it at the end of `POST /creators` (idempotent: re-posting the same email re-sends the same
   game), and `DELETE` when the owner revokes a game. Handshake picks the game up within 30 s.
   Alternative: the CRM process writes the file itself when it runs on the same host with write access to the
   directory; same atomic write, same refusal for owner entries.
5. Cross-mission uniqueness of `etc_publishers(platform, external_id)` (the Wavedash audience), enforced by the
   bridge like `_foreign_game_claim` does for game codes. Handshake already lets an owner game win and refuses an
   id claimed by two creator games, but a creator copying another creator's id would block that creator's
   Wavedash purchases until fixed.
6. Each creator configures its own Stripe endpoint `https://<game server>/webhooks/stripe/<game>` and stores its
   own `stripe_webhook_secret` / `stripe_secret_key` (encrypted per-game secrets, CRM `d54a1c28`).

## 3. Publisher: env and install changes

- `deploy/publisher/install.sh` now also creates `/etc/etcito-publisher.key` (copy of `PUBLISHER_KEY`,
  `root:etcito 0640`) when it is absent; the CRM bridge reads it only when its `etcito_publisher_key` setting is
  empty. If the CRM process does not run as root or in group `etcito`, it cannot read that file: keep the setting.
  An existing file is never overwritten.
- New optional env: `PUBLISHER_MAX_QUEUE` (default 8, max 100).
- Unchanged: `PUBLISHER_GAMES` (default `PUBLISHER_DATA/games.json`, used only for `kekkai`, `monsterracer`,
  `kart` when a run carries no `game_id`), `ETCITO_URL` + `ETCITO_API_KEY` (mirror into `etc_deploy_runs`, now owner
  runs only), `PUBLISHER_HOME`, `WAVEDASH_BIN`, `BUTLER_BIN`.
- Creator games need their own `wavedash_api_token` (or `itch_api_key`) in their per-game secrets: the bridge sends
  it as `X-Wavedash-Token` / `X-Itch-Token`; without it a run answers 409.

## 4. Deploy (owner, by hand; nothing here is run by this repo)

Commit to deploy: the `feat/multicreator` head (`git rev-parse feat/multicreator`). Currently live: `816897a`.

Read-only pre-checks on the VM:

```sh
# Handshake games: must print exactly ['kekkai', 'monsterracer'] (any other name would be filtered on /webhooks/stripe)
sudo sed -n 's/^ETCITO_GAME_KEYS=//p' /etc/kart-rooms.env | python3 -c 'import json,sys; print(sorted(json.load(sys.stdin)))'
grep -c '^ETCITO_GAME_KEYS_FILE=' /etc/kart-rooms.env        # must be 0 on deploy day
# nginx must forward the whole /webhooks/ prefix, not only exact paths, for /webhooks/stripe/<game>
sudo nginx -T 2>/dev/null | grep -n 'webhooks'
# Publisher: which optional env is set (names only), and the static map
sudo grep -oE '^(ETCITO_URL|ETCITO_API_KEY|PUBLISHER_GAMES|PUBLISHER_HOME|WAVEDASH_BIN|BUTLER_BIN)=' /etc/etcito-publisher.env
ls -l /var/lib/etcito-publisher/games.json /etc/etcito-publisher.key 2>&1
# No publisher run in progress (a publisher restart kills a running CLI)
curl -fsS -H "Authorization: Bearer $(sudo sed -n 's/^PUBLISHER_KEY=//p' /etc/etcito-publisher.env)" http://127.0.0.1:9997/runs | grep -cE '"status":"(queued|running)"'
```

Steps:

1. Push `feat/multicreator` (or merge it) to the repository the backoffice update uses.
2. Handshake (`kart-rooms`): backoffice, Handshake update, ref = the commit sha. `handshake-update.sh` fetches it,
   `npm install --omit=dev`, backs up `/opt/kart-rooms` to `/opt/kart-rooms.bak-<timestamp>`, swaps, restarts and
   rolls back on its own when `/health` fails. Check `journalctl -u kart-rooms -n 50`: the line
   `player store: http, games: kekkai, monsterracer` and no `[games]` error.
3. Publisher (`/opt/etcito-publisher`, same repo, not covered by the update flow), with no run in progress:
   ```sh
   sudo rm -rf /opt/etcito-publisher.prev && sudo cp -a /opt/etcito-publisher /opt/etcito-publisher.prev
   # put the same commit's tree in /opt/etcito-publisher (git checkout <sha> if it is a clone, else rsync it)
   cd /opt/etcito-publisher && sudo npm install --omit=dev
   sudo sh deploy/publisher/install.sh      # idempotent; adds /etc/etcito-publisher.key if absent; restarts the unit
   ```
4. Smoke tests (owner games):
   - `curl -fsS http://127.0.0.1:9998/health` and the public `/health`.
   - Kekkai and Monster Racer: connect, `auth`, open a room, the shop lists products (`eco_products`).
   - Backoffice Deployments page for Kekkai: the overview shows the publisher as authenticated and the run list.
     A push or a publish starts and its log fills while it runs.
   - Stripe dashboard (owner account): "Send test webhook" to `/webhooks/stripe` answers 200 (`ignored`), a wrong
     signature 400.

Later, multi-creator mode (separate maintenance window):

5. Create `/var/lib/etcito-registry/game-keys.json` (section 1) with exactly the current `ETCITO_GAME_KEYS` value,
   then add `ETCITO_GAME_KEYS_FILE=/var/lib/etcito-registry/game-keys.json` to `/etc/kart-rooms.env` (remove or keep
   `ETCITO_GAME_KEYS`: the file wins) and `sudo systemctl restart kart-rooms`. Check the log as in step 2.
6. Onboard a creator (section 2), then confirm within 30 s: `[games] registry reloaded: game-17 (added)`.

## 5. Rollback

- Handshake: backoffice Handshake update with ref `816897a` (same backup/health/rollback flow), or by hand:
  `sudo mv /opt/kart-rooms /opt/kart-rooms.failed && sudo mv /opt/kart-rooms.bak-<timestamp> /opt/kart-rooms && sudo systemctl restart kart-rooms`.
- Publisher: `sudo systemctl stop etcito-publisher && sudo rm -rf /opt/etcito-publisher && sudo mv /opt/etcito-publisher.prev /opt/etcito-publisher && sudo systemctl start etcito-publisher`.
  `/etc/etcito-publisher.key` can stay (only read when the bridge setting is empty; same value as `PUBLISHER_KEY`).
  Run records written meanwhile stay in `/var/lib/etcito-publisher/runs` and are read by the old version.
- Multi-creator mode only: remove the `ETCITO_GAME_KEYS_FILE` line (keep a valid `ETCITO_GAME_KEYS`) and restart
  `kart-rooms`. Creator games then stop being served; owner data is untouched (nothing in this change migrates or
  rewrites tenant data).
- Creator Stripe endpoints `/webhooks/stripe/<game>` answer 404 on the old version: Stripe retries for 3 days, so a
  short rollback loses nothing.

## 6. Live risks

1. `ETCITO_GAME_KEYS` on the VM is not verified (no SSH). If it holds a game other than `kekkai` / `monsterracer`, a
   Stripe session for that game on `/webhooks/stripe` is now ignored (200) instead of credited. Pre-check above.
2. nginx: if `/webhooks` is proxied by exact paths, `/webhooks/stripe/<game>` never reaches Handshake (owner
   endpoints unaffected).
3. Legacy Stripe endpoint: a bad signature is now checked against kekkai's then monsterracer's secret (two bridge
   calls instead of one); if one bridge call fails and the other says "invalid", the answer is 503 (Stripe retries)
   instead of 400.
4. Publisher restart during a run kills the CLI (as with any restart): deploy only with no run queued/running.
5. Publisher run logs are now redacted (`token: x`, `secret=x`, `gsk_...`, `sk_live_...`, `whsec_...`): an owner
   log line that merely contains those words is masked. Build-id parsing reads the raw output, unaffected.
6. A creator game whose service key is not admin gets 403 from the bridge's `/stripe/*` until CRM change 2.3 ships:
   its Stripe webhooks answer 503 (retried) and checkout fails. Owner games are unaffected.
7. Multi-creator mode: a client whose `hello` names a game missing from the key file (for example a rooms-only
   client with its own game name) is refused. List the live client game names before step 5.
8. Multi-creator mode: an owner game whose `etc_game.handshake_game` is changed to another value is disabled at the
   next refresh (60 s) instead of being served on; in single-owner mode it is served on, as before.
9. Wavedash: a creator who registers the owner's Wavedash game id cannot divert the owner's purchases (owner wins),
   but two creators claiming one id block each other until the bridge enforces uniqueness (section 2.5).
