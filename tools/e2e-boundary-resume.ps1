# 边界准点自动恢复验证（Lead）：把"现在"设到 2026-10-12 11:59:50（高峰末尾），
# 跨越 12:00:00 这个空闲边界，观察被扣住的任务是否在边界那一刻被释放。
# 造 peak 与清 peak 必须在同一条命令内完成：闸门同样拦工具调用。
$ErrorActionPreference = 'Continue'
$base = 'http://127.0.0.1:19387'
function Post-Json([string]$path, [string]$body) { return curl.exe -s -X POST -H 'content-type: application/json' -d $body "$base$path" }
function Get-State { return curl.exe -s "$base/api/peak-hours/state" }
function Brief([string]$raw) {
  if ($raw -match '"mode":"([^"]+)".*?"phase":"([^"]+)".*?"nowText":"([^"]+)".*?"nextTransitionText":"([^"]+)".*?"paused":(true|false).*?"waitingTasks":(\d+)') {
    return "mode=$($Matches[1]) phase=$($Matches[2]) now=$($Matches[3]) next=$($Matches[4]) paused=$($Matches[5]) waitingTasks=$($Matches[6])"
  }
  return $raw
}

$offset = node -e "console.log(Date.UTC(2026,9,12,3,59,50)-Date.now())"
Write-Host "=== 基线（真实时间） ==="; Brief (Get-State)

Write-Host "`n=== 切 idle-only，并把现在设为 2026-10-12 11:59:50（高峰末尾，距空闲边界 10 秒） ==="
Post-Json '/api/peak-hours/mode' '{"mode":"idle-only"}' | Out-Null
Post-Json '/api/peak-hours/clock' "{`"offsetMs`":$offset,`"ttlMs`":180000}" | Out-Null
Get-State | ForEach-Object { Brief $_ }

Start-Sleep -Seconds 8
Write-Host "`n=== T1（模拟 11:59:58，边界前 2 秒）：期望 phase=peak, paused=true, waitingTasks>=1 ==="
Get-State | ForEach-Object { Brief $_ }

Start-Sleep -Seconds 5
Write-Host "`n=== T2（模拟 12:00:03，边界后 3 秒）：期望 phase=idle, paused=false, waitingTasks=0（准点释放） ==="
Get-State | ForEach-Object { Brief $_ }

Write-Host "`n=== 清覆盖 + 恢复 always ==="
Post-Json '/api/peak-hours/clock' '{"offsetMs":null}' | Out-Null
Post-Json '/api/peak-hours/mode' '{"mode":"always"}' | Out-Null
Get-State | ForEach-Object { Brief $_ }
Write-Host ''
