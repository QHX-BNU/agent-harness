// Docker/container wiring checks that do not require a Docker installation.
// These assertions intentionally cover both the whole-harness Bun image and
// the per-command Docker sandbox specification.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isolationSummary } from '../src/isolation.js';
import { createSandbox, sandboxDefaults } from '../src/sandbox.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let passed = 0;
let failed = 0;

function section(title) {
  console.log(`\n${title}`);
}

function ok(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
    return;
  }
  failed += 1;
  console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function hasAll(text, needles) {
  return needles.every((needle) => text.includes(needle));
}

function argValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function mounts(args) {
  const values = [];
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === '-v' || args[i] === '--volume' || args[i] === '--mount') values.push(args[i + 1]);
  }
  return values;
}

const requiredFiles = [
  'Dockerfile',
  '.dockerignore',
  'docker-compose.yml',
  'docker-run.cmd',
  'docker-run.sh',
  'docker/entrypoint.sh',
  'scripts/docker-run.ps1',
  'scripts/docker-smoke.js',
];

section('[1] Container files and Bun version stay in sync');
for (const file of requiredFiles) ok(`${file} exists`, fs.existsSync(path.join(ROOT, file)));

const dockerfile = read('Dockerfile');
const compose = read('docker-compose.yml');
const runSh = read('docker-run.sh');
const runPs1 = read('scripts/docker-run.ps1');
const entrypoint = read('docker/entrypoint.sh');
const dockerignore = read('.dockerignore');
const packageJson = JSON.parse(read('package.json'));
const version = /ARG\s+BUN_VERSION=([^\s]+)/.exec(dockerfile)?.[1] || '';
const defaultImage = sandboxDefaults({}).image;

ok('Dockerfile pins a Bun version', /^\d+\.\d+\.\d+$/.test(version), version || 'missing');
ok('Dockerfile derives from the official Bun Alpine image', dockerfile.includes('FROM oven/bun:${BUN_VERSION}-alpine'));
ok('command sandbox image matches Dockerfile Bun version', defaultImage === `oven/bun:${version}-alpine`, defaultImage);
ok('Compose build arg matches Dockerfile Bun version', compose.includes(`BUN_VERSION: \${BUN_VERSION:-${version}}`));
ok('POSIX launcher build arg matches Dockerfile Bun version', runSh.includes(`BUN_VERSION:-${version}`));
ok('PowerShell launcher build arg matches Dockerfile Bun version', runPs1.includes(`BUN_VERSION=${version}`));
if (fs.existsSync(path.join(ROOT, 'runtime', 'VERSION'))) {
  const bundled = /bun\s+([^\s]+)/.exec(read('runtime/VERSION'))?.[1] || '';
  ok('bundled Bun version matches the container version', bundled === version, `runtime=${bundled || '?'} image=${version}`);
}

section('[2] Whole-harness image separates code, workspace, data, and secrets');
ok('runtime user is non-root', /\nUSER\s+bun\s*(?:\r?\n|$)/.test(dockerfile));
ok('application code is copied under /app and made non-writable', hasAll(dockerfile, ['WORKDIR /app', 'chmod -R a-w /app']));
ok('workspace and controller data use distinct roots', hasAll(dockerfile, ['WORKSPACE=/workspace', 'SESSIONS_DIR=/data/.sessions', 'RUNTIME_MODEL_FILE=/data/.runtime-model.json']));
ok('container identity marker and internal listen address are set', hasAll(dockerfile, ['MINI_HARNESS_CONTAINER=1', 'HOST=0.0.0.0']));
ok('whole-container shell stays inside that boundary', dockerfile.includes('SANDBOX_BACKEND=local'));
ok('image has a health check and PID-1 entrypoint', hasAll(dockerfile, ['HEALTHCHECK', 'ENTRYPOINT ["/app/docker/entrypoint.sh"]']));
ok('entrypoint refuses uid 0', /id -u[\s\S]*= "0"[\s\S]*exit 1/.test(entrypoint));
ok('entrypoint verifies data and workspace mounts', hasAll(entrypoint, ['data mount is not writable', 'workspace does not exist', 'exec "$@"']));

