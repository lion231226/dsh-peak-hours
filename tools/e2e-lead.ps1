# Lead 端到端验证：真实运行时里"进入高峰自动暂停 / 回到空闲自动恢复"。
# 关键设计：造 peak 与清 peak 必须在同一条命令内完成——闸门也拦工具调用，
# 分成两次工具调用会把 Lead 自己的下一步扣在高峰里。
$ErrorActionPreference = 'Continue'
$base = 'http://127.0.0.1:19387'

function Get-State {
  $raw = curl.exe -s "$base/api/peak-hours/state"
  return $raw
}
function Post-Json([string]$path, [string]$body) {
  return curl.exe -s -X POST -H 'content-type: application/json' -d $body "$base$path"
}

Write-Host '=== 1) 基线状态 ==='
Get-State

Write-Host "`n=== 2) 切 idle-only ==="
Post-Json '/api/peak-hours/mode' '{"mode":"idle-only"}'

# 下一个真实高峰：2026-10-12（周一）09:10 北京 = UTC 01:10
$offset = node -e "console.log(Date.UTC(2026,9,12,1,10,0)-Date.now())"
Write-Host "`n=== 3) 造 peak：offsetMs=$offset (=$([DateTimeOffset]::FromUnixTimeMilliseconds([long]$offset + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).ToString('u'))) ttlMs=90000 ==="
Post-Json '/api/peak-hours/clock' "{`"offsetMs`":$offset,`"ttlMs`":90000}"

Start-Sleep -Seconds 4
Write-Host "`n=== 4) peak 中：期望 paused=true，waitingTasks>=1（后台 canary 任务被扣住） ==="
Get-State

Start-Sleep -Seconds 6
Write-Host "`n=== 5) 6 秒后再看（仍在扣住，证明是持续持有而不是瞬时延迟） ==="
Get-State

Write-Host "`n=== 6) 清除时间覆盖（模拟回到空闲时段） ==="
Post-Json '/api/peak-hours/clock' '{"offsetMs":null}'

Start-Sleep -Seconds 5
Write-Host "`n=== 7) 清除后：期望 paused=false 且 waitingTasks 回到 0（任务已自动继续） ==="
Get-State

Write-Host "`n=== 8) 恢复默认 always 模式 ==="
Post-Json '/api/peak-hours/mode' '{"mode":"always"}'
Get-State
Write-Host ''
