#!/usr/bin/env bash
# Point the T3 Code workbench at the memory service.
#
# A drop-in rather than an edit to t3code.service, so the unit keeps matching
# harden-unit.sh and this can be removed by deleting one file.
#
#   enable-in-t3code.sh            enable and restart the workbench
#   enable-in-t3code.sh --disable  remove the drop-in and restart
set -euo pipefail

DROPIN_DIR=/etc/systemd/system/t3code.service.d
DROPIN="$DROPIN_DIR/memory.conf"

if [ "${1:-}" = "--disable" ]; then
  rm -f "$DROPIN"
  rmdir "$DROPIN_DIR" 2>/dev/null || true
  systemctl daemon-reload
  systemctl restart t3code
  echo "memory disabled for t3code; the memory service itself is untouched"
  exit 0
fi

if [ ! -s /opt/t3-memory/token ]; then
  echo "ERROR: no token at /opt/t3-memory/token. Run memory/install-memory.sh first." >&2
  exit 1
fi

install -d -m 755 "$DROPIN_DIR"
cat > "$DROPIN" <<'EOF'
[Service]
# The unified memory service. Without both variables T3 Code registers no
# memory tools and injects no memory block; see apps/memory/README.md.
Environment=T3CODE_MEMORY_URL=http://127.0.0.1:3211
Environment=T3CODE_MEMORY_TOKEN_FILE=/opt/t3-memory/token
EOF

systemctl daemon-reload
systemctl restart t3code
echo "memory enabled for t3code; waiting for readiness"
for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 http://127.0.0.1:3773/.well-known/t3/environment 2>/dev/null |
       grep environmentId >/dev/null ||
     curl -fsS --max-time 3 http://127.0.0.1:3773/ >/dev/null 2>&1; then
    echo "t3code is $(systemctl is-active t3code)"
    exit 0
  fi
  sleep 1
done
echo "t3code did not answer after the restart; check journalctl -u t3code" >&2
exit 1
