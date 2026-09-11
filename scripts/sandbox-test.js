// 沙箱专项测试：作用区域 / 权限 / 命令扫描 / 环境变量清洗 / 后端构造 / 审计 / HTTP / 界面。
// 用法: node scripts/sandbox-test.js [baseUrl]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSandbox, SCOPE_PRESETS, probe } from '../src/sandbox.js';
import { createToolRegistry } from '../src/tools/index.js';
import { openPage } from './cdp.js';

const BASE = process.argv[2] || 'http://127.0.0.1:5175';
const WS = path.resolve('.');
const HOME = os.homedir();

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
const denied = (fn) => {
  try {
    const r = fn();
    return r && r.ok === false ? true : false;
  } catch {
    return true;
  }
};

// ================= 1. 作用区域 =================
section('[1] 作用区域（用户可选）');
{
  const ws = createSandbox({ scope: 'workspace', workspace: WS });
  ok('仅工作区：区域内放行', ws.resolve('package.json').endsWith('package.json'));
  ok('仅工作区：区域外拒绝', denied(() => ws.resolve(path.join(HOME, '.ssh', 'id_rsa'))));
  ok('仅工作区：绝对路径越界拒绝', denied(() => ws.resolve(isWinPath() ? 'C:\\Windows\\win.ini' : '/etc/passwd')));

  const home = createSandbox({ scope: 'home', workspace: WS });
  ok('用户主目录：主目录内放行', home.resolve(path.join(HOME, 'Desktop')) === path.resolve(HOME, 'Desktop'));
  ok('用户主目录：系统目录仍拒绝', denied(() => home.resolve(isWinPath() ? 'C:\\Windows\\win.ini' : '/etc/passwd')));

  const extra = path.join(os.tmpdir(), 'sb-extra-root');
  fs.mkdirSync(extra, { recursive: true });
  const custom = createSandbox({ scope: 'custom', customRoots: [WS, extra], workspace: WS });
  ok('自定义：两个根目录都放行', custom.resolve('package.json') && custom.resolve(path.join(extra, 'x.txt')));
  ok('自定义：根目录之外拒绝', denied(() => custom.resolve(path.join(HOME, 'nope.txt'))));
  ok('自定义：没有给根目录时回落工作区', createSandbox({ scope: 'custom', customRoots: [], workspace: WS }).roots[0] === WS);

  const full = createSandbox({ scope: 'full', workspace: WS });
  ok('整个文件系统：任意路径放行', full.resolve(path.join(HOME, 'anything.txt')));

  ok('四种作用区域都有中文说明', Object.values(SCOPE_PRESETS).every((p) => p.label && p.description));
}

// ================= 2. 权限（只读） =================
section('[2] 权限：只读 / 可写');
{
  const ro = createSandbox({ scope: 'workspace', workspace: WS, mode: 'readonly' });
  ok('只读：读文件放行', ro.resolve('package.json'));
  ok('只读：写文件拒绝', denied(() => ro.resolve('x.txt', { forWrite: true })));
  ok('只读：重定向命令拒绝', denied(() => ro.checkCommand('echo hi > a.txt')));
  ok('只读：rm 拒绝', denied(() => ro.checkCommand('rm -r node_modules')));
  ok('只读：git push 拒绝', denied(() => ro.checkCommand('git push origin main')));
  ok('只读：npm install 拒绝', denied(() => ro.checkCommand('npm install left-pad')));
  ok('只读：只读命令仍放行', ro.checkCommand('node -v').ok === true);

  const rw = createSandbox({ scope: 'workspace', workspace: WS, mode: 'write' });
  ok('可写：写命令放行', rw.checkCommand('mkdir tmp-dir').ok === true);
}

