// 容器文件一致性检查：没有 Docker 也能跑，专门抓「配置写错但 build 才发现」的问题。
//   - 容器里用到的每个环境变量，都必须是 src/config.js 里真实存在的
//   - .dockerignore 不能把运行时需要的文件排除掉
//   - entrypoint 必须是 LF、有 shebang、最后 exec "$@"
//   - Dockerfile 的目录约定要和 entrypoint / compose 一致
// 用法: node scripts/docker-check.js
import fs from 'node:fs';
import path from 'node:path';

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
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');

const FILES = ['Dockerfile', 'Dockerfile.node', '.dockerignore', 'docker-compose.yml', 'docker/entrypoint.sh', 'docker-run.cmd', 'docker-run.sh'];
const dockerfile = read('Dockerfile');
const dockerfileNode = read('Dockerfile.node');
const dockerignore = read('.dockerignore');
const compose = read('docker-compose.yml');
const entrypoint = read('docker/entrypoint.sh');

// ---- 1. 文件齐不齐 ----
section('[1] 容器文件');
for (const f of FILES) ok(`${f} 存在`, fs.existsSync(f) && read(f).trim().length > 0);

// ---- 2. 环境变量必须真实存在 ----
section('[2] 环境变量对得上代码');
{
  // 真值来源：全项目所有读环境变量的地方（config.js 只覆盖一部分，sandbox.js 里还有）
  const sources = ['src/config.js', 'src/sandbox.js', 'src/runtime-model.js', 'server.js'];
  const known = new Set();
  for (const f of sources) {
    for (const m of read(f).matchAll(/(?:process\.)?env\.([A-Z][A-Z0-9_]*)/g)) known.add(m[1]);
  }
  // 容器/系统层面的变量 + entrypoint 自己的开关，不属于 harness 配置
  const allowed = new Set([
    'NODE_ENV', 'PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'TMPDIR', 'LANG', 'PWD', 'TERM', 'HOSTNAME',
    'CONTAINER_SELFCHECK', // entrypoint 的开关
    'DATA_ROOT', // entrypoint 内部的 shell 变量
  ]);
  const containers = { Dockerfile: dockerfile, 'Dockerfile.node': dockerfileNode, 'docker-compose.yml': compose, 'docker/entrypoint.sh': entrypoint };
  for (const [file, text] of Object.entries(containers)) {
    const used = new Set();
    for (const m of text.matchAll(/^\s*([A-Z][A-Z0-9_]{2,})\s*[:=]/gm)) used.add(m[1]); // ENV / YAML key / shell 赋值
    for (const m of text.matchAll(/\$\{?([A-Z][A-Z0-9_]{2,})\}?/g)) used.add(m[1]); // ${VAR}
    const unknown = [...used].filter((v) => !known.has(v) && !allowed.has(v));
    ok(`${file} 里的变量都真实存在`, unknown.length === 0, unknown.length ? `不认识：${unknown.join(', ')}` : `${[...used].length} 个`);
  }
  ok('已知配置变量足够多（解析没跑偏）', known.size >= 30, `${known.size} 个`);
}

// ---- 3. .dockerignore 不能挡住运行时文件 ----
section('[3] .dockerignore 不会误伤');
{
  const rules = dockerignore
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const hits = (p) => rules.some((r) => r === p || r === `${p}/` || (r.endsWith('/') && p.startsWith(r)) || r === p.replace(/\/.*$/, ''));
  const needed = ['server.js', 'src/', 'public/', 'workflows/', 'docker/entrypoint.sh', 'scripts/container-check.js', 'package.json'];
  const blocked = needed.filter((p) => hits(p));
  ok('运行时需要的文件都还在镜像里', blocked.length === 0, blocked.length ? `被排除：${blocked.join(', ')}` : `检查了 ${needed.length} 项`);
  ok('排除了运行态数据目录', ['.sessions', '.memory', '.channels', '.artifacts'].every((p) => hits(p)));
  ok('排除了密钥文件', ['.runtime-model.json', '.lark-app-secret', '.env'].every((p) => hits(p)));
}

