# 严格边界验证（Lead）：窗口只有 5 秒，配合高频金丝雀任务（每步 1 秒），
# 目的：在边界前采到 waitingTasks>=1，在边界后立刻采到 waitingTasks=0（准点释放）。
# 全程在一条命令内完成，避免 Lead 自己的下一步被闸门扣住。
$ErrorActionPreference = 'Continue'
$base = 'http://127.0.0.1:19387'
function Post-Json([string]$path, [string]$body) { return curl.exe -s -X POST -H 'content-type: application/json' -d $body "$base$path" }
function Brief([string]$raw) {
  if ($raw -match '"mode":"([^"]+)".*?"phase":"([^"]+)".*?"nowText":"([^"]+)".*?"nextTransitionText":"([^"]+)".*?"paused":(true|false).*?"waitingTasks":(\d+)') {
    return "phase=$($Matches[2]) now=$($Matches[3]) next=$($Matches[4]) paused=$($Matches[5]) waitingTasks=$($Matches[6])"
  }
  return $raw
}

# 模拟 2026-10-12 11:59:55（距空闲边界 5 秒）
$offset = node -e "console.log(Date.UTC(2026,9,12,3,59,55)-Date.now())"
Post-Json '/api/peak-hours/mode' '{"mode":"idle-only"}' | Out-Null
Post-Json '/api/peak-hours/clock' "{`"offsetMs`":$offset,`"ttlMs`":120000}" | Out-Null

Start-Sleep -Seconds 3
Write-Host "T1 (模拟 11:59:58，高峰内)：$((Get-Date -Format 'HH:mm:ss'))  $(Brief (curl.exe -s "$base/api/peak-hours/state"))"
Start-Sleep -Seconds 2
Write-Host "T2 (模拟 12:00:00，边界瞬间)：$((Get-Date -Format 'HH:mm:ss'))  $(Brief (curl.exe -s "$base/api/peak-hours/state"))"
Start-Sleep -Seconds 2
Write-Host "T3 (模拟 12:00:02，边界后)：$((Get-Date -Format 'HH:mm:ss'))  $(Brief (curl.exe -s "$base/api/peak-hours/state"))"
Start-Sleep -Seconds 3
Write-Host "T4 (模拟 12:00:05，空闲内)：$((Get-Date -Format 'HH:mm:ss'))  $(Brief (curl.exe -s "$base/api/peak-hours/state"))"

Post-Json '/api/peak-hours/clock' '{"offsetMs":null}' | Out-Null
Post-Json '/api/peak-hours/mode' '{"mode":"always"}' | Out-Null
Write-Host "收尾：$(Brief (curl.exe -s "$base/api/peak-hours/state"))"
Write-Host ''
