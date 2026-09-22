// Linux 轻量沙箱后端：bubblewrap（bwrap）。
//
// 这是 Claude Code / Codex 在 Linux 上的同款思路 —— 不拉容器、不要守护进程、不要 root，
// 只用内核 namespace + bind mount 拼出边界：
//
//   读   ：整机只读（--ro-bind / /）—— 和这两个工具一样，读系统文件不是威胁模型
//   写   ：只有授权根目录可写（--bind <root> <root>）；/tmp 换成私有目录，宿主 /tmp 不进沙箱
//   进程 ：独立 PID/UTS/IPC namespace、--die-with-parent、--new-session（防 TIOCSTI 注入）
//   网络 ：off  → --unshare-net（沙箱里根本没有网络接口）
//          all  → 共享宿主网络
//          白/黑名单 → --unshare-net + 宿主 unix socket 代理 + 沙箱内 socat 桥：
//                      沙箱里连不到任何外部地址，只能连 127.0.0.1 上的桥，桥后面是按
//                      策略放行的代理（Claude Code 同款做法）。
//
// 不假装的部分（写进 describe，让界面说实话）：
//   * bubblewrap 没有 cgroup 配额，内存/CPU 上限在这里不生效；进程数用 `ulimit -u` 兜底。
//   * 白/黑名单模式要求宿主有 socat，缺了就明确拒绝执行，不会静默降级成 all。
import fs from 'node:fs';
import { probe, probeRunnable, capture } from './probe.js';

export const BWRAP_BIN = 'bwrap';
export const BWRAP_INSTALL_HINT =
  'Debian/Ubuntu: sudo apt install bubblewrap · Fedora: sudo dnf install bubblewrap · Arch: sudo pacman -S bubblewrap';

/** 沙箱内代理桥监听的端口（netns 是隔离的，不会和宿主撞端口） */
export const BWRAP_BRIDGE_PORT = 3128;

let capsCache = null;

/** bwrap 的开关随版本变化（--new-session 0.5+、--unshare-cgroup-try 0.6+），先问 --help 再决定 */
export function bwrapCapabilities() {
  if (capsCache) return capsCache;
  const help = capture(BWRAP_BIN, ['--help'], 4000) || '';
  capsCache = {
    newSession: help.includes('--new-session'),
    unshareCgroupTry: help.includes('--unshare-cgroup-try'),
    dieWithParent: help.includes('--die-with-parent'),
  };
  return capsCache;
}

/**
 * 探测 bwrap 是否真能用：装了不够 —— 不少发行版默认禁掉非特权 user namespace
 * （Ubuntu 23.10+ 的 AppArmor 限制、容器里缺 CAP_SYS_ADMIN 等），必须真跑一次
 * 一个「只读根 + 新 PID namespace」的最小沙箱来确认。
 */
export function bwrapAvailable() {
  if (process.platform !== 'linux') return false;
  return probeRunnable(
    BWRAP_BIN,
    [
      '--unshare-pid',
      '--unshare-uts',
      '--unshare-ipc',
      '--ro-bind',
      '/',
      '/',
      '--dev',
      '/dev',
      '--proc',
      '/proc',
      '--',
      '/bin/true',
    ],
    6000,
  );
}

/** 给界面/文档看的一句诊断：不可用时要说清楚为什么 */
export function bwrapDiagnostics() {
  if (process.platform !== 'linux') return { ok: false, reason: 'bubblewrap 只在 Linux 上可用' };
  if (!probe(BWRAP_BIN)) return { ok: false, reason: `没装 bubblewrap（${BWRAP_INSTALL_HINT}）` };
  if (!bwrapAvailable()) {
    return {
      ok: false,
      reason: 'bubblewrap 已安装，但建不出 namespace（内核或发行版禁用了非特权 user namespace，或进程缺少必要权限）',
    };
  }
  return { ok: true, reason: 'bubblewrap 可用' };
}

/** 网络白/黑名单的桥需要 socat（宿主与沙箱同一个 rootfs，所以探宿主即可） */
export function socatAvailable() {
  return probe('socat');
}

