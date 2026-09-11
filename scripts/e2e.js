// 端到端测试：对着已启动的服务跑一轮真实 HTTP + SSE，
// 并在收到 approval_request 时自动点「允许」，验证审批链路。
// 用法: node scripts/e2e.js [baseUrl]
const base = process.argv[2] || 'http://127.0.0.1:5175';
const message = process.argv[3] || '帮我创建 e2e/approval.txt 验证审批流程';

const seen = [];
let approved = 0;

const res = await fetch(`${base}/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message, approvalMode: 'ask' }),
});

if (!res.ok || !res.body) {
  console.error(`✗ /api/chat HTTP ${res.status}`);
  process.exit(1);
}

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = '';

while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const frame = buf.slice(0, i);
    buf = buf.slice(i + 2);
    const line = frame.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    const ev = JSON.parse(line.slice(5).trim());
    seen.push(ev.type);

    if (ev.type === 'tool_call') console.log(`→ tool_call   ${ev.name} ${JSON.stringify(ev.args)} [${ev.decision}]`);
    if (ev.type === 'approval_request') {
      console.log(`? approval    ${ev.name}（${ev.reason}）→ 自动批准`);
      const r = await fetch(`${base}/api/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: ev.id, approved: true }),
      });
      approved += (await r.json()).ok ? 1 : 0;
    }
    if (ev.type === 'approval_result') console.log(`${ev.approved ? '✓' : '✗'} approval_result ${ev.approved}`);
    if (ev.type === 'tool_result') console.log(`← tool_result ${ev.name} ok=${ev.ok} ${ev.ms}ms`);
    if (ev.type === 'assistant_message') console.log(`\n[assistant] ${ev.content.slice(0, 200)}`);
    if (ev.type === 'error') console.log(`✗ error: ${ev.message}`);
    if (ev.type === 'done') console.log(`\ndone: ${ev.steps} step / ${ev.reason}`);
  }
}

const need = ['session', 'step', 'tool_call', 'approval_request', 'approval_result', 'tool_result', 'done'];
const missing = need.filter((t) => !seen.includes(t));
console.log(`\n事件序列: ${[...new Set(seen)].join(' → ')}`);
if (missing.length || approved === 0) {
  console.error(`✗ 缺少事件: ${missing.join(', ') || '(无)'} / 批准次数: ${approved}`);
  process.exit(1);
}
console.log('✓ e2e 通过：工具调用 + 人工审批 + 结果回灌 全链路正常');
