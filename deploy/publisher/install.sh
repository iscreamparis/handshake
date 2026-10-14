#!/bin/sh
# Install the Etcito publisher on the VM (idempotent). Run as root from /opt/etcito-publisher:
#   sudo sh deploy/publisher/install.sh
# - system user `etcito` (no login) with its own HOME: that is where the wavedash CLI keeps ITS credentials
# - wavedash CLI installed in that HOME (official installer, no PATH edits)
# - /etc/etcito-publisher.env (mode 640, root:etcito) with a random PUBLISHER_KEY, created only if absent
# - systemd unit etcito-publisher on 127.0.0.1:9997 (9998 = handshake, 9999 = nginx)
# It does not touch nginx, coturn, kart-rooms or any CRM tenant.
set -eu

APP=/opt/etcito-publisher
DATA=/var/lib/etcito-publisher
ENVFILE=/etc/etcito-publisher.env
HERE="$(cd "$(dirname "$0")" && pwd)"

id -u etcito >/dev/null 2>&1 || useradd --system --home-dir "$DATA/home" --shell /usr/sbin/nologin etcito
mkdir -p "$DATA/home"
# games.json is optional (compat): games now come with each run from the backoffice mission. An existing one is kept.
chown -R etcito:etcito "$DATA"
chmod 700 "$DATA/home"

if [ ! -x "$DATA/home/.cargo/bin/wavedash" ]; then
  tmp="$(mktemp)"
  curl -fsSL https://wavedash.com/cli/install.sh -o "$tmp"
  chmod 644 "$tmp"
  su -s /bin/sh etcito -c "HOME=$DATA/home WAVEDASH_NO_MODIFY_PATH=1 sh $tmp" || { rm -f "$tmp"; exit 1; }
  rm -f "$tmp"
fi

# itch.io `butler` for the user etcito (idempotent). The itch API key is NOT here: the backoffice hands it
# to the publisher per request (X-Itch-Token -> BUTLER_API_KEY for that one child process).
BUTLER="$DATA/home/.butler/butler"
if [ ! -x "$BUTLER" ]; then
  tmpz="$(mktemp)"
  curl -fsSL https://broth.itch.zone/butler/linux-amd64/LATEST/archive/default -o "$tmpz"
  mkdir -p "$DATA/home/.butler"
  python3 - "$tmpz" "$DATA/home/.butler" <<'PY'
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1]); z.extractall(sys.argv[2])
PY
  rm -f "$tmpz"
  chmod 755 "$DATA/home/.butler/butler"
  chown -R etcito:etcito "$DATA/home/.butler"
fi
grep -q '^BUTLER_BIN=' "$ENVFILE" 2>/dev/null || { [ -f "$ENVFILE" ] && echo "BUTLER_BIN=$BUTLER" >> "$ENVFILE"; }

# Handshake self-update: the publisher (unprivileged) only drops a validated request file in
# $DATA/handshake; the root unit below does the swap/restart/rollback of /opt/kart-rooms.
mkdir -p "$DATA/handshake"
chown etcito:etcito "$DATA/handshake"
install -m 644 "$HERE/etcito-handshake-update.service" /etc/systemd/system/etcito-handshake-update.service
install -m 644 "$HERE/etcito-handshake-update.path" /etc/systemd/system/etcito-handshake-update.path
chmod 755 "$HERE/handshake-update.sh"

if [ ! -f "$ENVFILE" ]; then
  umask 027
  {
    echo "PUBLISHER_KEY=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    echo "PUBLISHER_PORT=9997"
    echo "PUBLISHER_HOST=127.0.0.1"
    echo "PUBLISHER_DATA=$DATA"
    echo "PUBLISHER_HOME=$DATA/home"
    echo "WAVEDASH_BIN=$DATA/home/.cargo/bin/wavedash"
    echo "BUTLER_BIN=$BUTLER"
  } > "$ENVFILE"
  chown root:etcito "$ENVFILE"
  chmod 640 "$ENVFILE"
fi

install -m 644 "$HERE/etcito-publisher.service" /etc/systemd/system/etcito-publisher.service
systemctl daemon-reload
systemctl enable --now etcito-handshake-update.path >/dev/null 2>&1 || true
systemctl enable etcito-publisher >/dev/null 2>&1 || true
systemctl restart etcito-publisher
sleep 2
systemctl is-active etcito-publisher
curl -fsS -m 5 http://127.0.0.1:9997/health && echo
echo "Next (once, by the operator): sudo -u etcito -H $DATA/home/.cargo/bin/wavedash auth login"
