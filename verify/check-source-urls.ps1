# Verifier-owned: confirm every HOLIDAY_SOURCE / HOLIDAY_SOURCE_DETAIL URL cited by core-dev
# actually resolves and carries the expected notice text. Network-dependent: run manually, the
# node:test suite never depends on it.  pwsh -File verify/check-source-urls.ps1
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$root = Join-Path $PSScriptRoot 'raw\cited'
New-Item -ItemType Directory -Force -Path $root | Out-Null

$urls = [ordered]@{
  'official-2025' = 'https://www.gov.cn/zhengce/zhengceku/202411/content_6986383.htm'
  'official-2026' = 'https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm'
  'xcheck-2025-xinhua' = 'http://www.news.cn/20241112/87875d15b31442709def6d1cca169ab3/c.html'
  'xcheck-2025-people' = 'https://cpc.people.com.cn/GB/n1/2024/1113/c64387-40360003.html'
  'xcheck-2025-gmw' = 'https://m.gmw.cn/2024-11/12/content_1303894988.htm'
  'xcheck-2026-people' = 'http://politics.people.com.cn/n1/2025/1105/c1001-40596810.html'
  'xcheck-2026-gmw' = 'https://m.gmw.cn/2025-11/04/content_1304211342.htm'
}

foreach ($k in $urls.Keys) {
  $out = Join-Path $root ($k + '.html')
  $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ssK')
  $res = curl.exe -sS -L --compressed --max-time 45 -A 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' -o $out -w 'HTTP=%{http_code} SIZE=%{size_download}' $urls[$k] 2>&1
  $text = ''
  if (Test-Path $out) {
    $raw = [System.IO.File]::ReadAllBytes($out)
    $html = [System.Text.Encoding]::UTF8.GetString($raw)
    $text = ($html -replace '<script[\s\S]*?</script>', ' ' -replace '<[^>]+>', ' ' -replace '\s+', ' ')
  }
  $hit = @()
  foreach ($anchor in @('部分节假日安排的通知', '国庆节', '春节', '放假')) {
    if ($text -like "*$anchor*") { $hit += $anchor }
  }
  Write-Host ("[{0}] {1}`n  URL={2}`n  {3}`n  anchors_found={4}" -f $stamp, $k, $urls[$k], $res, ($hit -join ','))
}
