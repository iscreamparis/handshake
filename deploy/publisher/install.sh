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

if [ ! -f "$ENVFILE" ]; then
  umask 027
  {
    echo "PUBLISHER_KEY=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    echo "PUBLISHER_PORT=9997"
    echo "PUBLISHER_HOST=127.0.0.1"
    echo "PUBLISHER_DATA=$DATA"
    echo "PUBLISHER_HOME=$DATA/home"
    echo "WAVEDASH_BIN=$DATA/home/.cargo/bin/wavedash"
  } > "$ENVFILE"
  chown root:etcito "$ENVFILE"
  chmod 640 "$ENVFILE"
fi

install -m 644 "$HERE/etcito-publisher.service" /etc/systemd/system/etcito-publisher.service
systemctl daemon-reload
systemctl enable etcito-publisher >/dev/null 2>&1 || true
systemctl restart etcito-publisher
sleep 2
systemctl is-active etcito-publisher
curl -fsS -m 5 http://127.0.0.1:9997/health && echo
echo "Next (once, by the operator): sudo -u etcito -H $DATA/home/.cargo/bin/wavedash auth login"
