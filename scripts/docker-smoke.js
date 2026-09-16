// Real Docker acceptance test. It builds and starts the Bun image, then checks
// API behavior plus Docker's effective runtime settings. Without Docker this is
// a clear skip by default; pass --require to make missing Docker a failure.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REQUIRE = process.argv.includes('--require');
const KEEP_IMAGE = process.argv.includes('--keep-image');
const id = `${process.pid}-${Date.now().toString(36)}`;
const image = `mini-harness:smoke-${id}`;
const name = `mini-harness-smoke-${id}`;
let temp = null;
let built = false;
let started = false;
let passed = 0;
let failed = 0;

function run(args, { timeout = 120_000, quiet = false, allowFailure = false } = {}) {
  const result = spawnSync('docker', args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    const detail = result.error?.message || result.stderr || result.stdout || `exit ${result.status}`;
    throw new Error(`docker ${args.slice(0, 3).join(' ')} failed: ${String(detail).trim()}`);
  }
  return result;
}

function ok(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
    return;
  }
  failed += 1;
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
}

function section(title) {
  console.log(`\n${title}`);
}

function dockerAvailable() {
  const cli = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  return !cli.error && cli.status === 0 && Boolean(String(cli.stdout || '').trim());
}

function get(url, timeout = 5_000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode || 0, body, headers: res.headers }));
    });
    req.on('timeout', () => req.destroy(new Error(`request timed out after ${timeout}ms`)));
    req.on('error', reject);
  });
}

function postJson(url, payload, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const target = new URL(url);
    const req = http.request(
      target,
      {
        method: 'POST',
        timeout,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        let response = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (response += chunk));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: response, headers: res.headers }));
      },
    );
    req.on('timeout', () => req.destroy(new Error(`request timed out after ${timeout}ms`)));
    req.on('error', reject);
    req.end(body);
  });
}

async function waitForApi(baseUrl, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let last = 'not attempted';
  while (Date.now() < deadline) {
    try {
      const result = await get(`${baseUrl}/api/config`, 2_000);
      if (result.status === 200) return result;
      last = `HTTP ${result.status}`;
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`container API did not become ready: ${last}`);
}

function inspectContainer() {
  const result = run(['inspect', name], { quiet: true });
  return JSON.parse(result.stdout)[0];
}

function exec(command, { allowFailure = false } = {}) {
  return run(['exec', name, 'sh', '-lc', command], { quiet: true, allowFailure });
}

function cleanup() {
  if (started) run(['rm', '-f', name], { timeout: 20_000, quiet: true, allowFailure: true });
  if (built && !KEEP_IMAGE) run(['image', 'rm', image], { timeout: 30_000, quiet: true, allowFailure: true });
  if (temp) {
    try {
      fs.rmSync(temp, { recursive: true, force: true });
    } catch {
      // A bind-mounted Linux VM can occasionally hold a handle briefly on Windows.
    }
  }
}

if (!dockerAvailable()) {
  const message = 'Docker CLI/daemon is unavailable; real container smoke test skipped.';
  console.log(REQUIRE ? `✗ ${message}` : `↷ ${message} Use --require in CI to make this fatal.`);
  process.exit(REQUIRE ? 1 : 0);
}

process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    cleanup();
    process.exit(128);
  });
}

