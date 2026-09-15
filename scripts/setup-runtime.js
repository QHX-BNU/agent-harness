// 把 Bun 运行时装进项目：下载一次到 runtime/bin/，之后项目自带运行时，换机器直接跑。
//
// 用法：
//   node scripts/setup-runtime.js            # 下载当前平台的 Bun
//   node scripts/setup-runtime.js --bundle   # 不下载，把本机已装的 bun 复制进来（用来打包分发）
//   node scripts/setup-runtime.js --check    # 只看状态，不动文件
//
// 零依赖：只用 Node 内置模块。Windows 上的 bootstrap 路径由 run.cmd 用 PowerShell 完成
// （用户机器上连 Node 都没有时，这个脚本跑不起来）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RUNTIME_DIR = path.join(HERE, 'runtime');
const BIN_DIR = path.join(RUNTIME_DIR, 'bin');
const BIN_NAME = process.platform === 'win32' ? 'bun.exe' : 'bun';
const BIN_PATH = path.join(BIN_DIR, BIN_NAME);

// 只有「直接执行」时才跑安装流程；被 import（例如 run-check.js 要复用 assetFor）
// 不能有任何副作用——否则检查脚本会意外触发一次下载。
const RUN_AS_SCRIPT = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

const args = process.argv.slice(2);
const MODE = args.includes('--bundle') ? 'bundle' : args.includes('--check') ? 'check' : 'download';

const say = (s) => console.log(s);

/** 当前平台对应的 Bun 发行包名 + 解包后二进制名 */
export function assetFor(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  const table = {
    'win32-x64': 'bun-windows-x64.zip',
    'win32-arm64': 'bun-windows-aarch64.zip',
    'linux-x64': 'bun-linux-x64.zip',
    'linux-arm64': 'bun-linux-aarch64.zip',
    'darwin-x64': 'bun-darwin-x64.zip',
    'darwin-arm64': 'bun-darwin-aarch64.zip',
  };
  return table[key] || null;
}

function findOnPath(name) {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
  if (probe.status !== 0) return null;
  return (probe.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || null;
}

function runVersion(bin) {
  if (!bin || !fs.existsSync(bin)) return null;
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 20000 });
  if (r.status !== 0) return null;
  const out = (r.stdout || '').trim();
  return /^\d+\.\d+\.\d+/.test(out) ? out : null;
}

function installedVersion(bin = BIN_PATH) {
  return runVersion(bin);
}

/**
 * 找出本机真正能跑的 bun 二进制。
 * 注意：npm 在 Windows 上装的是 bun / bun.cmd / bun.ps1 这些 shim 脚本，
 * 直接复制到 runtime/bin/bun.exe 是跑不起来的 —— 必须逐个验证候选文件真能执行。
 */
export function findBunBinary() {
  const candidates = [];
  if (process.versions.bun) candidates.push(process.execPath); // 当前就是 bun 在跑
  if (process.platform === 'win32') {
    const p = findOnPath('bun.exe');
    if (p) candidates.push(p);
    candidates.push(path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'bun', 'bin', 'bun.exe'));
  } else {
    const p = findOnPath('bun');
    if (p) candidates.push(p);
    candidates.push('/usr/local/bin/bun', '/usr/bin/bun', path.join(process.env.HOME || '', '.bun', 'bin', 'bun'));
  }
  for (const c of candidates) {
    const v = runVersion(c);
    if (v) return { bin: c, version: v };
  }
  return null;
}

// ---------- 模式：只看状态 ----------
if (RUN_AS_SCRIPT && MODE === 'check') {
  const v = installedVersion();
  say(v ? `✓ 项目自带运行时：${path.relative(HERE, BIN_PATH)}（bun ${v}）` : '✗ 项目里还没有运行时（跑一次 node scripts/setup-runtime.js）');
  const sysBun = findOnPath('bun');
  const sysNode = findOnPath('node');
  say(`  系统 bun : ${sysBun || '无'}`);
  say(`  系统 node: ${sysNode || '无'}`);
  process.exit(v ? 0 : 1);
}

