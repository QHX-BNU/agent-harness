// 网络访问策略专项测试：规则匹配 / 命令解析 / 四种模式 / 本地代理真拦截 / 沙箱集成。
// 用法: node scripts/network-test.js
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createNetworkPolicy, getNetworkProxy, proxyEnvFor, extractTargets, parseRule, ruleMatches, normalizeMode } from '../src/network-policy.js';
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

// ================= 1. 规则解析与匹配 =================
section('[1] 主机规则');
{
  ok('普通域名', ruleMatches(parseRule('example.com'), 'example.com') && !ruleMatches(parseRule('example.com'), 'evil.com'));
  ok('大小写与末尾点忽略', ruleMatches(parseRule('Example.COM'), 'example.com.'));
  ok('通配符匹配子域', ruleMatches(parseRule('*.github.com'), 'api.github.com'));
  ok('通配符也匹配根域', ruleMatches(parseRule('*.github.com'), 'github.com'));
  ok('通配符不匹配后缀伪装', !ruleMatches(parseRule('*.github.com'), 'notgithub.com'));
  ok('带端口规则只匹配该端口', ruleMatches(parseRule('localhost:8080'), 'localhost', 8080) && !ruleMatches(parseRule('localhost:8080'), 'localhost', 9999));
  ok('不带端口的规则匹配任意端口', ruleMatches(parseRule('example.com'), 'example.com', 8443));
  ok('IP 字面量', ruleMatches(parseRule('192.168.1.10'), '192.168.1.10'));
  ok('星号放行一切', ruleMatches(parseRule('*'), 'anything.example'));
  ok('从 URL 里粘贴也能解析', JSON.stringify(parseRule('https://api.example.com/v1/x')) === JSON.stringify(parseRule('api.example.com')));
  ok('旧写法 1/0 兼容', normalizeMode('1') === 'all' && normalizeMode(0) === 'off' && normalizeMode(true) === 'all' && normalizeMode(false) === 'off');
  ok('不认识的模式回落到默认', normalizeMode('banana', 'all') === 'all');
}

// ================= 2. 命令行里的目标解析 =================
section('[2] 命令目标解析');
{
  const t = (cmd) => extractTargets(cmd);
  ok('curl URL', t('curl -s https://api.github.com/repos').targets[0]?.host === 'api.github.com');
  ok('wget 带端口', (() => {
    const x = t('wget http://example.com:8080/a.tgz').targets[0];
    return x.host === 'example.com' && x.port === 8080;
  })());
  ok('git clone', t('git clone https://github.com/a/b.git').targets[0]?.host === 'github.com');
  ok('git@host:path 形式', t('git clone git@github.com:a/b.git').targets[0]?.host === 'github.com');
  ok('ssh user@host', t('ssh deploy@10.0.0.5 -p 22').networkish && t('ssh deploy@10.0.0.5').targets.some((x) => x.host === '10.0.0.5'));
  ok('PowerShell Invoke-WebRequest', t('Invoke-WebRequest -Uri https://example.org/x').targets[0]?.host === 'example.org');
  ok('node fetch', t(`node -e "fetch('https://api.openai.com/v1')"`).targets[0]?.host === 'api.openai.com');
  ok('npm install 认得出是联网命令', t('npm install lodash').networkish);
  ok('curl $URL 认得出联网但目标不明', (() => {
    const x = t('curl -s $URL');
    return x.networkish && x.unknownTarget;
  })());
  ok('普通命令不算联网', !t('Get-ChildItem -Recurse').networkish && t('echo hi > a.txt').targets.length === 0);
  ok('一条命令里的多个目标都抓到', t('curl https://a.com && curl https://b.com').targets.length === 2);
}

