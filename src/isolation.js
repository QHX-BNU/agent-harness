// 隔离等级：说清楚「现在到底有没有真沙箱」，别让界面和文档含糊过去。
//
// 四种边界：
//   container  Docker 后端，或 harness 本身运行在容器里：操作系统级边界
//   os         Windows Restricted Token + capability SID ACL + Job Object
//   runtime    运行时强制：Node 权限模型（--permission）生效，fs/子进程由 V8 运行时拒绝
//   policy     仅策略：路径作用域 + 命令扫描 + 环境变量清洗 —— 可被绕过，不是安全边界
//
// 这个模块只做「探测与如实描述」，不做任何承诺。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isWin = process.platform === 'win32';

/**
 * 探测 harness 进程本身是否位于容器内。
 *
 * 不能只信环境变量（宿主机上随手设一个变量就会让 UI 撒谎），必须同时看到
 * Docker/Podman/Kubernetes 留下的文件或 cgroup 证据。containerHint 只是用来说明
 * 这是本项目镜像，不参与 active 判定。
 */
export function detectContainerRuntime({
  exists = (p) => fs.existsSync(p),
  read = (p) => fs.readFileSync(p, 'utf8'),
  env = process.env,
} = {}) {
  if (isWin) return { active: false, engine: null, marker: null, imageHint: false };

  const imageHint = env.MINI_HARNESS_CONTAINER === '1';
  try {
    if (exists('/.dockerenv')) return { active: true, engine: 'docker', marker: '/.dockerenv', imageHint };
    if (exists('/run/.containerenv')) return { active: true, engine: 'podman', marker: '/run/.containerenv', imageHint };
  } catch {
    /* 继续看 cgroup */
  }

  for (const file of ['/proc/1/cgroup', '/proc/self/cgroup']) {
    try {
      const cgroup = read(file);
      const hit = /(docker|containerd|kubepods|libpod|podman)/i.exec(cgroup);
      if (hit) return { active: true, engine: hit[1].toLowerCase(), marker: file, imageHint };
    } catch {
      /* 这个平台没有 procfs */
    }
  }
  return { active: false, engine: null, marker: null, imageHint };
}

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
export function isolationSummary({
  sandbox = null,
  runtimeJail = null,
  containerRuntime = null,
  backendReady = null,
  controllerExposed = false,
} = {}) {
  const jail = runtimeJail || detectRuntimeJail();
  const container = containerRuntime || detectContainerRuntime();
  const backend = sandbox?.backend || 'local';
  let level = 'policy';
  let label = '仅策略（不是真沙箱）';
  let detail = '路径作用域 + 命令扫描 + 环境变量清洗。可以被脚本内容、编码命令、管道等方式绕过。';

  if (backend === 'windows' && backendReady !== false) {
    level = 'os';
    label = 'Windows 原生写入沙箱';
    detail =
      '模型命令使用受限令牌运行，Windows ACL 把写入限制在已授权根目录，Job Object 限制并收拢整棵进程树；读取仍继承当前用户权限，非 all 网络规则依赖代理，不能阻止刻意绕过代理的直连。';
  } else if (backend === 'docker' && backendReady !== false) {
    level = 'container';
    label = '命令容器隔离（Docker）';
    detail = 'run_shell 命令在独立 Docker 容器里执行；文件工具仍由 harness 进程按路径策略执行。';
  } else if (container.active) {
    level = 'container';
    label = `Harness 容器边界（${container.engine || 'container'}）`;
    detail =
      'Harness 与 shell 都在容器内，宿主机只暴露显式挂载的目录；容器内部的“仅工作区”范围仍由策略层执行，/data 等挂载不属于工作区安全边界。';
  } else if (jail.active && !jail.overPermissive) {
    // 运行时强制要排在「后端不可用」前面：--jail 里就是这层边界在管文件读写，
    // 不能因为配置的 shell 后端探测不到就把它说成「仅策略」。
    level = 'runtime';
    label = '运行时强制（Node 权限模型）';
    detail = jail.canSpawn
      ? '文件读写由 Node 运行时强制执行，超出白名单直接 ERR_ACCESS_DENIED；但允许了子进程，shell 里的操作仍可绕过。'
      : '文件读写由 Node 运行时强制执行，且禁止派生进程 —— agent 的文件操作与命令都被真正关住。';
  } else if (backend === 'windows' && backendReady === false) {
    label = 'Windows 原生沙箱不可用';
    detail = '项目内原生执行器或 Windows PowerShell 不可用；命令会失败关闭，不会静默回落。';
  } else if (backend === 'docker' && backendReady === false) {
    label = 'Docker 后端不可用';
    detail = '配置选择了 Docker，但当前没有可用的 Docker 守护进程；命令不会静默回落到宿主机执行。';
  } else if (backend === 'wsl') {
    label = 'WSL 子系统（非完整隔离）';
    detail = '命令进入 WSL 执行，但 Windows 磁盘挂载和互操作通常仍可访问；它不是与宿主机隔绝的容器边界。';
  }

  // 可写范围包含控制器代码目录时，任何“隔离”描述都不能装作能保护 harness 自己。
  if (controllerExposed) {
    detail +=
      ' ⚠ 当前可写范围包含控制器代码目录（harness 自己的 src/、scripts/、native/ 等）：模型改这里就等于改下次运行的代码，这个边界保护不了控制器自身。';
  }
  return {
    level,
    label,
    detail,
    runtimeJail: jail,
    containerRuntime: container,
    backend,
    backendReady,
    controllerExposed: Boolean(controllerExposed),
  };
}
