<#
.SYNOPSIS
  Build this fork and deploy it to the pigeoncore workbench host.

.DESCRIPTION
  Builds the server bundle plus the web client, stages the platform-independent
  JavaScript, ships it to the host, installs the runtime-external native
  packages there (they must be built for Linux, not for this Windows machine),
  then restarts the service and verifies it.

  Run from anywhere; paths resolve relative to the repository root.

.PARAMETER SshHost
  SSH alias or host for the target. Defaults to `pigeoncore`.

.PARAMETER SkipBuild
  Reuse the existing apps/server/dist instead of rebuilding.

.PARAMETER SkipVerify
  Skip the post-restart health check.

.EXAMPLE
  pwsh -File deploy/pigeoncore/deploy.ps1
#>
[CmdletBinding()]
param(
  [string] $SshHost = 'pigeoncore',
  [switch] $SkipBuild,
  [switch] $SkipVerify
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
set -uo pipefail

echo '  stopping __SERVICE__'
systemctl stop __SERVICE__ 2>/dev/null || true

echo '  extracting'
rm -rf __APP_DIR__/node_modules __APP_DIR__/dist __APP_DIR__/patches
tar -xzf /tmp/t3-dist.tar.gz -C __APP_DIR__
rm -rf __APP_DIR__/dist/client/.vite

# Windows tar stores 0666/0777, so every extracted file lands world-writable.
# The service runs as root and serves that JavaScript to an authenticated
# browser, so a local user could otherwise swap it out.
echo '  normalizing permissions'
find __APP_DIR__ -path __APP_DIR__/home -prune -o -type d -print0 | xargs -0 -r chmod 755
find __APP_DIR__ -path __APP_DIR__/home -prune -o -type f -print0 | xargs -0 -r chmod 644
chmod 700 __APP_DIR__/home

echo '  installing runtime-external native packages (Linux builds)'
cd __APP_DIR__
pnpm install --prod 2>&1 | tail -8

echo '  verifying the fff-node patch applied'
node -e 'const p=require("__APP_DIR__/node_modules/@ff-labs/fff-node/package.json"); if(!p.exports["."].require) { console.error("  PATCH MISSING"); process.exit(1); } console.log("  require condition present");'

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
UNIT=/etc/systemd/system/__SERVICE__.service
if grep -q '^Environment=T3CODE_ACP_REGISTRY_URL=' "$UNIT"; then
  sed -i "s|^Environment=T3CODE_ACP_REGISTRY_URL=.*|Environment=T3CODE_ACP_REGISTRY_URL=__REGISTRY_URL__|" "$UNIT"
else
  sed -i "/^Environment=T3CODE_HOME=/a Environment=T3CODE_ACP_REGISTRY_URL=__REGISTRY_URL__" "$UNIT"
fi
systemctl daemon-reload

echo '  starting'
systemctl restart __SERVICE__
sleep 15
printf '  %s: enabled=%s active=%s\n' '__SERVICE__' "$(systemctl is-enabled __SERVICE__ 2>/dev/null)" "$(systemctl is-active __SERVICE__ 2>/dev/null)"
if ss -H -ltn | grep -qF ':__PORT__'; then
  echo '  listening on __PORT__'
else
  echo '  NOT LISTENING'
  journalctl -u __SERVICE__ -n 30 --no-pager
  exit 1
fi
'@
$remote = $remoteTemplate.
  Replace('__APP_DIR__', $AppDir).
  Replace('__SERVICE__', $Service).
  Replace('__PORT__', [string] $Port).
  Replace('__REGISTRY_URL__', "https://t3.pigeontech.cn/acp-registry.json")
Invoke-RemoteScript $remote 't3-install'

# ---------------------------------------------------------------- 5. verify
if (-not $SkipVerify) {
  Write-Step 5 'Verifying over HTTPS'
  $probe = @'
set -uo pipefail
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://t3.pigeontech.cn/)
echo "  https://t3.pigeontech.cn/ -> $code"
[ "$code" = "200" ] || exit 1
curl -sS -o /dev/null -w '  /ws -> %{http_code} (426 is the server answering; not a proxy error)\n' --max-time 20 https://t3.pigeontech.cn/ws
'@
  Invoke-RemoteScript $probe 't3-verify'
}

Write-Host "`nDeployed. Pair a browser with:" -ForegroundColor Green
Write-Host "  ssh $SshHost 'T3CODE_HOME=$AppDir/home /opt/node24/bin/node $AppDir/dist/bin.mjs pair --ttl 15m'" -ForegroundColor Green
Write-Host "  then open https://t3.pigeontech.cn/pair#token=<TOKEN>`n" -ForegroundColor Green
