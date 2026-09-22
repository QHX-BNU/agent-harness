// macOS 轻量沙箱后端：sandbox-exec（Seatbelt）。
//
// Claude Code 在 macOS 上用的就是这个 —— 内核强制、系统自带、不需要安装任何东西。
// 边界模型与 bwrap 对齐：默认拒绝一切；允许读全域、派生进程；写只给授权根目录（+ 可写临时目录）；
// 网络按策略整体放行/拒绝。
//
// 限制（如实写进界面，不装）：Seatbelt 的过滤器是路径/操作级的，没有「按主机名放行」的能力，
// 所以白名单/黑名单模式在这里明确不支持 —— 要么 all，要么 off。
import { probe } from './probe.js';

export const SEATBELT_BIN = 'sandbox-exec';

/** macOS 系统自带，只要进程能在 PATH 里找到它就算可用 */
export function seatbeltAvailable() {
  return process.platform === 'darwin' && probe(SEATBELT_BIN);
}

/** Seatbelt profile 里的字符串字面量转义（路径里出现引号/反斜杠时不能把 profile 拆坏） */
function sbplLiteral(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * 生成 SBPL profile。
 * 纯字符串函数，方便在任何平台上单测（真实执行只在 macOS 上发生）。
 */
export function buildSeatbeltProfile({
  writable = [],
  tmpPaths = [],
  network = 'all',
  allowProcessInfo = true,
} = {}) {
  const lines = ['(version 1)', '(deny default)'];
  lines.push('(allow process-fork)');
  lines.push('(allow process-exec*)');
  if (allowProcessInfo) lines.push('(allow process-info*)');
  lines.push('(allow signal (target self))');
  lines.push('(allow sysctl-read)');
  // 系统调用要靠 mach 服务（DNS、日志、钥匙串之外的常规服务）；不允许的话几乎所有程序都跑不起来
  lines.push('(allow mach-lookup)');
  lines.push('(allow ipc-posix-shm)');
  lines.push('(allow file-read*)');

  const writeRoots = [...new Set([...writable, ...tmpPaths].filter(Boolean))];
  if (writeRoots.length) {
    lines.push(`(allow file-write* ${writeRoots.map((p) => `(subpath ${sbplLiteral(p)})`).join(' ')})`);
  }
  // 标准流与空设备：只读模式也必须能写，否则命令连 echo 都做不到
  lines.push(
    `(allow file-write-data ${['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty', '/dev/dtracehelper']
      .map((p) => `(literal ${sbplLiteral(p)})`)
      .join(' ')})`,
  );

  if (network === 'all') lines.push('(allow network*)');
  return `${lines.join('\n')}\n`;
}

/**
 * 构造 sandbox-exec 的 argv。
 * 用户命令以 argv 传入（`/bin/sh -c <command>`），profile 只由本函数生成，不掺用户输入。
 */
export function buildSeatbeltPlan({ command, cwd, roots = [], mode = 'write', network = 'all', tmpPaths = [] } = {}) {
  const profile = buildSeatbeltProfile({
    writable: mode === 'write' ? roots : [],
    // 只读模式不给临时目录写权限：语义就是「一个字节都不许落盘」
    tmpPaths: mode === 'write' ? tmpPaths : [],
    network,
  });
  return {
    file: SEATBELT_BIN,
    args: ['-p', profile, '/bin/sh', '-c', String(command)],
    cwd,
    writable: mode === 'write' ? roots : [],
  };
}
