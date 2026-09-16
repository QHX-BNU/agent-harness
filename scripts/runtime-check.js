// 运行环境自检；在 Bun 容器里还会验证容器标记与 Bun 运行时。
// 用法：node scripts/runtime-check.js（容器内用 bun scripts/runtime-check.js）
//
// 检查项：运行时 / 工作区 / 数据目录 / 端口 / 沙箱边界 / 工具链（文件读写 + 命令执行）
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { config } from '../src/config.js';
import { createSandbox } from '../src/sandbox.js';
import { detectContainerRuntime } from '../src/isolation.js';
import { createToolRegistry } from '../src/tools/index.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
};
const section = (t) => console.log(`\n${t}`);

section('[1] 运行时');
{
  const major = Number(process.versions.node.split('.')[0]);
  ok('Node 版本 ≥ 18', major >= 18, `v${process.versions.node}`);
  if (process.env.MINI_HARNESS_CONTAINER === '1') {
    const container = detectContainerRuntime();
    ok('官方 Bun 运行时正在执行', Boolean(process.versions.bun), process.versions.bun || process.execPath);
    ok('检测到真实容器证据', container.active, `${container.engine || 'unknown'} · ${container.marker || 'no marker'}`);
  }
  ok('代码目录可读', fs.existsSync(path.resolve('server.js')) && fs.existsSync(path.resolve('src/loop.js')));
  ok('公共资源可读', fs.existsSync(path.resolve('public/index.html')) && fs.existsSync(path.resolve('public/app.js')));
  ok('工作流目录存在', fs.existsSync(config.workflowsDir), config.workflowsDir);
  ok('/tmp 可写（产物与临时文件要用）', (() => {
    try {
      const f = path.join(os.tmpdir(), `.check-${Date.now()}`);
      fs.writeFileSync(f, 'x');
      fs.unlinkSync(f);
      return true;
    } catch {
      return false;
    }
  })(), os.tmpdir());
}

section('[2] 工作区与数据目录');
{
  ok('工作区存在且是目录', (() => {
    try {
      return fs.statSync(config.workspace).isDirectory();
    } catch {
      return false;
    }
  })(), config.workspace);

  const probe = (dir, label) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, `.check-${Date.now()}`);
      fs.writeFileSync(f, 'x');
      fs.unlinkSync(f);
      ok(`${label} 可写`, true, dir);
      return true;
    } catch (err) {
      ok(`${label} 可写`, false, `${dir} · ${err.code || err.message}`);
      return false;
    }
  };
  const wsWritable = probe(config.workspace, '工作区');
  if (!wsWritable) console.log('      （只读也可以跑，但 agent 不能落盘改动）');
  probe(config.sessionsDir, '会话目录');
  probe(config.trashDir, '回收站目录');
  probe(config.artifactsDir, '产物目录');
  probe(config.memoryDir, '记忆目录');

  ok('工作区不是空的', (() => {
    try {
      return fs.readdirSync(config.workspace).length > 0;
    } catch {
      return false;
    }
  })(), '（空工作区通常是忘了挂载项目目录）');
}

section('[3] 端口');
{
  const port = config.port;
  const canBind = await new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, config.host);
  });
  let existingHarness = false;
  if (!canBind) {
    try {
      const probeHost = ['0.0.0.0', '::'].includes(config.host) ? '127.0.0.1' : config.host;
      const response = await fetch(`http://${probeHost}:${port}/api/config`, { signal: AbortSignal.timeout(1500) });
      const body = await response.json();
      existingHarness = response.ok && typeof body === 'object' && body !== null && 'provider' in body;
    } catch {
      existingHarness = false;
    }
  }
  ok(
    `端口 ${config.host}:${port} 可用`,
    canBind || existingHarness,
    canBind ? '可监听' : existingHarness ? '已有 mini-harness 正在监听' : '被其它程序占用或权限不足',
  );
  const container = detectContainerRuntime();
  if (container.active || process.env.MINI_HARNESS_CONTAINER === '1') {
    ok('容器监听地址可从宿主访问', config.host === '0.0.0.0' || config.host === '::', `HOST=${config.host}`);
  } else {
    ok('宿主机监听地址不会意外暴露公网', ['127.0.0.1', 'localhost', '::1'].includes(config.host), `HOST=${config.host}`);
  }
}

section('[4] 沙箱边界');
{
  const sb = createSandbox({ ...(config.sandbox || {}), scope: 'workspace', workspace: config.workspace, mode: 'write' });
  const inside = sb.resolve('inside-check.txt', { forWrite: true });
  ok('工作区内路径放行', inside.startsWith(config.workspace), path.relative(config.workspace, inside) || '.');
  let denied = false;
  try {
    sb.resolve('../outside-check.txt', { forWrite: true });
  } catch {
    denied = true;
  }
  ok('越界路径（../）被拒绝', denied);
  let deniedAbs = false;
  try {
    sb.resolve(process.platform === 'win32' ? 'C:/Windows/win.ini' : '/etc/passwd');
  } catch {
    deniedAbs = true;
  }
  ok('系统路径被拒绝', deniedAbs, process.platform === 'win32' ? 'C:/Windows/win.ini' : '/etc/passwd');

  const cmd = sb.checkCommand('cd .. && ls');
  ok('命令里的父目录穿越被拦', cmd.ok === false, cmd.reason || '');
  const danger = sb.checkCommand('rm -rf /');
  ok('危险命令被拦', danger.ok === false, danger.reason || '');
}

section('[5] 工具链（真跑一次）');
{
  const tools = createToolRegistry();
  const session = { id: 'runtime-check', workspaceId: 'default' };
  const ctx = {
    session,
    config,
    workspaceId: 'default',
    sandbox: createSandbox({
      ...(config.sandbox || {}),
      scope: 'workspace',
      workspace: config.workspace,
      mode: 'write',
      tempDir: path.join(config.sessionsDir, '..', '.sandbox-tmp'),
      sessionId: session.id,
    }),
    emit: () => {},
  };

  const target = path.join(config.workspace, '.runtime-check.txt');
  const w = await tools.execute('write_file', { path: '.runtime-check.txt', content: 'hello from runtime\n' }, ctx);
  ok('write_file 能写工作区', w.ok && fs.existsSync(target), w.ok ? path.basename(target) : w.content.slice(0, 60));

  const r = await tools.execute('read_file', { path: '.runtime-check.txt' }, ctx);
  ok('read_file 能读回来', r.ok && /hello from runtime/.test(r.content));

  const l = await tools.execute('list_dir', { path: '.' }, ctx);
  ok('list_dir 能列目录', l.ok && l.content.includes('runtime-check.txt'));

  const sh = await tools.execute('run_shell', { command: 'echo runtime-shell-ok' }, ctx);
  ok('run_shell 能执行命令', sh.ok && /runtime-shell-ok/.test(sh.content), (sh.content.split('\n')[1] || '').slice(0, 40));

  try {
    fs.unlinkSync(target);
  } catch {
    /* 只读工作区时忽略 */
  }
  try {
    fs.rmSync(path.join(config.artifactsDir, session.id), { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}

console.log(`\n${fail === 0 ? '✓' : '✗'} 运行环境自检: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