// ---------- 模式：复制本机已装的 bun ----------
if (RUN_AS_SCRIPT && MODE === 'bundle') {
  const found = findBunBinary();
  if (!found) {
    console.error('本机没有找到能用的 bun 二进制。');
    console.error('  提示：npm 装的是 shim 脚本，真正的二进制在 node_modules/bun/bin/ 下；');
    console.error('  也可以直接跑下载模式：node scripts/setup-runtime.js');
    process.exit(1);
  }
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.copyFileSync(found.bin, BIN_PATH);
  if (process.platform !== 'win32') fs.chmodSync(BIN_PATH, 0o755);
  const v = installedVersion();
  if (!v) {
    console.error(`✗ 复制后跑不起来（来源 ${found.bin}），换个方式：直接跑下载模式`);
    process.exit(1);
  }
  fs.writeFileSync(path.join(RUNTIME_DIR, 'VERSION'), `bun ${v}\nbundled from ${found.bin}\n`, 'utf8');
  say(`✓ 已把本机 bun 复制进项目：${path.relative(HERE, BIN_PATH)}（bun ${v}）`);
  say('  打包分发时把 runtime/ 一起压缩，别人下载后不用再装任何东西。');
  process.exit(0);
}

// ---------- 模式：下载 ----------
async function install() {
const asset = assetFor();
if (!asset) {
  console.error(`不认识的平台：${process.platform}-${process.arch}`);
  process.exit(1);
}

const RELEASE = process.env.BUN_VERSION || 'latest';
const base =
  RELEASE === 'latest'
    ? 'https://github.com/oven-sh/bun/releases/latest/download'
    : `https://github.com/oven-sh/bun/releases/download/${RELEASE}`;

const say2 = (s) => console.log(s);
say2(`项目里还没有运行时，开始下载 Bun…`);
say2(`  平台: ${process.platform}-${process.arch} → ${asset}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bun-setup-'));
const zipPath = path.join(tmp, asset);

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf.length;
}

try {
  const size = await download(`${base}/${asset}`, zipPath);
  say2(`  已下载 ${(size / 1048576).toFixed(1)} MB，校验 SHA256…`);

  // 校验：官方 SHASUMS256.txt
  try {
    const sumsRes = await fetch(`${base}/SHASUMS256.txt`, { redirect: 'follow' });
    if (sumsRes.ok) {
      const text = await sumsRes.text();
      const line = text.split('\n').find((l) => l.trim().endsWith(asset));
      if (line) {
        const want = line.trim().split(/\s+/)[0];
        const got = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
        if (want !== got) throw new Error(`SHA256 不匹配（期望 ${want.slice(0, 16)}…，实际 ${got.slice(0, 16)}…）`);
        say2(`  ✓ SHA256 校验通过`);
      } else {
        say2(`  ! 校验文件里没有 ${asset}，跳过校验`);
      }
    } else {
      say2('  ! 拿不到 SHASUMS256.txt，跳过校验');
    }
  } catch (err) {
    if (/SHA256 不匹配/.test(err.message)) throw err;
    say2(`  ! 校验环节出错（${err.message}），继续`);
  }

  // 解压：Windows 用 PowerShell 的 Expand-Archive，其余用 unzip
  say2('  解压…');
  const unzipDir = path.join(tmp, 'x');
  fs.mkdirSync(unzipDir, { recursive: true });
  if (process.platform === 'win32') {
    const r = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${unzipDir}' -Force`],
      { encoding: 'utf8' },
    );
    if (r.status !== 0) throw new Error(`解压失败：${(r.stderr || '').slice(0, 200)}`);
  } else {
    const r = spawnSync('unzip', ['-q', '-o', zipPath, '-d', unzipDir], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`解压失败（需要 unzip）：${(r.stderr || '').slice(0, 200)}`);
  }

  // 在解压结果里找 bun 可执行文件
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === BIN_NAME) found.push(p);
    }
  };
  walk(unzipDir);
  if (!found.length) throw new Error(`解压后没找到 ${BIN_NAME}`);

  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.copyFileSync(found[0], BIN_PATH);
  if (process.platform !== 'win32') fs.chmodSync(BIN_PATH, 0o755);

  const v = installedVersion();
  fs.writeFileSync(path.join(RUNTIME_DIR, 'VERSION'), `bun ${v || '?'}\nfrom ${base}/${asset}\n`, 'utf8');
  say2(`✓ 装好了：${path.relative(HERE, BIN_PATH)}（bun ${v}）`);
  say2('  之后直接跑 run.cmd / run.sh，不会再下载任何东西。');
} catch (err) {
  console.error(`✗ 安装失败：${err.message}`);
  console.error('  可以手动下载对应的 zip，把里面的 bun 放到 runtime/bin/ 下。');
  process.exit(1);
} finally {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 清理失败无所谓 */
  }
}
}

if (RUN_AS_SCRIPT) await install();
