# 一条命令跑起来（Windows）。run.cmd 会调用这个脚本。
#
# 运行时优先级：
#   1. 项目自带的 runtime\bin\bun.exe   ← 打包分发时带上，别人不用装任何东西
#   2. 系统里的 node                    ← 已经装了 Node 就用它，零下载
#   3. 系统里的 bun
#   4. 都没有 → 下载一次 Bun 到项目里（约 38MB，之后不再下载）
#
# --jail：改用真沙箱启动（Node 权限模型），agent 的文件操作被运行时关在工作区内，
#         代价是 shell 工具被禁用；加 --allow-shell 可以保留 shell，但隔离会降级。
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Args
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $PSScriptRoot          # 项目根目录
$bun = Join-Path $here 'runtime\bin\bun.exe'
$server = Join-Path $here 'server.js'

# 解析参数：--jail / --allow-shell / 工作区路径
$useJail = $false
$allowShell = $false
$Workspace = ''
foreach ($a in @($Args)) {
  if ($a -eq '--jail') { $useJail = $true; continue }
  if ($a -eq '--allow-shell') { $allowShell = $true; continue }
  if ($a.StartsWith('-')) { continue }
  if (-not $Workspace) { $Workspace = $a }
}

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

# ---- 真沙箱模式：交给 jail 启动器（它负责算权限模型的白名单）----
# 必须用 Node 启动：权限模型是 Node 的能力，Bun 不支持（拿 Bun 启动等于假装开了沙箱）
if ($useJail) {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) {
    Write-Host '[!] 真沙箱需要 Node（Node 的 --permission 权限模型），当前机器上没有找到。'
    Write-Host '    装一个 Node（≥20，https://nodejs.org）后再跑 run.cmd --jail；'
    Write-Host '    或者按普通模式启动，并在设置里把「执行后端」换成 Docker / WSL。'
    exit 1
  }
  $jail = Join-Path $PSScriptRoot 'jail.js'
  $jailArgs = @($jail, '--workspace', $env:WORKSPACE)
  if ($allowShell) { $jailArgs += '--allow-shell' }
  Write-Host "[runtime] 真沙箱模式（Node 权限模型）· $($nodeCmd.Source)"
  & $nodeCmd.Source @jailArgs
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