// ================= 3. 命令扫描 =================
section('[3] 命令扫描（本地后端的核心）');
{
  const sb = createSandbox({ scope: 'workspace', workspace: WS });
  ok('区域内命令放行', sb.checkCommand('node -v').ok);
  ok('区域内相对路径放行', sb.checkCommand('node scripts/smoke.js').ok);
  ok('区域外绝对路径拒绝', denied(() => sb.checkCommand(isWinPath() ? 'type C:\\Windows\\win.ini' : 'cat /etc/passwd')));
  ok('父目录穿越拒绝', denied(() => sb.checkCommand('cd .. && ls')));
  ok('家目录引用拒绝', denied(() => sb.checkCommand('ls ~/.ssh')));
  ok('赋值形式也拦', denied(() => sb.checkCommand(`cat ${path.join(HOME, '.gitconfig')}`)));
  ok('危险命令硬拦', denied(() => sb.checkCommand('rm -rf /')));
  ok('关机命令硬拦', denied(() => sb.checkCommand('shutdown /s')));
  ok('改权限硬拦', denied(() => sb.checkCommand('icacls . /grant Everyone:F')));
  ok('URL 不误判', sb.checkCommand('curl https://example.com/a/b').ok);
  ok('NUL/dev-null 不误判', sb.checkCommand(isWinPath() ? 'echo hi > NUL' : 'echo hi > /dev/null').ok);
  ok('参数里的路径也检查', denied(() => sb.checkCommand(`node -e "require('fs').readFileSync('${path.join(HOME, 'x')}')"`)));

  const loose = createSandbox({ scope: 'workspace', workspace: WS, strict: false });
  ok('strict=false：不再扫路径', loose.checkCommand('type C:\\Windows\\win.ini').ok === true);
  ok('strict=false：危险命令仍然拦', denied(() => loose.checkCommand('rm -rf /')));
}

// ================= 4. 环境变量清洗 =================
section('[4] 环境变量清洗（不把密钥暴露给子进程）');
{
  const sb = createSandbox({ scope: 'workspace', workspace: WS, tempDir: path.join(os.tmpdir(), 'sb-tmp') });
  process.env.SANDBOX_TEST_SECRET = 'topsecret';
  const env = sb.cleanEnv();
  ok('密钥类变量被剔除', env.SANDBOX_TEST_SECRET === undefined);
  ok('PATH 保留（否则命令跑不起来）', Boolean(env.PATH));
  ok('HOME 被指到作用区域', env.HOME === WS);
  ok('TEMP 被指到沙箱临时目录', String(env.TEMP).includes('sb-tmp'));
}

// ================= 5. 后端构造 =================
section('[5] 执行后端（local / docker / wsl）');
{
  const sb = createSandbox({ scope: 'workspace', workspace: WS });
  const local = sb.buildExec('node -v');
  ok('local 后端可执行文件正确', local.backend === 'local' && /powershell|sh/.test(local.file), local.file);
  ok('local 后端 cwd 在作用区域内', local.cwd === WS, local.cwd);

  const docker = createSandbox({ scope: 'workspace', workspace: WS, backend: 'docker', image: 'alpine:3' }).buildExec('ls');
  ok('docker 后端构造出挂载参数', docker.file === 'docker' && docker.args.includes('-v') && docker.args.some((a) => a.endsWith(':/work')));
  ok('docker 后端默认禁网', docker.args.includes('--network') && docker.args.includes('none'));
  ok('docker 后端带镜像', docker.args.includes('alpine:3'));
  const roDocker = createSandbox({ scope: 'workspace', workspace: WS, backend: 'docker', mode: 'readonly' }).buildExec('ls');
  ok('docker 只读时挂载 :ro', roDocker.args.some((a) => a.endsWith(':/work:ro')));

  const wsl = createSandbox({ scope: 'workspace', workspace: WS, backend: 'wsl' }).buildExec('ls');
  ok('wsl 后端把路径映射到 /mnt', wsl.file === 'wsl.exe' && wsl.args.join(' ').includes('/mnt/'));

  const cat = sb.describe();
  ok('后端可用性被如实上报', cat.backends.length === 3 && cat.backends[0].available === true, cat.backends.map((b) => `${b.id}:${b.available}`).join(' '));
  ok('本地后端永远可用', cat.backends.find((b) => b.id === 'local').available === true);
}

