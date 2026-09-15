#!/bin/sh
# 容器启动脚本：准备可写目录 → 打印生效配置 → 交回给 CMD。
# 用 POSIX sh 写（Alpine 只有 busybox sh），不要用 bash 专有语法。
set -e

WORKSPACE="${WORKSPACE:-/workspace}"
SESSIONS_DIR="${SESSIONS_DIR:-/data/.sessions}"
PORT="${PORT:-5175}"

say() { printf '%s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }

say "mini-harness 容器启动"
# 运行时可能是 node 也可能是 bun，都报一下
if command -v node >/dev/null 2>&1; then
  say "  运行时      = node $(node -v)"
elif command -v bun >/dev/null 2>&1; then
  say "  运行时      = bun $(bun -v 2>/dev/null || echo '')"
else
  warn "镜像里既没有 node 也没有 bun"
  exit 1
fi
say "  代码        = /app"
say "  工作区      = ${WORKSPACE}"
say "  数据目录    = $(dirname "${SESSIONS_DIR}")"

# ---- 1. 数据目录必须可写（持久化挂载点）----
DATA_ROOT="$(dirname "${SESSIONS_DIR}")"
mkdir -p "${DATA_ROOT}" 2>/dev/null || true
if ! touch "${DATA_ROOT}/.write-test" 2>/dev/null; then
  warn "数据目录不可写：${DATA_ROOT}"
  warn "通常是把只读卷挂到了 /data，或者忘了以 node 用户运行"
  exit 1
fi
rm -f "${DATA_ROOT}/.write-test"
mkdir -p "${SESSIONS_DIR}" \
         "${TRASH_DIR:-${DATA_ROOT}/.sessions-trash}" \
         "${ARTIFACTS_DIR:-${DATA_ROOT}/.artifacts}" \
         "${MEMORY_DIR:-${DATA_ROOT}/.memory}"

# ---- 2. 工作区检查（最常见的坑是忘了挂载 / 挂了个空目录）----
if [ ! -d "${WORKSPACE}" ]; then
  warn "工作区不存在：${WORKSPACE}"
  exit 1
fi
if [ -z "$(ls -A "${WORKSPACE}" 2>/dev/null)" ]; then
  warn "工作区是空的：${WORKSPACE}"
  warn "记得挂载项目目录，例如 -v /path/to/project:/workspace"
fi
if ! touch "${WORKSPACE}/.write-test" 2>/dev/null; then
  warn "工作区不可写：${WORKSPACE}（agent 只能读，不能改文件）"
  warn "要允许写入，挂载时别加 :ro"
else
  rm -f "${WORKSPACE}/.write-test"
fi

# ---- 3. 可选自检 ----
if [ "${CONTAINER_SELFCHECK:-0}" = "1" ] && [ -f /app/scripts/container-check.js ]; then
  say ""
  node /app/scripts/container-check.js || warn "自检未通过（见上面的输出）"
  say ""
fi

say "  模型        = ${PROVIDER:-mock}${MODEL:+ / ${MODEL}}"
say "  审批策略    = ${APPROVAL_MODE:-ask}"
say "  沙箱        = ${SANDBOX_SCOPE:-workspace} / ${SANDBOX_BACKEND:-local}"
say ""
say "  打开界面    →  http://127.0.0.1:${PORT}"
say "  （容器里监听 0.0.0.0:${PORT}，宿主机用 -p ${PORT}:${PORT} 映射）"
say ""

# 把控制权交回 CMD（默认 node server.js）
exec "$@"
