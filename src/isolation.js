// 隔离等级：说清楚「现在到底有没有真沙箱」，别让界面和文档含糊过去。
//
// 三个等级（强 → 弱）：
//   container  容器/虚拟机：docker / wsl 后端，操作系统级隔离，最强
//   runtime    运行时强制：Node 权限模型（--permission）生效，fs/子进程由 V8 运行时拒绝
//   policy     仅策略：路径作用域 + 命令扫描 + 环境变量清洗 —— 可被绕过，不是安全边界
//
// 这个模块只做「探测与如实描述」，不做任何承诺。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isWin = process.platform === 'win32';

/** Node 权限模型是否生效，以及它到底管住了什么 */
export function detectRuntimeJail() {
  const has = process.permission?.has;
  if (typeof has !== 'function') {
    return { active: false, reason: '没有用 --permission 启动（Node 权限模型未生效）' };
  }
  // 拿一个几乎肯定不在白名单里的系统路径来探
  const outside = isWin ? 'C:\\Windows' : '/etc';
  const outsideReadable = has.call(process.permission, 'fs.read', outside);
  const canSpawn = has.call(process.permission, 'child_process');
  const canWorker = has.call(process.permission, 'worker');
  const canAddons = has.call(process.permission, 'addons');
  return {
    active: !outsideReadable,
    // 权限模型开着但白名单过大（连系统目录都放行）时，等于没关住
    overPermissive: outsideReadable,
    canReadOutside: outsideReadable,
    canSpawn,
    canWorker,
    canAddons,
    reason: outsideReadable ? '权限模型在跑，但白名单放得太宽（系统目录都能读）' : 'Node 权限模型生效',
  };
}

/** 从允许的根目录集合生成一份人话说明 */
export function describeJail({ roots = [], writable = [] } = {}) {
  const jail = detectRuntimeJail();
  if (!jail.active) return { level: 'policy', jail, roots, writable };
  return { level: 'runtime', jail, roots, writable };
}

/**
 * 计算 jail 启动参数：把代码目录、工作区、数据目录分别放进读/写白名单。
 *
 * 坑（实测）：Windows 上 --allow-fs-* 的路径**必须用正斜杠**，反斜杠写法一律不匹配
 * （即使目录存在也会 ERR_ACCESS_DENIED），所以这里统一转成 / 再传。
 * @returns {{ flags: string[], read: string[], write: string[], allowShell: boolean }}
 */
export function jailFlags({ appDir, workspace, dataPaths = [], allowShell = false, tmpDir = null }) {
  const toFlag = (p) => (isWin ? path.resolve(p).replace(/\\/g, '/') : path.resolve(p));

  const read = new Set([appDir, workspace, ...dataPaths]);
  const write = new Set([workspace, ...dataPaths]); // 注意：代码目录不在写白名单里
  const tmp = tmpDir || os.tmpdir();
  read.add(tmp);
  write.add(tmp);

  const flags = ['--permission'];
  for (const p of read) if (p && fs.existsSync(p)) flags.push(`--allow-fs-read=${toFlag(p)}`);
  for (const p of write) if (p && (fs.existsSync(p) || fs.existsSync(path.dirname(p)))) flags.push(`--allow-fs-write=${toFlag(p)}`);
  // 默认**不给**子进程权限：这样 run_shell 会被运行时直接拒绝，agent 的操作才真的关在工作区里
  if (allowShell) flags.push('--allow-child-process');
  return { flags, read: [...read], write: [...write], allowShell };
}

/** 给界面/接口用的总览 */
export function isolationSummary({ sandbox = null, runtimeJail = null } = {}) {
  const jail = runtimeJail || detectRuntimeJail();
  const backend = sandbox?.backend || 'local';
  let level = 'policy';
  let label = '仅策略（不是真沙箱）';
  let detail = '路径作用域 + 命令扫描 + 环境变量清洗。可以被脚本内容、编码命令、管道等方式绕过。';

  if (backend === 'docker' || backend === 'wsl') {
    level = 'container';
    label = `容器隔离（${backend}）`;
    detail = '命令在容器/子系统里执行，文件系统与进程与主机隔离。';
  } else if (jail.active && !jail.overPermissive) {
    level = 'runtime';
    label = '运行时强制（Node 权限模型）';
    detail = jail.canSpawn
      ? '文件读写由 Node 运行时强制执行，超出白名单直接 ERR_ACCESS_DENIED；但允许了子进程，shell 里的操作仍可绕过。'
      : '文件读写由 Node 运行时强制执行，且禁止派生进程 —— agent 的文件操作与命令都被真正关住。';
  }
  return { level, label, detail, runtimeJail: jail, backend };
}
