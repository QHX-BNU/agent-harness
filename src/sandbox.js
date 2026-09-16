// 沙箱层：决定 agent 到底能碰到什么。
//
// 设计原则（很重要，别自欺欺人）：
//   1. Windows 默认把模型命令放进 Restricted Token + ACL + Job Object；控制器仍在边界外。
//   2. local 是兼容用策略后端；docker / wsl 是可选后端。缺工具时明确报不可用，
//      绝不静默回落到宿主机执行。
//   3. 每一次放行/拒绝都进审计（trace + 会话里可查），否则沙箱等于没有。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createNetworkPolicy, getNetworkProxy, proxyEnvFor, normalizeMode, NETWORK_MODES } from './network-policy.js';
import { detectRuntimeJail, isolationSummary } from './isolation.js';
import { ensureDir } from './fsutil.js';

export class SandboxError extends Error {
  constructor(message, { rule = 'scope', target = '' } = {}) {
    super(message);
    this.name = 'SandboxError';
    this.rule = rule;
    this.target = target;
  }
}

const isWin = process.platform === 'win32';
const norm = (p) => (isWin ? path.resolve(p).toLowerCase() : path.resolve(p));

/** 作用区域预设：用户可选的就是这几个 */
export const SCOPE_PRESETS = {
  workspace: { label: '仅工作区', description: '只能碰当前工作区目录，最安全' },
  home: { label: '用户主目录', description: '整个 ~ 都能读写' },
  custom: { label: '自定义目录', description: '自己指定一个或多个根目录' },
  full: { label: '整个文件系统', description: '不做路径限制，风险自负' },
};

export const MODES = {
  write: { label: '可写', description: '允许写文件、执行命令' },
  readonly: { label: '只读', description: '禁止任何写操作与可能改盘的命令' },
};

export const EXEC_BACKENDS = new Set(['windows', 'local', 'docker', 'wsl']);

const APP_ROOT = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const WINDOWS_RUNNER = path.join(APP_ROOT, 'scripts', 'windows-sandbox-runner.ps1');
const WINDOWS_SOURCE = path.join(APP_ROOT, 'native', 'windows-sandbox', 'HarnessSandbox.cs');

/** 目录 p 是否落在 root 里面（含相等） */
function pathInside(root, p) {
  const rel = path.relative(norm(root), norm(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 原生执行器的 C# 桥接由控制器进程加载，所以编译产物绝不能落在受限进程能写的地方：
 * 否则沙箱里的命令只要把 DLL 换掉，下一次 run_shell 就会以当前用户身份把它加载起来。
 * 这里只挑沙箱授权范围之外的目录；实在没有（例如把整个盘设成可写），返回 null，
 * 由执行器改为每次在内存里编译，不留下可被篡改的文件。
 */
export function pickEngineCacheDir({ roots = [], extraRoots = [], env = process.env } = {}) {
  const granted = [...roots, ...extraRoots].filter(Boolean).map((p) => path.resolve(p));
  const candidates = [
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'mini-harness', 'sandbox-engine') : null,
    env.APPDATA ? path.join(env.APPDATA, 'mini-harness', 'sandbox-engine') : null,
    env.ProgramData ? path.join(env.ProgramData, 'mini-harness', 'sandbox-engine') : null,
    path.join(os.tmpdir(), 'mini-harness-sandbox-engine'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const abs = path.resolve(candidate);
    if (!granted.some((root) => pathInside(root, abs))) return abs;
  }
  return null;
}

/** 授权写根目录里是否包含控制器自己的代码目录（包含 → 这个边界保护不了控制器自身） */
export function controllerAtRisk(roots, appRoot = APP_ROOT) {
  return roots.some((root) => pathInside(root, appRoot));
}

function memoryBytes(value) {
  const text = String(value ?? '').trim().toLowerCase();
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt]?)(?:i?b)?$/.exec(text);
  if (!m) throw new SandboxError(`无效内存限制 "${value}"`, { rule: 'config' });
  const scale = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[m[2]];
  const bytes = Math.floor(Number(m[1]) * scale);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new SandboxError(`无效内存限制 "${value}"`, { rule: 'config' });
  return bytes;
}

/** 本地后端也要硬拦的命令（和 policy 的危险命令表互补） */
const DANGEROUS_CMDS = [
  { re: /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf][a-z]*\s+(\/|\*|~)/i, why: 'rm -rf 指向根/通配/家目录' },
  { re: /\b(mkfs|fdisk|diskpart)\b/i, why: '磁盘操作命令' },
  { re: /\bformat\s+[a-z]:/i, why: '格式化磁盘' },
  { re: /\bshutdown\b|\breboot\b/i, why: '关机/重启' },
  { re: /:\(\)\s*\{.*\};\s*:/, why: 'fork 炸弹' },
  { re: /\breg\s+(add|delete|import)\b/i, why: '改注册表' },
  { re: /\b(Set-ExecutionPolicy|netsh|sc\s+(create|delete))\b/i, why: '改系统配置' },
  { re: /\bicacls\b|\btakeown\b|\bcacls\b/i, why: '改文件权限/属主' },
];

