// Trace 查看器：实时事件流 + 历史回放 + 导出（JSONL / JSON / Markdown）。
// 数据来源：当前 SSE 流（实时 push）+ GET /api/sessions/:id/events（回放）。
(function () {
  const $ = (id) => document.getElementById(id);

  const GROUP_LABEL = {
    meta: '状态',
    flow: '流程',
    model: '模型',
    tool: '工具',
    approval: '审批',
    memory: '记忆',
    plan: '计划',
    agent: '子代理',
    workflow: '工作流',
    error: '错误',
    other: '其他',
  };

  const state = {
    sessionId: null,
    events: [], // { ...ev, group, summary }
    filter: 'all',
    keyword: '',
    follow: true,
    expanded: new Set(), // 展开原始 JSON 的行索引
    MAX: 2000,
  };

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const hhmmss = (ts) => {
    const d = new Date(ts || Date.now());
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  };

  /** 本地兜底摘要（服务端 /events 会带 summary，实时事件没有） */
  function summarize(ev) {
    const cut = (s, n = 110) => {
      const t = String(s ?? '').replace(/\s+/g, ' ').trim();
      return t.length > n ? `${t.slice(0, n)}…` : t;
    };
    const map = {
      session: () => `会话 ${ev.sessionId} · ${ev.provider}/${ev.model}`,
      model: () => `${ev.provider} · ${ev.model} (${ev.protocol})`,
      state: () => `状态 → ${ev.status}${ev.lastError ? ` · ${cut(ev.lastError, 60)}` : ''}`,
      step: () => `第 ${ev.step}/${ev.maxSteps} 次模型往返`,
      assistant_delta: () => cut(ev.text, 90),
      reasoning_delta: () => cut(ev.text, 90),
      assistant_message: () => cut(ev.content, 140),
      tool_call: () => `${ev.name}(${cut(JSON.stringify(ev.args ?? {}), 100)}) [${ev.decision}]`,
      tool_result: () => `${ev.name} ${ev.ok ? '成功' : '失败'} · ${ev.ms}ms · ${String(ev.content ?? '').length} 字符`,
      approval_request: () => `${ev.name} · ${ev.reason}`,
      approval_result: () => (ev.approved ? '已允许' : '已拒绝'),
      retry: () => `重试 #${ev.attempt} · ${cut(ev.reason, 60)}`,
      memory_recall: () => `召回 ${ev.hits?.length || 0} 条：${(ev.hits || []).map((h) => `#${h.id}`).join(' ')}`,
      memory: () => `${ev.action} #${ev.item?.id} ${cut(ev.item?.content, 80)}`,
      todos: () => `${(ev.todos || []).filter((t) => t.status === 'completed').length}/${(ev.todos || []).length} 完成`,
      subagent_start: () => `${ev.description} · 深度 ${ev.depth}`,
      subagent_done: () => `${ev.description} · ${ev.steps} 步 · ${ev.toolCalls} 次工具`,
      subagent_event: () => `[${ev.description || ev.agentId}] ${summarize(ev.event || {})}`,
      workflow_start: () => `${ev.name} · ${(ev.phases || []).join(' → ')}`,
      workflow_phase: () => `${ev.index}/${ev.total} ${ev.phase}`,
      workflow_step_start: () => `${ev.phase} · ${ev.label}`,
      workflow_step_done: () => `${ev.phase} · ${ev.label} ${ev.ok === false ? '失败' : '完成'}`,
      workflow_done: () => `${ev.name} · ${ev.ok}/${ev.steps} 步 · ${ev.ms}ms`,
      usage: () => `${ev.usage?.prompt_tokens ?? '?'} in / ${ev.usage?.completion_tokens ?? '?'} out`,
      done: () => `${ev.steps} 步 · ${ev.reason}`,
      error: () => cut(ev.message, 140),
    };
    return (map[ev.type] || (() => cut(JSON.stringify(ev), 120)))();
  }

  function groupOf(type) {
    const table = {
      session: 'meta',
      model: 'meta',
      state: 'meta',
      step: 'flow',
      done: 'flow',
      retry: 'flow',
      error: 'error',
      assistant_delta: 'model',
      assistant_message: 'model',
      reasoning_delta: 'model',
      usage: 'model',
      tool_call: 'tool',
      tool_result: 'tool',
      approval_request: 'approval',
      approval_result: 'approval',
      memory: 'memory',
      memory_recall: 'memory',
      todos: 'plan',
      subagent_start: 'agent',
      subagent_done: 'agent',
      subagent_event: 'agent',
    };
    return table[type] || (String(type).startsWith('workflow_') ? 'workflow' : 'other');
  }

  function push(ev) {
    state.events.push({ ...ev, group: ev.group || groupOf(ev.type), summary: ev.summary || summarize(ev) });
    if (state.events.length > state.MAX) state.events.splice(0, state.events.length - state.MAX);
    render();
  }

  async function load(id = state.sessionId, { replace = true } = {}) {
    if (!id) return render();
    state.sessionId = id;
    try {
      const data = await (await fetch(`/api/sessions/${id}/events?limit=2000`)).json();
      const events = Array.isArray(data) ? data : data.events || [];
      if (replace) state.events = events.map((e) => ({ ...e, group: e.group || groupOf(e.type), summary: e.summary || summarize(e) }));
      render();
    } catch (err) {
      console.warn('加载 trace 失败', err);
    }
  }

  /** 把连续的流式增量合并成一行，避免几百行噪音 */
  function coalesce(events) {
    const out = [];
    for (const ev of events) {
      const last = out[out.length - 1];
      if (last && last.type === ev.type && ['assistant_delta', 'reasoning_delta'].includes(ev.type)) {
        last.merged = (last.merged || 1) + 1;
        last.text = (last.text || '') + (ev.text || '');
        last.summary = summarize(last);
        last.ts = ev.ts;
        continue;
      }
      out.push({ ...ev, merged: 1 });
    }
    return out;
  }

  function visible() {
    const kw = state.keyword.trim().toLowerCase();
    return coalesce(state.events).filter((ev) => {
      if (state.filter !== 'all' && ev.group !== state.filter) return false;
      if (!kw) return true;
      return `${ev.type} ${ev.summary} ${JSON.stringify(ev)}`.toLowerCase().includes(kw);
    });
  }

  function render() {
    const rows = visible();
    const targets = [$('traceList'), $('traceModalBody')].filter(Boolean);
    const tabBtn = document.querySelector('.tab[data-tab="trace"]');
    if (tabBtn) tabBtn.textContent = `Trace${state.events.length ? ` ${state.events.length}` : ''}`;

    for (const box of targets) {
      const isModal = box.id === 'traceModalBody';
      const stick = state.follow && (isModal || box.scrollHeight - box.scrollTop - box.clientHeight < 60);
      box.innerHTML = '';
      if (!rows.length) {
        box.append(el('div', 'dim', state.events.length ? '没有匹配的事件' : '还没有事件（发一条消息试试）'));
        continue;
      }
      let lastAgent = null;
      rows.forEach((ev) => {
        // 子代理的事件嵌在父 trace 里：进入一个新子代理就先插一条分组标题
        if (ev.type === 'subagent_event' && ev.agentId !== lastAgent) {
          lastAgent = ev.agentId;
          const groupHead = el('div', 'trace-group');
          const btn = el('button', 'link-btn', '⇢ 子代理');
          btn.title = '查看这个子代理的执行过程';
          btn.onclick = () => window.AgentView?.open(ev.agentId, { description: ev.description, depth: ev.depth });
          groupHead.append(btn, el('span', 'trace-group-desc', ev.description || ev.agentId));
          box.append(groupHead);
        }
        if (ev.type !== 'subagent_event') lastAgent = null;

        const nested = ev.type === 'subagent_event';
        const inner = nested ? ev.event || {} : ev;
        const row = el('div', `trace-row g-${ev.group}${nested ? ' nested' : ''}`);
        const head = el('div', 'trace-head');
        head.append(el('span', 'trace-time', hhmmss(ev.ts)));
        head.append(el('span', `trace-badge g-${ev.group}`, nested ? '↳ 子代理' : GROUP_LABEL[ev.group] || ev.group));
        head.append(el('span', 'trace-type', inner.type || ev.type));
        const merged = ev.merged > 1 ? ev.merged : inner.merged;
        if (merged > 1) head.append(el('span', 'trace-merged', `×${merged}`));
        row.append(head);
        row.append(el('div', 'trace-summary', nested ? summarize(inner) : ev.summary));

        const key = `${ev.ts}:${ev.type}:${ev.i ?? ''}`;
        const details = el('details', 'trace-raw');
        const summary = el('summary', null, '原始 JSON');
        details.append(summary, el('pre', null, JSON.stringify(ev, null, 2)));
        if (state.expanded.has(key)) details.open = true;
        details.ontoggle = () => (details.open ? state.expanded.add(key) : state.expanded.delete(key));
        row.append(details);
        box.append(row);
      });
      if (stick) box.scrollTop = box.scrollHeight;
    }
  }

  // ---------- 导出 ----------
  async function exportText(format = 'jsonl') {
    if (!state.sessionId) throw new Error('当前没有会话可导出');
    const r = await fetch(`/api/sessions/${state.sessionId}/trace?format=${format}`);
    if (!r.ok) throw new Error(`导出失败 HTTP ${r.status}`);
    return await r.text();
  }

  async function exportAs(format = 'jsonl') {
    const btn = $(`exp-${format}`) || $('exportTrace');
    if (btn) btn.disabled = true;
    try {
      const text = await exportText(format);
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `harness-${state.sessionId}.${format === 'md' ? 'md' : format}`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      if (btn) {
        const old = btn.textContent;
        btn.textContent = '已导出';
        setTimeout(() => (btn.textContent = old), 1200);
      }
    } catch (err) {
      alert(`导出失败：${err.message}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ---------- 弹窗 ----------
  const openModal = () => {
    $('traceModal').hidden = false;
    render();
  };
  const closeModal = () => ($('traceModal').hidden = true);

  function init() {
    $('openTrace').onclick = openModal;
    $('closeTrace').onclick = closeModal;
    $('traceModal').onclick = (e) => {
      if (e.target === $('traceModal')) closeModal();
    };
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('traceModal').hidden) closeModal();
    });

    $('traceFilter').onchange = (e) => {
      state.filter = e.target.value;
      render();
    };
    $('traceSearch').oninput = (e) => {
      state.keyword = e.target.value;
      render();
    };
    $('traceFollow').onchange = (e) => {
      state.follow = e.target.checked;
      render();
    };
    $('traceRefresh').onclick = () => load();

    for (const id of ['exp-jsonl', 'exp-json', 'exp-md']) {
      const btn = $(id);
      if (btn) btn.onclick = () => exportAs(id.replace('exp-', ''));
    }
  }

  window.Trace = {
    init,
    push,
    load,
    render,
    open: openModal,
    close: closeModal,
    exportAs,
    exportText,
    get events() {
      return state.events;
    },
    setSession(id) {
      if (id === state.sessionId) return;
      state.sessionId = id;
      state.events = [];
      state.expanded.clear();
      render();
    },
  };
})();
