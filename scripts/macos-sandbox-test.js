// macOS 轻量沙箱（sandbox-exec / Seatbelt）真实行为测试。
//
// 用法: node scripts/macos-sandbox-test.js
// 非 macOS 或 sandbox-exec 不可用时：打印原因并跳过（exit 0）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createSandbox, backendAvailable } from '../src/sandbox.js';

if (process.platform !== 'darwin') {
  console.log(`跳过：sandbox-exec 只在 macOS 上可用（当前平台 ${process.platform}）`);
  process.exit(0);
}
if (!backendAvailable.seatbelt()) {
  console.log('跳过：当前系统里找不到可用的 sandbox-exec（可能被 SIP / 企业策略禁用）');
  process.exit(0);
}

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'macos-sandbox-'));
const ws = path.join(tmp, 'ws');
fs.mkdirSync(ws, { recursive: true });
const secret = path.join(tmp, 'outside-secret.txt');
const SECRET = 'TOP-SECRET-OUTSIDE-WORKSPACE-4f19';
fs.writeFileSync(secret, `${SECRET}\n`, 'utf8');
fs.writeFileSync(path.join(ws, 'inside.txt'), 'inside ok\n', 'utf8');

const run = (sandbox, command) => {
  const spec = sandbox.buildExec(command, { cwd: ws });
  const r = spawnSync(spec.file, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

try {
  section('[1] 文件系统：读全域、只有工作区可写');
  {
    const sb = createSandbox({ scope: 'workspace', workspace: ws, mode: 'write', backend: 'seatbelt', network: 'all' });
    const write = run(sb, 'echo hello-seatbelt > out.txt && cat out.txt');
    ok('工作区内可写', write.code === 0 && write.out.includes('hello-seatbelt'));
    ok('写入落在宿主机工作区', fs.existsSync(path.join(ws, 'out.txt')));

    const escape = run(sb, `echo pwned > ${secret}`);
    ok('工作区外写入被 Seatbelt 拒绝', escape.code !== 0, escape.out.trim().split('\n').slice(-1)[0]?.slice(0, 80));
    ok('越界写没有改到原文件', fs.readFileSync(secret, 'utf8').includes(SECRET));

    const readAll = run(sb, `cat ${secret}`);
    ok('沙箱里可以读整机（Claude Code 同语义）', readAll.code === 0 && readAll.out.includes(SECRET));
  }

  section('[2] 只读模式');
  {
    const sb = createSandbox({ scope: 'workspace', workspace: ws, mode: 'readonly', backend: 'seatbelt' });
    const ro = run(sb, 'echo nope > ro.txt');
    ok('只读模式写被拒', ro.code !== 0 && !fs.existsSync(path.join(ws, 'ro.txt')));
    const readOk = run(sb, 'cat inside.txt');
    ok('只读模式读正常', readOk.code === 0 && readOk.out.includes('inside ok'));
  }

  section('[3] 网络：off 拒绝出网');
  {
    const sb = createSandbox({ scope: 'workspace', workspace: ws, mode: 'write', backend: 'seatbelt', network: 'off' });
    const conn = run(
      sb,
      'node -e "const n=require(\'net\');const c=n.connect({host:\'1.1.1.1\',port:443});c.on(\'connect\',()=>process.exit(9));c.on(\'error\',()=>process.exit(0));setTimeout(()=>process.exit(0),2500)"',
    );
    ok('对外 TCP 连接被拒（exit≠9）', conn.code !== 9, `exit=${conn.code}`);
  }

  section('[4] 不支持的能力要明确拒绝，不伪装');
  {
    let threw = '';
    try {
      createSandbox({ scope: 'workspace', workspace: ws, backend: 'seatbelt', network: 'whitelist', networkList: ['example.com'] });
    } catch (err) {
      threw = err.message;
    }
    ok('白/黑名单模式直接拒绝', /不支持/.test(threw), threw.slice(0, 80));
  }
} finally {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响测试结论 */
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