/** 只读模式下额外拦截的写操作 */
const WRITE_CMDS = [
  { re: />\s*[^&|]+/, why: '输出重定向会写文件' },
  { re: /\b(rm|rmdir|del|erase|mv|move|cp|copy|mkdir|md|touch|chmod|chown|truncate|dd)\b/i, why: '写类命令' },
  { re: /\b(sed|perl)\b.*\s-i\b/i, why: '原地修改文件' },
  { re: /\b(Set-Content|Out-File|Add-Content|New-Item|Remove-Item|Move-Item|Copy-Item)\b/i, why: 'PowerShell 写操作' },
  { re: /\bgit\s+(push|commit|reset|clean|checkout)\b/i, why: '改仓库状态' },
  { re: /\bnpm\s+(install|i|ci|uninstall|publish)\b/i, why: '改依赖/发布' },
  { re: /\bpip\s+install\b|\bapt(-get)?\s+install\b/i, why: '装软件包' },
];

/** 环境变量白名单：默认不把 API key 之类的秘密暴露给子进程 */
const ENV_ALLOW = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'windir',
  'ComSpec',
  'SystemDrive',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'TZ',
  'PYTHONIOENCODING',
  'NUMBER_OF_PROCESSORS',
];

/** 看起来像路径的 token */
const looksLikePath = (t) =>
  t === '..' ||
  t === '.' ||
  t.startsWith('~') ||
  t.includes('/') ||
  t.includes('\\') ||
  /^[a-zA-Z]:[\\/]/.test(t) ||
  /^[a-zA-Z]:$/.test(t);

// Windows 控制台默认是本地代码页（中文机器上是 GBK），直接跑命令中文会变成乱码。
// 统一让子进程按 UTF-8 输出，解码侧就永远是 UTF-8。
export function utf8Prelude(command) {
  return (
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' +
    '$OutputEncoding=[System.Text.Encoding]::UTF8; ' +
    // 让原生命令（node/git/dir 之类）也按 UTF-8 输出；写成这样是为了让 PowerShell 正确解析重定向
    'chcp 65001 > $null; ' +
    command
  );
}

/** 把「作用区域」翻译成实际根目录（创建沙箱和给界面/日志看的是同一套规则） */
export function resolveSandboxRoots({ scope = 'workspace', customRoots = [], workspace = process.cwd() } = {}) {
  if (scope === 'workspace') return [path.resolve(workspace)];
  if (scope === 'home') return [path.resolve(os.homedir())];
  if (scope === 'full') return [path.parse(path.resolve(workspace)).root];
  const list = (Array.isArray(customRoots) ? customRoots : String(customRoots).split(/[;\n]+/))
    .map((r) => String(r).trim())
    .filter(Boolean)
    .map((r) => path.resolve(r));
  return list.length ? list : [path.resolve(workspace)];
}

