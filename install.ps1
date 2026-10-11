# dsh-peak-hours installer / uninstaller for a running DSH desktop profile.
#
# Usage (from the project root, any PowerShell):
#   powershell -ExecutionPolicy Bypass -File .\install.ps1                 # install into profile "desktop"
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile web    # another profile
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall      # remove again
#
# The running DSH Loader reconciles a changed profile patch file within a few
# seconds, so neither direction needs an app restart. The desktop app owns the
# live session; restarting it would kill that session, so this script never does.
#
# Two lessons this script encodes, both learned the hard way on 2026-10-09:
#  * A malformed patch file stops the Loader from reconciling the whole profile,
#    so the YAML is validated with js-yaml BEFORE it is written.
#  * A Loader entry whose fiber already FAILED is never retried, and Node's ESM
#    cache keeps the old module for the process lifetime. Re-activation therefore
#    drops the old row and inserts a row with a FRESH id (a new row id is a new
#    entry, which re-resolves and re-imports the module).
[CmdletBinding()]
param(
  [string]$Profile = $(if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'desktop' }),
  [string]$PackageName = 'dsh-peak-hours',
  [switch]$Uninstall,
  [int]$WaitSeconds = 25
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$profileDir = Join-Path $dshHome "profiles\$Profile"
$patchFile = Join-Path $profileDir 'cordis.patch.yml'
$targetDir = Join-Path $profileDir "node_modules\$PackageName"
$healthUrl = 'http://127.0.0.1:19387/api/peak-hours/health'

# Directories left behind by earlier diagnostic activations; always removed so a
# stale copy can never be the module a row resolves to.
$staleDirs = @('dsh-peak-hours-live', 'dsh-peak-hours-2', 'dsh-peak-hours-3', 'dsh-probe-a', 'dsh-probe-b', 'dsh-probe-c', 'dsh-probe-d', 'dsh-probe-live')

$beginMarker = "# >>> $PackageName (managed block; do not edit by hand) >>>"
$endMarker = "# <<< $PackageName (managed block) <<<"

function New-Block([string]$rowId) {
  return @(
    $beginMarker,
    '- insert:',
    "    - id: $rowId",
    "      name: '$PackageName'",
    $endMarker
  ) -join "`n"
}

