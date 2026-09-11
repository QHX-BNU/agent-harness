// Trace 专项测试：事件记录 → 查看 → 导出（JSONL / JSON / Markdown），服务端与界面两侧都验。
// 用法: node scripts/trace-test.js [baseUrl]
import { openPage } from './cdp.js';

const BASE = process.argv[2] || 'http://127.0.0.1:5175';

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
const j = async (p, opts) => {
  const r = await fetch(BASE + p, opts);
  return { status: r.status, headers: r.headers, text: await r.text() };
};

// ---------- 1. 造一个真实会话 ----------
console.log(`Trace 专项测试: ${BASE}\n`);
console.log('[1] 服务端：事件记录与导出');
const chat = await fetch(`${BASE}/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message: '帮我创建 trace/demo.txt 测试导出', approvalMode: 'auto' }),
});
const chatText = await chat.text();
let sessionId = null;
for (const frame of chatText.split('\n\n')) {
  const line = frame.split('\n').find((l) => l.startsWith('data:'));
  if (!line) continue;
  const ev = JSON.parse(line.slice(5));
  if (ev.type === 'session') sessionId = ev.sessionId;
}
ok('跑通一轮对话并拿到 sessionId', Boolean(sessionId), sessionId);

// ---------- 2. /events ----------
const events = await j(`/api/sessions/${sessionId}/events?limit=500`);
const evData = JSON.parse(events.text);
ok('GET /events 返回 {count, events}', evData.count > 0 && Array.isArray(evData.events), `${evData.count} 条`);
ok('每条事件带 group 与 summary', evData.events.every((e) => e.group && e.summary));
ok('事件顺序以 session 开头', evData.events[0].type === 'session', evData.events[0].type);
const types = new Set(evData.events.map((e) => e.type));
ok('包含关键事件类型', ['session', 'model', 'state', 'step', 'tool_call', 'tool_result', 'done'].every((t) => types.has(t)), [...types].join(','));

// ---------- 3. /trace?format=jsonl ----------
const jsonl = await j(`/api/sessions/${sessionId}/trace?format=jsonl`);
const lines = jsonl.text.trim().split('\n').filter(Boolean);
ok('JSONL 每行一个合法 JSON', lines.length > 5 && lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }), `${lines.length} 行`);
ok('JSONL 带下载头', /attachment/.test(jsonl.headers.get('content-disposition') || ''), jsonl.headers.get('content-disposition'));
ok('JSONL 是 ndjson 类型', /ndjson/.test(jsonl.headers.get('content-type') || ''), jsonl.headers.get('content-type'));

// ---------- 4. /trace?format=json ----------
const bundle = JSON.parse((await j(`/api/sessions/${sessionId}/trace?format=json`)).text);
ok('JSON 是完整快照', Boolean(bundle.session && bundle.messages && bundle.events), Object.keys(bundle).join(','));
ok('快照含状态与用量', Boolean(bundle.session.state?.usage), JSON.stringify(bundle.session.state?.usage));
ok('快照含全部消息', bundle.messages.length >= 3, `${bundle.messages.length} 条`);
ok('快照含导出时间戳', Boolean(bundle.exportedAt && bundle.harness));

// ---------- 5. /trace?format=md 与 /export ----------
const md = (await j(`/api/sessions/${sessionId}/trace?format=md`)).text;
ok('Markdown 有标题与元信息', md.startsWith(`# 会话 ${sessionId}`) && md.includes('- 模型:'));
ok('Markdown 有对话段', md.includes('## 对话') && md.includes('### 1. 用户'));
ok('Markdown 有工具轨迹', md.includes('调用 `write_file`') && md.includes('工具结果'));
ok('Markdown 有事件表', md.includes('## 事件轨迹') && md.includes('| # | 时间 | 类型 | 摘要 |'));
ok('Markdown 行数合理', md.split('\n').length > 20, `${md.split('\n').length} 行`);
const exportMd = await j(`/api/sessions/${sessionId}/export`);
ok('GET /export 默认返回 Markdown 附件', /attachment/.test(exportMd.headers.get('content-disposition') || '') && exportMd.text.includes('# 会话'), exportMd.headers.get('content-disposition'));

// ---------- 6. 界面上看 trace ----------
console.log('\n[2] 界面：实时查看 + 导出');
const page = await openPage(`${BASE}/?say=列一下工作区`, { port: 9336, outDir: 'docs', freshProfile: true });
const { evalJs, waitFor, shot } = page;
try {
  await waitFor(`document.body.dataset.ready === '1'`, '前端初始化完成');
  await evalJs(`document.querySelector('.tab[data-tab="trace"]').click(); true`);
  await waitFor(`document.querySelector('.tabpane.active')?.id === 'pane-trace'`, 'Trace 标签页激活');
  await sleep(600);
  await evalJs(`document.getElementById('traceRefresh').click(); true`);
  await waitFor(`document.querySelectorAll('#traceList .trace-row').length > 3`, 'trace 列表渲染', 20000);
  const listInfo = JSON.parse(
    await evalJs(`JSON.stringify({
      rows: document.querySelectorAll('#traceList .trace-row').length,
      tabLabel: document.querySelector('.tab[data-tab="trace"]').textContent,
      pane: document.querySelector('.tabpane.active')?.id,
      hasTool: [...document.querySelectorAll('#traceList .trace-badge')].some(n => n.textContent === '工具'),
      hasModel: [...document.querySelectorAll('#traceList .trace-badge')].some(n => n.textContent === '模型'),
      firstSummary: document.querySelector('#traceList .trace-summary')?.textContent,
    })`),
  );
  ok('Trace 标签页渲染出事件行', listInfo.rows > 3, `${listInfo.rows} 行`);
  ok('标签显示事件计数', /\d/.test(listInfo.tabLabel), listInfo.tabLabel);
  ok('Trace 标签页已激活', listInfo.pane === 'pane-trace', listInfo.pane);
  ok('按类别着色（工具/模型）', listInfo.hasTool && listInfo.hasModel);
  ok('每行有摘要', Boolean(listInfo.firstSummary), listInfo.firstSummary?.slice(0, 50));

  // 过滤 + 搜索
  await evalJs(`(() => { const s = document.getElementById('traceFilter'); s.value = 'tool'; s.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(300);
  const filtered = JSON.parse(
    await evalJs(`JSON.stringify({ rows: document.querySelectorAll('#traceList .trace-row').length, allTool: [...document.querySelectorAll('#traceList .trace-badge')].every(n => n.textContent === '工具') })`),
  );
  ok('按「工具」过滤只剩工具事件', filtered.rows > 0 && filtered.allTool, `${filtered.rows} 行`);
  await evalJs(`(() => { const s = document.getElementById('traceFilter'); s.value = 'all'; s.dispatchEvent(new Event('change')); const q = document.getElementById('traceSearch'); q.value = 'tool'; q.dispatchEvent(new Event('input')); return true; })()`);
  await sleep(300);
  const searched = await evalJs(`document.querySelectorAll('#traceList .trace-row').length`);
  ok('关键字搜索生效', searched > 0 && searched < listInfo.rows, `"tool" 命中 ${searched} 行（全量 ${listInfo.rows}）`);
  await evalJs(`(() => { const q = document.getElementById('traceSearch'); q.value = ''; q.dispatchEvent(new Event('input')); return true; })()`);

  const tabShot = await shot('ui-trace-tab.png');
  console.log(`  ✓ Trace 标签页截图 → ${tabShot}`);

  // 全屏弹窗
  await evalJs(`document.getElementById('openTrace').click(); true`);
  await waitFor(`!document.getElementById('traceModal').hidden && document.querySelectorAll('#traceModalBody .trace-row').length > 3`, 'Trace 弹窗', 20000);
  const modalRows = await evalJs(`document.querySelectorAll('#traceModalBody .trace-row').length`);
  ok('全屏弹窗渲染同样的事件', modalRows > 3, `${modalRows} 行`);
  await sleep(500); // 等弹窗入场动画结束再截图
  const modalShot = await shot('ui-trace-modal.png');
  console.log(`  ✓ Trace 弹窗截图 → ${modalShot}`);

  // 展开原始 JSON
  await evalJs(`document.querySelector('#traceModalBody .trace-raw summary').click(); true`);
  await sleep(300);
  const raw = await evalJs(`document.querySelector('#traceModalBody .trace-raw pre')?.textContent || ''`);
  ok('可以展开原始 JSON', raw.startsWith('{') && raw.includes('"type"'), raw.slice(0, 40).replace(/\n/g, ' '));
  await evalJs(`document.getElementById('closeTrace').click(); true`);

  // 界面里的导出（走同一个服务端接口）
  const uiMd = await evalJs(`Trace.exportText('md')`);
  ok('界面导出 Markdown 内容正确', uiMd.includes('# 会话') && uiMd.includes('## 事件轨迹'), `${uiMd.length} 字符`);
  const uiJsonl = await evalJs(`Trace.exportText('jsonl')`);
  ok('界面导出 JSONL 可逐行解析', uiJsonl.trim().split('\n').every((l) => { try { JSON.parse(l); return true; } catch { return false; } }), `${uiJsonl.trim().split('\n').length} 行`);
} finally {
  page.close();
}

await fetch(`${BASE}/api/sessions/${sessionId}`, { method: 'DELETE' });

console.log(`\n${fail === 0 ? '✓' : '✗'} Trace 专项测试: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