export function createSandbox({
  scope = 'workspace',
  customRoots = [],
  mode = 'write',
  backend = 'local',
  workspace = process.cwd(),
  strict = true,
  image = 'oven/bun:1.4.2-alpine',
  memoryLimit = '1g',
  cpuLimit = '2',
  pidsLimit = 256,
  network = 'all',
  networkList = [],
  tempDir = null,
  emit = null,
  sessionId = null,
} = {}) {
  if (!SCOPE_PRESETS[scope]) throw new SandboxError(`未知作用区域 "${scope}"`, { rule: 'config' });
  if (!MODES[mode]) throw new SandboxError(`未知权限模式 "${mode}"`, { rule: 'config' });
  if (!EXEC_BACKENDS.has(backend)) throw new SandboxError(`未知执行后端 "${backend}"`, { rule: 'config' });
  const containerImage = String(image || '').trim() || 'oven/bun:1.4.2-alpine';

  // 网络策略：all / off / whitelist / blacklist（兼容旧的 network: true/false）
  const networkPolicy = createNetworkPolicy({ mode: normalizeMode(network, 'all'), list: networkList });
  // 非 all 模式要起本地代理；创建时就把它拉起来，等它绑定端口（shell 工具执行前会 await ready()）
  const proxyHandle = networkPolicy.mode === 'all' || backend === 'docker' ? null : getNetworkProxy(networkPolicy, {
    onDecision: (d) => {
      if (!d.ok) emit?.({ type: 'network_denied', host: d.host, port: d.port, reason: d.reason });
    },
  });
  const readyPromise = proxyHandle ? proxyHandle.ready : Promise.resolve(null);

  const roots = resolveSandboxRoots({ scope, customRoots, workspace });
  // 同一 roots + mode 复用能力 SID，避免每条消息/会话都给目录追加新 ACE；只读或换 roots
  // 会得到不同 SID，因此以前授权过的能力不会污染收紧后的配置。外部同用户进程本来就有
  // 用户权限；真正需要防的是受限子进程，而它不能把已有 restricted SID 换成另一个。
  const nativeCapabilityKey = crypto
    .createHash('sha256')
    .update([APP_ROOT, mode, ...roots.map(norm)].join('\0'))
    .digest('hex');

  // 授权写的根目录把控制器代码目录也包进去时，「沙箱」拦不住模型改 harness 自己：
  // 无论是 shell 还是文件工具写进 src/、scripts/、native/，下次都会被控制器当代码执行。
  // 这不是可以用 ACL 修的漏洞，但必须如实报出来，不能装作还在隔离。
  const exposesController = mode === 'write' && controllerAtRisk(roots);

  const auditLog = [];
  const denials = [];

  const record = (entry) => {
    const ev = { ts: Date.now(), ...entry };
    auditLog.push(ev);
    if (auditLog.length > 500) auditLog.shift();
    if (entry.action === 'deny') {
      denials.push(ev);
      if (denials.length > 100) denials.shift();
      emit?.({ type: 'sandbox_denied', rule: entry.rule, target: entry.target, reason: entry.reason, tool: entry.tool });
    }
  };

  /** 路径是否落在作用区域内 */
  const inside = (abs) => roots.some((r) => {
    const rel = path.relative(norm(r), norm(abs));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });

  /**
   * 解析一个用户/模型给的路径。
   * @throws {SandboxError} 越界或只读模式下写
   */
  function resolve(p, { forWrite = false, cwd = roots[0], tool = 'fs' } = {}) {
    const raw = String(p ?? '.');
    const expanded = raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\') ? path.join(os.homedir(), raw.slice(1)) : raw;
    if (scope === 'full') {
      const abs = path.resolve(cwd, expanded);
      if (forWrite && mode === 'readonly') {
        record({ action: 'deny', rule: 'readonly', target: abs, reason: '只读模式下禁止写', tool });
        throw new SandboxError(`只读沙箱：不能写入 ${abs}`, { rule: 'readonly', target: abs });
      }
      return abs;
    }
    const abs = path.resolve(cwd, expanded);
    if (!inside(abs)) {
      const reason = `路径不在作用区域内（${roots.map((r) => path.basename(r) || r).join(', ')}）`;
      record({ action: 'deny', rule: 'scope', target: abs, reason, tool });
      throw new SandboxError(`沙箱拒绝：${p} 不在允许的范围内`, { rule: 'scope', target: abs });
    }
    if (forWrite && mode === 'readonly') {
      record({ action: 'deny', rule: 'readonly', target: abs, reason: '只读模式下禁止写', tool });
      throw new SandboxError(`只读沙箱：不能写入 ${abs}`, { rule: 'readonly', target: abs });
    }
    record({ action: 'allow', rule: 'scope', target: abs, tool });
    return abs;
  }

  /**
   * 命令扫描：本地后端靠它拦住「用命令绕过路径限制」。
   * 明确不做的事：解析变量展开（%TEMP%、$HOME）、混淆编码、管道里的动态路径。
   * 所以 strict=false 时应视为无沙箱。
   */
  function checkCommand(command, { cwd = roots[0], tool = 'run_shell' } = {}) {
    const cmd = String(command || '');
    if (!cmd.trim()) return { ok: false, reason: '空命令' };

    for (const d of DANGEROUS_CMDS) {
      if (d.re.test(cmd)) {
        const reason = `危险命令：${d.why}`;
        record({ action: 'deny', rule: 'dangerous', target: cmd.slice(0, 200), reason, tool });
        return { ok: false, reason };
      }
    }

    if (mode === 'readonly') {
      for (const w of WRITE_CMDS) {
        if (w.re.test(cmd)) {
          const reason = `只读沙箱：${w.why}`;
          record({ action: 'deny', rule: 'readonly', target: cmd.slice(0, 200), reason, tool });
          return { ok: false, reason };
        }
      }
    }

    // 网络策略：命令分析层（事前拒绝明显越界的联网命令）
    const netVerdict = networkPolicy.checkCommand(cmd);
    if (!netVerdict.ok) {
      record({ action: 'deny', rule: 'network', target: cmd.slice(0, 200), reason: netVerdict.reason, tool });
      return { ok: false, reason: netVerdict.reason };
    }
    if (netVerdict.warn) record({ action: 'warn', rule: 'network', target: cmd.slice(0, 200), reason: netVerdict.warn, tool });

    if (!strict || scope === 'full') {
      record({ action: 'allow', rule: 'scope', target: cmd.slice(0, 200), tool });
      return { ok: true, network: netVerdict.targets || [] };
    }

    // 把命令切成 token，逐个看有没有越界路径
    const tokens = cmd
      .replace(/"[^"]*"|'[^']*'/g, (m) => ' ' + m.slice(1, -1) + ' ')
      .split(/[\s;|&<>(){}[\]$`]+/)
      .filter(Boolean);

    for (const raw of tokens) {
      let t = raw.replace(/^['"]+|['"]+$/g, ''); // 去掉包裹引号
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) t = t.slice(t.indexOf('=') + 1); // FOO=/x/y
      if (!t || t.startsWith('-')) continue;
      if (/^(https?|ftp|git|ssh):\/\//i.test(t)) continue;
      if (/^(nul|\/dev\/null|\/dev\/stdout|\/dev\/stderr)$/i.test(t)) continue;
      if (/^[0-9]+$/.test(t)) continue;
      if (!looksLikePath(t)) continue;

      const expanded = t === '~' || t.startsWith('~/') || t.startsWith('~\\') ? path.join(os.homedir(), t.slice(1)) : t;
      const candidate = path.resolve(cwd, expanded);
      if (!inside(candidate)) {
        const reason = `命令里出现作用区域外的路径：${t}`;
        record({ action: 'deny', rule: 'scope', target: candidate, reason, tool });
        return { ok: false, reason };
      }
    }

    record({ action: 'allow', rule: 'scope', target: cmd.slice(0, 200), tool });
    return { ok: true };
  }

  /** 清洗后的环境变量（本地后端用） */
  function cleanEnv(extra = {}) {
    const env = {};
    for (const k of ENV_ALLOW) {
      const found = Object.keys(process.env).find((n) => n.toLowerCase() === k.toLowerCase());
      if (found) env[k] = process.env[found];
    }
    env.HOME = roots[0];
    env.USERPROFILE = roots[0];
    env.SANDBOX = scope;
    env.SANDBOX_ROOTS = roots.join(path.delimiter);
    env.SANDBOX_NETWORK = networkPolicy.mode;
    if (tempDir) {
      ensureDir(tempDir);
      env.TEMP = tempDir;
      env.TMP = tempDir;
      env.TMPDIR = tempDir;
    }
    // 网络策略不是 all 时，给子进程注入本地代理：连接建立时按策略放行/拒绝
    const netEnv = networkPolicy.mode === 'all' ? {} : proxyEnvFor(networkPolicy, proxyHandle);
    return { ...env, ...netEnv, ...extra };
  }

  /** 构造真正要 spawn 的东西 */
  function buildExec(command, { cwd = roots[0], tool = 'run_shell' } = {}) {
    const cwdAbs = resolve(cwd, { tool });
    const env = cleanEnv();
    const netFlag = networkPolicy.mode === 'all' ? 'bridge' : 'none';

    if (backend === 'windows') {
      if (!isWin) {
        throw new SandboxError('Windows 原生沙箱只能在 Windows 上使用', { rule: 'backend', target: backend });
      }
      if (!backendAvailable.windows()) {
        throw new SandboxError('Windows 原生沙箱组件不可用；命令已拒绝，不会回落到本地执行', {
          rule: 'backend',
          target: WINDOWS_RUNNER,
        });
      }
      if (scope === 'full' && mode === 'write') {
        throw new SandboxError('Windows 原生沙箱拒绝把整个磁盘根目录设为可写；请选工作区、主目录或自定义目录', {
          rule: 'scope',
          target: roots[0],
        });
      }
      const nativeTemp = path.resolve(tempDir || path.join(os.tmpdir(), 'mini-harness-sandbox'));
      ensureDir(nativeTemp);
      // 受限令牌只能写「授权根目录 + 私有临时目录」，所以子进程的 TEMP/TMP 必须指到私有临时目录。
      // 否则（例如调用方没传 tempDir）：真实 %TEMP% 写不进去，Windows PowerShell 会退到
      // ConstrainedLanguage，命令里的 .NET 调用会被拒。C# 侧已经把这个目录授予了能力 SID。
      env.TEMP = nativeTemp;
      env.TMP = nativeTemp;
      env.TMPDIR = nativeTemp;
      // 编译缓存必须放在受权范围之外；实在挑不出来就不缓存（在内存里编译）。
      const engineCache = pickEngineCacheDir({ roots, extraRoots: [nativeTemp] });
      const request = {
        command: String(command),
        capabilityKey: nativeCapabilityKey,
        cwd: cwdAbs,
        writableRoots: mode === 'write' ? roots : [],
        tempDir: nativeTemp,
        cacheDir: engineCache,
        pidsLimit: Math.max(1, Math.min(4096, Number(pidsLimit) || 256)),
        memoryLimitBytes: memoryBytes(memoryLimit),
        // Job Object CPU rate 的 10000 = 整台机器 100%；Docker 的 cpus=2 换算为约 2 个逻辑核。
        cpuRate: Math.max(1, Math.min(10000, Math.round(((Number(cpuLimit) || 2) / Math.max(1, os.cpus().length)) * 10000))),
      };
      const encoded = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
      return {
        file: 'powershell.exe',
        args: [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          WINDOWS_RUNNER,
          '-Request',
          encoded,
        ],
        cwd: APP_ROOT,
        env,
        backend: 'windows',
        cwdAbs,
      };
    }

    if (backend === 'docker') {
      // Docker 的 none 能可靠实现完全禁网；白/黑名单依赖宿主代理，但 network=none
      // 又无法访问代理。以前把二者都悄悄降级成 none，表现为“允许的站点也连不上”。
      // 在有真正的受控代理网络前明确拒绝，不能伪装成规则已生效。
      if (networkPolicy.mode === 'whitelist' || networkPolicy.mode === 'blacklist') {
        throw new SandboxError(
          `Docker 后端暂不支持 ${networkPolicy.mode} 网络模式；请选择 all 或 off`,
          { rule: 'network', target: networkPolicy.mode },
        );
      }

      const args = [
        'run',
        '--rm',
        '-i',
        '--init',
        '--read-only',
        '--network',
        netFlag,
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--pids-limit',
        String(pidsLimit),
        '--memory',
        String(memoryLimit),
        '--cpus',
        String(cpuLimit),
        '--tmpfs',
        '/tmp:rw,nosuid,nodev,size=128m',
      ];

      // 不以容器 root 写宿主工作区。Linux 沿用当前 uid/gid；Docker Desktop 使用
      // Bun 官方镜像的 bun 用户（1000:1000）。数字 uid 不依赖镜像里的 /etc/passwd。
      const hostUid = typeof process.getuid === 'function' ? process.getuid() : 1000;
      const hostGid = typeof process.getgid === 'function' ? process.getgid() : 1000;
      const uid = hostUid > 0 ? hostUid : 1000;
      const gid = hostUid > 0 && hostGid > 0 ? hostGid : 1000;
      args.push('--user', `${uid}:${gid}`);
      args.push(
        '--env',
        'HOME=/tmp/home',
        '--env',
        'XDG_CACHE_HOME=/tmp/cache',
        '--env',
        'BUN_INSTALL_CACHE_DIR=/tmp/bun-cache',
        '--env',
        `SANDBOX_NETWORK=${networkPolicy.mode}`,
      );

      // custom scope 可以有多个根；全部挂进去，并把请求的 cwd 映射到对应容器目录。
      const mountTargets = roots.map((_, i) => (i === 0 ? '/work' : `/roots/${i}`));
      for (let i = 0; i < roots.length; i++) {
        args.push('-v', `${roots[i]}:${mountTargets[i]}${mode === 'readonly' ? ':ro' : ''}`);
      }
      const cwdRoot = roots.findIndex((r) => {
        const rel = path.relative(norm(r), norm(cwdAbs));
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
      });
      const rootIndex = cwdRoot >= 0 ? cwdRoot : 0;
      const relCwd = path.relative(roots[rootIndex], cwdAbs).split(path.sep).join('/');
      const containerCwd = relCwd ? `${mountTargets[rootIndex]}/${relCwd}` : mountTargets[rootIndex];
      args.push('-w', containerCwd);

      // timeout/abort 时 shell 工具靠 cidfile 精确清掉对应容器，避免只杀 docker CLI
      // 后把真正的 workload 留在后台。
      let cidFile = null;
      if (tempDir) {
        ensureDir(tempDir);
        const sid = String(sessionId || 'shell').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 40);
        cidFile = path.join(tempDir, `docker-${sid}-${crypto.randomUUID()}.cid`);
        args.push('--cidfile', cidFile);
      }
      args.push(containerImage);
      args.push('sh', '-lc', command);
      return { file: 'docker', args, cwd: process.cwd(), env, backend: 'docker', cwdAbs, containerCwd, cidFile };
    }

    if (backend === 'wsl') {
      // 把 Windows 路径转成 /mnt/<drive>/... 形式
      const toWsl = (p) => {
        const m = /^([a-zA-Z]):[\\/](.*)$/.exec(path.resolve(p));
        return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : path.resolve(p).replace(/\\/g, '/');
      };
      const envPrefix = Object.entries(env)
        .filter(([k]) => /^(HTTP|HTTPS|ALL|NO)_PROXY$|_proxy$|^NODE_USE_ENV_PROXY$|^SANDBOX_NETWORK$/.test(k))
        .map(([k, v]) => `${k}='${v}'`)
        .join(' ');
      return {
        file: 'wsl.exe',
        args: ['-e', 'sh', '-lc', `cd '${toWsl(cwdAbs)}' && ${envPrefix ? `${envPrefix} ` : ''}${command}`],
        cwd: process.cwd(),
        env,
        backend: 'wsl',
        cwdAbs,
      };
    }

    // local：Windows 上用 powershell，其余用 sh
    return isWin
      ? {
          file: 'powershell.exe',
          args: ['-NoProfile', '-NonInteractive', '-Command', utf8Prelude(command)],
          cwd: cwdAbs,
          env,
          backend: 'local',
          cwdAbs,
        }
      : { file: '/bin/sh', args: ['-c', command], cwd: cwdAbs, env, backend: 'local', cwdAbs };
  }

  return {
    scope,
    mode,
    backend,
    strict,
    image: containerImage,
    memoryLimit,
    cpuLimit,
    pidsLimit,
    roots,
    get denials() {
      return denials;
    },
    get audit() {
      return auditLog;
    },
    resolve,
    checkCommand,
    cleanEnv,
    buildExec,
    network: networkPolicy,
    /** 等本地代理绑定端口（shell 工具执行前调用） */
    ready: () => readyPromise,
    /** 给 UI / API 用的快照 */
    describe() {
      return {
        scope,
        scopeLabel: SCOPE_PRESETS[scope].label,
        mode,
        modeLabel: MODES[mode].label,
        backend,
        strict,
        image: containerImage,
        limits: { memory: memoryLimit, cpus: cpuLimit, pids: pidsLimit },
        network: networkPolicy.mode,
        networkLabel: networkPolicy.describe().label,
        networkList: networkPolicy.rules.map((r) => r.raw),
        networkModes: Object.entries(NETWORK_MODES).map(([id, m]) => ({ id, ...m })),
        proxy: proxyHandle ? { active: true, port: proxyHandle.port, stats: { ...proxyHandle.stats } } : { active: false },
        // 隔离类型要如实展示：container / os / runtime / policy。
        isolation: isolationSummary({
          sandbox: { backend },
          runtimeJail: detectRuntimeJail(),
          backendReady: backend === 'local' ? true : backendAvailable[backend]?.() ?? false,
          controllerExposed: exposesController,
        }),
        // 控制器代码目录被划进可写范围时如实标记：这个边界保护不了 harness 自己。
        controller: {
          appRoot: APP_ROOT,
          exposed: exposesController,
          note: exposesController
            ? '可写范围包含控制器代码目录（src/、scripts/、native/ 等）：模型改这里等同于改下次运行的代码，此模式下不要运行不可信内容。'
            : '可写范围不包含控制器代码目录，命令改不到 harness 自身。',
        },
        roots,
        sessionId,
        denials: denials.slice(-20),
        auditCount: auditLog.length,
        presets: Object.entries(SCOPE_PRESETS).map(([id, p]) => ({ id, ...p })),
        modes: Object.entries(MODES).map(([id, m]) => ({ id, ...m })),
        backends: [
          {
            id: 'windows',
            label: 'Windows 原生沙箱',
            available: backendAvailable.windows(),
            note: '免安装：Restricted Token + ACL 强制写入边界，Job Object 管住进程树；读取权限沿用当前用户，网络规则为代理级',
          },
          { id: 'local', label: '本地策略沙箱', available: true, note: '路径作用域 + 命令扫描 + 环境变量清洗；不是内核隔离，可被绕过' },
          {
            id: 'docker',
            label: 'Docker 容器',
            available: backendAvailable.docker(),
            note: '真正的文件系统/进程隔离，需要 docker 且守护进程在跑',
          },
          {
            id: 'wsl',
            label: 'WSL',
            available: backendAvailable.wsl(),
            note: '命令进入 WSL，但 Windows 磁盘与互操作通常仍可访问；不是完整容器边界',
          },
        ],
      };
    },
  };
}

/** 探测某个可执行文件是否存在（同步，够快） */
export function probe(cmd) {
  const exts = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    for (const ext of exts) {
      try {
        if (fs.existsSync(path.join(d, cmd + ext))) return true;
      } catch {
        /* ignore */
      }
    }
  }
  return false;
}

const probeCache = new Map();

/** 真正跑一下确认可用（docker 装了但守护进程没起、wsl 没装发行版都算不可用） */
export function probeRunnable(cmd, args, timeoutMs = 4000) {
  const key = `${cmd} ${args.join(' ')}`;
  if (probeCache.has(key)) return probeCache.get(key);
  let result = false;
  if (probe(cmd)) {
    try {
      const r = spawnSync(cmd, args, { timeout: timeoutMs, stdio: 'ignore', windowsHide: true });
      result = r.status === 0;
    } catch {
      result = false;
    }
  }
  probeCache.set(key, result);
  return result;
}

export const backendAvailable = {
  windows: () => isWin && fs.existsSync(WINDOWS_RUNNER) && fs.existsSync(WINDOWS_SOURCE) && probe('powershell'),
  local: () => true,
  docker: () => probeRunnable('docker', ['info', '--format', '{{.ServerVersion}}']),
  wsl: () => probeRunnable('wsl.exe', ['-e', 'sh', '-c', 'exit 0']),
};

/** 从环境变量读默认沙箱配置（多余空格容忍一下，配置写错不要等到执行时才炸） */
export function sandboxDefaults(env = process.env) {
  const text = (value) => String(value ?? '').trim();
  const pids = Number.parseInt(text(env.SANDBOX_PIDS) || '256', 10);
  // --jail（Node 权限模型）里已经有一层更强的边界，而且那个受限进程内探测不到
  // Windows PowerShell；这时默认用 local（策略层），免得所有请求都被“后端不可用”挡住。
  const inJail = text(env.SANDBOX_JAIL) === '1' || detectRuntimeJail().active;
  return {
    scope: text(env.SANDBOX_SCOPE) || 'workspace',
    mode: text(env.SANDBOX_MODE) || 'write',
    backend: text(env.SANDBOX_BACKEND) || (isWin && !inJail ? 'windows' : 'local'),
    customRoots: (text(env.SANDBOX_ROOTS) || '').split(/[;\n]+/).map((r) => r.trim()).filter(Boolean),
    strict: text(env.SANDBOX_STRICT) !== '0',
    image: text(env.SANDBOX_IMAGE) || 'oven/bun:1.4.2-alpine',
    memoryLimit: text(env.SANDBOX_MEMORY) || '1g',
    cpuLimit: text(env.SANDBOX_CPUS) || '2',
    pidsLimit: Number.isFinite(pids) && pids > 0 ? Math.min(pids, 4096) : 256,
    // all | off | whitelist | blacklist（兼容旧写法 1/0）
    network: text(env.SANDBOX_NETWORK) || 'all',
    networkList: (text(env.SANDBOX_NETWORK_LIST) || '').split(/[,;\s\n]+/).map((h) => h.trim()).filter(Boolean),
  };
}
