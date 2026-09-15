# 下载 Bun 到项目里（Windows）。由 run.cmd 在「没有 node 也没有 bun」时调用。
# 只用 Windows 自带的 PowerShell，不需要任何额外安装。
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # 关掉进度条，PS5.1 下快很多

$root = Split-Path -Parent $PSScriptRoot          # 项目根目录
$binDir = Join-Path $root 'runtime\bin'
$binPath = Join-Path $binDir 'bun.exe'

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'aarch64' } else { 'x64' }
$asset = "bun-windows-$arch.zip"
$tag = if ($env:BUN_VERSION) { $env:BUN_VERSION } else { 'latest' }
$base = if ($tag -eq 'latest') {
  'https://github.com/oven-sh/bun/releases/latest/download'
} else {
  "https://github.com/oven-sh/bun/releases/download/$tag"
}

Write-Host "  平台 $arch → $asset"
$tmp = Join-Path $env:TEMP ("bun-setup-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
  $zip = Join-Path $tmp $asset
  Write-Host "  下载中…"
  Invoke-WebRequest -Uri "$base/$asset" -OutFile $zip -UseBasicParsing
  Write-Host "  已下载 $([math]::Round((Get-Item $zip).Length / 1MB, 1)) MB，校验 SHA256…"

  try {
    $sumsPath = Join-Path $tmp 'SHASUMS256.txt'
    Invoke-WebRequest -Uri "$base/SHASUMS256.txt" -OutFile $sumsPath -UseBasicParsing
    $line = Get-Content $sumsPath | Where-Object { $_ -match [regex]::Escape($asset) } | Select-Object -First 1
    if ($line) {
      $want = ($line -split '\s+')[0]
      $got = (Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLower()
      if ($want -ne $got) { throw "SHA256 不匹配（期望 $($want.Substring(0,16))…，实际 $($got.Substring(0,16))…）" }
      Write-Host "  ✓ SHA256 校验通过"
    } else {
      Write-Host "  ! 校验文件里没有 $asset，跳过"
    }
  } catch {
    if ($_.Exception.Message -like '*SHA256 不匹配*') { throw }
    Write-Host "  ! 校验环节出错（$($_.Exception.Message)），继续"
  }

  Write-Host "  解压…"
  $x = Join-Path $tmp 'x'
  Expand-Archive -LiteralPath $zip -DestinationPath $x -Force
  $found = Get-ChildItem -Path $x -Recurse -Filter 'bun.exe' | Select-Object -First 1
  if (-not $found) { throw "解压后没找到 bun.exe" }

  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  Copy-Item $found.FullName $binPath -Force

  $ver = & $binPath --version
  Set-Content -Path (Join-Path $root 'runtime\VERSION') -Value "bun $ver`nfrom $base/$asset" -Encoding UTF8
  Write-Host "  ✓ 装好了：runtime\bin\bun.exe（bun $ver）"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