function Write-Utf8([string]$path, [string]$text) {
  [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

function Read-Patch {
  if (-not (Test-Path $patchFile)) { throw "profile patch not found: $patchFile" }
  return [System.IO.File]::ReadAllText($patchFile)
}

function Remove-Block([string]$text) {
  $pattern = "(?ms)^\s*" + [regex]::Escape($beginMarker) + ".*?" + [regex]::Escape($endMarker) + "\s*\r?\n?"
  return [regex]::Replace($text, $pattern, '')
}

function Assert-Yaml([string]$text) {
  # A malformed patch file is worse than no install: the Loader stops reconciling
  # the entire profile, and no later edit is picked up until a restart.
  $jsYaml = Join-Path $profileDir 'node_modules\js-yaml'
  if (-not (Test-Path $jsYaml)) { Write-Host "  (js-yaml not found; skipping the YAML guard)"; return $true }
  $tmp = Join-Path $env:TEMP "peak-hours-patch-check-$([guid]::NewGuid().ToString('N')).yml"
  Write-Utf8 $tmp $text
  $script = "const yaml=require(process.argv[1]);const fs=require('fs');try{yaml.load(fs.readFileSync(process.argv[2],'utf8'));console.log('OK')}catch(e){console.log('BAD '+e.message)}"
  $result = & node -e $script $jsYaml $tmp 2>&1
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  if ("$result".Trim() -eq 'OK') { return $true }
  throw "refusing to write an invalid cordis.patch.yml: $result"
}

function Save-Patch([string]$text) {
  Assert-Yaml $text | Out-Null
  Copy-Item $patchFile "$patchFile.bak-peakhours-$(Get-Date -Format yyyyMMddHHmmss)" -Force
  Write-Utf8 $patchFile $text
}

function Has-Row([string]$text) {
  return $text -match [regex]::Escape("name: '$PackageName'")
}

function Health {
  $code = & curl.exe -s -o NUL -w '%{http_code}' $healthUrl 2>$null
  return "$code".Trim() -eq '200'
}

function Wait-Health {
  param([switch]$ExpectUp)
  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  while ((Get-Date) -lt $deadline) {
    $up = Health
    if ($ExpectUp -and $up) { return $true }
    if (-not $ExpectUp -and -not $up) { return $true }
    Start-Sleep -Milliseconds 1000
  }
  return $false
}

function Remove-Stale {
  foreach ($name in $staleDirs) {
    $dir = Join-Path $profileDir "node_modules\$name"
    if (Test-Path $dir) { Remove-Item $dir -Recurse -Force; Write-Host "  removed stale directory $name" }
  }
}

# Bundle guard: the normal install path is `dsh plugin add`, which registers the
# package in `dsh.profile.bundles`, and the bundle layer then contributes the
# patch row from the package's own cordis.patch.yml. This script writes that row
# by hand instead. Running it against a profile that already has the bundle would
# leave two entries with the same id, and nothing downstream de-duplicates them —
# the patch applier pushes inserted rows as-is and the cordis Loader has no
# duplicate check — so refuse instead of creating a boot hazard.
$profileManifest = Join-Path $profileDir 'package.json'
if (Test-Path $profileManifest) {
  $manifest = Get-Content $profileManifest -Raw | ConvertFrom-Json
  if (@($manifest.dsh.profile.bundles) -contains $PackageName) {
    Write-Host "[$PackageName] is already registered as a profile bundle in '$Profile'."
    Write-Host "  Manage it with:  dsh plugin --profile $Profile remove $PackageName"
    Write-Host "  This script is only for profiles without the bundle mechanism: a hand-written"
    Write-Host "  row next to the bundle's own row would duplicate the entry."
    exit 0
  }
}

if ($Uninstall) {
  Save-Patch (Remove-Block (Read-Patch))
  if (Test-Path $targetDir) { Remove-Item $targetDir -Recurse -Force }
  Remove-Stale
  Write-Host "[$PackageName] removed from profile '$Profile' (patch row + package directories)."
  if (Wait-Health -ExpectUp:$false) { Write-Host "[$PackageName] route is gone." }
  else { Write-Host "[$PackageName] WARNING: route still answers; the Loader may need a moment or a manual reload." }
  return
}

if (-not (Test-Path $patchFile)) { throw "profile patch not found: $patchFile (is profile '$Profile' the right one?)" }

# 1. Copy the package (implementation + manifests; tests and verify stay in the project).
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
foreach ($item in @('lib', 'package.json', 'cordis.patch.yml', 'README.md', 'SPEC.md')) {
  $src = Join-Path $projectRoot $item
  if (-not (Test-Path $src)) { continue }
  $dst = Join-Path $targetDir $item
  if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
  Copy-Item $src $dst -Recurse -Force
}
Get-ChildItem (Join-Path $targetDir 'lib\host') -Filter '*.pre-instrument' -ErrorAction SilentlyContinue | Remove-Item -Force
Remove-Item (Join-Path $targetDir 'lib\host\entry.js') -Force -ErrorAction SilentlyContinue
Remove-Stale

# 2. Phase one: one managed insert row, canonical id.
$rowId = 'peak-hours'
$text = Remove-Block (Read-Patch)
Save-Patch ($text.TrimEnd() + "`n`n" + (New-Block $rowId) + "`n")
Write-Host "[$PackageName] patch row '$rowId' inserted."

if (Wait-Health -ExpectUp) {
  Write-Host "[$PackageName] installed and live: GET /api/peak-hours/health -> 200"
  & curl.exe -s $healthUrl; Write-Host ''
  return
}

# 3. Phase two: the entry did not come up (first install, or a previously failed
#    fiber that the Loader will not retry). Drop the row, let the entry leave the
#    tree, then insert a row with a FRESH id so a new entry is created and the
#    module is re-resolved and re-imported.
Write-Host "[$PackageName] no answer yet; re-activating with a fresh row id."
Save-Patch (Remove-Block (Read-Patch))
Wait-Health -ExpectUp:$false | Out-Null
$freshId = "peak-hours-$((Get-Date).ToString('yyMMddHHmmss'))"
$text = Remove-Block (Read-Patch)
Save-Patch ($text.TrimEnd() + "`n`n" + (New-Block $freshId) + "`n")
Write-Host "[$PackageName] patch row '$freshId' inserted."

if (Wait-Health -ExpectUp) {
  Write-Host "[$PackageName] installed and live after re-activation: GET /api/peak-hours/health -> 200"
  & curl.exe -s $healthUrl; Write-Host ''
} else {
  Write-Host "[$PackageName] FAILED: the entry did not answer within ${WaitSeconds}s."
  Write-Host "  Check (a) plugin_manager list_plugins -> include:<row id> fiberPhase"
  Write-Host "        (b) the Loader diagnostic for that row"
  Write-Host "        (c) that the patch file still parses (this script's YAML guard did not trip)"
  exit 1
}
