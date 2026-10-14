#!/bin/sh
# Send a prebuilt game folder to the publisher on the VM (the VM cannot build: 0.9 GB RAM).
#   tools/upload-build.sh <game> <dist-dir> [ssh-host]
#   tools/upload-build.sh kekkai ../kekkai/dist-wd
#   tools/upload-build.sh monsterracer ../nomorechat_games/KartRacer_OpusXhigh/dist
# The service key never leaves the VM: it is read there (root-only env file) and used by curl on the VM.
# Then use the backoffice: Send (build push), then Publish.
set -eu
GAME="${1:?game id (see games.json)}"
DIR="${2:?folder to upload}"
HOST="${3:-9.160.8.41}"
[ -f "$DIR/index.html" ] || { echo "no index.html in $DIR" >&2; exit 2; }
case "$GAME" in *[!a-z0-9_-]*) echo "bad game id" >&2; exit 2 ;; esac
# Do not ship dev-tool leftovers.
tar -czf - --exclude=nmc.gpu.json -C "$DIR" . |
  ssh "$HOST" "sudo sh -c '. /etc/etcito-publisher.env && curl -sS -f -m 600 -X PUT --data-binary @- -H \"authorization: Bearer \$PUBLISHER_KEY\" http://127.0.0.1:9997/artifacts/$GAME'"
echo
