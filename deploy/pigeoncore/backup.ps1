<#
.SYNOPSIS
  Pull the newest T3 Code workbench backup off the host.

.DESCRIPTION
  The host keeps a rolling set of daily archives in /opt/t3-backups, which
  protects against a bad migration or an accidental delete but not against losing
  the host itself. This script is the off-host half: it copies the newest archive
  (and its MANIFEST) to a local directory and prunes old copies.

  Local copies land outside the worktree by default so they never show up in
  `git status`. Run it by hand, or register it as a Scheduled Task.

.PARAMETER SshHost
  SSH alias or host for the source. Defaults to `pigeoncore`.

.PARAMETER DestDir
  Where local copies land. Defaults to `%USERPROFILE%\t3-backups`.

.PARAMETER Keep
  How many local archives to keep. Defaults to 14.

.EXAMPLE
  pwsh -File deploy/pigeoncore/backup.ps1
#>
[CmdletBinding()]
param(
  [string] $SshHost = 'pigeoncore',
  [string] $DestDir = (Join-Path $env:USERPROFILE 't3-backups'),
  [int] $Keep = 14
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not (Test-Path $DestDir)) {
  New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
}

Write-Host 'Locating the newest archive on the host...' -ForegroundColor Cyan
$newest = (& ssh -o BatchMode=yes $SshHost 'ls -1t /opt/t3-backups/t3-home-*.tar.gz 2>/dev/null | head -1').Trim()
if ($LASTEXITCODE -ne 0) { throw "ssh failed with $LASTEXITCODE" }
if ([string]::IsNullOrWhiteSpace($newest)) {
  throw "No archive found in /opt/t3-backups on $SshHost. Is t3-backup.timer enabled?"
}

$name = Split-Path $newest -Leaf
$local = Join-Path $DestDir $name

# Idempotent: the same archive is already here, so there is nothing to do.
if (Test-Path $local) {
  $remote = (& ssh -o BatchMode=yes $SshHost "stat -c %s '$newest'").Trim()
  $here = (Get-Item $local).Length
  if ($remote -eq "$here") {
    Write-Host "Already have $name ($here bytes); nothing to pull." -ForegroundColor Green
    return
  }
  Write-Host "Local copy of $name is stale ($here vs $remote bytes); re-pulling." -ForegroundColor Yellow
}

Write-Host "Pulling $name" -ForegroundColor Cyan
& scp -o BatchMode=yes "${SshHost}:$newest" $local | Out-Null
if ($LASTEXITCODE -ne 0) { throw "scp failed with $LASTEXITCODE" }

# Verify the copy is a readable archive and that the remote sha256 matches, so a
# truncated transfer cannot masquerade as a backup.
$remoteSha = (& ssh -o BatchMode=yes $SshHost "sha256sum '$newest' | cut -d' ' -f1").Trim()
$localSha = (Get-FileHash -Algorithm SHA256 -Path $local).Hash.ToLower()
if ($remoteSha -ne $localSha) {
  Remove-Item $local -Force
  throw "sha256 mismatch for ${name}: remote $remoteSha, local $localSha. Discarded the copy."
}
Write-Host "  sha256 verified: $localSha" -ForegroundColor Green

# Prove the archive is readable rather than trusting the hash alone.
& tar -tzf $local > $null
if ($LASTEXITCODE -ne 0) { throw "$name is not a readable tar.gz" }

$size = [math]::Round((Get-Item $local).Length / 1KB, 1)
Write-Host "  $local ($size KB)" -ForegroundColor Green

# Prune old local copies.
$all = @(Get-ChildItem $DestDir -Filter 't3-home-*.tar.gz' | Sort-Object LastWriteTime -Descending)
if ($all.Count -gt $Keep) {
  $all[$Keep..($all.Count - 1)] | ForEach-Object {
    Remove-Item $_.FullName -Force
    Write-Host "  pruned $($_.Name)" -ForegroundColor DarkGray
  }
}

Write-Host "`nOff-host copies in ${DestDir}:" -ForegroundColor Cyan
Get-ChildItem $DestDir -Filter 't3-home-*.tar.gz' |
  Sort-Object LastWriteTime -Descending |
  Select-Object Name, @{n = 'KB'; e = { [math]::Round($_.Length / 1KB, 1) } }, LastWriteTime |
  Format-Table -AutoSize
