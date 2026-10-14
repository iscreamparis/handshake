#!/bin/sh
# Root updater for kart-rooms (Handshake). Started by etcito-handshake-update.path when the publisher drops
# /var/lib/etcito-publisher/handshake/request.env (ID, REPO, REF - validated by the publisher AND again here).
#   fetch ref -> new tree -> npm install --omit=dev -> backup /opt/kart-rooms -> swap -> restart kart-rooms
#   -> /health must answer -> else automatic rollback to the backup.
# It touches only /opt/kart-rooms*, the kart-rooms unit and its own exchange folder. Never nginx, never the CRM.
set -u
DATA="${HS_DATA:-/var/lib/etcito-publisher/handshake}"
APP="${HS_APP:-/opt/kart-rooms}"
UNIT="${HS_UNIT:-kart-rooms}"
HEALTH="${HS_HEALTH_URL:-http://127.0.0.1:9998/health}"
REQ="$DATA/request.env"
STATUS="$DATA/status.json"
LOG="$DATA/update.log"
export HOME="${HOME:-/root}" GIT_TERMINAL_PROMPT=0 LC_ALL=C

ID=""; REPO=""; REF=""; SHA=""; STARTED=$(( $(date +%s) * 1000 ))
say() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >> "$LOG"; }
status() { # state message
  node -e '
    const [state, message, id, repo, ref, sha, started] = process.argv.slice(1)
    const done = !["queued", "running"].includes(state)
    process.stdout.write(JSON.stringify({ state, id, repo, ref, sha: sha || null, started_at: Number(started), ended_at: done ? Date.now() : null, message }))
  ' "$1" "$2" "$ID" "$REPO" "$REF" "$SHA" "$STARTED" > "$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"
  chown etcito:etcito "$STATUS" 2>/dev/null || true
}
health_ok() { curl -fsS -m 3 "$HEALTH" 2>/dev/null | grep -q '"ok":true'; }
wait_health() { i=0; while [ $i -lt 25 ]; do if systemctl is-active --quiet "$UNIT" && health_ok; then return 0; fi; i=$((i+1)); sleep 1; done; return 1; }
fail() { say "FAILED: $*"; status failed "$*"; exit 1; }

[ -f "$REQ" ] || exit 0
: > "$LOG"
for k in ID REPO REF; do
  v=$(sed -n "s/^$k=//p" "$REQ" | head -n 1)
  eval "$k=\$v"
done
rm -f "$REQ"
printf '%s' "$ID" | grep -Eq '^[0-9]{10,16}$' || fail "invalid request id"
printf '%s' "$REPO" | grep -Eq '^https://[A-Za-z0-9][A-Za-z0-9.-]{0,100}/[A-Za-z0-9._-]{1,100}/[A-Za-z0-9._-]{1,100}$' || fail "invalid repo"
printf '%s' "$REF" | grep -Eq '^[A-Za-z0-9._][A-Za-z0-9._/-]{0,99}$' || fail "invalid ref"
case "$REPO$REF" in *..*) fail "invalid repo/ref" ;; esac
status running "starting"
say "update $UNIT from $REPO @ $REF"

health_ok || fail "Handshake not healthy before the update: aborting (nothing changed)"

CACHE="$DATA/src.git"
[ -d "$CACHE" ] || git init --bare -q "$CACHE" || fail "cannot init the git cache"
say "fetch"
git -C "$CACHE" fetch -q --depth 1 --no-tags "$REPO" "$REF" >> "$LOG" 2>&1 || fail "git fetch failed (repo/ref unreachable)"
SHA=$(git -C "$CACHE" rev-parse FETCH_HEAD) || fail "cannot resolve the fetched commit"
say "commit $SHA"

NEW="$APP.new-$ID"
rm -rf "$NEW"; mkdir -p "$NEW" || fail "cannot create $NEW"
git -C "$CACHE" archive FETCH_HEAD | tar -x -C "$NEW" --no-same-owner || { rm -rf "$NEW"; fail "cannot export the tree"; }
[ -f "$NEW/package.json" ] && [ -f "$NEW/src/main.ts" ] || { rm -rf "$NEW"; fail "the ref is not a Handshake tree (package.json / src/main.ts missing)"; }
[ -d "$APP/node_modules" ] && cp -a "$APP/node_modules" "$NEW/node_modules"
say "npm install --omit=dev"
( cd "$NEW" && npm install --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error ) >> "$LOG" 2>&1 || { rm -rf "$NEW"; fail "npm install failed (nothing changed)"; }
printf '%s\n' "$SHA" > "$NEW/.deployed-ref"
chmod -R go-w "$NEW"; chmod 755 "$NEW"

BAK="$APP.bak-$(date +%Y%m%d%H%M%S)"
say "backup -> $BAK, swap, restart"
status running "swapping"
mv "$APP" "$BAK" || { rm -rf "$NEW"; fail "cannot move $APP aside"; }
mv "$NEW" "$APP" || { mv "$BAK" "$APP"; fail "cannot put the new tree in place (restored)"; }
systemctl restart "$UNIT"
if wait_health; then
  say "healthy: $(curl -fsS -m 3 "$HEALTH")"
  ls -dt "$APP".bak-* 2>/dev/null | tail -n +4 | while read -r old; do rm -rf "$old"; done
  status ok "updated to $SHA"
  exit 0
fi

say "NOT healthy after the update: rolling back to $BAK"
systemctl stop "$UNIT" || true
rm -rf "$APP.failed" ; mv "$APP" "$APP.failed"
mv "$BAK" "$APP"
systemctl restart "$UNIT"
if wait_health; then
  rm -rf "$APP.failed"
  say "rolled back, healthy"
  status rolled_back "the new version did not pass /health: previous version restored"
  exit 1
fi
say "ROLLBACK ALSO UNHEALTHY"
status failed "new version unhealthy AND rollback unhealthy: manual intervention needed ($APP.failed kept)"
exit 1
