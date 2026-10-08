<#
.SYNOPSIS
  Build and deploy the T3 memory service to the pigeoncore host.

.DESCRIPTION
  Builds apps/memory into a self-contained bundle, ships it, swaps it into
  /opt/t3-memory/dist atomically, restarts t3-memory.service, and probes the
  service's own /health before calling the deploy done. A failed probe restores
  the previous bundle and starts the service on it.

  The memory data directory (/opt/t3-memory/home) is never touched: a deploy
  must not be able to lose the store. Token and unit come from
  memory/install-memory.sh, which is idempotent.

  Run from anywhere; paths resolve relative to the repository root.

.PARAMETER SshHost
  SSH alias or host for the target. Defaults to `pigeoncore`.

.PARAMETER SkipBuild
  Reuse the existing apps/memory/dist instead of rebuilding.

.PARAMETER SkipVerify
  Skip the post-restart readiness probe.

.EXAMPLE
  pwsh -File deploy/pigeoncore/deploy-memory.ps1
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
$MemoryDir = Join-Path $PSScriptRoot 'memory'
$WorkDir = Join-Path $env:TEMP 't3-memory-deploy'
$StageDir = Join-Path $WorkDir 'stage'
$Tarball = Join-Path $WorkDir 't3-memory-dist.tar.gz'

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
  Write-Step 1 'Building the memory bundle (vp run --filter @t3tools/memory build)'
  Invoke-Native 'vp' @('run', '--filter', '@t3tools/memory', 'build') $RepoRoot
} else {
  Write-Step 1 'Skipping build (--SkipBuild)'
}

$MemoryDist = Join-Path $RepoRoot 'apps\memory\dist'
if (-not (Test-Path (Join-Path $MemoryDist 'bin.mjs'))) {
  throw "No memory bundle at $MemoryDist. Run without -SkipBuild."
}

# ---------------------------------------------------------------- 2. stage
Write-Step 2 'Staging the bundle and the host scripts'
if (Test-Path $StageDir) { Remove-Item $StageDir -Recurse -Force }
New-Item -ItemType Directory -Path $StageDir -Force | Out-Null
Copy-Item (Join-Path $MemoryDist '*') $StageDir -Recurse -Force
# Sourcemaps are for reading stack traces locally; nothing on the host consumes them.
Get-ChildItem $StageDir -Recurse -Filter '*.map' -Force | Remove-Item -Force
$stageMb = [math]::Round((Get-ChildItem $StageDir -Recurse -Force -File | Measure-Object Length -Sum).Sum / 1MB, 2)
Write-Host "    $stageMb MB"

# ---------------------------------------------------------------- 3. ship
Write-Step 3 "Packaging and uploading to $SshHost"
if (Test-Path $Tarball) { Remove-Item $Tarball -Force }
Invoke-Native 'tar' @('-czf', $Tarball, '-C', $StageDir, '.') $WorkDir
& ssh -o BatchMode=yes $SshHost 'rm -rf /tmp/t3-memory-install && mkdir -p /tmp/t3-memory-install'
if ($LASTEXITCODE -ne 0) { throw "could not prepare /tmp/t3-memory-install on $SshHost" }
Invoke-Native 'scp' @('-o', 'BatchMode=yes', $Tarball, "${SshHost}:/tmp/t3-memory-dist.tar.gz") $WorkDir
foreach ($file in 'install-memory.sh', 'deploy-remote.sh', 't3-memory.service', 'enable-in-t3code.sh') {
  Invoke-Native 'scp' @('-o', 'BatchMode=yes',
    (Join-Path $MemoryDir $file), "${SshHost}:/tmp/t3-memory-install/$file") $WorkDir
}

# ------------------------------------------------- 4. install, swap, verify
Write-Step 4 'Installing, swapping, and probing readiness'
$skip = if ($SkipVerify) { '--skip-verify' } else { '' }
Invoke-RemoteScript @"
set -euo pipefail
bash /tmp/t3-memory-install/install-memory.sh
bash /tmp/t3-memory-install/deploy-remote.sh /tmp/t3-memory-dist.tar.gz /tmp/t3-memory-install $skip
"@ 't3-memory-deploy'

Write-Host "`nDeployed. The workbench picks it up on its next provider session." -ForegroundColor Green
Write-Host "  T3CODE_MEMORY_URL=http://127.0.0.1:3211"
Write-Host "  T3CODE_MEMORY_TOKEN_FILE=/opt/t3-memory/token"