/**
 * 构造一条完整的 bwrap argv。
 *
 * 纯函数：不探测、不碰文件系统，方便在 Windows/macOS 上单测参数是否正确，
 * 真实能力探测交给 bwrapAvailable()/bwrapCapabilities()。
 *
 * @param {object} input
 * @param {string} input.command        用户命令（以 argv 传递，不做字符串拼接，避免转义漏洞）
 * @param {string} input.cwd            沙箱内工作目录（宿主绝对路径，沙箱里路径一致）
 * @param {string[]} input.roots        授权根目录；write 模式下只有这些目录可写
 * @param {'write'|'readonly'} input.mode
 * @param {'all'|'off'|'whitelist'|'blacklist'} input.network
 * @param {{socketPath:string,port?:number}|null} input.bridge 白/黑名单的 unix socket 桥
 * @param {string|null} input.tmpDir    私有 /tmp 的来源目录（不存在则退回 tmpfs）
 * @param {number} input.pidsLimit      进程数上限（0 = 不设）
 * @param {object} input.capabilities   来自 bwrapCapabilities()
 * @param {string[]} input.setenv       ['K=V', ...] 需要覆盖的环境变量
 * @returns {{file:string,args:string[],writable:string[],bridge:object|null}}
 */
export function buildBwrapPlan({
  command,
  cwd,
  roots = [],
  mode = 'write',
  network = 'all',
  bridge = null,
  tmpDir = null,
  pidsLimit = 0,
  capabilities = {},
  setenv = [],
} = {}) {
  const caps = { newSession: true, unshareCgroupTry: true, dieWithParent: true, ...capabilities };
  const args = [];

  // --- 进程边界 ---
  if (caps.dieWithParent) args.push('--die-with-parent');
  if (caps.newSession) args.push('--new-session');
  args.push('--unshare-pid', '--unshare-uts', '--unshare-ipc');
  if (caps.unshareCgroupTry) args.push('--unshare-cgroup-try');

  // --- 文件系统：整机只读，再把授权根写开 ---
  args.push('--ro-bind', '/', '/');
  args.push('--dev', '/dev', '--proc', '/proc');
  // /dev/shm 通常是宿主共享内存，换成私有的，避免跨进程留下东西
  args.push('--tmpfs', '/dev/shm');

  // 可写根先 bind；/tmp 放在后面 bind，保证它是私有的那个（顺序 = 挂载顺序）
  const writable = mode === 'write' ? roots.filter(Boolean) : [];
  for (const root of writable) args.push('--bind', root, root);

  // /tmp 换成私有目录：沙箱里的 /tmp 与宿主 /tmp 不再共享内容。
  // 注意：这意味着代理桥的 socket 不能放在宿主 /tmp 下面（沙箱里会看不见），
  // pickBridgeSocketPath() 已经把这个约束考虑进去了。
  if (tmpDir && fs.existsSync(tmpDir)) args.push('--bind', tmpDir, '/tmp');
  else args.push('--tmpfs', '/tmp');

  // --- 网络 ---
  if (bridge) {
    // 完全断网 + 只暴露一个 unix socket：沙箱里唯一能连出去的路就是策略代理
    args.push('--unshare-net');
    args.push('--ro-bind', bridge.socketPath, bridge.socketPath);
  } else if (network === 'off') {
    args.push('--unshare-net');
  }

  // --- 环境变量覆盖（bwrap 继承 spawn 的 env，这里只覆盖需要按沙箱改的）---
  for (const item of setenv) {
    const eq = String(item).indexOf('=');
    if (eq <= 0) continue;
    args.push('--setenv', String(item).slice(0, eq), String(item).slice(eq + 1));
  }

  args.push('--chdir', cwd);

  // --- 命令：用 argv 传，不拼字符串 ---
  const script = [];
  if (Number(pidsLimit) > 0) script.push(`ulimit -u ${Math.floor(Number(pidsLimit))} 2>/dev/null || true`);
  if (bridge) {
    const port = Number(bridge.port) || BWRAP_BRIDGE_PORT;
    // loopback 在新 netns 里默认是 down 的，先拉起来（失败也不中断：断了网更安全）
    script.push('ip link set lo up >/dev/null 2>&1 || true');
    // socat 把沙箱内 127.0.0.1:port 桥到宿主的策略代理 socket
    script.push(
      `socat TCP-LISTEN:${port},bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:${bridge.socketPath} >/dev/null 2>&1 &`,
    );
    script.push('sleep 0.1');
  }
  script.push('exec /bin/sh -c "$1"');
  args.push('--', '/bin/sh', '-c', script.join('\n'), 'harness-sh', String(command));

  return { file: BWRAP_BIN, args, writable, bridge };
}
