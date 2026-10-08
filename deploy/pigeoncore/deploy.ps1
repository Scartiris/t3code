<#
.SYNOPSIS
  Build this fork and deploy it to the pigeoncore workbench host.

.DESCRIPTION
  Builds the server bundle plus the web client, stages the platform-independent
  JavaScript, ships it to the host, installs the runtime-external native
  packages there (they must be built for Linux, not for this Windows machine),
  then restarts the service and verifies it.

  The remote half extracts into a staging directory, renames the new build into
  place, and probes readiness rather than the TCP port. Any failure restores the
  previous build and starts the service on it, so a bad tarball or a missing
  patch degrades to "the deploy did not happen" instead of a dead workbench.

  Run from anywhere; paths resolve relative to the repository root.

.PARAMETER SshHost
  SSH alias or host for the target. Defaults to `pigeoncore`.

.PARAMETER SkipBuild
  Reuse the existing apps/server/dist instead of rebuilding.

.PARAMETER SkipVerify
  Skip the post-restart health check.

.PARAMETER AssetRetentionDays
  How long to keep superseded hashed assets in dist/client/assets. An open page
  holds an index.html naming the previous build's chunks, so dropping them
  immediately 404s that page mid-session. Defaults to 7.

.EXAMPLE
  pwsh -File deploy/pigeoncore/deploy.ps1
#>
[CmdletBinding()]
param(
  [string] $SshHost = 'pigeoncore',
  [switch] $SkipBuild,
  [switch] $SkipVerify,
  [int] $AssetRetentionDays = 7
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$AppDir = '/opt/t3'
$Port = 3773
$Service = 't3code'

# Staging happens outside the worktree: it is build output, not source.
$WorkDir = Join-Path $env:TEMP 't3-pigeoncore-deploy'
$StageDir = Join-Path $WorkDir 'stage'
$Tarball = Join-Path $WorkDir 't3-dist.tar.gz'

function Write-Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }
function Invoke-Native($exe, $arguments, $workdir) {
  Push-Location $workdir
  try {
    & $exe @arguments
    if ($LASTEXITCODE -ne 0) { throw "$exe exited with $LASTEXITCODE" }
  } finally { Pop-Location }
}
# Piping a script into `ssh host 'bash -s'` is not reliable from Windows:
# PowerShell terminates native-command stdin with CRLF, which bash reports as
# "$'\r': command not found" and which changes the exit code. Ship the script as
# a file with LF endings and run it by path instead.
function Invoke-RemoteScript([string] $script, [string] $name) {
  $local = Join-Path $WorkDir "$name.sh"
  $remote = "/tmp/$name.sh"
  $lf = ($script -replace "`r`n", "`n") -replace "`r", "`n"
  [System.IO.File]::WriteAllText($local, $lf, (New-Object System.Text.UTF8Encoding($false)))
  & scp -o BatchMode=yes $local "${SshHost}:$remote" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "scp of $name failed with $LASTEXITCODE" }
  & ssh -o BatchMode=yes $SshHost "bash $remote"
  if ($LASTEXITCODE -ne 0) { throw "$name failed with $LASTEXITCODE" }
}

# ---------------------------------------------------------------- 1. build
if (-not $SkipBuild) {
  Write-Step 1 'Building server bundle + web client (vp run --filter t3 build)'
  Invoke-Native 'vp' @('run', '--filter', 't3', 'build') $RepoRoot
} else {
  Write-Step 1 'Skipping build (--SkipBuild)'
}

$ServerDist = Join-Path $RepoRoot 'apps\server\dist'
if (-not (Test-Path (Join-Path $ServerDist 'bin.mjs'))) {
  throw "No server bundle at $ServerDist. Run without -SkipBuild."
}
if (-not (Test-Path (Join-Path $ServerDist 'client\index.html'))) {
  throw "The web client was not bundled into $ServerDist\client. Run without -SkipBuild."
}

# ---------------------------------------------------------------- 2. stage
Write-Step 2 'Staging the platform-independent JavaScript'
if (Test-Path $StageDir) { Remove-Item $StageDir -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $StageDir 'dist') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $StageDir 'patches') -Force | Out-Null

