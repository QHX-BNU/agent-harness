// 网络访问策略：管住 agent 能访问哪些网站。
//
// 两层执行，缺一不可：
//   1. 命令分析（事前）：从命令行里抠出目标主机，按策略直接拒掉可疑命令
//   2. 本地代理（事中）：给子进程注入 HTTP(S)_PROXY，真正在建立连接时按策略放行/拒绝
//      —— curl / git / python / npm / node(≥24 带 NODE_USE_ENV_PROXY=1) 都会走这个代理
//
// 说清楚边界：代理是「合作式」的。程序如果自己实现网络栈、绕过代理变量直连，仍能出去；
// 要绝对禁止只能靠内核/容器级隔离（docker --network none 或虚拟机）。
// 所以这里是「大幅收窄 + 可审计」，不是「不可绕过」。
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';

export const NETWORK_MODES = {
  all: { label: '全部放行', description: '不做网络限制（默认）' },
  off: { label: '完全禁网', description: '拒绝一切对外连接' },
  whitelist: { label: '白名单', description: '只允许列表里的主机，其余拒绝' },
  blacklist: { label: '黑名单', description: '拒绝列表里的主机，其余放行' },
};

/** 兼容旧写法：SANDBOX_NETWORK=0/1 → off/all */
export function normalizeMode(raw, fallback = 'all') {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (raw === true || raw === 1 || raw === '1' || raw === 'true') return 'all';
  if (raw === false || raw === 0 || raw === '0' || raw === 'false') return 'off';
  const s = String(raw).toLowerCase().trim();
  return NETWORK_MODES[s] ? s : fallback;
}

/** 主机规则：example.com / *.example.com / example.com:8080 / 1.2.3.4 / * */
export function parseRule(raw) {
  let r = String(raw || '').trim().toLowerCase();
  if (!r) return null;
  if (r === '*') return { raw: '*', host: '*', wildcard: true, port: null }; // 放行/拒绝一切
  r = r.replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '').replace(/^\./, '');
  const m = /^(.+?):(\d+)$/.exec(r);
  const host = m ? m[1] : r;
  const port = m ? Number(m[2]) : null;
  if (!host) return null;
  const wildcard = host.startsWith('*');
  const base = wildcard ? host.replace(/^\*\.?/, '') : host;
  return { raw: r, host: base, wildcard, port };
}

export function parseList(input) {
  const arr = Array.isArray(input) ? input : String(input || '').split(/[,;\s\n]+/);
  return arr.map(parseRule).filter(Boolean);
}

/** 主机是否命中某条规则 */
export function ruleMatches(rule, host, port = null) {
  if (rule.port && port && Number(rule.port) !== Number(port)) return false;
  if (rule.host === '*') return true;
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  if (rule.wildcard) return h === rule.host || h.endsWith(`.${rule.host}`); // *.x.com 也匹配 x.com 本身
  return h === rule.host;
}

