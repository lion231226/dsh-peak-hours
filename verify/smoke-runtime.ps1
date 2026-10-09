# verify/smoke-runtime.ps1 — minimal post-restart acceptance smoke for dsh-peak-hours.
#
# Deliberately short and copy-pasteable: health -> simulate peak -> observe paused/waitingTasks ->
# clear the override -> restore always. Every step prints its raw response. The override is cleared
# in a `finally`, so a failure can never leave the machine simulating a peak window.
#
#   pwsh -NoProfile -File verify/smoke-runtime.ps1
#
# Full contract verification is `node verify/e2e-runtime.mjs`; this is the 30-second sanity check.
$ErrorActionPreference = 'Stop'
$base = if ($env:PEAK_HOURS_BASE) { $env:PEAK_HOURS_BASE } else { 'http://127.0.0.1:19387' }
$stamp = { (Get-Date).ToString('HH:mm:ss') }

function Show($label, $json) { Write-Host "[$(& $stamp)] $label`n$json`n" }

# POST a JSON body built by PowerShell. `--data-raw` + a separate argument avoids the quoting
# mangling that breaks inline `-d "{\"k\":$v}"` bodies in PowerShell (curl exit 3).
function Post-Json($path, $obj) {
  $body = $obj | ConvertTo-Json -Compress
  return curl.exe -sS -m 8 -X POST -H 'content-type: application/json' --data-raw $body "$base$path"
}

try {
  # 1. health ------------------------------------------------------------------------------
  Write-Host "=== 1. health ($base) ==="
  $health = curl.exe -sS -m 8 "$base/api/peak-hours/health"
  Write-Host $health
  if ($health -match 'unauthorized' -or $LASTEXITCODE -ne 0) {
    Write-Host "`nABORT: the plugin is not mounted (401 = unregistered-route fallback)."
    Write-Host "Check: plugin_manager list_plugins -> entryId 'include:peak-hours', fiberPhase must be 'active'."
    exit 3
  }

  # 2. simulate a peak window --------------------------------------------------------------
  # Land 10 minutes inside the next real peak window (Beijing) using the verifier's independent
  # oracle, then arm the override with a 2-minute TTL as a safety net.
  $target = & node --input-type=module -e "const m = await import('./verify/lib/oracle.mjs'); const n = Date.now(); for (let t = n; t < n + 14*86400000; t += 60000) { if (m.classifyOracle(t).phase === 'peak') { console.log(t + 600000); break } }"
  $offset = [int64]$target - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  Write-Host "=== 2. POST /clock { offsetMs = $offset, ttlMs = 120000 }  (simulating a peak window) ==="
  $armed = Post-Json '/api/peak-hours/clock' @{ offsetMs = $offset; ttlMs = 120000 }
  Show 'clock ->' $armed
  $nowText = ($armed | ConvertFrom-Json).state.nowText

  Write-Host '=== 3. POST /mode { mode = "idle-only" } ==='
  $mode = Post-Json '/api/peak-hours/mode' @{ mode = 'idle-only' }
  Show 'mode ->' $mode

  # 4. observe: paused must be true inside a peak window in idle-only mode -------------------
  $state = (curl.exe -sS -m 8 "$base/api/peak-hours/state" | ConvertFrom-Json).state
  Write-Host '=== 4. GET /state (expect phase=peak, paused=True) ==='
  Write-Host ("  mode={0} phase={1} reason={2} paused={3} waitingTasks={4} nowText={5} nextTransitionText={6}" -f `
    $state.mode, $state.phase, $state.reason, $state.paused, $state.waitingTasks, $state.nowText, $state.nextTransitionText)
  if ($state.paused -ne $true) { Write-Host '  !! expected paused=True'; $script:bad = $true }

  # 5. clear the override and restore the default mode --------------------------------------
  Write-Host '=== 5. POST /clock { offsetMs = null } then POST /mode { mode = "always" } ==='
  $cleared = Post-Json '/api/peak-hours/clock' @{ offsetMs = $null }
  $restored = Post-Json '/api/peak-hours/mode' @{ mode = 'always' }
  $final = ($restored | ConvertFrom-Json).state
  Write-Host ("  clockOverride={0} mode={1} paused={2} nowText={3}" -f `
    ($(if ($null -eq $final.clockOverride) { 'null' } else { $final.clockOverride.offsetMs })), $final.mode, $final.paused, $final.nowText)
  if ($null -ne $final.clockOverride) { Write-Host '  !! override did not clear'; $script:bad = $true }
  if ($final.mode -ne 'always') { Write-Host '  !! mode did not restore to always'; $script:bad = $true }

  Write-Host ''
  if ($script:bad) { Write-Host 'SMOKE RESULT: 失败'; exit 1 }
  Write-Host "SMOKE RESULT: 已验证 (peak simulated at $nowText, paused=true, override cleared, mode always)"
  exit 0
} finally {
  # never leave a simulated peak behind, even on an exception or Ctrl-C
  try { Post-Json '/api/peak-hours/clock' @{ offsetMs = $null } | Out-Null } catch {}
  try { Post-Json '/api/peak-hours/mode' @{ mode = 'always' } | Out-Null } catch {}
}
