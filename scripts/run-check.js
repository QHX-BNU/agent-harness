// 启动脚本一致性检查：不需要任何运行时就能跑，专门抓「换个平台就跑不起来」的坑。
//   - run.cmd 必须是纯 ASCII（cmd.exe 按 OEM 代码页解析，UTF-8 中文会把它拆坏）
//   - .ps1 必须带 UTF-8 BOM（Windows PowerShell 5.1 没 BOM 会按 ANSI 读，中文乱码）
//   - .sh 必须是 LF 且语法正确（有 \r 会报 bad interpreter）
//   - 运行时优先级、目录约定、平台资产名要和文档一致
// 用法: node scripts/run-check.js
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assetFor } from './setup-runtime.js';

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
const readText = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
const readBytes = (p) => (fs.existsSync(p) ? fs.readFileSync(p) : Buffer.alloc(0));

const FILES = ['run.cmd', 'run.sh', 'scripts/run.ps1', 'scripts/setup-runtime.js', 'scripts/setup-runtime.ps1', 'scripts/setup-runtime.sh'];
const cmd = readText('run.cmd');
const sh = readText('run.sh');
const ps1 = readText('scripts/run.ps1');
const setupJs = readText('scripts/setup-runtime.js');
const setupPs1 = readText('scripts/setup-runtime.ps1');
const setupSh = readText('scripts/setup-runtime.sh');

section('[1] 文件都在');
for (const f of FILES) ok(`${f} 存在`, readBytes(f).length > 0);

section('[2] 跨平台编码（最容易翻车的地方）');
{
  const cmdBytes = readBytes('run.cmd');
  const nonAscii = [...cmdBytes].filter((b) => b > 127).length;
  ok('run.cmd 是纯 ASCII', nonAscii === 0, nonAscii ? `${nonAscii} 个非 ASCII 字节（cmd.exe 会解析崩）` : 'cmd.exe 按 OEM 代码页读也没问题');
  ok('run.cmd 只负责转发到 PowerShell', /scripts\\run\.ps1/.test(cmd) && cmd.split('\n').filter((l) => l.trim() && !l.trim().startsWith('REM') && !l.startsWith('@')).length <= 2);

  // Windows PowerShell 5.1 对「没有 BOM 的 .ps1」按 ANSI 代码页解码：中文会变乱码，
  // 乱码里若出现引号/花括号就会直接解析失败（沙箱执行器踩过这个坑）。要么纯 ASCII，要么带 BOM。
  for (const name of [
    'scripts/run.ps1',
    'scripts/setup-runtime.ps1',
    'scripts/docker-run.ps1',
    'scripts/windows-sandbox-runner.ps1',
  ]) {
    const buf = readBytes(name);
    const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    const nonAscii = [...buf].filter((b) => b > 127).length;
    ok(
      `${name} 编码适合 PowerShell 5.1`,
      bom || nonAscii === 0,
      bom ? '带 UTF-8 BOM' : nonAscii === 0 ? '纯 ASCII，不需要 BOM' : `有 ${nonAscii} 个非 ASCII 字节但没 BOM → PS 5.1 会读崩`,
    );
  }

  for (const f of ['run.sh', 'scripts/setup-runtime.sh']) {
    const buf = readBytes(f);
    ok(`${f} 是 LF 换行`, !buf.includes(0x0d), buf.includes(0x0d) ? '有 \\r，Linux 上会 bad interpreter' : '');
  }
}

section('[3] 运行顺序与目录约定');
{
  const idx = (s) => sh.indexOf(s);
  ok(
    'run.sh 按「自带 → node → bun → 下载」找运行时',
    idx('runtime/bin/bun') >= 0 &&
      idx('command -v node') > idx('runtime/bin/bun') &&
      idx('command -v bun') > idx('command -v node') &&
      idx('setup-runtime.sh') > idx('command -v bun'),
  );
  ok('run.ps1 也是同样顺序', /Test-Path \$bun/.test(ps1) && /Get-Command node/.test(ps1) && /Get-Command bun/.test(ps1) && /setup-runtime\.ps1/.test(ps1));
  ok('两个启动脚本都先设定工作区', /WORKSPACE/.test(sh) && /env:WORKSPACE/.test(ps1));
  ok('在项目根目录执行（会话/记忆的相对路径才对）', /cd "\$HERE"/.test(sh) && /Set-Location \$here/.test(ps1));
  ok('工作区不存在时给出明确错误', /工作区不存在|不存在/.test(ps1) || /不存在/.test(ps1));
  ok('失败时给出手动安装步骤', /releases\/latest/.test(ps1) && /bun-windows-x64\.zip/.test(ps1));
  ok('run.sh 同样给出手动步骤', /releases\/latest/.test(sh));
}

