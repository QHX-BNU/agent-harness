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

// ---- 画像文件（user.md / soul.md / preference.md）----
const chunks = await get('/api/memory/chunks');
ok('GET /api/memory/chunks', chunks.status === 200 && chunks.data.chunks.length === 3, chunks.data.chunks.map((c) => c.file).join(', '));
ok('画像返回原文与条目', chunks.data.chunks.every((c) => typeof c.text === 'string' && Array.isArray(c.items)));

const chunkAdd = await send('/api/memory', {
  content: '接口冒烟：用户偏好中文回答',
  scope: 'global',
  category: 'self',
  chunk: 'preference',
});
ok('POST /api/memory 带 chunk', chunkAdd.status === 201 && chunkAdd.data.chunk === 'preference' && chunkAdd.data.scope === 'global');
const pref = await get('/api/memory/chunks/preference');
ok('GET /api/memory/chunks/:name', pref.status === 200 && pref.data.text.includes('接口冒烟') && pref.data.items.some((i) => i.id === chunkAdd.data.id));

const manualText = `${pref.data.text.trimEnd()}\n- 接口冒烟：手改一行也能生效\n`;
const putChunk = await send('/api/memory/chunks/preference', { text: manualText }, 'PUT');
ok('PUT /api/memory/chunks/:name（整块手改）', putChunk.status === 200 && putChunk.data.items.some((i) => i.content.includes('手改一行')));
const reloaded = await get('/api/memory/chunks/preference');
ok('手改后重新读取仍在', reloaded.data.text.includes('手改一行'));

// 清理：把两行测试记忆删掉
for (const item of reloaded.data.items.filter((i) => i.content.includes('接口冒烟'))) {
  await fetch(`${base}/api/memory/${item.id}`, { method: 'DELETE' });
}
ok('清理冒烟记忆', (await get('/api/memory/chunks/preference')).data.items.every((i) => !i.content.includes('接口冒烟')));

// ---- 技能 ----
const skills = await get('/api/skills');
ok('GET /api/skills', skills.status === 200 && Array.isArray(skills.data.items), `${skills.data.items.length} 个 · enabled=${skills.data.enabled}`);

const made = await send('/api/skills', {
  name: 'api-smoke-skill',
  description: '接口冒烟用的技能',
  when: '测试时',
  content: '# 步骤\n1. 什么都不做\n',
  force: true,
});
ok('POST /api/skills（自己生成）', made.status === 201 && made.data.name === 'api-smoke-skill', made.data?.name);
ok('生成后带文件清单', Array.isArray(made.data.files) && made.data.files.some((f) => f.path === 'SKILL.md'));

const oneSkill = await get('/api/skills/api-smoke-skill?file=SKILL.md');
ok('GET /api/skills/:name?file=', oneSkill.status === 200 && oneSkill.data.content.includes('什么都不做'));

const exported = await fetch(`${base}/api/skills/api-smoke-skill/export`);
const zipBuf = Buffer.from(await exported.arrayBuffer());
ok('GET /api/skills/:name/export 返回 zip', exported.status === 200 && zipBuf.subarray(0, 2).toString('latin1') === 'PK', `${zipBuf.length} 字节`);

const installed = await send('/api/skills/install', { zipBase64: zipBuf.toString('base64'), source: 'api-test.zip', name: 'api-smoke-skill-2', force: true });
ok('POST /api/skills/install（base64）', installed.status === 201 && installed.data.name === 'api-smoke-skill-2');

const badInstall = await send('/api/skills/install', { zipBase64: Buffer.from('nope').toString('base64') });
ok('安装坏包被拒（4xx/5xx 且带原因）', badInstall.status >= 400 && Boolean(badInstall.data?.error), badInstall.data?.error);

const removed1 = await fetch(`${base}/api/skills/api-smoke-skill`, { method: 'DELETE' });
const removed2 = await fetch(`${base}/api/skills/api-smoke-skill-2`, { method: 'DELETE' });
ok('DELETE /api/skills/:name（清理冒烟技能）', (await removed1.json()).ok === true && (await removed2.json()).ok === true);

const wfs = await get('/api/workflows');
ok('GET /api/workflows', wfs.status === 200 && wfs.data.length >= 2, wfs.data.map((w) => w.name).join(', '));
ok('工作流带阶段说明', wfs.data.every((w) => w.phases.length > 0));

const approvals = await get('/api/approvals');
ok('GET /api/approvals', approvals.status === 200 && Array.isArray(approvals.data));