const ignoredSecrets = ['.git', '.sessions/', '.sessions-trash/', '.artifacts/', '.memory/', '.runtime-model.json', '.lark-app-secret', '.env', 'runtime/bin/'];
ok('Docker build context excludes runtime state and secrets', hasAll(dockerignore, ignoredSecrets));
ok('Docker build context excludes helper/smoke inputs not copied into the image', hasAll(dockerignore, ['scripts/docker-check.js', 'scripts/docker-smoke.js']));

section('[3] Compose and launchers use safe host-facing defaults');
ok('Compose publishes only on loopback', compose.includes('127.0.0.1:${HARNESS_PORT:-5175}:5175'));
ok('Compose does not mount the harness repository as the default workspace', compose.includes('source: ${HARNESS_WORKSPACE:-./workspace}'));
ok('Compose keeps workspace and state on separate mounts', hasAll(compose, ['target: /workspace', 'target: /data', 'source: harness-data']));
ok('Compose hardens the container', hasAll(compose, ['read_only: true', 'cap_drop:', '- ALL', 'no-new-privileges:true', 'pids_limit:', 'mem_limit:', 'cpus:', '/tmp:rw,nosuid,nodev,size=128m']));
ok('Compose does not expose the Docker socket', !/docker\.sock/i.test(compose));
ok('POSIX launcher requires an explicit workspace', /if \[ "\$#" -lt 1 \]/.test(runSh));
ok('POSIX launcher binds loopback and separates workspace/data', hasAll(runSh, ['127.0.0.1:${PORT}:5175', 'target=/workspace', 'target=/data']));
ok('PowerShell launcher requires an explicit workspace', hasAll(runPs1, ["throw 'Pass the project directory explicitly", 'Resolve-Path -LiteralPath']));
ok('PowerShell launcher binds loopback and separates workspace/data', hasAll(runPs1, ['127.0.0.1:${Port}:5175', 'target=/workspace', 'target=/data']));
ok('both launchers apply resource and privilege limits', hasAll(runSh, ['--read-only', '--cap-drop ALL', '--pids-limit', '--memory', '--cpus']) && hasAll(runPs1, ["'--read-only'", "'--cap-drop', 'ALL'", "'--pids-limit'", "'--memory'", "'--cpus'"]));