// ---------- 从命令行里抠目标主机 ----------
const NET_COMMANDS =
  /\b(curl|wget|nc|ncat|telnet|ftp|sftp|scp|ssh|rsync|ping|tracert|dig|nslookup|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|Test-NetConnection|Test-Connection|Start-BitsTransfer|git\s+(clone|fetch|pull|push|ls-remote)|npm\s+(install|i|ci|view|ping)|pip\s+(install|download)|yarn\s+add|pnpm\s+add|go\s+get|cargo\s+(install|add)|docker\s+(pull|run)|fetch\()\b/i;

const URL_RE = /\b([a-z][a-z0-9+.-]*):\/\/([^\s"'`|;)<>\]]+)/gi;
const SCP_RE = /\b[\w.-]+@([\w.-]+):/g;
const HOSTLIKE_RE = /^(?:\d{1,3}\.){3}\d{1,3}$|^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

function splitHostPort(authority) {
  const a = String(authority).replace(/^\[|\]$/g, '');
  const m = /^(.+?):(\d+)$/.exec(a);
  return m ? { host: m[1], port: Number(m[2]) } : { host: a, port: null };
}

/**
 * 解析命令里的网络目标。
 * @returns {{ targets: Array<{host:string, port:number|null, src:string}>, networkish: boolean, unknownTarget: boolean }}
 */
export function extractTargets(command) {
  const cmd = String(command || '');
  const targets = [];
  const seen = new Set();
  const push = (host, port, src) => {
    const key = `${host}:${port || ''}`;
    if (!host || seen.has(key)) return;
    seen.add(key);
    targets.push({ host: String(host).toLowerCase(), port, src });
  };

  for (const m of cmd.matchAll(URL_RE)) {
    const { host, port } = splitHostPort(m[2].split('/')[0]);
    if (host) push(host, port, m[0]);
  }
  for (const m of cmd.matchAll(SCP_RE)) push(m[1], null, m[0]);

  const networkish = NET_COMMANDS.test(cmd);
  if (networkish && !targets.length) {
    // 网络命令但没抠出主机：可能是变量/管道里的动态目标
    const hostLike = cmd
      .split(/[\s"'`|;()<>[\]]+/)
      .filter(Boolean)
      .map((t) => t.replace(/^[\w-]+@/, '').split(':')[0])
      .filter((t) => HOSTLIKE_RE.test(t) && !t.includes('\\'));
    for (const h of hostLike) push(h, null, 'bare');
  }
  return { targets, networkish, unknownTarget: networkish && targets.length === 0 };
}

// ---------- 策略对象 ----------
export function createNetworkPolicy({ mode = 'all', list = [] } = {}) {
  const m = normalizeMode(mode);
  const rules = parseList(list);

  const allows = (host, port = null) => {
    if (m === 'all') return { ok: true };
    if (m === 'off') return { ok: false, reason: '网络被完全关闭（SANDBOX_NETWORK=off）' };
    const hit = rules.some((r) => ruleMatches(r, host, port));
    if (m === 'whitelist') {
      return hit
        ? { ok: true }
        : { ok: false, reason: `主机 ${host}${port ? `:${port}` : ''} 不在白名单里（当前白名单：${rules.map((r) => r.raw).join(', ') || '空'}）` };
    }
    // blacklist
    return hit
      ? { ok: false, reason: `主机 ${host}${port ? `:${port}` : ''} 在黑名单里` }
      : { ok: true };
  };

  /**
   * 事前命令检查。
   * @returns {{ ok: boolean, reason?: string, targets?: array, unknown?: boolean }}
   */
  const checkCommand = (command) => {
    if (m === 'all') return { ok: true };
    const { targets, networkish, unknownTarget } = extractTargets(command);
    if (!networkish && !targets.length) return { ok: true };

    if (m === 'off') {
      return {
        ok: false,
        reason: `网络被完全关闭：命令看起来要联网${targets.length ? `（目标 ${targets.map((t) => t.host).join(', ')}）` : ''}`,
        targets,
      };
    }
    for (const t of targets) {
      const v = allows(t.host, t.port);
      if (!v.ok) return { ok: false, reason: `网络策略拒绝：${v.reason}`, targets };
    }
    if (unknownTarget) {
      if (m === 'whitelist') {
        return { ok: false, reason: '白名单模式下无法确认这条命令要连哪台主机（目标可能是变量或运行时拼出来的），已拒绝', targets };
      }
      // 黑名单模式下看不清目标就跟没写黑名单一样危险，明确告知
      return { ok: true, warn: '命令看起来要联网，但没能解析出目标主机，黑名单无法生效', targets, unknown: true };
    }
    return { ok: true, targets };
  };

  return {
    mode: m,
    rules,
    allows,
    checkCommand,
    describe: () => ({
      mode: m,
      label: NETWORK_MODES[m].label,
      list: rules.map((r) => r.raw),
      enforce: m === 'all' ? 'none' : 'command+proxy',
    }),
  };
}

// ---------- 本地代理：真正在建立连接时拦截 ----------
const proxyCache = new Map();

/**
 * 取一个执行该策略的本地代理（同策略复用同一个）。
 * 返回 { url, port, token, close(), stats() }
 */
export function getNetworkProxy(policy, { onDecision = null } = {}) {
  const key = `${policy.mode}|${policy.rules.map((r) => r.raw).join(',')}`;
  if (proxyCache.has(key)) return proxyCache.get(key);

  const token = crypto.randomBytes(12).toString('hex');
  const stats = { allowed: 0, denied: 0, lastDenied: null };
  const decided = (host, port, ok, reason) => {
    if (ok) stats.allowed++;
    else {
      stats.denied++;
      stats.lastDenied = { host, port, reason, at: Date.now() };
    }
    onDecision?.({ host, port, ok, reason });
  };

  const authorized = (req) => {
    const h = req.headers['proxy-authorization'] || '';
    if (!h.startsWith('Basic ')) return false;
    try {
      const [, pass] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
      return pass === token || h.slice(6) === Buffer.from(`x:${token}`).toString('base64');
    } catch {
      return false;
    }
  };

  const reject = (res, code, reason) => {
    res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`mini-harness 网络策略拒绝：${reason}\n`);
  };

  const server = http.createServer((req, res) => {
    if (!authorized(req)) return reject(res, 407, '代理令牌不对（防止本机其它程序蹭这个代理）');
    let target;
    try {
      target = new URL(req.url);
    } catch {
      return reject(res, 400, `不是合法的代理请求：${req.url}`);
    }
    const verdict = policy.allows(target.hostname, Number(target.port) || 80);
    if (!verdict.ok) {
      decided(target.hostname, target.port, false, verdict.reason);
      return reject(res, 403, verdict.reason);
    }
    decided(target.hostname, target.port, true, '');
    const upstream = http.request(
      {
        host: target.hostname,
        port: Number(target.port) || 80,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers: { ...req.headers, host: target.host },
      },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', (err) => reject(res, 502, `连不上 ${target.hostname}：${err.message}`));
    req.pipe(upstream);
  });

  server.on('connect', (req, socket, head) => {
    const [host, portRaw] = String(req.url).split(':');
    const port = Number(portRaw) || 443;
    const fail = (code, reason) => {
      socket.end(`HTTP/1.1 ${code} ${reason}\r\n\r\n`);
      decided(host, port, false, reason);
    };
    if (!authorized(req)) return fail(407, '代理令牌不对');
    const verdict = policy.allows(host, port);
    if (!verdict.ok) return fail(403, verdict.reason);
    const upstream = net.connect(port, host, () => {
      decided(host, port, true, '');
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', (err) => {
      decided(host, port, false, `连不上：${err.message}`);
      socket.end();
    });
  });

  const entry = {
    token,
    stats,
    get port() {
      return server.address()?.port || 0;
    },
    get url() {
      return `http://x:${token}@127.0.0.1:${entry.port}`;
    },
    ready: new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(entry.port))),
    close: () => {
      proxyCache.delete(key);
      server.close();
    },
  };
  server.unref?.();
  proxyCache.set(key, entry);
  return entry;
}

/** 给子进程用的代理环境变量（拿不到代理就返回空） */
export function proxyEnvFor(policy, proxy) {
  if (!proxy || policy.mode === 'all') return {};
  const url = proxy.url;
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    ALL_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    all_proxy: url,
    // 本机回环不走代理，否则把自己也拦了
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
    // Node ≥24 默认不吃代理变量，这个开关让它吃
    NODE_USE_ENV_PROXY: '1',
  };
}
