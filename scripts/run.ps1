# 一条命令跑起来（Windows）。run.cmd 会调用这个脚本。
#
# 运行时优先级：
#   1. 项目自带的 runtime\bin\bun.exe   ← 打包分发时带上，别人不用装任何东西
#   2. 系统里的 node                    ← 已经装了 Node 就用它，零下载
#   3. 系统里的 bun
#   4. 都没有 → 下载一次 Bun 到项目里（约 38MB，之后不再下载）
param(
  [string]$Workspace = ""
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $PSScriptRoot          # 项目根目录
$bun = Join-Path $here 'runtime\bin\bun.exe'
$server = Join-Path $here 'server.js'

# 工作区：参数 > 环境变量 > 当前目录
if (-not $Workspace) { $Workspace = if ($env:WORKSPACE) { $env:WORKSPACE } else { (Get-Location).Path } }
if (-not (Test-Path $Workspace)) {
  Write-Host "[!] 工作区不存在：$Workspace"
  exit 1
}
$env:WORKSPACE = (Resolve-Path $Workspace).Path
Write-Host "[workspace] $env:WORKSPACE"

# 会话/记忆/产物都放项目目录下（配置里是相对路径，所以要在这里执行）
Set-Location $here

function Start-Harness($exe, $label) {
  Write-Host "[runtime] $label"
  & $exe $server
  exit $LASTEXITCODE
}

if (Test-Path $bun) { Start-Harness $bun '用项目自带的 Bun' }

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) { Start-Harness $node.Source '项目里没有自带运行时，用系统 Node（零下载）' }

$sysBun = Get-Command bun -ErrorAction SilentlyContinue
if ($sysBun) { Start-Harness $sysBun.Source '用系统 Bun' }

Write-Host '[runtime] 没找到可用运行时，下载 Bun 到项目里（约 38MB，只下一次）...'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'setup-runtime.ps1')
if (-not (Test-Path $bun)) {
  Write-Host ''
  Write-Host '[!] 自动安装失败。可以手动来：'
  Write-Host '    1) 打开 https://github.com/oven-sh/bun/releases/latest'
  Write-Host '    2) 下载 bun-windows-x64.zip，解压出 bun.exe'
  Write-Host "    3) 放到 $bun"
  exit 1
}
Start-Harness $bun '装好了，启动'
