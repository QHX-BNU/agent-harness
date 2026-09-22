// 可执行文件探测：只回答两件事 ——「装没装」和「真能不能跑」。
//
// 单独成模块是为了让所有沙箱后端（bubblewrap / sandbox-exec / docker / wsl）共用同一套
// 语义与缓存：装了但守护进程没起、发行版没装、内核禁了 user namespace，都算「不可用」，
// 由调用方失败关闭，绝不静默回落。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const isWin = process.platform === 'win32';

/** PATH 里是否存在这个可执行文件（Windows 补 PATHEXT；绝对路径直接看文件） */
export function probe(cmd) {
  const name = String(cmd || '');
  if (!name) return false;
  if (path.isAbsolute(name)) {
    try {
      return fs.existsSync(name);
    } catch {
      return false;
    }
  }
  const exts = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    if (!d) continue;
    for (const ext of exts) {
      try {
        if (fs.existsSync(path.join(d, name + ext))) return true;
      } catch {
        /* 不可读的目录跳过 */
      }
    }
  }
  return false;
}

const runCache = new Map();

/** 真的跑一下再下结论；结果缓存，避免每条命令都 fork 一次 */
export function probeRunnable(cmd, args = [], timeoutMs = 4000) {
  const key = `${cmd}\0${args.join('\0')}`;
  if (runCache.has(key)) return runCache.get(key);
  let result = false;
  if (probe(cmd)) {
    try {
      const r = spawnSync(cmd, args, { timeout: timeoutMs, stdio: 'ignore', windowsHide: true });
      result = r.status === 0;
    } catch {
      result = false;
    }
  }
  runCache.set(key, result);
  return result;
}

/** 跑一条命令拿输出（读 `bwrap --help` 之类的能力清单用）；失败返回 null */
export function capture(cmd, args = [], timeoutMs = 4000) {
  if (!probe(cmd)) return null;
  try {
    const r = spawnSync(cmd, args, { timeout: timeoutMs, encoding: 'utf8', windowsHide: true });
    const text = `${r.stdout || ''}${r.stderr || ''}`;
    return text || null;
  } catch {
    return null;
  }
}

/** 测试/配置变更后用得上：把探测缓存清掉重新判断 */
export function resetProbeCache() {
  runCache.clear();
}
