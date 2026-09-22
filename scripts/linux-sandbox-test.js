// Linux 轻量沙箱（bubblewrap）真实行为测试：不猜代码，直接去越界一次看挡不挡得住。
//
// 用法: node scripts/linux-sandbox-test.js
// 非 Linux、没装 bubblewrap、或内核禁了非特权 user namespace 时：打印原因并跳过（exit 0）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';

import { createSandbox } from '../src/sandbox.js';
import { bwrapDiagnostics, socatAvailable } from '../src/sandbox/bwrap.js';

if (process.platform !== 'linux') {
  console.log(`跳过：bubblewrap 只能在 Linux 上运行（当前平台 ${process.platform}）`);
  process.exit(0);
}
const diag = bwrapDiagnostics();
if (!diag.ok) {
  console.log(`跳过：${diag.reason}`);
  console.log('  安装后重跑：sudo apt install bubblewrap（Debian/Ubuntu）');
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-sandbox-'));
const ws = path.join(tmp, 'ws');
fs.mkdirSync(ws, { recursive: true });
const secret = path.join(tmp, 'outside-secret.txt');
const SECRET = 'TOP-SECRET-OUTSIDE-WORKSPACE-7c21';
fs.writeFileSync(secret, `${SECRET}\n`, 'utf8');
fs.writeFileSync(path.join(ws, 'inside.txt'), 'inside ok\n', 'utf8');

/** 真的把 bwrap 计划跑起来 */
const run = (sandbox, command, { cwd = ws } = {}) => {
  const spec = sandbox.buildExec(command, { cwd });
  const r = spawnSync(spec.file, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, spec };
};

try {
  // ================= 1. 读写边界 =================
  section('[1] 文件系统边界：整机只读、只有工作区可写');
  {
    const sb = createSandbox({ scope: 'workspace', workspace: ws, mode: 'write', backend: 'bwrap', network: 'all' });

    const write = run(sb, 'echo hello-bwrap > out.txt && cat out.txt');
    ok('工作区内可写', write.code === 0 && write.out.includes('hello-bwrap'));
    ok('写入真的落在宿主机工作区', fs.existsSync(path.join(ws, 'out.txt')));

    const escape = run(sb, `echo pwned > ${secret}`);
    ok('工作区外写入被内核拒绝', escape.code !== 0, escape.out.trim().split('\n').slice(-1)[0]?.slice(0, 80));
    ok('越界写没有改到原文件', fs.readFileSync(secret, 'utf8').includes(SECRET));

    const relativeEscape = run(sb, 'echo pwned > ../outside-secret.txt');
    ok('相对路径穿越写也被拒', relativeEscape.code !== 0);

    const readAll = run(sb, `cat ${secret}`);
    ok('沙箱里可以读整机（Claude Code / Codex 同语义）', readAll.code === 0 && readAll.out.includes(SECRET));

    const homeWrite = run(sb, `echo x > ${path.join(os.homedir(), 'mh-bwrap-escape.txt')}`);
    ok('家目录写入被拒（不在作用区域内）', homeWrite.code !== 0 && !fs.existsSync(path.join(os.homedir(), 'mh-bwrap-escape.txt')));
  }

  // ================= 2. 只读模式 =================
  section('[2] 只读模式：一个字节都不许落盘');
  {
    const sb = createSandbox({ scope: 'workspace', workspace: ws, mode: 'readonly', backend: 'bwrap', network: 'all' });
    const ro = run(sb, 'echo nope > ro.txt');
    ok('只读模式写被拒', ro.code !== 0 && !fs.existsSync(path.join(ws, 'ro.txt')));
    const readOk = run(sb, 'cat inside.txt');
    ok('只读模式读正常', readOk.code === 0 && readOk.out.includes('inside ok'));
  }

  // ================= 3. 网络边界 =================
  section('[3] 网络：off 是真断网');
  {
    const sb = createSandbox({ scope: 'workspace', workspace: ws, mode: 'write', backend: 'bwrap', network: 'off' });
    // 有一张网卡就说明没断干净；lo 是沙箱自己的（会 up 起来给代理桥用）
    const ifaces = run(sb, 'ls /sys/class/net');
    const names = ifaces.out.split(/\s+/).filter(Boolean);
    ok('独立 network namespace 里没有对外网卡', ifaces.code === 0 && names.every((n) => n === 'lo'), names.join(','));
    const conn = run(
      sb,
      'node -e "const n=require(\'net\');const c=n.connect({host:\'1.1.1.1\',port:80});c.on(\'connect\',()=>process.exit(9));c.on(\'error\',()=>process.exit(0));setTimeout(()=>process.exit(0),2500)"',
    );
    ok('对外 TCP 连接失败（exit≠9）', conn.code !== 9, `exit=${conn.code}`);
  }

  // ================= 4. 白名单：强制代理桥 =================
  section('[4] 白名单 + socat 代理桥（沙箱唯一出网通道）');
  if (!socatAvailable()) {
    console.log('  · 跳过：机器上没有 socat（bwrap 白/黑名单模式会明确拒绝执行）');
  } else {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('proxy-bridge-ok');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const sb = createSandbox({
      scope: 'workspace',
      workspace: ws,
      mode: 'write',
      backend: 'bwrap',
      network: 'whitelist',
      networkList: [`127.0.0.1:${port}`],
    });
    await sb.ready();

    const allowed = run(sb, `node -e "fetch('http://127.0.0.1:${port}/').then(r=>r.text()).then(t=>{console.log(t);process.exit(0)}).catch(e=>{console.log('ERR '+e.message);process.exit(1)})"`);
    ok('白名单内的主机可以连（经代理桥）', allowed.code === 0 && allowed.out.includes('proxy-bridge-ok'), allowed.out.trim().slice(0, 100));

    const blocked = run(sb, 'node -e "fetch(\'https://example.com/\').then(()=>process.exit(9)).catch(()=>process.exit(0))"');
    ok('白名单外的主机被拒（不是伪装成功）', blocked.code === 0, `exit=${blocked.code}`);

    const direct = run(
      sb,
      'node -e "const n=require(\'net\');const c=n.connect({host:\'1.1.1.1\',port:443});c.on(\'connect\',()=>process.exit(9));c.on(\'error\',()=>process.exit(0));setTimeout(()=>process.exit(0),2500)"',
    );
    ok('绕过代理直连被断网挡住', direct.code !== 9);

    const desc = sb.describe();
    ok('快照如实标记代理桥已绑定', desc.proxy?.bridge?.bound === true, JSON.stringify(desc.proxy?.bridge));
    server.close();
  }

  // ================= 5. 进程与资源边界 =================
  section('[5] 进程边界：独立 PID namespace + 进程数上限');
  {
    const sb = createSandbox({ scope: 'workspace', workspace: ws, mode: 'write', backend: 'bwrap', network: 'off', pidsLimit: 24 });
    const p1 = run(sb, 'cat /proc/1/comm');
    ok('沙箱内 PID 1 不是宿主 init', p1.code === 0 && !/systemd|init/i.test(p1.out), p1.out.trim());
    const many = run(sb, 'for i in $(seq 1 200); do sleep 5 & done; wait');
    ok('进程数上限生效（200 个子进程被 ulimit 拦住）', many.code !== 0, `exit=${many.code}`);
  }

  // ================= 6. 失败关闭 =================
  section('[6] 失败关闭：拒绝把整个文件系统设为可写');
  {
    let threw = '';
    try {
      createSandbox({ scope: 'full', workspace: ws, mode: 'write', backend: 'bwrap' }).buildExec('ls');
    } catch (err) {
      threw = err.message;
    }
    ok('scope=full + write 直接拒绝', /拒绝/.test(threw), threw.slice(0, 80));
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