// ================= 3. 四种模式的判定 =================
section('[3] 模式判定');
{
  const all = createNetworkPolicy({ mode: 'all' });
  ok('all：什么都放行', all.checkCommand('curl https://evil.com').ok && all.allows('evil.com').ok);

  const off = createNetworkPolicy({ mode: 'off' });
  ok('off：联网命令一律拒', !off.checkCommand('curl https://example.com').ok, off.checkCommand('curl https://example.com').reason?.slice(0, 30));
  ok('off：不联网的命令放行', off.checkCommand('Get-ChildItem').ok);
  ok('off：直接连主机也拒', !off.allows('example.com').ok);

  const wl = createNetworkPolicy({ mode: 'whitelist', list: ['api.github.com', '*.npmjs.org'] });
  ok('whitelist：名单内放行', wl.checkCommand('git clone https://api.github.com/a/b').ok);
  ok('whitelist：名单外拒绝', !wl.checkCommand('curl https://evil.com').ok);
  ok('whitelist：目标不明时拒绝（宁可拦错）', !wl.checkCommand('curl $URL').ok, wl.checkCommand('curl $URL').reason?.slice(0, 24));

  const bl = createNetworkPolicy({ mode: 'blacklist', list: ['evil.com', '*.tracker.io'] });
  ok('blacklist：黑名单内拒绝', !bl.checkCommand('curl https://evil.com').ok);
  ok('blacklist：子域也拒绝', !bl.checkCommand('curl https://a.tracker.io').ok);
  ok('blacklist：名单外放行', bl.checkCommand('curl https://example.com').ok);
  ok('blacklist：目标不明时放行但给出警告', (() => {
    const r = bl.checkCommand('curl $URL');
    return r.ok && Boolean(r.warn);
  })());
  ok('策略可序列化给界面', (() => {
    const d = wl.describe();
    return d.mode === 'whitelist' && Array.isArray(d.list) && d.enforce === 'command+proxy';
  })());
}

// ================= 4. 本地代理（真拦截）=================
section('[4] 本地代理真拦截');
{
  // 一个本机目标服务器，充当「被允许的网站」
  const target = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('TARGET-OK');
  });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const targetPort = target.address().port;

  // 走代理发请求的辅助函数（不理会 NO_PROXY，直接打代理）
  const viaProxy = (proxy, url, { token = true } = {}) =>
    new Promise((resolve) => {
      const u = new URL(url);
      const req = http.request(
        {
          host: '127.0.0.1',
          port: proxy.port,
          method: 'GET',
          path: url,
          headers: {
            host: u.host,
            ...(token ? { 'proxy-authorization': `Basic ${Buffer.from(`x:${proxy.token}`).toString('base64')}` } : {}),
          },
        },
        (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => resolve({ status: res.statusCode, body }));
        },
      );
      req.on('error', (e) => resolve({ status: 0, body: e.message }));
      req.end();
    });

  // 白名单：允许 127.0.0.1，拒绝其它
  const wl = createNetworkPolicy({ mode: 'whitelist', list: ['127.0.0.1'] });
  const proxy = getNetworkProxy(wl);
  await proxy.ready;

  const allowed = await viaProxy(proxy, `http://127.0.0.1:${targetPort}/x`);
  ok('白名单内的主机真的能连上', allowed.status === 200 && allowed.body === 'TARGET-OK', `HTTP ${allowed.status} ${allowed.body.slice(0, 20)}`);

  const denied = await viaProxy(proxy, 'http://blocked.example/secret');
  ok('白名单外的主机被代理拒绝', denied.status === 403 && /不在白名单/.test(denied.body), `HTTP ${denied.status} ${denied.body.trim().slice(0, 40)}`);

  const noToken = await viaProxy(proxy, `http://127.0.0.1:${targetPort}/x`, { token: false });
  ok('没有代理令牌被拒（防本机其它程序蹭代理）', noToken.status === 407, `HTTP ${noToken.status}`);

  ok('代理统计里有放行与拒绝记录', proxy.stats.allowed >= 1 && proxy.stats.denied >= 1, `放行 ${proxy.stats.allowed} / 拒绝 ${proxy.stats.denied}`);

  // 完全禁网
  const offProxy = getNetworkProxy(createNetworkPolicy({ mode: 'off' }));
  await offProxy.ready;
  const offRes = await viaProxy(offProxy, `http://127.0.0.1:${targetPort}/x`);
  ok('禁网模式下连本机目标也被拒', offRes.status === 403, `HTTP ${offRes.status}`);

  // HTTPS 隧道（CONNECT）：黑名单主机应在握手前拒绝
  const blP = getNetworkProxy(createNetworkPolicy({ mode: 'blacklist', list: ['blocked.example'] }));
  await blP.ready;
  const connectStatus = await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: blP.port,
      method: 'CONNECT',
      path: 'blocked.example:443',
      headers: { 'proxy-authorization': `Basic ${Buffer.from(`x:${blP.token}`).toString('base64')}` },
    });
    req.on('connect', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(0));
    req.end();
  });
  ok('CONNECT 隧道对黑名单主机返回 403', connectStatus === 403, `HTTP ${connectStatus}`);

  // 代理环境变量
  const env = proxyEnvFor(wl, proxy);
  ok('注入的代理变量齐全', Boolean(env.HTTP_PROXY && env.HTTPS_PROXY && env.ALL_PROXY && env.http_proxy));
  ok('本机回环不走代理（否则自己拦自己）', String(env.NO_PROXY).includes('127.0.0.1'));
  ok('带上了 Node 24 需要的开关', env.NODE_USE_ENV_PROXY === '1');
  ok('mode=all 不注入代理', Object.keys(proxyEnvFor(createNetworkPolicy({ mode: 'all' }), proxy)).length === 0);

  proxy.close();
  offProxy.close();
  blP.close();
  await new Promise((r) => target.close(r));
}

