// 真沙箱启动器：用 Node 权限模型（--permission）跑 harness。
//
//   node scripts/jail.js                     # 严格：文件操作被运行时关在工作区内，禁止派生进程（没有 shell 工具）
//   node scripts/jail.js --allow-shell       # 允许 shell（注意：子进程不受权限模型约束，隔离会降级）
//   node scripts/jail.js --workspace D:\proj # 指定工作区
//
// 为什么这样做：local 后端是「策略沙箱」，靠路径判断和命令扫描，可以被绕过（见 sandbox-breach-test）。
// 权限模型是运行时强制的：工作区之外的 fs 调用会直接抛 ERR_ACCESS_DENIED，跟正则没关系。
// 要更强的隔离（含子进程）用 docker/wsl 后端，或者把整个 harness 放进容器/虚拟机。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { jailFlags } from '../src/isolation.js';

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

/**
 * 权限模型只有 Node 有：Bun 不认 --permission，用它启动等于「假装开了沙箱」。
 * 所以这里必须找到真正的 node，找不到就明确报错，而不是悄悄降级。
 */
function findNodeRuntime() {
  const isNode = (p) => {
    if (!p) return false;
    const r = spawnSync(p, ['-e', 'process.stdout.write(process.versions.bun ? "bun" : "node")'], { encoding: 'utf8' });
    return r.status === 0 && (r.stdout || '').trim() === 'node';
  };
  if (!process.versions.bun && isNode(process.execPath)) return { exe: process.execPath, how: '当前进程就是 Node' };
  for (const cand of [findOnPath('node'), process.env.NODE_BIN, 'C:/Program Files/nodejs/node.exe']) {
    if (isNode(cand)) return { exe: cand, how: `找到 ${cand}` };
  }
  return null;
}

function findOnPath(name) {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
  if (probe.status !== 0) return null;
  return (probe.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || null;
}

const allowShell = flag('--allow-shell') || process.env.SANDBOX_JAIL_SHELL === '1';
const workspace = path.resolve(value('--workspace', process.env.WORKSPACE || process.cwd()));

// 数据目录同样要放进白名单，否则会话/记忆/产物都写不进去
const dataPaths = [
  process.env.SESSIONS_DIR || path.join(HERE, '.sessions'),
  process.env.TRASH_DIR || path.join(HERE, '.sessions-trash'),
  process.env.ARTIFACTS_DIR || path.join(HERE, '.artifacts'),
  process.env.MEMORY_DIR || path.join(HERE, '.memory'),
  path.join(HERE, '.channels'),
  path.join(HERE, '.sandbox-tmp'),
  path.join(HERE, '.workspaces.json'),
  path.join(HERE, '.runtime-model.json'),
  path.join(HERE, 'runtime'),
].map((p) => path.resolve(p));

const { flags, read, write } = jailFlags({ appDir: HERE, workspace, dataPaths, allowShell });

// 白名单之外的已保存工作区会让 agent 的工具莫名失败，启动时先说清楚
const allowed = (p) => write.some((w) => {
  const rel = path.relative(path.resolve(w), path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
});
try {
  const wsFile = path.resolve(process.env.SESSIONS_DIR || path.join(HERE, '.sessions'), '..', '.workspaces.json');
  if (fs.existsSync(wsFile)) {
    const saved = JSON.parse(fs.readFileSync(wsFile, 'utf8')).workspaces || [];
    const outside = saved.filter((w) => !allowed(w.path));
    if (outside.length) {
      console.log('  ⚠ 这些已保存的工作区不在本次白名单内，在里面干活会被拒绝：');
      for (const w of outside) console.log(`      ${w.name}  →  ${w.path}`);
      console.log('    用 --workspace 指定它，或把它的父目录加进来。\n');
    }
  }
} catch {
  /* 读不出来就算了 */
}

const runtime = findNodeRuntime();
if (!runtime) {
  console.error('✗ 找不到 Node 运行时，无法启用权限模型。');
  console.error('  Node 的 --permission 是这套真隔离的实现基础，Bun 不支持它。');
  console.error('  装一个 Node（≥20）再来，或者改用 docker / wsl 沙箱后端。');
  process.exit(2);
}

console.log('真沙箱启动（Node 权限模型）');
console.log(`  运行时          : ${runtime.exe}  (${runtime.how})`);
console.log(`  代码目录（只读）: ${HERE}`);
console.log(`  工作区（可读写）: ${workspace}`);
console.log(`  数据目录（可写）: ${dataPaths.length} 个`);
console.log(`  派生进程        : ${allowShell ? '允许 ⚠（shell 里的操作不受权限模型约束）' : '禁止 ✓（run_shell 会被运行时拒绝）'}`);
console.log(`  读白名单        : ${read.length} 项`);
console.log(`  写白名单        : ${write.length} 项`);
console.log('');

const child = spawn(runtime.exe, [...flags, path.join(HERE, 'server.js')], {
  cwd: HERE,
  stdio: 'inherit',
  env: { ...process.env, WORKSPACE: workspace, SANDBOX_JAIL: '1' },
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));

// 让 --check 之类的调用能提前退出
void fs;
void os;
