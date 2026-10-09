# Verifier-owned: independent (non-gov.cn) mirrors of the holiday notices.
# Writes only under verify/raw/. Run from project root: pwsh -File verify/fetch-mirrors.ps1
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$root = Join-Path $PSScriptRoot 'raw'
New-Item -ItemType Directory -Force -Path $root | Out-Null

$sources = @(
  @{ id = 'm2025-people';    url = 'https://cpc.people.com.cn/GB/n1/2024/1113/c64387-40360003.html' },
  @{ id = 'm2026-gmw-a';     url = 'https://m.gmw.cn/2025-11/04/content_1304211422.htm' },
  @{ id = 'm2026-gmw-b';     url = 'https://m.gmw.cn/2025-11/04/content_1304211593.htm' },
  @{ id = 'm2026-oct-remind'; url = 'https://kan.china.com/article/5665726.html' },
  @{ id = 'm2027-probe';     url = 'https://www.gslnwd.gov.cn/zfxxgk/public/32128876/147953942.html' }
)

foreach ($s in $sources) {
  $out = Join-Path $root ($s.id + '.html')
  $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ssK')
  $res = curl.exe -sS -L --compressed --max-time 45 -A 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' -o $out -w 'HTTP=%{http_code} SIZE=%{size_download} IP=%{remote_ip}' $s.url 2>&1
  $len = if (Test-Path $out) { (Get-Item $out).Length } else { 0 }
  Write-Host ("[{0}] {1}`n  URL={2}`n  {3} FILE_BYTES={4}" -f $stamp, $s.id, $s.url, $res, $len)
}
