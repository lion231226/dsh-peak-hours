# Verifier-owned: download official holiday notices for cross-checking.
# Writes only under verify/raw/. Run from project root:  pwsh -File verify/fetch-sources.ps1
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$root = Join-Path $PSScriptRoot 'raw'
New-Item -ItemType Directory -Force -Path $root | Out-Null

$sources = @(
  @{ id = '2026-gov-zhengce';   url = 'https://www.gov.cn/zhengce/content/202511/content_7047090.htm' },
  @{ id = '2026-gov-gongbao';   url = 'https://www.gov.cn/gongbao/2025/issue_12406/202511/content_7048922.html' },
  @{ id = '2026-gov-zhengceku'; url = 'https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm' },
  @{ id = '2025-gov-gongbao';   url = 'https://www.gov.cn/gongbao/2024/issue_11726/202411/content_6989767.html' },
  @{ id = '2025-gov-zhengceku'; url = 'https://www.gov.cn/zhengce/zhengceku/202411/content_6989768.htm' },
  @{ id = '2024-gov-gongbao';   url = 'https://www.gov.cn/gongbao/2023/issue_10882/202311/content_6913956.html' }
)

foreach ($s in $sources) {
  $out = Join-Path $root ($s.id + '.html')
  $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ssK')
  $res = curl.exe -sS -L --compressed --max-time 45 -A 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' -o $out -w 'HTTP=%{http_code} SIZE=%{size_download} IP=%{remote_ip}' $s.url 2>&1
  $len = if (Test-Path $out) { (Get-Item $out).Length } else { 0 }
  Write-Host ("[{0}] {1}`n  URL={2}`n  {3} FILE_BYTES={4}" -f $stamp, $s.id, $s.url, $res, $len)
}