section('[3b] 真沙箱（--jail）接线');
{
  const jail = readText('scripts/jail.js');
  ok('jail.js 存在且用权限模型启动', /--permission/.test(jail) || /jailFlags/.test(jail), '白名单由 src/isolation.js 计算');
  ok('jail 必须用 Node 启动（Bun 不支持权限模型）', /findNodeRuntime/.test(jail) && /Bun 不支持/.test(jail));
  ok('找不到 Node 时明确报错而不是静默降级', /找不到 Node 运行时/.test(jail) && /process\.exit\(2\)/.test(jail));
  ok('run.ps1 的 --jail 走 Node 而不是自带 Bun', /--jail/.test(ps1) && /Get-Command node/.test(ps1) && /真沙箱需要 Node/.test(ps1));
  ok('run.sh 的 --jail 同理', /--jail/.test(sh) && /真沙箱需要 Node/.test(sh) && /exec node/.test(sh));
  ok('会提示白名单外的工作区', /不在本次白名单内/.test(jail));
  ok('网络策略进沙箱快照', /networkList/.test(readText('src/sandbox.js')) && /networkModes/.test(readText('src/sandbox.js')));
  ok('隔离等级可自报', /detectRuntimeJail/.test(readText('src/isolation.js')) && /process\.permission/.test(readText('src/isolation.js')));
}

section('[4] 运行时安装器');{
  const table = ['bun-windows-x64.zip', 'bun-linux-x64.zip', 'bun-darwin-x64.zip'].every((n) => setupJs.includes(n)) && /aarch64/.test(setupJs);
  ok('setup-runtime.js 自带平台资产表（含 arm64）', table);
  ok('会校验 SHA256', /SHASUMS256/.test(setupJs) && /createHash\('sha256'\)/.test(setupJs));
  ok('校验失败会中止（不是警告一下继续）', /SHA256 不匹配/.test(setupJs) && /throw new Error\(`SHA256/.test(setupJs));
  ok('--check 只看状态', /--check/.test(setupJs));
  ok('--bundle 复制本机 bun（打包分发用）', /--bundle/.test(setupJs) && /findBunBinary/.test(setupJs));
  ok('bundle 会验证复制过来的真能跑', /runVersion/.test(setupJs) && /跑不起来/.test(setupJs));
  ok('PowerShell 安装器同样校验 SHA256', /Get-FileHash/.test(setupPs1) && /SHASUMS256/.test(setupPs1));
  ok('shell 安装器同样校验 SHA256', /sha256sum|shasum -a 256/.test(setupSh));
  ok('Alpine（musl）会用 musl 版本', /alpine-release/.test(setupSh) && /musl/.test(setupSh));

  const assets = [
    ['win32', 'x64', 'bun-windows-x64.zip'],
    ['linux', 'x64', 'bun-linux-x64.zip'],
    ['linux', 'arm64', 'bun-linux-aarch64.zip'],
    ['darwin', 'arm64', 'bun-darwin-aarch64.zip'],
    ['darwin', 'x64', 'bun-darwin-x64.zip'],
  ];
  const wrong = assets.filter(([p, a, want]) => assetFor(p, a) !== want);
  ok('平台→资产名映射正确', wrong.length === 0, wrong.length ? JSON.stringify(wrong) : `${assets.length} 项`);
  ok('不认识的平台返回 null（不是乱猜）', assetFor('sunos', 'sparc') === null);
}

section('[5] 仓库卫生');
{
  const ignore = readText('.gitignore');
  ok('runtime 二进制不进 git', /runtime\/bin\//.test(ignore));
  const tracked = spawnSync('git', ['ls-files', 'runtime'], { encoding: 'utf8' }).stdout || '';
  ok('git 里没有 runtime 二进制', !/bun(\.exe)?$/m.test(tracked), tracked.trim().split('\n').filter(Boolean).join(', ') || '（空）');
  ok('runtime/README.md 说明了怎么用', /setup-runtime/.test(readText('runtime/README.md')));
  ok('README 里提到了 run.cmd / run.sh', /run\.cmd/.test(readText('README.md')) && /run\.sh/.test(readText('README.md')));
  ok('package.json 有对应脚本', /setup-runtime/.test(readText('package.json')));
}

console.log(`\n${fail === 0 ? '✓' : '✗'} 启动脚本检查: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