section('[4] Per-command Docker backend constructs a real Bun container');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-docker-check-'));
try {
  const sb = createSandbox({
    workspace: ROOT,
    backend: 'docker',
    image: defaultImage,
    memoryLimit: '768m',
    cpuLimit: '1.5',
    pidsLimit: 123,
    tempDir: temp,
    sessionId: 'static-check',
  });
  const spec = sb.buildExec('bun --version', { cwd: path.join(ROOT, 'src') });
  const args = spec.args;
  ok('backend invokes docker rather than a host shell', spec.file === 'docker' && spec.backend === 'docker');
  ok('Bun command is passed to sh inside the pinned image', args.slice(-4).join('|') === `${defaultImage}|sh|-lc|bun --version`);
  ok('requested subdirectory maps to the container workdir', argValue(args, '-w') === '/work/src', argValue(args, '-w') || 'missing');
  ok('workspace is bind-mounted, not copied into the worker', mounts(args).some((m) => m.endsWith(':/work')));
  ok('worker has a read-only root and dropped privileges', hasAll(args, ['--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user']));
  ok('worker resource limits are wired', argValue(args, '--memory') === '768m' && argValue(args, '--cpus') === '1.5' && argValue(args, '--pids-limit') === '123');
  ok('worker has init and a constrained writable /tmp', hasAll(args, ['--init', '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m']));
  ok('worker uses a non-root uid/gid', (() => {
    const [uid, gid] = String(argValue(args, '--user') || '').split(':').map(Number);
    return uid > 0 && gid > 0;
  })(), argValue(args, '--user') || 'missing');
  ok('Bun cache and HOME point at writable tmpfs', hasAll(args, ['HOME=/tmp/home', 'XDG_CACHE_HOME=/tmp/cache', 'BUN_INSTALL_CACHE_DIR=/tmp/bun-cache']));
  ok('cidfile is unique and located in the controlled temp directory', Boolean(spec.cidFile) && path.dirname(spec.cidFile) === temp);
  ok('sandbox object preserves its effective image and limits', sb.image === defaultImage && sb.memoryLimit === '768m' && sb.cpuLimit === '1.5' && sb.pidsLimit === 123);

  const ro = createSandbox({ workspace: ROOT, backend: 'docker', mode: 'readonly' }).buildExec('bun --version');
  ok('readonly mode bind-mounts the workspace read-only', mounts(ro.args).some((m) => m.endsWith(':/work:ro')));
  const offline = createSandbox({ workspace: ROOT, backend: 'docker', network: 'off' }).buildExec('bun --version');
  ok('network=off uses the Docker network namespace', argValue(offline.args, '--network') === 'none');

  let listRejected = false;
  try {
    createSandbox({ workspace: ROOT, backend: 'docker', network: 'whitelist', networkList: ['example.com'] }).buildExec('bun --version');
  } catch (error) {
    listRejected = /暂不支持|not support/i.test(String(error.message));
  }
  ok('unsupported Docker whitelist fails closed instead of silently becoming offline', listRejected);

  const custom = createSandbox({ scope: 'custom', customRoots: [ROOT, temp], backend: 'docker' });
  const customSpec = custom.buildExec('pwd', { cwd: temp });
  ok('all custom roots are mounted', mounts(customSpec.args).filter((m) => /:\/(?:work|roots\/\d+)(?::ro)?$/.test(m)).length === 2);
  ok('cwd in a secondary root maps correctly', argValue(customSpec.args, '-w') === '/roots/1');

  let badBackendRejected = false;
  try {
    createSandbox({ workspace: ROOT, backend: 'not-a-backend' });
  } catch (error) {
    badBackendRejected = /未知执行后端/.test(String(error.message));
  }
  ok('unknown backend is rejected', badBackendRejected);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

section('[5] Effective isolation is reported without overclaiming');
const noRuntimeJail = { active: false, reason: 'test' };
const noContainer = { active: false, engine: null, marker: null, imageHint: false };
const unavailable = isolationSummary({ sandbox: { backend: 'docker' }, backendReady: false, runtimeJail: noRuntimeJail, containerRuntime: noContainer });
ok('unavailable Docker backend is not reported as container isolation', unavailable.level === 'policy' && /不可用/.test(unavailable.label));
const commandContainer = isolationSummary({ sandbox: { backend: 'docker' }, backendReady: true, runtimeJail: noRuntimeJail, containerRuntime: noContainer });
ok('Docker backend is scoped as command isolation', commandContainer.level === 'container' && /run_shell/.test(commandContainer.detail));
const wholeContainer = isolationSummary({
  sandbox: { backend: 'local' },
  backendReady: true,
  runtimeJail: noRuntimeJail,
  containerRuntime: { active: true, engine: 'docker', marker: '/.dockerenv', imageHint: true },
});
ok('whole-harness container is detected independently of backend=local', wholeContainer.level === 'container' && /Harness/.test(wholeContainer.label));
const wsl = isolationSummary({ sandbox: { backend: 'wsl' }, backendReady: true, runtimeJail: noRuntimeJail, containerRuntime: noContainer });
ok('WSL is not mislabeled as a complete container boundary', wsl.level === 'policy' && /非完整隔离/.test(wsl.label));

section('[6] Failure, timeout, and API preflight wiring');
const shellSource = read('src/tools/shell.js');
const registrySource = read('src/tools/index.js');
const serverSource = read('server.js');
ok('shell returns structured success/failure results', hasAll(shellSource, ['ok: code === 0', 'timedOut', 'aborted']));
ok('tool registry preserves structured result status', /typeof result\.ok === 'boolean'/.test(registrySource));
ok('timeout and abort use the Docker cidfile cleanup path', hasAll(shellSource, ['spec.cidFile', "spawnSync('docker', ['rm', '-f', cid]", "addEventListener?.('abort'", 'clearContainer(true)']));
const chatPreflight = serverSource.indexOf('preflightSandbox(session, body.sandbox)');
const chatSse = serverSource.indexOf('openSSE(req, res, session.id)', chatPreflight);
ok('API checks backend availability before opening the chat stream', chatPreflight >= 0 && chatSse > chatPreflight);
ok('Docker whitelist/blacklist is rejected by API preflight', /backend === 'docker'[\s\S]*whitelist[\s\S]*blacklist/.test(serverSource));
ok('package.json exposes both Docker checks', packageJson.scripts?.['docker-check'] === 'node scripts/docker-check.js' && packageJson.scripts?.['docker-smoke'] === 'node scripts/docker-smoke.js');

console.log(`\n${failed === 0 ? '✓' : '✗'} Docker static check: ${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
