#!/bin/sh
# Prepare writable mounts, report the effective boundary, then hand PID 1 to Bun.
set -eu

WORKSPACE="${WORKSPACE:-/workspace}"
SESSIONS_DIR="${SESSIONS_DIR:-/data/.sessions}"
TRASH_DIR="${TRASH_DIR:-/data/.sessions-trash}"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-/data/.artifacts}"
MEMORY_DIR="${MEMORY_DIR:-/data/.memory}"
PORT="${PORT:-5175}"

say() { printf '%s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }

say "mini-harness Bun container"
say "  runtime      = bun $(bun --version)"
say "  uid:gid      = $(id -u):$(id -g)"
say "  code         = /app (read-only at runtime)"
say "  workspace    = ${WORKSPACE}"
say "  data         = $(dirname "${SESSIONS_DIR}")"

if [ "$(id -u)" = "0" ]; then
  warn "container is running as root; use the image default user"
  exit 1
fi

for dir in "${SESSIONS_DIR}" "${TRASH_DIR}" "${ARTIFACTS_DIR}" "${MEMORY_DIR}" /tmp/home /tmp/cache /tmp/bun-cache; do
  mkdir -p "${dir}"
done

DATA_ROOT="$(dirname "${SESSIONS_DIR}")"
if ! touch "${DATA_ROOT}/.write-test" 2>/dev/null; then
  warn "data mount is not writable: ${DATA_ROOT}"
  exit 1
fi
rm -f "${DATA_ROOT}/.write-test"

if [ ! -d "${WORKSPACE}" ]; then
  warn "workspace does not exist: ${WORKSPACE}"
  exit 1
fi
if [ -z "$(ls -A "${WORKSPACE}" 2>/dev/null)" ]; then
  warn "workspace is empty; mount the project you want the agent to edit"
fi
if ! touch "${WORKSPACE}/.write-test" 2>/dev/null; then
  warn "workspace is read-only; read tools work, write tools will fail"
else
  rm -f "${WORKSPACE}/.write-test"
fi

if [ "${CONTAINER_SELFCHECK:-0}" = "1" ]; then
  say "  self-check   = running"
  bun /app/scripts/runtime-check.js
fi

say "  model        = ${PROVIDER:-mock}${MODEL:+ / ${MODEL}}"
say "  sandbox      = ${SANDBOX_SCOPE:-workspace} / ${SANDBOX_BACKEND:-local}"
say "  listen       = 0.0.0.0:${PORT} (publish to 127.0.0.1 on the host)"
say ""

exec "$@"
