#!/usr/bin/env bash
# Idempotent host setup for the T3 memory service.
#
# Lays down the directories, a bearer token, and the systemd unit. Deliberately
# does not start or restart the service: deploy-remote.sh owns that, so this
# script is safe to re-run while the service is live.
set -euo pipefail

APP=${MEMORY_APP_DIR:-/opt/t3-memory}
UNIT=/etc/systemd/system/t3-memory.service
TOKEN_FILE="$APP/token"
HERE=$(cd "$(dirname "$0")" && pwd)

install -d -m 755 "$APP" "$APP/home"

# 48 base64url characters, 0600, never echoed. The service refuses to serve
# authenticated routes below 32 characters, so a truncated file shows up as
# "tokenConfigured: false" in /health rather than as a silent weak secret.
if [ ! -s "$TOKEN_FILE" ]; then
  ( umask 077; head -c 48 /dev/urandom | base64 | tr -d '/+=' | head -c 48 > "$TOKEN_FILE" )
  echo "token: created $TOKEN_FILE"
else
  echo "token: kept $TOKEN_FILE"
fi
chmod 600 "$TOKEN_FILE"

install -m 644 "$HERE/t3-memory.service" "$UNIT"
echo "unit: installed $UNIT"
if ! systemd-analyze verify "$UNIT" 2>&1 | grep -v '^$'; then
  echo "unit: verify clean"
fi
systemctl daemon-reload
echo "unit: daemon-reload done (service untouched)"