const bad = await send('/api/chat', { message: '' });
ok('空消息被拒绝', bad.status === 400);

const missing = await get('/api/sessions/不存在');
ok('不存在的会话返回 404', missing.status === 404);

// ---- 删除 = 软删除（回收站可恢复），这是为了防止误删丢历史 ----
const preTrash = await get('/api/sessions/trash');
const preTrashCount = preTrash.data.items.length;

const delRes = await fetch(`${base}/api/sessions/${sid}`, { method: 'DELETE' });
const delBody = await delRes.json();
ok('DELETE 默认软删除并返回 trashId', delBody.ok === true && delBody.soft === true && Boolean(delBody.trashId), delBody.trashId);

const after = await get(`/api/sessions/${sid}`);
ok('软删后主列表查不到', after.status === 404);

const trash = await get('/api/sessions/trash');
ok('回收站里能查到刚删的会话', trash.data.items.length === preTrashCount + 1 && trash.data.items.some((t) => t.trashId === delBody.trashId));
ok('回收站条目带标题与消息数', trash.data.items[0].messages >= 0 && Boolean(trash.data.items[0].title));
ok('回收站暴露磁盘路径', typeof trash.data.dir === 'string' && trash.data.dir.length > 0, trash.data.dir);

const restore = await send(`/api/sessions/trash/${encodeURIComponent(delBody.trashId)}/restore`, null);
ok('POST 回收站恢复', restore.status === 200 && restore.data.ok === true, restore.data.title);
const back = await get(`/api/sessions/${sid}`);
ok('恢复后会话回来了（含消息）', back.status === 200 && back.data.id === sid && back.data.messages.length > 0, `${back.data.messages.length} 条消息`);
const backTrace = await fetch(`${base}/api/sessions/${sid}/trace?format=jsonl`);
ok('恢复后 trace 也一起回来', (await backTrace.text()).trim().length > 0);

// 备份：全部会话打包下载
const backupRes = await fetch(`${base}/api/sessions/export`);
const backup = await backupRes.json();
ok('GET /api/sessions/export 全量备份', backupRes.ok && backup.count >= 1 && Array.isArray(backup.sessions), `${backup.count} 个会话`);
ok('备份里含消息与 trace', backup.sessions[0].messages.length > 0 && Array.isArray(backup.sessions[0].events));
ok('备份响应是附件下载', /attachment/.test(backupRes.headers.get('content-disposition') || ''), backupRes.headers.get('content-disposition'));

// 彻底删除：先软删，再从回收站清掉
const del2 = await (await fetch(`${base}/api/sessions/${sid}`, { method: 'DELETE' })).json();
await fetch(`${base}/api/sessions/trash/${encodeURIComponent(del2.trashId)}`, { method: 'DELETE' });
const trashAfterPurge = await get('/api/sessions/trash');
ok('彻底删除回收站条目', !trashAfterPurge.data.items.some((t) => t.trashId === del2.trashId));
const gone = await get(`/api/sessions/${sid}`);
ok('彻底删除后不可恢复', gone.status === 404);

// 硬删除参数仍然可用（脚本/CI 用来清理）
const hardTarget = await send('/api/sessions', { title: '硬删除测试' });
const hardDel = await (await fetch(`${base}/api/sessions/${hardTarget.data.id}?hard=1`, { method: 'DELETE' })).json();
ok('?hard=1 直接真删不进回收站', hardDel.soft === false && hardDel.trashId === null);

// ---- 身份缓存（open_id → 真名）----
const ids0 = await get('/api/identities');
ok('GET /api/identities', ids0.status === 200 && Array.isArray(ids0.data.users) && Array.isArray(ids0.data.chats), `${ids0.data.users.length} 人 / ${ids0.data.chats.length} 群`);
const alias = await send('/api/identities/alias', { id: 'ou_test_alias', name: '测试别名' });
ok('POST 设置人工别名', alias.status === 200 && alias.data.alias === '测试别名');
const ids1 = await get('/api/identities');
ok('别名出现在列表里', ids1.data.users.some((u) => u.id === 'ou_test_alias' && u.name === '测试别名'));
const cleared = await send('/api/identities/alias', { id: 'ou_test_alias', name: '' });
ok('传空名字可清除别名', cleared.status === 200 && cleared.data.alias === null);
ok('没 id 会被拒', (await send('/api/identities/alias', { name: 'x' })).status === 400);

console.log(`\n${fail === 0 ? '✓' : '✗'} 接口冒烟: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
