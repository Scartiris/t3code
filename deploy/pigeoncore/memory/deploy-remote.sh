#!/usr/bin/env bash
# Remote half of the memory deploy. Ships with the tarball and runs on the host.
#
#   deploy-remote.sh <tarball> <installer-dir> [--skip-verify]
#
# Extracts beside the live tree, swaps atomically, restarts, and probes
# readiness rather than the port — the listener binds before the store is open,
# so a port check would call a broken database a successful deploy. Any failure
# restores the previous build and starts the service on it.
set -euo pipefail

TARBALL=${1:?usage: deploy-remote.sh <tarball> <installer-dir> [--skip-verify]}
HERE=${2:?usage: deploy-remote.sh <tarball> <installer-dir> [--skip-verify]}
SKIP_VERIFY=${3:-}
APP=${MEMORY_APP_DIR:-/opt/t3-memory}
PORT=${MEMORY_PORT:-3211}
SERVICE=t3-memory

log() { echo "[memory-deploy] $*"; }

if [ ! -f "$TARBALL" ]; then
  log "ERROR: no tarball at $TARBALL"
  exit 1
fi

log "extracting beside the live tree"
rm -rf "$APP/dist.new"
install -d -m 755 "$APP/dist.new"
tar -xzf "$TARBALL" -C "$APP/dist.new"
if [ ! -f "$APP/dist.new/bin.mjs" ]; then
  log "ERROR: the tarball did not contain bin.mjs"
  rm -rf "$APP/dist.new"
  exit 1
fi

# Token and unit first: the swap below is the only step that can leave the
# service unable to start, and a missing unit would make that harder to read.
bash "$HERE/install-memory.sh"

log "swapping dist into place (previous kept as dist.old)"
rm -rf "$APP/dist.old"
if [ -d "$APP/dist" ]; then mv "$APP/dist" "$APP/dist.old"; fi
mv "$APP/dist.new" "$APP/dist"

log "restarting $SERVICE"
systemctl restart "$SERVICE"

if [ "$SKIP_VERIFY" = "--skip-verify" ]; then
  log "skipping the readiness probe (--skip-verify)"
  exit 0
fi

ready=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done

if [ "$ready" -ne 1 ]; then
  log "readiness probe failed; rolling back to dist.old"
  systemctl stop "$SERVICE" || true
  rm -rf "$APP/dist"
  if [ -d "$APP/dist.old" ]; then mv "$APP/dist.old" "$APP/dist"; fi
  systemctl start "$SERVICE" || true
  journalctl -u "$SERVICE" -n 40 --no-pager || true
  exit 1
fi

curl -fsS "http://127.0.0.1:$PORT/health"
echo
log "deployed: $SERVICE is $(systemctl is-active "$SERVICE")"
