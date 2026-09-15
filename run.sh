#!/bin/sh
# ============================================================
#  一条命令跑起来（Linux / macOS）：./run.sh [项目目录]
#
#  运行时优先级：
#    1. 项目自带的 runtime/bin/bun        ← 打包分发时带上，别人不用装任何东西
#    2. 系统里的 node                     ← 已经装了 Node 就用它，零下载
#    3. 系统里的 bun
#    4. 都没有 → 下载一次 Bun 到 runtime/（约 30MB，之后不再下载）
# ============================================================
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
BUN="$HERE/runtime/bin/bun"

# 第一个参数当工作区目录；不传就用当前目录
if [ -n "$1" ]; then
  WORKSPACE=$(cd "$1" && pwd)
else
  WORKSPACE=$(pwd)
fi
export WORKSPACE
echo "[workspace] $WORKSPACE"

# 会话/记忆/产物都放项目目录下（配置里是相对路径，所以要在项目根目录执行）
cd "$HERE"

if [ -x "$BUN" ]; then
  echo "[runtime] 用项目自带的 Bun"
  exec "$BUN" "$HERE/server.js"
fi

if command -v node >/dev/null 2>&1; then
  echo "[runtime] 项目里没有自带运行时，用系统 Node（零下载）"
  exec node "$HERE/server.js"
fi

if command -v bun >/dev/null 2>&1; then
  echo "[runtime] 用系统 Bun"
  exec bun "$HERE/server.js"
fi

echo "[runtime] 没找到可用运行时，下载 Bun 到项目里（约 30MB，只下一次）..."
if [ -f "$HERE/scripts/setup-runtime.sh" ]; then
  sh "$HERE/scripts/setup-runtime.sh" || {
    echo "[!] 自动安装失败，可手动下载 https://github.com/oven-sh/bun/releases/latest 的对应 zip，"
    echo "    把里面的 bun 放到 runtime/bin/bun"
    exit 1
  }
else
  echo "[!] 缺少 scripts/setup-runtime.sh"
  exit 1
fi

[ -x "$BUN" ] || { echo "[!] 安装后仍找不到 $BUN"; exit 1; }
echo "[runtime] 装好了，启动"
exec "$BUN" "$HERE/server.js"