// ================= 6. 审计 =================
section('[6] 审计：谁被拦了、为什么');
{
  const events = [];
  const sb = createSandbox({ scope: 'workspace', workspace: WS, emit: (e) => events.push(e) });
  try {
    sb.resolve('C:\\Windows\\win.ini');
  } catch {}
  sb.checkCommand('rm -rf /');
  sb.checkCommand('node -v');
  ok('拒绝被记进 denials', sb.denials.length === 2, JSON.stringify(sb.denials.map((d) => d.rule)));
  ok('拒绝会发事件', events.filter((e) => e.type === 'sandbox_denied').length === 2);
  ok('放行也留痕（audit）', sb.audit.some((a) => a.action === 'allow'));
  ok('拒绝带规则与原因', sb.denials.every((d) => d.rule && d.reason));
}

// ================= 7. 工具层接合 =================
section('[7] 工具层：沙箱真的挡在工具前面');
{
  const tools = createToolRegistry();
  const session = { id: 'sb-test', messages: [], todos: [], state: {} };
  const ctx = { session, sandbox: createSandbox({ scope: 'workspace', workspace: WS }), config: { workspace: WS } };

  const inside = await tools.execute('read_file', { path: 'package.json' }, ctx);
  ok('read_file 区域内成功', inside.ok);

  const outside = await tools.execute('read_file', { path: path.join(HOME, '.gitconfig') }, ctx);
  ok('read_file 区域外被拒', !outside.ok && /沙箱/.test(outside.content), outside.content.slice(0, 60));

  const grepOut = await tools.execute('grep', { pattern: 'root', path: HOME }, ctx);
  ok('grep 区域外被拒', !grepOut.ok && /沙箱/.test(grepOut.content));

  const roCtx = { ...ctx, sandbox: createSandbox({ scope: 'workspace', workspace: WS, mode: 'readonly' }) };
  const writeRo = await tools.execute('write_file', { path: 'x-ro.txt', content: 'nope' }, roCtx);
  ok('只读沙箱下 write_file 被拒', !writeRo.ok && /只读/.test(writeRo.content), writeRo.content.slice(0, 60));

  const shellOk = await tools.execute('run_shell', { command: 'node -v' }, ctx);
  ok('run_shell 正常执行', shellOk.ok && /v24|v2[0-9]/.test(shellOk.content), shellOk.content.split('\n')[0]);

  const shellBad = await tools.execute('run_shell', { command: isWinPath() ? 'type C:\\Windows\\win.ini' : 'cat /etc/passwd' }, ctx);
  ok('run_shell 越界命令被拒', !shellBad.ok === false || /沙箱拒绝/.test(shellBad.content), shellBad.content.slice(0, 60));

  const secret = await tools.execute('run_shell', { command: 'node -e "console.log(process.env.SANDBOX_TEST_SECRET || \'EMPTY\')"' }, ctx);
  ok('子进程看不到密钥变量', /EMPTY/.test(secret.content), secret.content.replace(/\n/g, ' ').slice(0, 60));

  const noSandbox = await tools.execute('read_file', { path: 'package.json' }, { session, config: { workspace: WS } });
  ok('没有沙箱时退回工作区检查', noSandbox.ok);
}

