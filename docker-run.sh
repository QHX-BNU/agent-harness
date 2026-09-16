#!/bin/sh
# Secure Bun-container launcher. The workspace argument is intentionally required
# so the harness repository's own .env/runtime state is not exposed by accident.
set -eu

if [ "$#" -lt 1 ]; then
  echo "usage: ./docker-run.sh /path/to/project" >&2
  exit 2
fi

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT=$(CDPATH= cd -- "$1" && pwd)
PORT="${HARNESS_PORT:-5175}"
IMAGE="${HARNESS_IMAGE:-mini-harness:local}"

command -v docker >/dev/null 2>&1 || { echo "docker CLI not found" >&2; exit 1; }
docker info --format '{{.ServerVersion}}' >/dev/null
docker build --build-arg BUN_VERSION="${BUN_VERSION:-1.4.2}" -t "$IMAGE" "$HERE"

set -- docker run --rm --init --read-only \
  --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit "${HARNESS_PIDS_LIMIT:-256}" \
  --memory "${HARNESS_MEMORY_LIMIT:-1g}" --cpus "${HARNESS_CPU_LIMIT:-2}" \
  --tmpfs /tmp:rw,nosuid,nodev,size=128m \
  -p "127.0.0.1:${PORT}:5175" \
  --mount "type=bind,source=${PROJECT},target=/workspace" \
  --mount type=volume,source=mini-harness-data,target=/data

if [ -f "$HERE/.env" ]; then set -- "$@" --env-file "$HERE/.env"; fi
set -- "$@" \
  -e HOST=0.0.0.0 -e PORT=5175 -e WORKSPACE=/workspace \
  -e SESSIONS_DIR=/data/.sessions -e TRASH_DIR=/data/.sessions-trash \
  -e ARTIFACTS_DIR=/data/.artifacts -e MEMORY_DIR=/data/.memory \
  -e RUNTIME_MODEL_FILE=/data/.runtime-model.json -e WORKFLOWS_DIR=/app/workflows \
  -e SANDBOX_BACKEND=local "$IMAGE"

echo "Bun container workspace: $PROJECT"
echo "Open: http://127.0.0.1:$PORT"
exec "$@"
