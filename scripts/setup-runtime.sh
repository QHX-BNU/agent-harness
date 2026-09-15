#!/bin/sh
# 下载 Bun 到项目里（Linux / macOS）。由 run.sh 在「没有 node 也没有 bun」时调用。
# 只用系统自带工具：curl/wget + unzip + sha256sum/shasum
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
BIN_DIR="$ROOT/runtime/bin"
BIN_PATH="$BIN_DIR/bun"

# ---- 平台识别 ----
OS=$(uname -s)
MACHINE=$(uname -m)
case "$OS" in
  Linux)  OSNAME=linux ;;
  Darwin) OSNAME=darwin ;;
  *) echo "  不认识的系统：$OS"; exit 1 ;;
esac
case "$MACHINE" in
  x86_64|amd64) ARCH=x64 ;;
  arm64|aarch64) ARCH=aarch64 ;;
  *) echo "  不认识的架构：$MACHINE"; exit 1 ;;
esac
# Linux 上优先用 glibc 版；musl 系统（Alpine）用 musl 版
SUFFIX=""
if [ "$OSNAME" = "linux" ] && [ -f /etc/alpine-release ]; then SUFFIX="-musl"; fi
ASSET="bun-$OSNAME-$ARCH$SUFFIX.zip"
TAG="${BUN_VERSION:-latest}"
if [ "$TAG" = "latest" ]; then
  BASE="https://github.com/oven-sh/bun/releases/latest/download"
else
  BASE="https://github.com/oven-sh/bun/releases/download/$TAG"
fi

echo "  平台 $OSNAME-$ARCH → $ASSET"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    echo "  需要 curl 或 wget"; exit 1
  fi
}

echo "  下载中…"
fetch "$BASE/$ASSET" "$TMP/$ASSET"
SIZE=$(wc -c < "$TMP/$ASSET" | tr -d ' ')
echo "  已下载 $(awk "BEGIN{printf \"%.1f\", $SIZE/1048576}") MB，校验 SHA256…"

if fetch "$BASE/SHASUMS256.txt" "$TMP/SHASUMS256.txt" 2>/dev/null; then
  WANT=$(grep " $ASSET\$" "$TMP/SHASUMS256.txt" | head -1 | awk '{print $1}')
  if [ -n "$WANT" ]; then
    if command -v sha256sum >/dev/null 2>&1; then
      GOT=$(sha256sum "$TMP/$ASSET" | awk '{print $1}')
    else
      GOT=$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')
    fi
    if [ "$WANT" != "$GOT" ]; then echo "  SHA256 不匹配！"; exit 1; fi
    echo "  ✓ SHA256 校验通过"
  fi
else
  echo "  ! 拿不到 SHASUMS256.txt，跳过校验"
fi

echo "  解压…"
if command -v unzip >/dev/null 2>&1; then
  unzip -q -o "$TMP/$ASSET" -d "$TMP/x"
else
  echo "  需要 unzip"; exit 1
fi
SRC=$(find "$TMP/x" -type f -name bun | head -1)
[ -n "$SRC" ] || { echo "  解压后没找到 bun"; exit 1; }

mkdir -p "$BIN_DIR"
cp "$SRC" "$BIN_PATH"
chmod +x "$BIN_PATH"

VER=$("$BIN_PATH" --version 2>/dev/null || echo '?')
printf 'bun %s\nfrom %s/%s\n' "$VER" "$BASE" "$ASSET" > "$ROOT/runtime/VERSION"
echo "  ✓ 装好了：runtime/bin/bun（bun $VER）"
