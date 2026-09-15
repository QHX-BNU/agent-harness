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

# 参数：--jail（真沙箱）/ --allow-shell（jail 但保留 shell）/ 工作区路径
USE_JAIL=0
ALLOW_SHELL=0
WORKSPACE_ARG=""
for a in "$@"; do
  case "$a" in
    --jail) USE_JAIL=1 ;;
    --allow-shell) ALLOW_SHELL=1 ;;
    -*) ;;
    *) [ -z "$WORKSPACE_ARG" ] && WORKSPACE_ARG="$a" ;;
  esac
done

# 第一个参数当工作区目录；不传就用当前目录
if [ -n "$WORKSPACE_ARG" ]; then
  WORKSPACE=$(cd "$WORKSPACE_ARG" && pwd)
else
  WORKSPACE=$(pwd)
fi
export WORKSPACE
echo "[workspace] $WORKSPACE"

# 会话/记忆/产物都放项目目录下（配置里是相对路径，所以要在项目根目录执行）
cd "$HERE"

# ---- 真沙箱模式 ----
# 必须用 Node 启动：权限模型是 Node 的能力，Bun 不支持（用它等于假装开了沙箱）
if [ "$USE_JAIL" = "1" ]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "[!] 真沙箱需要 Node（Node 的 --permission 权限模型），当前机器上没有找到。"
    echo "    装一个 Node（>=20）后再跑 ./run.sh --jail；"
    echo "    或者按普通模式启动，并在设置里把「执行后端」换成 Docker / WSL。"
    exit 1
  fi
  echo "[runtime] 真沙箱模式（Node 权限模型）· $(command -v node)"
  set -- "$HERE/scripts/jail.js" --workspace "$WORKSPACE"
  [ "$ALLOW_SHELL" = "1" ] && set -- "$@" --allow-shell
  exec node "$@"
fi

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
