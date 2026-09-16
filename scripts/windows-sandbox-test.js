// Windows 原生沙箱的真实边界测试。这里故意直接调用 buildExec，绕过命令字符串扫描，
// 证明最终拒绝来自 Restricted Token + ACL，而不是正则表达式。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { backendAvailable, createSandbox, pickEngineCacheDir } from '../src/sandbox.js';
import { createToolRegistry } from '../src/tools/index.js';

const APP_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

if (process.platform !== 'win32') {
  console.log('⊘ Windows 原生沙箱测试跳过：当前不是 Windows');
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

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-harness-native-test-'));
const workspace = path.join(tmp, 'workspace');
const outside = path.join(tmp, 'outside');
const sandboxTemp = path.join(tmp, 'sandbox-temp');
fs.mkdirSync(workspace);
fs.mkdirSync(outside);
fs.mkdirSync(sandboxTemp);
fs.writeFileSync(path.join(outside, 'readable.txt'), 'outside-readable');
// 沙箱第一次运行之前就存在的文件：ACL 继承必须能覆盖它们，否则 agent 改不了已有代码
const preExisting = path.join(workspace, 'pre-existing.txt');
fs.writeFileSync(preExisting, 'before');

function run(spec, timeout = 30_000) {
  return new Promise((resolve) => {
    const child = spawn(spec.file, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('error', (error) => resolve({ code: null, stdout, stderr, error }));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

try {
  console.log('\n[Windows native sandbox]');
  ok('组件可用', backendAvailable.windows());

  const sandbox = createSandbox({
    scope: 'workspace',
    workspace,
    backend: 'windows',
    mode: 'write',
    tempDir: sandboxTemp,
    memoryLimit: '256m',
    pidsLimit: 32,
  });
  const spec = sandbox.buildExec(`Set-Content -LiteralPath ${quote(path.join(workspace, 'inside.txt'))} -Value 'inside'; Write-Output 'native-ok'`);
  ok('构造的是项目内 Windows 原生执行器', spec.backend === 'windows' && spec.file.toLowerCase().includes('powershell'));

  const inside = await run(spec);
  const insideDiag = `code=${inside.code} out=${inside.stdout.trim().slice(0, 120)} err=${inside.stderr.trim().slice(0, 180)}`;
  ok('授权根目录可写', inside.code === 0 && fs.existsSync(path.join(workspace, 'inside.txt')) && fs.readFileSync(path.join(workspace, 'inside.txt'), 'utf8').includes('inside'), insideDiag);
  ok('受限进程 stdout 正常回传', inside.stdout.includes('native-ok'), insideDiag);

  const preRun = await run(sandbox.buildExec(`Set-Content -LiteralPath ${quote(preExisting)} -Value 'after'`));
  ok(
    '沙箱运行前就存在的文件也能改写（ACL 继承生效）',
    preRun.code === 0 && fs.readFileSync(preExisting, 'utf8').includes('after'),
    preRun.stderr.trim().slice(0, 160),
  );

  const toolResult = await createToolRegistry().execute(
    'run_shell',
    { command: "Write-Output 'tool-native-ok'" },
    { session: { id: 'native-tool-test', messages: [], todos: [], state: {} }, sandbox, config: { workspace } },
  );
  ok('run_shell 工具端到端进入 Windows 原生后端', toolResult.ok && /tool-native-ok/.test(toolResult.content), toolResult.content.slice(0, 180));

  // ---- 编译缓存：控制器会加载它，所以受限进程必须碰不到 ----
  const insideDir = (dir, p) => {
    const rel = path.relative(dir, p);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  const engineCache = pickEngineCacheDir({ roots: [workspace], extraRoots: [sandboxTemp] });
  ok(
    '编译缓存放在沙箱授权范围之外',
    Boolean(engineCache) && ![workspace, sandboxTemp].some((dir) => insideDir(dir, engineCache)),
    engineCache || '（禁用缓存，改内存编译）',
  );

  const cacheProbe = engineCache ? path.join(engineCache, `sandbox-write-probe-${process.pid}.txt`) : null;
  const cacheWrite = cacheProbe ? await run(sandbox.buildExec(`Set-Content -LiteralPath ${quote(cacheProbe)} -Value 'nope'`)) : null;
  ok(
    '沙箱命令写不进编译缓存目录',
    cacheProbe ? cacheWrite.code !== 0 && !fs.existsSync(cacheProbe) : true,
    cacheWrite ? cacheWrite.stderr.trim().slice(0, 160) : '缓存已禁用，改内存编译',
  );

  const cachedDll = engineCache && fs.existsSync(engineCache) ? fs.readdirSync(engineCache).find((n) => n.endsWith('.dll')) : null;
  let moveTry = null;
  if (cachedDll) {
    const dllPath = path.join(engineCache, cachedDll);
    const movedPath = `${dllPath}.moved-${process.pid}`;
    moveTry = await run(sandbox.buildExec(`Move-Item -LiteralPath ${quote(dllPath)} -Destination ${quote(movedPath)} -Force -ErrorAction Stop; 'moved'`));
  }
  ok(
    '沙箱命令换不掉执行器 DLL（否则下次调用会以控制器身份加载它）',
    cachedDll ? moveTry.code !== 0 && fs.existsSync(path.join(engineCache, cachedDll)) && !fs.existsSync(`${path.join(engineCache, cachedDll)}.moved-${process.pid}`) : engineCache === null,
    cachedDll ? moveTry.stderr.trim().slice(0, 160) : '缓存已禁用，改为每次内存编译',
  );

  const stillWorks = await run(sandbox.buildExec("Write-Output 'still-alive'"));
  ok('缓存目录被尝试攻击后执行器仍然可用', stillWorks.code === 0 && /still-alive/.test(stillWorks.stdout), stillWorks.stderr.trim().slice(0, 160));

  // ---- 控制器代码目录被划进可写范围时必须如实标记 ----
  const normalDesc = sandbox.describe();
  ok('普通工作区不会把控制器代码目录圈进来', normalDesc.controller.exposed === false, normalDesc.controller.appRoot);
  const selfDesc = createSandbox({ scope: 'workspace', workspace: APP_ROOT, backend: 'windows', mode: 'write', tempDir: sandboxTemp }).describe();
  ok(
    '工作区含控制器代码目录时如实标记（不装作还能保护控制器）',
    selfDesc.controller.exposed === true && /控制器代码目录/.test(selfDesc.isolation.detail),
    selfDesc.controller.note.slice(0, 80),
  );
  ok(
    '候选缓存位置全在可写范围时退回内存编译',
    pickEngineCacheDir({ roots: ['C:\\', 'C:\\Users'], extraRoots: [sandboxTemp] }) === null,
  );

  // 不传 tempDir 时也要把子进程 TEMP/TMP 指到「已被授予写」的私有临时目录：
  // 否则真实 %TEMP% 写不进去，受限令牌下的 Windows PowerShell 会退化成 ConstrainedLanguage。
  const bare = createSandbox({ scope: 'workspace', workspace, backend: 'windows', mode: 'write', memoryLimit: '256m', pidsLimit: 32 });
  const bareSpec = bare.buildExec("Write-Output ('bare-temp=' + $env:TEMP)");
  ok(
    '没传 tempDir 时子进程 TEMP 指向私有临时目录',
    path.resolve(bareSpec.env.TEMP) === path.resolve(os.tmpdir(), 'mini-harness-sandbox') && bareSpec.env.TMP === bareSpec.env.TEMP,
    bareSpec.env.TEMP,
  );
  const bareRun = await run(bareSpec);
  ok(
    '没传 tempDir 时命令照样能跑（不落进 ConstrainedLanguage）',
    bareRun.code === 0 && /bare-temp=/.test(bareRun.stdout) && !/ConstrainedLanguage/i.test(bareRun.stderr),
    `code=${bareRun.code} out=${bareRun.stdout.trim().slice(0, 60)} err=${bareRun.stderr.trim().slice(0, 120)}`,
  );

  const outsideTarget = path.join(outside, 'escaped.txt');
  const encodedTarget = Buffer.from(outsideTarget, 'utf8').toString('base64');
  const bypass = sandbox.buildExec(
    `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTarget}')); Set-Content -LiteralPath $p -Value 'escaped'`,
  );
  const escaped = await run(bypass);
  ok('即使绕过命令扫描，工作区外写入仍被 OS 拒绝', escaped.code !== 0 && !fs.existsSync(outsideTarget), escaped.stderr.trim().slice(0, 180));

  const childTarget = path.join(outside, 'child-escaped.txt');
  const childPayload = Buffer.from(`Set-Content -LiteralPath ${quote(childTarget)} -Value child`, 'utf16le').toString('base64');
  const childCommand = `& powershell.exe -NoProfile -NonInteractive -EncodedCommand ${childPayload}; if (Test-Path -LiteralPath ${quote(childTarget)}) { exit 0 } else { exit 9 }`;
  const childEscape = await run(sandbox.buildExec(childCommand));
  ok('派生子进程继承受限令牌，不能逃逸写入', childEscape.code !== 0 && !fs.existsSync(childTarget), childEscape.stderr.trim().slice(0, 180));

  const read = await run(sandbox.buildExec(`Get-Content -LiteralPath ${quote(path.join(outside, 'readable.txt'))}`));
  ok('读取权限按设计沿用当前用户（界面会明确提示）', read.code === 0 && read.stdout.includes('outside-readable'), `code=${read.code} out=${read.stdout.trim().slice(0, 120)} err=${read.stderr.trim().slice(0, 180)}`);

  const readonly = createSandbox({
    scope: 'workspace',
    workspace,
    backend: 'windows',
    mode: 'readonly',
    tempDir: sandboxTemp,
    memoryLimit: '256m',
    pidsLimit: 32,
  });
  const readonlyTarget = path.join(workspace, 'readonly-escaped.txt');
  const readonlyWrite = await run(readonly.buildExec(`Set-Content -LiteralPath ${quote(readonlyTarget)} -Value nope`));
  ok('只读模式由 OS 拒绝工作区写入', readonlyWrite.code !== 0 && !fs.existsSync(readonlyTarget), readonlyWrite.stderr.trim().slice(0, 180));

  const marker = path.join(workspace, 'late-marker.txt');
  const longSpec = sandbox.buildExec(`Start-Sleep -Seconds 3; Set-Content -LiteralPath ${quote(marker)} -Value late`);
  const child = spawn(longSpec.file, longSpec.args, {
    cwd: longSpec.cwd,
    env: longSpec.env,
    windowsHide: true,
    stdio: 'ignore',
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  child.kill('SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 3500));
  ok('控制器终止执行器后，Job Object 会清理整棵进程树', !fs.existsSync(marker));
} finally {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (err) {
    console.warn(`  ! 临时目录稍后由系统清理：${err.message}`);
  }
}

console.log(`\n${fail === 0 ? '✓' : '✗'} Windows 原生沙箱: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
