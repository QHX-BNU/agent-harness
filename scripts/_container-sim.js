// 用「容器里那套环境变量」真启动一次 server，确认能起来并响应（宿主机上没有 Docker 时的替代验证）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.join(os.tmpdir(), 'ctr-sim');
const workspace = path.join(root, 'workspace');
const data = path.join(root, 'data');
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'README.md'), '# 容器模拟工作区\n');

const PORT = 5275;
const env = {
  ...process.env,
  HOST: '0.0.0.0',
  PORT: String(PORT),
  WORKSPACE: workspace,
  SESSIONS_DIR: path.join(data, '.sessions'),
  TRASH_DIR: path.join(data, '.sessions-trash'),
  ARTIFACTS_DIR: path.join(data, '.artifacts'),
  MEMORY_DIR: path.join(data, '.memory'),
  WORKFLOWS_DIR: path.resolve('workflows'),
  SANDBOX_SCOPE: 'workspace',
  SANDBOX_BACKEND: 'local',
  APPROVAL_MODE: 'auto',
  PROVIDER: 'mock',
};

const child = spawn(process.execPath, ['server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let up = false;
for (let i = 0; i < 30; i++) {
  await wait(500);
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/config`);
    if (r.ok) {
      up = true;
      const cfg = await r.json();
      console.log('✓ 服务起来了（按容器环境变量）');
      console.log(`  workspace = ${cfg.workspace}`);
      console.log(`  provider  = ${cfg.provider} · model ${cfg.model}`);
      break;
    }
  } catch {
    /* 还没起来 */
  }
}

if (up) {
  const tools = await (await fetch(`http://127.0.0.1:${PORT}/api/tools`)).json();
  console.log(`  工具      = ${tools.tools.length} 个`);
  const ws = await (await fetch(`http://127.0.0.1:${PORT}/api/workspaces`)).json();
  console.log(`  工作区列表 = ${ws.items.map((w) => `${w.name}(${w.path})`).join(', ')}`);
  const chat = await fetch(`http://127.0.0.1:${PORT}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '列一下工作区', approvalMode: 'auto' }),
  });
  const text = await chat.text();
  const toolResult = [...text.matchAll(/data: (\{.*?\})\n/g)].map((m) => JSON.parse(m[1])).find((e) => e.type === 'tool_result');
  console.log(`  真跑一轮  = ${toolResult ? toolResult.content.replace(/\n/g, ' ').slice(0, 70) : '（没拿到工具结果）'}`);
  console.log(`  数据目录  = ${fs.existsSync(path.join(data, '.sessions')) ? '已创建 ✓' : '未创建 ✗'}`);
} else {
  console.log('✗ 服务没起来，日志：');
  console.log(log.slice(-1500));
}

child.kill('SIGTERM');
await wait(800);
try {
  child.kill('SIGKILL');
} catch {
  /* 已经退出 */
}
process.exit(up ? 0 : 1);