// ================= 8. HTTP + 界面 =================
let createdSessionId = null;
section('[8] HTTP 与界面');
{
  const cat = await (await fetch(`${BASE}/api/sandbox`)).json();
  ok('GET /api/sandbox 返回目录', cat.presets.length === 4 && cat.backends.length === 3, cat.presets.map((p) => p.id).join(','));
  ok('返回默认配置与工作区', Boolean(cat.defaults && cat.workspace));

  const t = await (await fetch(`${BASE}/api/sandbox/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'workspace', mode: 'readonly' }) })).json();
  const byCase = Object.fromEntries(t.results.map((r) => [r.case, r.verdict]));
  ok('自测：区域内读放行', byCase['工作区内读'] === 'allow');
  ok('自测：区域外读拒绝', byCase['工作区外读'] === 'deny');
  ok('自测：越界命令拒绝', byCase['命令：越界路径'] === 'deny');
  ok('自测：危险命令拒绝', byCase['命令：危险命令'] === 'deny');
  ok('自测：只读写操作拒绝', byCase['命令：只读写操作'] === 'deny');

  // 走一轮真实对话，验证沙箱配置进了会话与 trace
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '列一下工作区', approvalMode: 'auto', sandbox: { scope: 'workspace', mode: 'readonly' } }),
  });
  const text = await res.text();
  let sid = null;
  const events = [];
  for (const frame of text.split('\n\n')) {
    const line = frame.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    const ev = JSON.parse(line.slice(5));
    events.push(ev);
    if (ev.type === 'session') sid = ev.sessionId;
  }
  const sbEvent = events.find((e) => e.type === 'sandbox');
  createdSessionId = sid;
  ok('对话里发出 sandbox 事件', Boolean(sbEvent), sbEvent ? `${sbEvent.scope} · ${sbEvent.mode} · ${sbEvent.backend}` : '');
  ok('沙箱配置随请求生效', sbEvent?.mode === 'readonly');
  const sess = await (await fetch(`${BASE}/api/sessions/${sid}/sandbox`)).json();
  ok('会话上记住了沙箱配置', sess.config.mode === 'readonly' && sess.config.scope === 'workspace');
  ok('会话暴露拒绝记录字段', Array.isArray(sess.denials));

  // 界面
  const page = await openPage(BASE, { port: 9338, outDir: 'docs', freshProfile: true });
  const { evalJs, waitFor, shot, sleep } = page;
  try {
    await waitFor(`document.body.dataset.ready === '1'`, '前端就绪');
    await evalJs(`document.getElementById('openSettings').click(); true`);
    await waitFor(`!document.getElementById('settingsModal').hidden`, '设置打开');
    await evalJs(`document.querySelector('.snav[data-sec="sandbox"]').click(); true`);
    await waitFor(`document.getElementById('sec-sandbox').offsetHeight > 0`, '沙箱分区可见');
    const ui = JSON.parse(
      await evalJs(`JSON.stringify({
        scopes: document.getElementById('sbScope').options.length,
        modes: document.getElementById('sbMode').options.length,
        backends: [...document.getElementById('sbBackend').options].map(o => ({v: o.value, off: o.disabled})),
        badge: document.getElementById('sbBadge').textContent,
        preview: document.getElementById('sbPreview').textContent.slice(0, 80),
      })`),
    );
    ok('界面有 4 种作用区域可选', ui.scopes === 4);
    ok('界面有 2 种权限可选', ui.modes === 2);
    ok('界面列出 3 种后端并标注不可用', ui.backends.length === 3 && ui.backends.find((b) => b.v === 'local').off === false, JSON.stringify(ui.backends));
    ok('输入区显示沙箱徽标', /🔒/.test(ui.badge), ui.badge);
    ok('预览显示实际根目录', ui.preview.includes('作用区域'), ui.preview.replace(/\s+/g, ' ').slice(0, 60));

    await evalJs(`(() => { const s = document.getElementById('sbScope'); s.value = 'home'; s.dispatchEvent(new Event('change')); return true; })()`);
    await waitFor(`document.getElementById('sbBadge').textContent.includes('主目录')`, '徽标跟随作用区域变化');
    const rootsHidden = await evalJs(`getComputedStyle(document.getElementById('sbRootsField')).display === 'none'`);
    ok('非自定义作用区域时隐藏自定义根目录输入', rootsHidden);
    await evalJs(`(() => { const s = document.getElementById('sbScope'); s.value = 'custom'; s.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(200);
    ok('切到自定义时显示根目录输入', (await evalJs(`getComputedStyle(document.getElementById('sbRootsField')).display !== 'none'`)) === true);

    await evalJs(`document.getElementById('sbTest').click(); true`);
    await waitFor(`document.getElementById('sbPreview').innerHTML.includes('拒绝')`, '自测结果渲染', 20000);
    const tested = await evalJs(`document.getElementById('sbResult').textContent`);
    ok('界面自测出结果', /\d+\/\d+/.test(tested), tested);
    const shotFile = await shot('ui-sandbox.png');
    console.log(`  ✓ 沙箱设置截图 → ${shotFile}`);
  } finally {
    page.close();
  }
}

if (createdSessionId) await fetch(`${BASE}/api/sessions/${createdSessionId}`, { method: 'DELETE' });

console.log(`\n${fail === 0 ? '✓' : '✗'} 沙箱专项测试: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

function isWinPath() {
  return process.platform === 'win32';
}
