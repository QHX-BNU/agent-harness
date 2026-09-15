// 真沙箱验收：在 Node 权限模型下跑 harness，然后从**外部接口**尝试各种逃逸。
//
// 与其他测试的区别：这里不调内部函数，而是启动一个真的 jail 进程，走 HTTP API 派活，
// 证明「agent 的操作确实被运行时关住了」，而不是「我们的正则写得比较严」。
//
// 用法: node scripts/jail-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 5391;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'JAIL-SECRET-OUTSIDE-7c1f';

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jailtest-'));
const ws = path.join(tmp, 'ws');
const data = path.join(tmp, 'data');
fs.mkdirSync(ws, { recursive: true });
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(ws, 'inside.txt'), 'INSIDE\n');
fs.writeFileSync(path.join(tmp, 'outside-secret.txt'), `${SECRET}\n`);
fs.writeFileSync(path.join(ws, 'probe.js'), `console.log(require('fs').readFileSync(${JSON.stringify(path.join(tmp, 'outside-secret.txt'))},'utf8'))\n`);

// ---------- 启动 jail 进程 ----------
// 数据目录也放到临时目录，避免用到上一次运行残留的 .workspaces.json（那会把工作区指到 jail 外面）
const child = spawn(process.execPath, [path.join(HERE, 'scripts', 'jail.js'), '--workspace', ws], {
  cwd: HERE,
  env: {
    ...process.env,
    PORT: String(PORT),
    APPROVAL_MODE: 'auto',
    PROVIDER: 'mock',
    SESSIONS_DIR: path.join(data, '.sessions'),
    TRASH_DIR: path.join(data, '.sessions-trash'),
    ARTIFACTS_DIR: path.join(data, '.artifacts'),
    MEMORY_DIR: path.join(data, '.memory'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));

const cleanup = () => {
  try {
    child.kill('SIGTERM');
  } catch {
    /* 已退出 */
  }
  setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 忽略 */
    }
  }, 2000);
  setTimeout(() => fs.rmSync(tmp, { recursive: true, force: true }), 2500);
};
process.on('exit', cleanup);

// ---------- 等就绪 ----------
let up = false;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  try {
    const r = await fetch(`${BASE}/api/config`);
    if (r.ok) {
      up = true;
      break;
    }
  } catch {
    /* 还没起来 */
  }
}
if (!up) {
  console.log('✗ jail 进程没起来，输出：');
  console.log(log.slice(-1200));
  process.exit(1);
}

/** 通过 API 真跑一轮，返回事件数组 */
async function turn(message) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, approvalMode: 'auto' }),
  });
  const text = await res.text();
  return text
    .split('\n\n')
    .map((f) => f.split('\n').find((l) => l.startsWith('data:')))
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l.slice(5));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const toolText = (evs) => evs.filter((e) => e.type === 'tool_result').map((e) => String(e.content)).join('\n');

// ---------- 1. 隔离等级自报 ----------
section('[1] 隔离等级自报（不能自欺欺人）');
{
  const cfg = await (await fetch(`${BASE}/api/sandbox`)).json();
  const iso = cfg.isolation;
  ok('接口如实报告隔离等级', iso?.level === 'runtime', `${iso?.level} · ${iso?.label}`);
  ok('说明里点明文件读写由运行时强制', /运行时强制/.test(iso?.detail || ''), (iso?.detail || '').slice(0, 40));
  ok('识别出禁止派生进程', iso?.runtimeJail?.canSpawn === false);
  ok('确认工作区外读不到', iso?.runtimeJail?.canReadOutside === false);
}

// ---------- 2. 工作区内的正常操作必须照常 ----------
section('[2] 工作区内操作正常（沙箱不能把自己弄瘸）');
{
  const evs = await turn('读取 inside.txt 的内容');
  ok('工作区内读文件正常', /INSIDE/.test(toolText(evs)), toolText(evs).replace(/\n/g, ' ').slice(0, 50));

  const w = await turn('创建 out.txt 文件，内容写 hello-jail');
  ok('工作区内写文件正常', w.some((e) => e.type === 'tool_result' && e.ok), 'write_file');
}

// ---------- 3. 策略层能挡的（和以前一样）----------
section('[3] 路径越界（策略层 + 运行时双重）');
{
  const evs = await turn(`读取 ${path.join(tmp, 'outside-secret.txt').replace(/\\/g, '/')}`);
  const txt = toolText(evs);
  ok('读工作区外被拒绝', !txt.includes(SECRET) && /沙箱拒绝|不存在/.test(txt), txt.replace(/\n/g, ' ').slice(0, 60));
}

// ---------- 4. 策略层挡不住、只有运行时能挡的 ----------
section('[4] 上次能绕过的三招，现在被运行时挡住');
{
  // 招数一：把 payload 写进脚本文件再执行（命令行里看不出任何越界路径）
  const evs = await turn('运行命令 node probe.js');
  const txt = toolText(evs);
  ok('「写脚本再执行」不再泄漏', !txt.includes(SECRET), txt.replace(/\n/g, ' ').slice(0, 90));
  ok('拒绝原因是运行时权限模型', /权限模型|派生进程/.test(txt), '');

  // 招数二/三：编码命令、管道喂解释器 —— 本质都要派生进程
  const b64 = Buffer.from('echo hi', 'utf16le').toString('base64');
  const evs2 = await turn(`执行命令 powershell -NoProfile -EncodedCommand ${b64}`);
  ok('base64 编码命令同样被拒', /权限模型|派生进程|沙箱拒绝/.test(toolText(evs2)), toolText(evs2).replace(/\n/g, ' ').slice(0, 60));

  // 哪怕完全无害的命令，也一样派不出去（因为运行时直接禁了 spawn）
  const evs3 = await turn('运行一条命令 echo harmless');
  ok('无害命令也被运行时拒绝（spawn 本身被禁）', /权限模型|派生进程/.test(toolText(evs3)), toolText(evs3).replace(/\n/g, ' ').slice(0, 60));
}

// ---------- 5. 失败要留痕 ----------
section('[5] 审计与痕迹');
{
  const sessions = await (await fetch(`${BASE}/api/sessions`)).json();
  ok('会话正常落盘（数据目录在白名单内）', sessions.length > 0, `${sessions.length} 个会话`);
  const last = sessions[0];
  if (last) {
    const ev = await (await fetch(`${BASE}/api/sessions/${last.id}/events?limit=200`)).json();
    const denied = (ev.events || []).filter((e) => e.type === 'sandbox_denied' || e.type === 'tool_result');
    ok('拒绝过程留在 trace 里可查', denied.length > 0, `${denied.length} 条相关事件`);
  }
}

console.log(`\n${fail === 0 ? '✓' : '✗'} 真沙箱验收: ${pass} 通过 / ${fail} 失败`);
cleanup();
await sleep(1200);
process.exit(fail === 0 ? 0 : 1);
