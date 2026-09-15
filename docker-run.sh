#!/bin/sh
# 一条命令跑起来（Linux / macOS）：
#   ./docker-run.sh                # 用当前目录当工作区
#   ./docker-run.sh ~/my-project   # 指定要干活的项目目录
# 然后打开 http://127.0.0.1:5175
set -e

IMAGE=mini-harness
HERE=$(cd "$(dirname "$0")" && pwd)
PROJECT="${1:-$PWD}"

if ! command -v docker >/dev/null 2>&1; then
  echo "[!] 没找到 docker 命令。装好 Docker 再试，或者直接用 Node 跑：node server.js"
  exit 1
fi

echo "[1/2] 构建镜像（本项目零依赖，构建很快，不用下载 npm 包）"
docker build -t "$IMAGE" "$HERE"

echo "[2/2] 启动：工作区 = $PROJECT"
echo "      界面   = http://127.0.0.1:5175   （Ctrl+C 停止）"
exec docker run --rm -it -p 5175:5175 -v "$PROJECT:/workspace" -v mini-harness-data:/data "$IMAGE"
