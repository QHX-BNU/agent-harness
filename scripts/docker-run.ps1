param(
  [Parameter(Position = 0)]
  [string]$Workspace = '',
  [int]$Port = 5175,
  [string]$Image = 'mini-harness:local',
  [switch]$NoBuild,
  [switch]$SelfCheck
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if (-not $Workspace) {
  throw 'Pass the project directory explicitly: docker-run.cmd D:\path\to\project'
}
$workspacePath = (Resolve-Path -LiteralPath $Workspace).Path
if (-not (Test-Path -LiteralPath $workspacePath -PathType Container)) {
  throw "Workspace is not a directory: $workspacePath"
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw 'Docker CLI was not found. Install/start Docker Desktop first.'
}
& docker info --format '{{.ServerVersion}}' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Docker daemon is not available.' }

if (-not $NoBuild) {
  & docker build --build-arg BUN_VERSION=1.4.2 -t $Image $root
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$runArgs = @(
  'run', '--rm', '--init', '--read-only',
  '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  '--pids-limit', '256', '--memory', '1g', '--cpus', '2',
  '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m',
  '-p', "127.0.0.1:${Port}:5175",
  '--mount', "type=bind,source=$workspacePath,target=/workspace",
  '--mount', 'type=volume,source=mini-harness-data,target=/data'
)

$envFile = Join-Path $root '.env'
if (Test-Path -LiteralPath $envFile -PathType Leaf) { $runArgs += @('--env-file', $envFile) }
$runArgs += @(
  '-e', 'HOST=0.0.0.0', '-e', 'PORT=5175', '-e', 'WORKSPACE=/workspace',
  '-e', 'SESSIONS_DIR=/data/.sessions', '-e', 'TRASH_DIR=/data/.sessions-trash',
  '-e', 'ARTIFACTS_DIR=/data/.artifacts', '-e', 'MEMORY_DIR=/data/.memory',
  '-e', 'RUNTIME_MODEL_FILE=/data/.runtime-model.json', '-e', 'WORKFLOWS_DIR=/app/workflows',
  '-e', 'SANDBOX_BACKEND=local'
)
if ($SelfCheck) { $runArgs += @('-e', 'CONTAINER_SELFCHECK=1') }
$runArgs += $Image

Write-Host "Bun container workspace: $workspacePath"
Write-Host "Open: http://127.0.0.1:$Port"
& docker @runArgs
exit $LASTEXITCODE
