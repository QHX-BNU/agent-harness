// 沙箱「是不是真的沙箱」——用真实逃逸尝试来回答，而不是看代码猜。
//
// 每个用例都去读一个**工作区之外**的诱饵文件（outside-secret.txt）。
// 判定标准很简单：读到了内容 = 逃逸成功（BYPASS），被拦住或读不到 = 挡住了。
//
// 用法: node scripts/sandbox-breach-test.js [--verbose]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSandbox } from '../src/sandbox.js';
import { createToolRegistry } from '../src/tools/index.js';

const VERBOSE = process.argv.includes('--verbose');
const SECRET = 'TOP-SECRET-OUTSIDE-WORKSPACE-9f3a';

// 布局：tmp/outside-secret.txt（工作区之外）与 tmp/ws/（工作区）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'breach-'));
const ws = path.join(tmp, 'ws');
fs.mkdirSync(ws, { recursive: true });
fs.writeFileSync(path.join(tmp, 'outside-secret.txt'), `${SECRET}\n`, 'utf8');
fs.writeFileSync(path.join(ws, 'inside.txt'), 'inside ok\n', 'utf8');

const sandbox = createSandbox({
  scope: 'workspace',
  workspace: ws,
  mode: 'write',
  strict: true,
  backend: 'local',
});
const tools = createToolRegistry();
const ctx = {
  session: { id: 'breach', workspaceId: 'default' },
  sandbox,
  config: { workspace: ws },
  workspaceId: 'default',
  emit: () => {},
};

const outside = path.join(tmp, 'outside-secret.txt');
const results = [];

const check = (name, text) => text.includes(SECRET);

async function attempt(name, note, run) {
  let out = '';
  let threw = '';
  try {
    out = String(await run());
  } catch (err) {
    threw = err.message;
  }
  const leaked = check(name, out) || check(name, threw);
  results.push({ name, note, leaked, detail: (out || threw).replace(/\s+/g, ' ').slice(0, 110) });
}

const sh = (command) => tools.execute('run_shell', { command }, ctx).then((r) => r.content);
const read = (p) => tools.execute('read_file', { path: p }, ctx).then((r) => r.content);
const write = (p, content) => tools.execute('write_file', { path: p, content }, ctx).then((r) => r.content);

console.log(`工作区: ${ws}`);
console.log(`诱饵文件: ${outside}\n`);

// ---------- 1. 直接来（路径级检查应该挡住）----------
await attempt('read_file 直接写绝对路径', '路径作用域检查', () => read(outside));
await attempt('run_shell 里写绝对路径', 'token 扫描', () => sh(`Get-Content "${outside}"`));
await attempt('run_shell 用 ../ 穿越', 'token 扫描 + resolve', () => sh('Get-Content ..\\outside-secret.txt'));
await attempt('run_shell 用正斜杠绝对路径', 'token 扫描', () => sh(`type ${outside.replace(/\\/g, '/')}`));

// ---------- 2. 变量 / 环境变量间接引用（扫描器明说不处理）----------
await attempt('PowerShell 变量拼接', '$p=...; Get-Content $p', () => sh(`$p='${outside}'; Get-Content $p`));
await attempt('分成两段拼接（C: + 剩余）', '把绝对路径拆成不像路径的片段', () =>
  sh(`$a='C'+':'; $b='\\Windows\\win.ini'; Get-Content ($a+$b) | Select-Object -First 3`),
);
await attempt('用 $env:SystemRoot 间接引用', '扫描器看 token 像相对路径就放行', () =>
  sh('Get-Content $env:SystemRoot\\..\\..\\Users\\Public\\..\\..\\Windows\\win.ini -TotalCount 1'),
);
await attempt('用 $env:TEMP 走出去', '环境变量指向工作区之外', () =>
  sh('Set-Content $env:TEMP\\breach-probe.txt "x"; Get-Content $env:TEMP\\breach-probe.txt'),
);

// ---------- 3. 编码 / 间接执行（扫描器只看命令行文本）----------
await attempt('把 payload 写进文件再执行', '文件内容不经过命令扫描', async () => {
  await write('probe.js', `const fs=require('fs');console.log(fs.readFileSync(${JSON.stringify(outside)},'utf8'));\n`);
  return sh('node probe.js');
});
await attempt('base64 编码的命令', 'EncodedCommand 解出来才看得见', () => {
  const payload = `Get-Content '${outside}'`;
  const b64 = Buffer.from(payload, 'utf16le').toString('base64');
  return sh(`powershell -NoProfile -EncodedCommand ${b64}`);
});
await attempt('用 cmd /c 绕一层', 'cmd 内建命令', () => sh(`cmd /c type "${outside}"`));
await attempt('通过管道喂给解释器', 'payload 不落在命令行里', () => {
  const b64 = Buffer.from(`Get-Content '${outside}'`, 'utf16le').toString('base64');
  return sh(`"${b64}" | ForEach-Object { powershell -NoProfile -EncodedCommand $_ }`);
});

// ---------- 4. 子系统 / 挂载点 ----------
await attempt('用 \\\\?\\ 前缀绕规范化', 'Windows 扩展路径前缀', () => sh(`Get-Content "\\\\?\\${outside}"`));
await attempt('用 8.3 短名', '短文件名规范化差异', () => sh('Get-Content C:\\PROGRA~1\\..\\Windows\\win.ini -TotalCount 1'));

// ---------- 5. 网络（网络策略是否生效）----------
const netProbe = await tools.execute('run_shell', { command: 'curl -s -m 5 https://example.com' }, ctx).then((r) => r.content);
results.push({
  name: 'curl 外网',
  note: /沙箱拒绝/.test(netProbe) ? '被网络策略拦住' : '当前策略放行（SANDBOX_NETWORK=all）',
  leaked: false,
  detail: netProbe.replace(/\s+/g, ' ').slice(0, 90),
});

// ---------- 结果 ----------
console.log('逃逸尝试结果：\n');
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0)));
console.log(`  ${pad('用例', 34)}${pad('结果', 12)}说明`);
console.log(`  ${'-'.repeat(34)}${'-'.repeat(12)}${'-'.repeat(28)}`);
for (const r of results) {
  console.log(`  ${pad(r.name, 34)}${pad(r.leaked ? 'BYPASS ⚠' : '挡住 ✓', 12)}${r.note}`);
  if (VERBOSE) console.log(`      → ${r.detail}`);
}

const bypassed = results.filter((r) => r.leaked);
console.log(`\n挡住 ${results.length - bypassed.length} / ${results.length}，绕过 ${bypassed.length}`);
console.log(
  bypassed.length
    ? `\n结论：local 后端是**策略沙箱**，不是内核沙箱。下面这些能绕过去，别把它当安全边界：\n${bypassed.map((r) => `  - ${r.name}`).join('\n')}`
    : '\n结论：本轮尝试全部被挡住（但仍是策略沙箱，不等于内核隔离）',
);

fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