// ================= 5. 沙箱集成 =================
section('[5] 沙箱集成');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'net-ws-'));
  fs.writeFileSync(path.join(tmp, 'a.txt'), 'hi\n');
  const tools = createToolRegistry();
  const mk = (network, networkList = []) =>
    createSandbox({ scope: 'workspace', workspace: tmp, mode: 'write', network, networkList });

  const off = mk('off');
  const r1 = off.checkCommand('curl https://example.com');
  ok('禁网时 run_shell 层就被拒', r1.ok === false, r1.reason?.slice(0, 36));
  ok('禁网时非联网命令照常', off.checkCommand('Get-ChildItem').ok);

  const wl = mk('whitelist', ['example.com']);
  ok('白名单内的联网命令放行', wl.checkCommand('curl https://example.com/x').ok);
  ok('白名单外的联网命令被拒', !wl.checkCommand('curl https://evil.com/x').ok);

  // 执行环境里要有代理变量
  await wl.ready();
  const spec = wl.buildExec('echo hi');
  ok('子进程环境里有代理变量', Boolean(spec.env.HTTPS_PROXY && spec.env.HTTP_PROXY), String(spec.env.HTTPS_PROXY || '').replace(/:[a-f0-9]{24}/, ':***'));
  ok('子进程环境里标了网络模式', spec.env.SANDBOX_NETWORK === 'whitelist');
  ok('代理令牌不在明文日志里暴露（只在 env 内）', !/token/i.test(JSON.stringify(wl.describe().proxy)));
  ok('describe() 带网络信息给界面', wl.describe().network === 'whitelist' && wl.describe().networkList.includes('example.com'));

  const allSbx = mk('all');
  const specAll = allSbx.buildExec('echo hi');
  ok('all 模式不注入代理', !specAll.env.HTTPS_PROXY);

  // 真跑一次工具：被拒的命令不会执行
  const ctx = { session: { id: 'net', workspaceId: 'default' }, sandbox: off, config: { workspace: tmp }, workspaceId: 'default', emit: () => {} };
  const denied = await tools.execute('run_shell', { command: 'curl -s https://example.com' }, ctx);
  ok(
    'run_shell 返回沙箱拒绝而不是执行结果',
    /沙箱拒绝/.test(denied.content) && !/DOCTYPE|<html|TARGET-OK/i.test(denied.content),
    denied.content.slice(0, 60),
  );

  const localOk = await tools.execute('run_shell', { command: 'Get-Content a.txt' }, ctx);
  ok('同一沙箱下本地命令仍正常', localOk.ok && /hi/.test(localOk.content), localOk.content.split('\n').slice(1, 2).join('').slice(0, 30));

  ok('拒绝会进审计', off.denials.some((d) => d.rule === 'network'), `${off.denials.length} 条拒绝记录`);

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? '✓' : '✗'} 网络策略测试: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
