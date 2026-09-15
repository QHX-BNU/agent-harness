// 子代理执行视图：点开一个子代理卡片，看它自己的完整执行过程。
// 数据源就是子代理自己的会话（kind=subagent）：GET /api/sessions/:id + /events。
// 运行中自动轮询刷新（store.append 会即时落盘，所以轮询就能看到实时进度）。
(function () {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const md = (s) => (window.MD ? window.MD.render(s) : esc(s));
  const clock = (ts) => {
    const d = new Date(ts || Date.now());
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  };
  const hhmmss = (ts) => `${clock(ts)}.${String(new Date(ts || Date.now()).getMilliseconds()).padStart(3, '0')}`;

  const GROUP_LABEL = {
    meta: '状态', flow: '流程', model: '模型', tool: '工具', approval: '审批',
    memory: '记忆', plan: '计划', agent: '子代理', workflow: '工作流', error: '错误', other: '其他',
  };
  const TOOL_ICON = { fs: '📄', shell: '⌨', memory: '🧠', plan: '☑', agent: '🤖', workflow: '⚙', artifact: '📦' };

  const state = { id: null, meta: {}, timer: null, live: true, running: false };

  // ---------- 渲染：执行轨迹（子代理自己的对话）----------
  function renderSteps(session) {
    const box = $('agentSteps');
    box.innerHTML = '';
    const cards = new Map();
    let n = 0;

    for (const m of session.messages || []) {
      if (m.role === 'user') {
        const wrap = el('div', 'step-item');
        wrap.append(el('div', 'step-role', `任务${n++ ? ` #${n}` : ''}`));
        const body = el('div', 'step-text');
        body.textContent = m.content;
        wrap.append(body);
        box.append(wrap);
      } else if (m.role === 'assistant') {
        if (m.reasoning) {
          const det = el('details', 'reasoning');
          det.append(el('summary', null, `思考过程（${m.reasoning.length} 字符）`));
          det.append(el('pre', null, m.reasoning));
          box.append(det);
        }
        if (m.content) {
          const wrap = el('div', 'step-item assistant');
          wrap.append(el('div', 'step-role', '助手'));
          const body = el('div', 'step-text md');
          body.innerHTML = md(m.content);
          wrap.append(body);
          box.append(wrap);
        }
        for (const tc of m.toolCalls || []) {
          const card = el('div', 'step-tool');
          const head = el('div', 'step-tool-head');
          head.append(el('span', 'tool-icon', TOOL_ICON[tc.category] || '▪'));
          head.append(el('span', 'step-tool-name', tc.name));
          const args = JSON.stringify(tc.arguments ?? {});
          const a = el('span', 'tool-args', args);
          a.title = args;
          head.append(a);
          card.append(head);
          box.append(card);
          cards.set(tc.id, card);
        }
      } else if (m.role === 'tool') {
        const card = cards.get(m.toolCallId);
        const content = String(m.content ?? '');
        if (card) {
          card.classList.add(/失败|未执行|拒绝|沙箱拒绝/.test(content) ? 'err' : 'ok');
          const det = el('details');
          det.append(el('summary', null, `结果 · ${content.length} 字符`));
          det.append(el('pre', null, content.slice(0, 3000)));
          card.append(det);
        } else {
          const card = el('div', 'step-tool ok');
          const head = el('div', 'step-tool-head');
          head.append(el('span', 'step-tool-name', m.name || 'tool'));
          card.append(head);
          const det = el('details');
          det.append(el('summary', null, `结果 · ${content.length} 字符`));
          det.append(el('pre', null, content.slice(0, 3000)));
          card.append(det);
          box.append(card);
        }
      }
    }
    if (!box.children.length) box.append(el('div', 'dim', '还没有内容'));
    box.scrollTop = box.scrollHeight;
  }

  // ---------- 渲染：事件流 ----------
  function renderEvents(events) {
    const box = $('agentEvents');
    box.innerHTML = '';
    if (!events?.length) {
      box.append(el('div', 'dim', '还没有事件'));
      return;
    }
    // 连续的流式增量合并
    const rows = [];
    for (const ev of events) {
      const last = rows.at(-1);
      if (last && last.type === ev.type && ['assistant_delta', 'reasoning_delta'].includes(ev.type)) {
        last.merged = (last.merged || 1) + 1;
        last.ts = ev.ts;
        continue;
      }
      rows.push({ ...ev, merged: 1 });
    }
    for (const ev of rows.slice(-400)) {
      const row = el('div', `trace-row g-${ev.group || 'other'}`);
      const head = el('div', 'trace-head');
      head.append(el('span', 'trace-time', hhmmss(ev.ts)));
      head.append(el('span', `trace-badge g-${ev.group || 'other'}`, GROUP_LABEL[ev.group] || ev.group || '其他'));
      head.append(el('span', 'trace-type', ev.type));
      if (ev.merged > 1) head.append(el('span', 'trace-merged', `×${ev.merged}`));
      row.append(head);
      row.append(el('div', 'trace-summary', ev.summary || ''));
      const det = el('details', 'trace-raw');
      det.append(el('summary', null, '原始 JSON'));
      det.append(el('pre', null, JSON.stringify(ev, null, 2)));
      row.append(det);
      box.append(row);
    }
    box.scrollTop = box.scrollHeight;
  }

  function renderMeta(session) {
    const st = session.state || {};
    const m = state.meta || {};
    const cred = { request: '本次请求', 'request(baseUrl only)': '本次请求(仅端点)', 'server-env': '服务端环境变量' }[m.credentialSource] || m.credentialSource;
    const bits = [
      `${session.provider || m.provider || '?'} · ${session.model || m.model || '?'}`,
      m.depth !== undefined ? `深度 ${m.depth}` : null,
      cred ? `凭证 ${cred}` : null,
      `${st.status || 'idle'}`,
      `${st.steps || 0} 步`,
      `${(session.messages || []).filter((x) => x.role === 'tool').length} 次工具调用`,
      st.usage ? `${st.usage.prompt_tokens || 0}↑${st.usage.completion_tokens || 0}↓` : null,
    ].filter(Boolean);
    $('agentTitle').textContent = m.description || session.title || '子代理';
    $('agentMeta').textContent = bits.join(' · ');
    const running = ['running', 'awaiting_approval'].includes(st.status);
    state.running = running;
    $('agentModal').querySelector('.agent-dot').className = `agent-dot${running ? ' running' : ''}`;
    $('agentLiveWrap').hidden = !running;
  }

  // ---------- 加载 ----------
  async function load() {
    if (!state.id) return;
    try {
      const [session, ev] = await Promise.all([
        (await fetch(`/api/sessions/${state.id}`)).json(),
        (await fetch(`/api/sessions/${state.id}/events?limit=2000`)).json(),
      ]);
      if (session.error) throw new Error(session.error);
      renderMeta(session);
      renderSteps(session);
      renderEvents(ev.events || []);
    } catch (err) {
      $('agentSteps').innerHTML = `<div class="dim">加载失败：${esc(err.message)}</div>`;
    }
    schedule();
  }

  function schedule() {
    clearTimeout(state.timer);
    if (!state.running || !state.live) return;
    state.timer = setTimeout(load, 1200);
  }

  function open(agentId, meta = {}) {
    state.id = agentId;
    state.meta = meta || {};
    state.live = true;
    $('agentLive').checked = true;
    $('agentModal').hidden = false;
    $('agentTitle').textContent = meta.description || '子代理';
    $('agentMeta').textContent = '加载中…';
    $('agentSteps').innerHTML = '<div class="dim">加载中…</div>';
    $('agentEvents').innerHTML = '';
    load();
  }

  function close() {
    clearTimeout(state.timer);
    state.timer = null;
    $('agentModal').hidden = true;
  }

  async function exportTrace(format) {
    if (!state.id) return;
    const r = await fetch(`/api/sessions/${state.id}/trace?format=${format}`);
    if (!r.ok) return;
    const text = await r.text();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    a.download = `subagent-${state.id}.${format === 'md' ? 'md' : format}`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function init() {
    $('agentClose').onclick = close;
    $('agentModal').onclick = (e) => {
      if (e.target === $('agentModal')) close();
    };
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('agentModal').hidden) close();
    });
    $('agentRefresh').onclick = () => load();
    $('agentLive').onchange = (e) => {
      state.live = e.target.checked;
      schedule();
    };
    $('agentExportMd').onclick = () => exportTrace('md');
    $('agentExportJsonl').onclick = () => exportTrace('jsonl');
  }

  window.AgentView = { init, open, close, load };
})();