// ---- 4. entrypoint 规范 ----
section('[4] entrypoint 脚本');
{
  ok('有 shebang', entrypoint.startsWith('#!/bin/sh'));
  ok('是 LF 换行（有 \\r 会导致 exec format error）', !entrypoint.includes('\r'));
  ok('用了 set -e', /^set -e$/m.test(entrypoint));
  ok('最后 exec "$@"（让信号能传到 node）', /exec "\$@"/.test(entrypoint));
  ok('不依赖 bash 专有语法', !/\[\[|\bfunction\s+\w+\s*\(|\becho -e\b/.test(entrypoint));
  ok('默认路径与 Dockerfile 一致', entrypoint.includes('/data/.sessions') && entrypoint.includes('/workspace'));
}

// ---- 5. Dockerfile 关键约定 ----
section('[5] Dockerfile（默认 = 小镜像）');
{
  // 注释里会出现「npm install」这类字眼，检查前先去掉注释
  const code = dockerfile.replace(/^\s*#.*$/gm, '');
  ok('基础镜像很小（Bun alpine，约 40MB）', /^FROM oven\/bun:[\d.]+-alpine/m.test(dockerfile), (dockerfile.match(/^FROM (.+)$/m) || [])[1]);
  ok('没有 npm install（零依赖）', !/npm (ci|install|i)\b/.test(code));
  ok('也没有 apk add（不额外装东西）', !/^RUN .*apk add/m.test(code) || /EXTRA_PACKAGES/.test(code), '');
  ok('entrypoint 有执行权限', /chmod \+x .*entrypoint\.sh/.test(dockerfile));
  ok('以非 root 运行', /^USER bun$/m.test(dockerfile) && /id -u bun/.test(dockerfile));
  ok('暴露端口与默认 PORT 一致', /EXPOSE 5175/.test(dockerfile) && /PORT=5175/.test(dockerfile));
  ok('健康检查不依赖 node（busybox wget）', /HEALTHCHECK/.test(dockerfile) && /wget -qO-/.test(dockerfile));
  ok('ENTRYPOINT + CMD 分离，CMD 用 bun 跑 server.js', /ENTRYPOINT \["\/app\/docker\/entrypoint\.sh"\]/.test(dockerfile) && /CMD \["bun", "server\.js"\]/.test(dockerfile));
  ok('工作区/数据目录约定写进 ENV', /WORKSPACE=\/workspace/.test(dockerfile) && /SESSIONS_DIR=\/data\/\.sessions/.test(dockerfile));
  ok('alpine 自带 sh（run_shell 要用）', /alpine/.test(dockerfile), '（distroless 没有 shell，run_shell 会跑不了）');
}

section('[5b] Dockerfile.node（备选 = 官方 Node）');
{
  ok('基础镜像是 node alpine', /^FROM node:\d+-alpine/m.test(dockerfileNode), (dockerfileNode.match(/^FROM (.+)$/m) || [])[1]);
  ok('没有 npm install', !/npm (ci|install|i)\b/.test(dockerfileNode));
  ok('以非 root 运行', /^USER node$/m.test(dockerfileNode));
  ok('CMD 用 node 跑 server.js', /CMD \["node", "server\.js"\]/.test(dockerfileNode));
  ok('与默认镜像的目录约定一致', /WORKSPACE=\/workspace/.test(dockerfileNode) && /SESSIONS_DIR=\/data\/\.sessions/.test(dockerfileNode));
}

// ---- 6. compose 关键约定 ----
section('[6] docker-compose.yml');
{
  ok('定义了 harness 服务', /^\s{2}harness:/m.test(compose));
  ok('端口映射到宿主机', /\d+:\d+/.test(compose) && /5175/.test(compose));
  ok('挂了工作区与数据卷', /:\/workspace/.test(compose) && /:\/data/.test(compose));
  ok('根文件系统只读 + tmpfs', /read_only:\s*true/.test(compose) && /tmpfs:/.test(compose));
  ok('没有把 WORKSPACE 改成容器外的路径', !/WORKSPACE:\s*(?!\/workspace)\S/.test(compose));
  ok('密钥走 .env 注入而不是写死在文件里', /env_file/.test(compose) && !/sk-[A-Za-z0-9]{10,}/.test(compose));
  ok('注释里说明了怎么用', /docker compose up/.test(compose));
  ok('工作区路径提示了要改', /项目目录|要改/.test(compose));
}

console.log(`\n${fail === 0 ? '✓' : '✗'} 容器配置检查: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
