#!/usr/bin/env bash
# Consistent, minimal backup of the T3 Code workbench state.
#
# Worth keeping: the sqlite state, the server's signing keys, and the small set
# of user settings. Not worth keeping: logs/ (108 MB of rotated trace files),
# tools/ (445 MB of provider installs the ACP registry re-creates), node_modules,
# or anything under dist/.
#
# Installed to /usr/local/bin/t3-backup and driven by t3-backup.timer.
set -euo pipefail

HOME_DIR=${T3CODE_HOME:-/opt/t3/home}
UD="$HOME_DIR/userdata"
DEST=${T3_BACKUP_DIR:-/opt/t3-backups}
KEEP=${T3_BACKUP_KEEP:-14}
NODE=${T3_NODE:-/opt/node24/bin/node}
STAMP=$(date +%Y%m%dT%H%M%S)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$DEST" "$WORK/userdata"

# VACUUM INTO gives a transactionally consistent snapshot under WAL; copying the
# .sqlite file while the server is writing does not. Written from a file rather
# than `node -e` so the SQL literal quoting stays readable.
cat > "$WORK/snapshot.mjs" <<'JS'
import { DatabaseSync } from "node:sqlite";
const [src, out] = process.argv.slice(2);
const literal = "'" + out.replaceAll("'", "''") + "'";
const db = new DatabaseSync(src, { readOnly: true });
db.exec("VACUUM INTO " + literal);
JS

snapshot() {
  if [ -f "$1" ]; then
    mkdir -p "$(dirname "$2")"
    "$NODE" "$WORK/snapshot.mjs" "$1" "$2"
  fi
}

snapshot "$UD/statev2.sqlite" "$WORK/userdata/statev2.sqlite"
rm -f "$WORK/snapshot.mjs"

# -a preserves the 0600/0700 modes on secrets/.
for item in secrets settings.json keybindings.json model-manifest.json \
            server-runtime.json environment-id anonymous-id themes \
            opencode-servers keybindings-migrations attachments caches; do
  if [ -e "$UD/$item" ]; then cp -a "$UD/$item" "$WORK/userdata/"; fi
done

{
  echo "createdAt=$(date -Is)"
  echo "host=$(hostname)"
  echo "t3Home=$HOME_DIR"
  echo "files=$(find "$WORK" -type f -not -name MANIFEST.txt | wc -l)"
  echo "bytes=$(du -sb --exclude=MANIFEST.txt "$WORK" | cut -f1)"
  echo "sha256:"
  (cd "$WORK" && find . -type f -not -name MANIFEST.txt -exec sha256sum {} + | sort -k2)
} > "$WORK/MANIFEST.txt"

OUT="$DEST/t3-home-$STAMP.tar.gz"
tar -czf "$OUT" -C "$WORK" .
chmod 600 "$OUT"

# Verify before reporting success, so corruption surfaces at write time rather
# than at restore time.
tar -tzf "$OUT" >/dev/null

echo "backup: $OUT ($(du -h "$OUT" | cut -f1))"
echo "  files=$(grep '^files=' "$WORK/MANIFEST.txt" | cut -d= -f2) bytes=$(grep '^bytes=' "$WORK/MANIFEST.txt" | cut -d= -f2)"

# Retention: keep the newest $KEEP archives.
if [ "$KEEP" -gt 0 ]; then
  ls -1t "$DEST"/t3-home-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
    rm -f "$old" && echo "  pruned $(basename "$old")"
  done
fi