$copied = 0
Get-ChildItem $ServerDist -Recurse -Force | ForEach-Object {
  $rel = $_.FullName.Substring($ServerDist.Length).TrimStart('\')
  # Sourcemaps are ~100 MB and nothing serves them.
  if ($_.Name -like '*.map') { return }
  # Vite's dev-only dependency optimizer cache.
  if ($rel -like 'client\.vite*') { return }
  $dst = Join-Path (Join-Path $StageDir 'dist') $rel
  if ($_.PSIsContainer) { New-Item -ItemType Directory -Path $dst -Force | Out-Null }
  else { Copy-Item $_.FullName $dst -Force; $script:copied++ }
}

Copy-Item (Join-Path $PSScriptRoot 'runtime\package.json') $StageDir -Force
Copy-Item (Join-Path $PSScriptRoot 'runtime\pnpm-workspace.yaml') $StageDir -Force
# The host install applies these; ship them from the repo so the two never drift.
foreach ($p in '@ff-labs__fff-node@0.9.4.patch', 'node-pty@1.2.0-beta.15.patch') {
  Copy-Item (Join-Path $RepoRoot "patches\$p") (Join-Path $StageDir 'patches') -Force
}
$stageMb = [math]::Round((Get-ChildItem $StageDir -Recurse -Force -File | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host "    $copied files, $stageMb MB"

# ---------------------------------------------------------------- 3. ship
Write-Step 3 "Packaging and uploading to $SshHost"
if (Test-Path $Tarball) { Remove-Item $Tarball -Force }
Invoke-Native 'tar' @('-czf', $Tarball, '-C', $StageDir, '.') $WorkDir
Invoke-Native 'scp' @('-o', 'BatchMode=yes', $Tarball, "${SshHost}:/tmp/t3-dist.tar.gz") $WorkDir
# Generates the brotli sidecars Caddy serves via `precompressed br`. See its
# header for why the sidecars exist rather than letting Caddy compress live.
Invoke-Native 'scp' @('-o', 'BatchMode=yes', (Join-Path $PSScriptRoot 'lib\precompress.mjs'), "${SshHost}:/tmp/t3-precompress.mjs") $WorkDir

# The local ACP Registry index, rebuilt from deploy/agents so the server never
# serves a stale list of agents.
$registry = Join-Path $RepoRoot 'deploy\agents\registry.local.json'
if (Test-Path $registry) {
  Invoke-Native 'scp' @('-o', 'BatchMode=yes', $registry, "${SshHost}:/tmp/registry.local.json") $WorkDir
} else {
  Write-Host '    no registry.local.json; run deploy/agents/build-registry.mjs first' -ForegroundColor Yellow
}

# ------------------------------------------------- 4. install + restart
Write-Step 4 'Installing on the host and restarting the service'
# Single-quoted here-string: nothing is expanded here, so PowerShell never tries
# to run the shell commands locally. Placeholders are substituted afterwards.
$remoteTemplate = @'
set -euo pipefail

APP=__APP_DIR__
SERVICE=__SERVICE__
PORT=__PORT__

# Any failure past this point restores the previous dist and brings the service
# back up on it, so a bad tarball or a missing patch degrades to "the deploy did
# not happen" instead of "the workbench is down".
on_exit() {
  code=$?
  if [ "$code" -ne 0 ]; then
    echo "  DEPLOY FAILED (exit $code)"
    if [ -d "$APP/dist.prev" ]; then
      echo "  restoring the previous dist"
      rm -rf "$APP/dist"
      mv "$APP/dist.prev" "$APP/dist"
      systemctl start "$SERVICE" || true
      sleep 3
      printf '  rollback: active=%s\n' "$(systemctl is-active "$SERVICE" 2>/dev/null)"
    else
      echo "  no previous dist to restore; the service is left as it is"
      systemctl start "$SERVICE" || true
    fi
  fi
  exit $code
}
trap on_exit EXIT

# Staging happens while the old build is still serving, so the outage window
# covers only the install and the restart.
echo '  extracting to staging (service still up)'
rm -rf "$APP/.stage"
mkdir -p "$APP/.stage"
tar -xzf /tmp/t3-dist.tar.gz -C "$APP/.stage"
rm -rf "$APP/.stage/dist/client/.vite"

# Windows tar stores 0666/0777, so every extracted file lands world-writable.
# The service runs as root and serves this JavaScript to a browser, so a local
# user could otherwise swap it out. Only the staged tree is chmodded: it is the
# only part that changed, and walking the whole app dir was wasted work.
echo '  normalizing permissions'
find "$APP/.stage" -type d -print0 | xargs -0 -r chmod 755
find "$APP/.stage" -type f -print0 | xargs -0 -r chmod 644
# State is not part of the tarball, so this survives a deploy; it is here for a
# host that has never been set up.
if [ -d "$APP/home" ]; then chmod 700 "$APP/home"; fi

# Optional: if this fails the deploy continues and Caddy compresses on the fly
# exactly as it did before, so a precompression problem is never fatal.
echo '  precompressing assets (brotli q11 sidecars)'
if ! node /tmp/t3-precompress.mjs "$APP/.stage/dist/client/assets"; then
  echo '    precompression failed; Caddy will compress on the fly'
fi

# pnpm resolves patchedDependencies through patches/ before it installs, so the
# patch set has to land first. Neither file is read by the running server.
echo '  staging runtime workspace files'
install -m 644 "$APP/.stage/package.json" "$APP/package.json"
install -m 644 "$APP/.stage/pnpm-workspace.yaml" "$APP/pnpm-workspace.yaml"
rm -rf "$APP/patches.prev"
if [ -d "$APP/patches" ]; then mv "$APP/patches" "$APP/patches.prev"; fi
mv "$APP/.stage/patches" "$APP/patches"

echo '  stopping '"$SERVICE"
systemctl stop "$SERVICE" 2>/dev/null || true

echo '  installing runtime-external native packages (Linux builds)'
cd "$APP"
pnpm install --prod 2>&1 | tail -8

# Checked from a file rather than `node -e` so the quoting stays readable. This
# is the check whose failure used to be ignored, which restarted the service
# against a half-installed tree and produced a crash-restart loop.
cat > /tmp/t3-verify-patch.cjs <<'JS'
const p = require(process.argv[2]);
if (!p.exports["."].require) {
  console.error("  PATCH MISSING");
  process.exit(1);
}
console.log("  require condition present");
JS
echo '  verifying the fff-node patch applied'
node /tmp/t3-verify-patch.cjs "$APP/node_modules/@ff-labs/fff-node/package.json"

# A page opened before this deploy holds an index.html that names the previous
# build's hashed chunks. Replacing assets/ wholesale makes those requests 404 and
# the page dies mid-session, which was observed on 2026-10-06 right after a swap.
# Asset names are content hashes, so carrying older generations forward is safe:
# a name can never mean two different bodies.
#
# Two sources, because a client can be a deploy behind or two: dist is the
# currently-live build, dist.old is the one before it (dist.prev does not exist
# yet at this point -- a successful deploy renames it to dist.old). Carrying the
# whole assets directory each time accumulates generations, and the mtime prune
# below is what bounds it.
echo '  carrying forward previous build assets'
# Names this build actually produced, captured BEFORE the merge below. Taking
# this after the merge would make the superseded set always empty, because the
# merge is what puts the old names back.
find "$APP/.stage/dist/client/assets" -type f -printf '%f\n' 2>/dev/null | sort -u > /tmp/t3-new-assets.txt

: > /tmp/t3-prev-assets.txt
for src in "$APP/dist" "$APP/dist.old"; do
  if [ -d "$src/client/assets" ]; then
    find "$src/client/assets" -type f -printf '%f\n' 2>/dev/null >> /tmp/t3-prev-assets.txt
    cp -an "$src/client/assets/." "$APP/.stage/dist/client/assets/" 2>/dev/null || true
    echo "    carried from $src"
  fi
done

# What the merge preserved but this build did not produce: exactly the URLs a
# page opened before this deploy still needs.
sort -u /tmp/t3-prev-assets.txt -o /tmp/t3-prev-assets.txt
comm -23 /tmp/t3-prev-assets.txt /tmp/t3-new-assets.txt > /tmp/t3-superseded-assets.txt
echo "    fresh this build: $(wc -l < /tmp/t3-new-assets.txt) files"
echo "    superseded this deploy: $(wc -l < /tmp/t3-superseded-assets.txt) files"
echo "    present after merge: $(find "$APP/.stage/dist/client/assets" -type f | wc -l) files"

# Same filesystem, so each rename is atomic: readers never see a partial or
# absent tree, and dist.prev stays available until readiness is confirmed.
echo '  activating the new build'
rm -rf "$APP/dist.prev"
if [ -d "$APP/dist" ]; then mv "$APP/dist" "$APP/dist.prev"; fi
mv "$APP/.stage/dist" "$APP/dist"
rm -rf "$APP/.stage"

# The retention half of the bound above. mtimes come from the build, not the
# deploy, so this prunes genuinely old generations rather than whatever happened
# to be copied most recently.
RETAIN_DAYS=__RETAIN_DAYS__
pruned=$(find "$APP/dist/client/assets" -type f -mtime +"$RETAIN_DAYS" -print -delete | wc -l)
echo "  pruned $pruned assets older than ${RETAIN_DAYS}d; $(find "$APP/dist/client/assets" -type f | wc -l) remain"

# Local ACP Registry index: it lists the agents the public registry does not
# carry. Caddy serves it over TLS because T3 rejects a non-HTTPS registry URL.
echo '  installing the local ACP registry index'
if [ -f /tmp/registry.local.json ]; then
  mkdir -p /srv/acp
  install -m 644 /tmp/registry.local.json /srv/acp/acp-registry.json
  node -e 'const d=require("/srv/acp/acp-registry.json"); console.log("    agents:", d.agents.length, " local:", JSON.stringify(d._localEntries ?? []));'
else
  echo '    no registry payload uploaded; leaving the existing index alone'
fi

echo '  pointing the service at it'
UNIT=/etc/systemd/system/$SERVICE.service
if grep -q '^Environment=T3CODE_ACP_REGISTRY_URL=' "$UNIT"; then
  sed -i "s|^Environment=T3CODE_ACP_REGISTRY_URL=.*|Environment=T3CODE_ACP_REGISTRY_URL=__REGISTRY_URL__|" "$UNIT"
else
  sed -i "/^Environment=T3CODE_HOME=/a Environment=T3CODE_ACP_REGISTRY_URL=__REGISTRY_URL__" "$UNIT"
fi
systemctl daemon-reload

echo '  starting'
systemctl restart "$SERVICE"

# The TCP port is bound before recovery finishes, so `ss | grep` reports success
# while the readiness gate is still holding every request. Probe a route that
# actually traverses that gate instead.
echo '  waiting for readiness'
ready=0
for i in $(seq 1 60); do
  if curl -sS --max-time 3 "http://127.0.0.1:$PORT/.well-known/t3/environment" 2>/dev/null | grep -q environmentId; then
    echo "  ready after ${i}s"
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo '  NOT READY within 60s'
  journalctl -u "$SERVICE" -n 40 --no-pager
  exit 1
fi
printf '  %s: enabled=%s active=%s\n' "$SERVICE" "$(systemctl is-enabled "$SERVICE" 2>/dev/null)" "$(systemctl is-active "$SERVICE" 2>/dev/null)"

# Readiness passed, so the previous tree can be retired. dist.old is kept for
# one more deploy as a hand-rollback target.
rm -rf "$APP/dist.old"
if [ -d "$APP/dist.prev" ]; then mv "$APP/dist.prev" "$APP/dist.old"; fi
rm -rf "$APP/patches.prev"
echo '  done'
'@
$remote = $remoteTemplate.
  Replace('__APP_DIR__', $AppDir).
  Replace('__SERVICE__', $Service).
  Replace('__PORT__', [string] $Port).
  Replace('__RETAIN_DAYS__', [string] $AssetRetentionDays).
  Replace('__REGISTRY_URL__', "https://t3.pigeontech.cn/acp-registry.json")
Invoke-RemoteScript $remote 't3-install'

# ------------------------------------------------------------ 5. edge config
# The Caddyfile lives in this repo but nothing else installs it, so it would
# drift from the host. Validated before the swap and rolled back on a failed
# reload, which makes shipping it here cheaper than reconciling it by hand.
Write-Step 5 'Reconciling the Caddy site config'
Invoke-Native 'scp' @(
  '-o', 'BatchMode=yes',
  (Join-Path $PSScriptRoot 'Caddyfile'),
  "${SshHost}:/tmp/Caddyfile.new"
) $WorkDir
$edge = @'
set -uo pipefail
LIVE=/etc/caddy/Caddyfile
if cmp -s /tmp/Caddyfile.new "$LIVE"; then
  echo '  unchanged; not reloading'
  exit 0
fi
if ! caddy validate --config /tmp/Caddyfile.new --adapter caddyfile >/dev/null 2>&1; then
  echo '  VALIDATION FAILED - leaving the live config alone'
  caddy validate --config /tmp/Caddyfile.new --adapter caddyfile 2>&1 | tail -5
  exit 1
fi
BAK=$LIVE.bak-$(date +%Y%m%d-%H%M%S)
cp -a "$LIVE" "$BAK"
install -m 644 /tmp/Caddyfile.new "$LIVE"
if caddy reload --config "$LIVE" --adapter caddyfile >/dev/null 2>&1; then
  echo "  reloaded (previous config kept at $BAK)"
else
  echo '  RELOAD FAILED - restoring'
  cp -a "$BAK" "$LIVE"
  caddy reload --config "$LIVE" --adapter caddyfile >/dev/null 2>&1
  exit 1
fi
ss -H -lunp | grep -q ':443' && echo '  http/3 listening on udp/443' || echo '  WARNING: nothing on udp/443'
'@
Invoke-RemoteScript $edge 't3-edge'

# ---------------------------------------------------------------- 6. verify
if (-not $SkipVerify) {
  Write-Step 6 'Verifying over HTTPS'
  $probe = @'
set -uo pipefail
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://t3.pigeontech.cn/)
echo "  https://t3.pigeontech.cn/ -> $code"
[ "$code" = "200" ] || exit 1
curl -sS -o /dev/null -w '  /ws -> %{http_code} (426 is the server answering; not a proxy error)\n' --max-time 20 https://t3.pigeontech.cn/ws
# An asset must come off disk rather than through the Node server, and a
# precompressed sidecar must be what gets picked. The largest asset is chosen
# deliberately: Caddy's encode has a minimum length, so a small file would
# legitimately arrive uncompressed and prove nothing.
ASSET=$(basename "$(ls -S /opt/t3/dist/client/assets/*.js | head -1)")
curl -sS -o /dev/null -D /tmp/t3-asset-headers -H 'Accept-Encoding: br' \
  "https://t3.pigeontech.cn/assets/$ASSET"
if grep -qi '^via: 1.1 Caddy' /tmp/t3-asset-headers; then
  echo "  WARNING: /assets/$ASSET went through reverse_proxy, not file_server"
  exit 1
fi
SIDECAR_BYTES=$(stat -c %s "/opt/t3/dist/client/assets/$ASSET.br" 2>/dev/null || echo none)
WIRE_BYTES=$(curl -sS -o /dev/null -w '%{size_download}' -H 'Accept-Encoding: br' \
  "https://t3.pigeontech.cn/assets/$ASSET")
ENCODING=$(grep -i '^content-encoding' /tmp/t3-asset-headers | tr -d '\r' | cut -d' ' -f2)
echo "  /assets/$ASSET -> $ENCODING, $WIRE_BYTES B (sidecar $SIDECAR_BYTES B)"
if [ "$SIDECAR_BYTES" != "none" ] && [ "$WIRE_BYTES" != "$SIDECAR_BYTES" ]; then
  echo "  WARNING: wire size does not match the sidecar; Caddy compressed live"
  exit 1
fi

# The property that keeps a page alive across a deploy: a chunk this deploy
# superseded must still resolve. A file that happens to be in both generations
# would prove nothing, so this picks from the superseded-only set.
if [ -s /tmp/t3-superseded-assets.txt ]; then
  OLD=$(grep -E '\.js$' /tmp/t3-superseded-assets.txt | head -1)
  if [ -n "$OLD" ]; then
    OLD_CODE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
      "https://t3.pigeontech.cn/assets/$OLD")
    echo "  superseded asset /assets/$OLD -> $OLD_CODE"
    if [ "$OLD_CODE" != "200" ]; then
      echo "  WARNING: a page opened before this deploy would 404 on its own chunks"
      exit 1
    fi
  fi
else
  echo "  no superseded assets to check (first deploy, or nothing changed)"
fi
'@
  Invoke-RemoteScript $probe 't3-verify'
}

Write-Host "`nDeployed. Pair a browser with:" -ForegroundColor Green
Write-Host "  ssh $SshHost 'T3CODE_HOME=$AppDir/home /opt/node24/bin/node $AppDir/dist/bin.mjs pair --ttl 15m'" -ForegroundColor Green
Write-Host "  then open https://t3.pigeontech.cn/pair#token=<TOKEN>`n" -ForegroundColor Green
