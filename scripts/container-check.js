// 容器内自检：确认这个容器真的能跑 harness（而不是只是进程起来了）。
// 用法（容器里）：node scripts/container-check.js
//
// 检查项：运行时 / 工作区 / 数据目录 / 端口 / 沙箱边界 / 工具链（文件读写 + 命令执行）
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { config } from '../src/config.js';
import { createSandbox } from '../src/sandbox.js';
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
  ok(`能监听 ${config.host}:${port}`, canBind, canBind ? '' : '端口被占用或权限不足（容器里要用 HOST=0.0.0.0）');
  ok('监听地址适合容器（0.0.0.0 或 ::）', config.host === '0.0.0.0' || config.host === '::', `HOST=${config.host}（127.0.0.1 在容器里外部访问不到）`);
}

section('[4] 沙箱边界');
{
  const sb = createSandbox({ scope: 'workspace', workspace: config.workspace, mode: 'write' });
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
  const session = { id: 'container-check', workspaceId: 'default' };
  const ctx = {
    session,
    config,
    workspaceId: 'default',
    sandbox: createSandbox({ scope: 'workspace', workspace: config.workspace, mode: 'write' }),
    emit: () => {},
  };

  const target = path.join(config.workspace, '.container-check.txt');
  const w = await tools.execute('write_file', { path: '.container-check.txt', content: 'hello from container\n' }, ctx);
  ok('write_file 能写工作区', w.ok && fs.existsSync(target), w.ok ? path.basename(target) : w.content.slice(0, 60));

  const r = await tools.execute('read_file', { path: '.container-check.txt' }, ctx);
  ok('read_file 能读回来', r.ok && /hello from container/.test(r.content));

  const l = await tools.execute('list_dir', { path: '.' }, ctx);
  ok('list_dir 能列目录', l.ok && l.content.includes('container-check.txt'));

  const sh = await tools.execute('run_shell', { command: 'echo container-shell-ok' }, ctx);
  ok('run_shell 能执行命令', sh.ok && /container-shell-ok/.test(sh.content), (sh.content.split('\n')[1] || '').slice(0, 40));

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

console.log(`\n${fail === 0 ? '✓' : '✗'} 容器自检: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