try {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-harness-docker-smoke-'));
  const workspace = path.join(temp, 'workspace');
  const data = path.join(temp, 'data');
  fs.mkdirSync(workspace, { recursive: true, mode: 0o777 });
  fs.mkdirSync(data, { recursive: true, mode: 0o777 });
  try {
    fs.chmodSync(workspace, 0o777);
    fs.chmodSync(data, 0o777);
  } catch {
    // Windows ACLs are handled by Docker Desktop's bind mount implementation.
  }
  const marker = `container-marker-${id}`;
  fs.writeFileSync(path.join(workspace, 'marker.txt'), `${marker}\n`, 'utf8');

  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const bunVersion = /ARG\s+BUN_VERSION=([^\s]+)/.exec(dockerfile)?.[1];
  if (!bunVersion) throw new Error('Dockerfile does not declare ARG BUN_VERSION');

  section('[1] Build the official-Bun-based image');
  const build = run(['build', '--build-arg', `BUN_VERSION=${bunVersion}`, '-t', image, ROOT], { timeout: 900_000, quiet: true });
  built = true;
  ok('image builds successfully', build.status === 0, image);

  section('[2] Start with the documented security boundary');
  const start = run(
    [
      'run',
      '--detach',
      '--rm',
      '--name',
      name,
      '--init',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '128',
      '--memory',
      '512m',
      '--cpus',
      '1',
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,size=64m',
      '-p',
      '127.0.0.1::5175',
      '--mount',
      `type=bind,source=${workspace},target=/workspace`,
      '--mount',
      `type=bind,source=${data},target=/data`,
      '-e',
      'PROVIDER=mock',
      '-e',
      'APPROVAL_MODE=auto',
      '-e',
      'SANDBOX_BACKEND=local',
      image,
    ],
    { timeout: 60_000, quiet: true },
  );
  started = true;
  ok('container starts', /^[a-f0-9]{12,64}$/i.test(String(start.stdout).trim()), String(start.stdout).trim().slice(0, 12));

  const inspected = inspectContainer();
  const binding = inspected.NetworkSettings?.Ports?.['5175/tcp']?.[0];
  if (!binding?.HostPort) throw new Error(`Docker did not publish 5175/tcp on loopback: ${JSON.stringify(binding)}`);
  const baseUrl = `http://127.0.0.1:${binding.HostPort}`;
  await waitForApi(baseUrl);

  ok('published port is loopback-only', binding.HostIp === '127.0.0.1', `${binding.HostIp}:${binding.HostPort}`);
  ok('root filesystem is read-only', inspected.HostConfig?.ReadonlyRootfs === true);
  ok('all Linux capabilities are dropped', Array.isArray(inspected.HostConfig?.CapDrop) && inspected.HostConfig.CapDrop.includes('ALL'));
  ok('no-new-privileges is active', (inspected.HostConfig?.SecurityOpt || []).some((v) => /no-new-privileges/.test(v)));
  ok('PID limit is active', Number(inspected.HostConfig?.PidsLimit) === 128);
  ok('memory limit is active', Number(inspected.HostConfig?.Memory) === 512 * 1024 * 1024);
  ok('CPU limit is active', Number(inspected.HostConfig?.NanoCpus) === 1_000_000_000);
  const destinations = (inspected.Mounts || []).map((m) => m.Destination);
  ok('workspace and data are distinct mounts', destinations.includes('/workspace') && destinations.includes('/data'));
  ok('Docker socket is not mounted', !destinations.some((p) => /docker\.sock/i.test(p)));

  section('[3] Verify Bun, uid, mounts, and filesystem behavior inside');
  const actualBun = exec('bun --version').stdout.trim();
  ok('container uses the pinned Bun version', actualBun === bunVersion, `bun ${actualBun}`);
  const uid = Number(exec('id -u').stdout.trim());
  ok('server/commands run as non-root', uid > 0, `uid=${uid}`);
  ok('workspace marker is visible', exec('cat /workspace/marker.txt').stdout.trim() === marker);
  ok('application source exists but is not writable', exec('test -f /app/server.js && test ! -w /app/server.js').status === 0);
  ok('root filesystem rejects writes', exec('touch /rootfs-write-test', { allowFailure: true }).status !== 0);
  ok('tmpfs remains writable for Bun caches', exec('mkdir -p "$HOME" "$XDG_CACHE_HOME" "$BUN_INSTALL_CACHE_DIR" && touch /tmp/cache-write-test').status === 0);
  ok('controller state is outside the workspace', exec('test -d /data/.sessions && test ! -e /workspace/.sessions').status === 0);

  section('[4] Verify API reports the effective container and runs a turn');
  const configResponse = await get(`${baseUrl}/api/config`);
  const publicConfig = JSON.parse(configResponse.body);
  ok('API is reachable', configResponse.status === 200);
  ok('API workspace is the explicit mount', publicConfig.workspace === '/workspace', publicConfig.workspace);
  ok('whole-container mode uses local shell inside the outer boundary', publicConfig.sandbox?.backend === 'local');

  const sandboxResponse = await get(`${baseUrl}/api/sandbox`);
  const sandbox = JSON.parse(sandboxResponse.body);
  ok('API detects the actual harness container', sandbox.isolation?.level === 'container' && sandbox.isolation?.containerRuntime?.active === true, sandbox.isolation?.label || 'missing');
  ok('container report does not claim file tools use the Docker command backend', sandbox.isolation?.backend === 'local');

  const turn = await postJson(`${baseUrl}/api/chat`, {
    message: 'run a shell command',
    provider: 'mock',
    approvalMode: 'auto',
    sandbox: { scope: 'workspace', mode: 'write', backend: 'local', strict: true, network: 'off' },
  });
  ok('mock tool turn completes over SSE', turn.status === 200 && /event: done/.test(turn.body));
  ok('turn really invokes run_shell successfully', /"name":"run_shell"/.test(turn.body) && /exit code: 0/.test(turn.body));

  section('[5] Health and persisted controller data');
  let health = inspectContainer().State?.Health?.Status;
  const healthDeadline = Date.now() + 45_000;
  while (health !== 'healthy' && Date.now() < healthDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    health = inspectContainer().State?.Health?.Status;
  }
  ok('Docker health check becomes healthy', health === 'healthy', health || 'missing');
  ok('session state is written under /data', fs.existsSync(path.join(data, '.sessions')) && fs.readdirSync(path.join(data, '.sessions')).some((f) => f.endsWith('.json')));

  console.log(`\n${failed === 0 ? '✓' : '✗'} Docker smoke: ${passed} passed / ${failed} failed`);
} catch (error) {
  failed += 1;
  console.error(`\n✗ Docker smoke failed: ${error.message}`);
  if (started) {
    const logs = run(['logs', name], { timeout: 20_000, quiet: true, allowFailure: true });
    const output = `${logs.stdout || ''}${logs.stderr || ''}`.trim();
    if (output) console.error(`\n--- container logs ---\n${output.slice(-8000)}`);
  }
} finally {
  cleanup();
  process.removeAllListeners('exit');
}

process.exit(failed === 0 ? 0 : 1);
