// 沙箱层：决定 agent 到底能碰到什么。
//
// 设计原则（很重要，别自欺欺人）：
//   1. 这是「策略沙箱」不是内核沙箱。Node 无法在没有原生扩展的情况下给子进程降权，
//      所以本地后端靠三件事收口：路径作用域、命令扫描、环境变量清洗。
//   2. 能真正隔离的后端（docker / wsl）做成可插拔的，缺工具时明确报「不可用」并回落，
//      绝不假装隔离成功。
//   3. 每一次放行/拒绝都进审计（trace + 会话里可查），否则沙箱等于没有。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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

export function createSandbox({
  scope = 'workspace',
  customRoots = [],
  mode = 'write',
  backend = 'local',
  workspace = process.cwd(),
  strict = true,
  image = 'alpine:3',
  network = false,
  tempDir = null,
  emit = null,
  sessionId = null,
} = {}) {
  if (!SCOPE_PRESETS[scope]) throw new SandboxError(`未知作用区域 "${scope}"`, { rule: 'config' });
  if (!MODES[mode]) throw new SandboxError(`未知权限模式 "${mode}"`, { rule: 'config' });

  const roots = (() => {
    if (scope === 'workspace') return [path.resolve(workspace)];
    if (scope === 'home') return [path.resolve(os.homedir())];
    if (scope === 'full') return [path.parse(path.resolve(workspace)).root];
    const list = (Array.isArray(customRoots) ? customRoots : String(customRoots).split(/[;\n]+/))
      .map((r) => String(r).trim())
      .filter(Boolean)
      .map((r) => path.resolve(r));
    return list.length ? list : [path.resolve(workspace)];
  })();

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

    if (!strict || scope === 'full') {
      record({ action: 'allow', rule: 'scope', target: cmd.slice(0, 200), tool });
      return { ok: true };
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
    if (tempDir) {
      fs.mkdirSync(tempDir, { recursive: true });
      env.TEMP = tempDir;
      env.TMP = tempDir;
      env.TMPDIR = tempDir;
    }
    return { ...env, ...extra };
  }

  /** 构造真正要 spawn 的东西 */
  function buildExec(command, { cwd = roots[0], tool = 'run_shell' } = {}) {
    const cwdAbs = resolve(cwd, { tool });

    if (backend === 'docker') {
      const args = ['run', '--rm', '-i', '--network', network ? 'bridge' : 'none'];
      args.push('-v', mode === 'readonly' ? `${roots[0]}:/work:ro` : `${roots[0]}:/work`, '-w', '/work');
      if (image) args.push(image);
      args.push('sh', '-lc', command);
      return { file: 'docker', args, cwd: process.cwd(), env: cleanEnv(), backend: 'docker', cwdAbs };
    }

    if (backend === 'wsl') {
      // 把 Windows 路径转成 /mnt/<drive>/... 形式
      const toWsl = (p) => {
        const m = /^([a-zA-Z]):[\\/](.*)$/.exec(path.resolve(p));
        return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : path.resolve(p).replace(/\\/g, '/');
      };
      return {
        file: 'wsl.exe',
        args: ['-e', 'sh', '-lc', `cd '${toWsl(cwdAbs)}' && ${command}`],
        cwd: process.cwd(),
        env: cleanEnv(),
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
          env: cleanEnv(),
          backend: 'local',
          cwdAbs,
        }
      : { file: '/bin/sh', args: ['-c', command], cwd: cwdAbs, env: cleanEnv(), backend: 'local', cwdAbs };
  }

  return {
    scope,
    mode,
    backend,
    strict,
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
    /** 给 UI / API 用的快照 */
    describe() {
      return {
        scope,
        scopeLabel: SCOPE_PRESETS[scope].label,
        mode,
        modeLabel: MODES[mode].label,
        backend,
        strict,
        image,
        network,
        roots,
        sessionId,
        denials: denials.slice(-20),
        auditCount: auditLog.length,
        presets: Object.entries(SCOPE_PRESETS).map(([id, p]) => ({ id, ...p })),
        modes: Object.entries(MODES).map(([id, m]) => ({ id, ...m })),
        backends: [
          { id: 'local', label: '本地策略沙箱', available: true, note: '路径作用域 + 命令扫描 + 环境变量清洗；不是内核隔离' },
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
            note: 'Linux 用户态隔离，但 /mnt/c 仍映射到 Windows 磁盘',
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
  local: () => true,
  docker: () => probeRunnable('docker', ['info', '--format', '{{.ServerVersion}}']),
  wsl: () => probeRunnable('wsl.exe', ['-e', 'sh', '-c', 'exit 0']),
};

/** 从环境变量读默认沙箱配置 */
export function sandboxDefaults(env = process.env) {
  return {
    scope: env.SANDBOX_SCOPE || 'workspace',
    mode: env.SANDBOX_MODE || 'write',
    backend: env.SANDBOX_BACKEND || 'local',
    customRoots: (env.SANDBOX_ROOTS || '').split(/[;\n]+/).filter(Boolean),
    strict: env.SANDBOX_STRICT !== '0',
    image: env.SANDBOX_IMAGE || 'alpine:3',
    network: env.SANDBOX_NETWORK === '1',
  };
}
