// HTTP 接口冒烟：把 server.js 暴露的每个端点都打一遍。
// 用法: node scripts/api-test.js [baseUrl]
const base = process.argv[2] || 'http://127.0.0.1:5175';

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
const get = async (p) => {
  const r = await fetch(base + p);
  return { status: r.status, data: await r.json().catch(() => null) };
};
const send = async (p, body, method = 'POST') => {
  const r = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => null) };
};

console.log(`接口冒烟: ${base}\n`);

const cfg = await get('/api/config');
ok('GET /api/config', cfg.status === 200 && cfg.data.workspace, `${cfg.data.provider} · ${cfg.data.model || '默认模型'}`);

const provs = await get('/api/providers');
ok('GET /api/providers', provs.status === 200 && provs.data.length >= 12, `${provs.data.length} 家`);

const probe = await send('/api/probe', { provider: cfg.data.provider });
ok('POST /api/probe', probe.data?.ok === true, `${probe.data?.latencyMs}ms · 工具 ${probe.data?.supportsTools ? '支持' : '不支持'}`);

const tools = await get('/api/tools');
ok('GET /api/tools', tools.status === 200 && tools.data.tools.length >= 15, `${tools.data.tools.length} 个工具 / ${Object.keys(tools.data.byCategory).length} 类`);
ok('工具带类别与只读标记', tools.data.tools.every((t) => t.category && t.enabled !== undefined));

const off = await send('/api/tools/run_shell/toggle', { enabled: false });
const on = await send('/api/tools/run_shell/toggle', { enabled: true });
ok('POST /api/tools/:name/toggle', off.data?.enabled === false && on.data?.enabled === true);

const created = await send('/api/sessions', { title: '接口冒烟会话' });
ok('POST /api/sessions', created.status === 201 && created.data.id, created.data?.id);
const sid = created.data.id;

const list = await get('/api/sessions');
ok('GET /api/sessions', list.status === 200 && list.data.some((s) => s.id === sid));
ok('会话列表带状态与用量', list.data.every((s) => s.status && s.usage));

const one = await get(`/api/sessions/${sid}`);
ok('GET /api/sessions/:id', one.status === 200 && one.data.id === sid);

// 先跑一轮真实对话，让这个会话产生事件，后面才能验证 trace 导出
await fetch(`${base}/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: sid, message: '列一下工作区', approvalMode: 'auto' }),
}).then((r) => r.text());

const events = await get(`/api/sessions/${sid}/events`);
ok('GET /api/sessions/:id/events', events.status === 200 && Array.isArray(events.data.events) && events.data.count >= 0, `${events.data.count} 条`);

for (const fmt of ['jsonl', 'json', 'md']) {
  const r = await fetch(`${base}/api/sessions/${sid}/trace?format=${fmt}`);
  const text = await r.text();
  ok(`GET /api/sessions/:id/trace?format=${fmt}`, r.ok && text.length > 0 && /attachment/.test(r.headers.get('content-disposition') || ''), `${text.length} 字符`);
}
const exp = await fetch(`${base}/api/sessions/${sid}/export?format=json`);
ok('GET /api/sessions/:id/export?format=json', exp.ok && (await exp.json()).harness === 'mini-harness');

const arts = await get(`/api/sessions/${sid}/artifacts`);
ok('GET /api/sessions/:id/artifacts', arts.status === 200 && Array.isArray(arts.data));

const abort = await send(`/api/sessions/${sid}/abort`);
ok('POST /api/sessions/:id/abort', abort.status === 200);

const m1 = await send('/api/memory', {
  content: '接口冒烟写入的记忆：这个 harness 用 Node 原生模块',
  scope: 'workspace',
  category: 'structure',
  importance: 0.85,
  tags: ['冒烟'],
});
ok('POST /api/memory', m1.status === 201 && m1.data.id, `#${m1.data?.id}`);

const mlist = await get('/api/memory?limit=10');
ok('GET /api/memory', mlist.status === 200 && mlist.data.items.length > 0, `${mlist.data.stats.total} 条`);

const msearch = await send('/api/memory/search', { query: 'harness 用什么模块', topK: 3 });
ok('POST /api/memory/search', msearch.status === 200 && msearch.data.length > 0, msearch.data?.[0]?.item?.content?.slice(0, 30));

const mstats = await get('/api/memory/stats');
ok('GET /api/memory/stats', mstats.status === 200 && mstats.data.total >= 1);

const medit = await send(`/api/memory/${m1.data.id}`, { importance: 0.95 }, 'PATCH');
ok('PATCH /api/memory/:id', medit.data?.importance === 0.95);

const mdel = await fetch(`${base}/api/memory/${m1.data.id}`, { method: 'DELETE' });
ok('DELETE /api/memory/:id', (await mdel.json()).ok === true);

const wfs = await get('/api/workflows');
ok('GET /api/workflows', wfs.status === 200 && wfs.data.length >= 2, wfs.data.map((w) => w.name).join(', '));
ok('工作流带阶段说明', wfs.data.every((w) => w.phases.length > 0));

const approvals = await get('/api/approvals');
ok('GET /api/approvals', approvals.status === 200 && Array.isArray(approvals.data));

const bad = await send('/api/chat', { message: '' });
ok('空消息被拒绝', bad.status === 400);

const missing = await get('/api/sessions/不存在');
ok('不存在的会话返回 404', missing.status === 404);

await fetch(`${base}/api/sessions/${sid}`, { method: 'DELETE' });
const after = await get(`/api/sessions/${sid}`);
ok('DELETE /api/sessions/:id', after.status === 404);

console.log(`\n${fail === 0 ? '✓' : '✗'} 接口冒烟: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
