// 右侧面板 + 左侧会话栏：状态 / 任务 / 记忆 / 工具 / 工作流。
// 与 app.js 的分工：app.js 只管对话流与事件渲染，面板只管「系统状态」的读写。
(function () {
  const $ = (id) => document.getElementById(id);
  const api = async (url, opts) => {
    const r = await fetch(url, opts);
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : await r.text();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  };
  const post = (url, body) =>
    api(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });

  const state = { sessionId: null, sessions: [] };

  const relTime = (ts) => {
    const d = Date.now() - (ts || 0);
    if (d < 60000) return '刚刚';
    if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`;
    if (d < 86400000) return `${Math.floor(d / 3600000)} 小时前`;
    return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  };

  // ---------- 左侧会话列表 ----------
  async function refreshSessions() {
    try {
      state.sessions = await api('/api/sessions');
    } catch {
      return;
    }
    const box = $('sessionList');
    box.innerHTML = '';
    for (const s of state.sessions) {
      const item = document.createElement('div');
      item.className = `session-item${s.id === state.sessionId ? ' active' : ''}`;
      item.innerHTML = `
        <span class="dot-status ${s.status}"></span>
        <span class="body"><span class="title"></span><span class="sub"></span></span>
        <span class="del">✕</span>`;
      item.querySelector('.title').textContent = s.title || s.id;
      item.querySelector('.sub').textContent = `${relTime(s.updatedAt)} · ${s.messages} 条`;
      item.title = `${s.id} · ${s.model || ''} · ${s.status}`;
      item.onclick = async (e) => {
        if (e.target.classList.contains('del')) {
          const r = await api(`/api/sessions/${s.id}`, { method: 'DELETE' });
          if (state.sessionId === s.id) window.Chat?.reset();
          refreshSessions();
          // 软删除：给一次撤销的机会
          showToast(`「${s.title || s.id}」已移入回收站`, '撤销', async () => {
            if (r?.trashId) await post(`/api/sessions/trash/${encodeURIComponent(r.trashId)}/restore`);
            refreshSessions();
          });
          return;
        }
        await window.Chat?.loadSession(s.id);
        refreshSessions();
      };
      box.append(item);
    }
  }

  // ---------- 轻提示（带撤销）----------
  let toastTimer = null;
  function showToast(text, actionLabel, onAction) {
    const box = $('toast');
    if (!box) return;
    $('toastText').textContent = text;
    const act = $('toastAction');
    if (actionLabel) {
      act.hidden = false;
      act.textContent = actionLabel;
      act.onclick = async () => {
        box.hidden = true;
        clearTimeout(toastTimer);
        await onAction?.();
      };
    } else {
      act.hidden = true;
    }
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      box.hidden = true;
      act.hidden = true;
    }, 9000);
  }

  // ---------- 状态 ----------
  function renderState(session) {
    const s = session?.state || {};
    const kv = $('stateKv');
    const rows = [
      ['会话', session?.id || '—'],
      ['状态', s.status || 'idle'],
      ['模型', `${session?.provider || ''} · ${session?.model || ''}`],
      ['轮次 / 步数', `${s.turns || 0} / ${s.steps || 0}`],
      ['请求数', String(s.requests || 0)],
      ['tokens', `${s.usage?.prompt_tokens || 0} in / ${s.usage?.completion_tokens || 0} out`],
      ['估算成本', s.costUsd ? `$${s.costUsd}` : '—'],
      ['消息数', String(session?.messages?.length ?? 0)],
      ['待审批', String(s.pendingApprovals || 0)],
      ['最后错误', s.lastError || '—'],
    ];
    kv.innerHTML = '';
    for (const [k, v] of rows) {
      const div = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      div.append(dt, dd);
      kv.append(div);
    }
  }

  function setStatus(status) {
    const pill = $('statusPill');
    if (!pill) return;
    const s = status || 'idle';
    pill.className = `pill ${s}`;
    // 只改文字节点，不能整个替换 innerHTML——否则里面的 #statusText 会被干掉
    const txt = pill.querySelector('#statusText');
    if (txt) txt.textContent = s;
  }

  function renderTodos(todos) {
    const ul = $('todoList');
    ul.innerHTML = '';
    if (!todos?.length) {
      const li = document.createElement('li');
      li.className = 'dim';
      li.textContent = '还没有任务清单';
      ul.append(li);
      return;
    }
    const icon = { pending: '○', in_progress: '◐', completed: '●' };
    for (const t of todos) {
      const li = document.createElement('li');
      li.className = t.status;
      li.textContent = `${icon[t.status] || '○'} ${t.content}`;
      ul.append(li);
    }
  }

  // ---------- 记忆 ----------
  async function refreshMemory(keyword = '') {
    const box = $('memList');
    try {
      const { items, stats } = await api(
        `/api/memory?sessionId=${state.sessionId || ''}&limit=60${keyword ? `&keyword=${encodeURIComponent(keyword)}` : ''}`,
      );
      box.innerHTML = '';
      if (!items.length) {
        box.innerHTML = '<div class="dim">没有记忆</div>';
      }
      for (const m of items) {
        const el = document.createElement('div');
        el.className = 'mem-item';
        el.innerHTML = `<div class="meta"><span>#${m.id} · ${m.scope}/${m.category} · ${m.importance}</span><span class="del">删除</span></div><div class="body"></div>`;
        el.querySelector('.body').textContent = m.content;
        el.querySelector('.del').onclick = async () => {
          await api(`/api/memory/${m.id}`, { method: 'DELETE' });
          refreshMemory();
        };
        box.append(el);
      }
      const foot = document.createElement('div');
      foot.className = 'dim';
      foot.style.marginTop = '8px';
      foot.textContent = `共 ${stats.total} 条 · ${Object.entries(stats.byScope || {}).map(([k, v]) => `${k}:${v}`).join(' ')}`;
      box.append(foot);
    } catch (err) {
      box.innerHTML = `<div class="dim">读取失败：${err.message}</div>`;
    }
  }

  async function addMemory() {
    const content = $('memContent').value.trim();
    if (!content) return;
    await post('/api/memory', {
      content,
      scope: $('memScope').value,
      category: $('memCategory').value,
      importance: Number($('memImportance').value) || 0.6,
      sessionId: state.sessionId,
    });
    $('memContent').value = '';
    refreshMemory();
  }

  // ---------- 工具 ----------
  async function refreshTools() {
    const box = $('toolList');
    try {
      const { byCategory } = await api('/api/tools');
      box.innerHTML = '';
      for (const [cat, list] of Object.entries(byCategory)) {
        const group = document.createElement('div');
        group.className = 'tool-group';
        const h = document.createElement('h4');
        h.textContent = `${cat} (${list.filter((t) => t.enabled).length}/${list.length})`;
        group.append(h);
        for (const t of list) {
          const row = document.createElement('div');
          row.className = 'tool-row';
          row.innerHTML = `<input type="checkbox" ${t.enabled ? 'checked' : ''} /><span class="name"></span><span class="desc"></span>`;
          row.querySelector('.name').textContent = t.name;
          row.querySelector('.desc').textContent = t.readOnly ? '只读' : '可写';
          row.title = t.description;
          row.querySelector('input').onchange = async (e) => {
            await post(`/api/tools/${encodeURIComponent(t.name)}/toggle`, { enabled: e.target.checked });
            refreshTools();
          };
          group.append(row);
        }
        box.append(group);
      }
    } catch (err) {
      box.innerHTML = `<div class="dim">读取失败：${err.message}</div>`;
    }
  }

  // ---------- 工作流 ----------
  async function refreshWorkflows() {
    const box = $('wfList');
    try {
      const list = await api('/api/workflows');
      box.innerHTML = '';
      if (!list.length) box.innerHTML = '<div class="dim">workflows/ 目录下没有定义</div>';
      for (const w of list) {
        const el = document.createElement('div');
        el.className = 'wf-item';
        el.innerHTML = `<div class="name"></div><div class="phases"></div><button class="mini primary">运行</button>`;
        el.querySelector('.name').textContent = w.name;
        el.querySelector('.phases').textContent = `${w.description}｜${w.phases.map((p) => `${p.title}(${p.steps.length})`).join(' → ')}`;
        el.querySelector('button').onclick = () => runWorkflow(w.name);
        box.append(el);
      }
    } catch (err) {
      box.innerHTML = `<div class="dim">读取失败：${err.message}</div>`;
    }
  }

  // ---------- 回收站 ----------
  async function refreshTrash() {
    const box = $('trashList');
    if (!box) return;
    try {
      const { items, dir } = await api('/api/sessions/trash');
      const dirEl = $('trashDir');
      if (dirEl && dir) dirEl.textContent = dir;
      box.innerHTML = '';
      if (!items.length) {
        box.innerHTML = '<div class="dim">回收站是空的</div>';
        return;
      }
      for (const t of items) {
        const el2 = document.createElement('div');
        el2.className = 'mem-item';
        el2.innerHTML = `<div class="meta"><span></span><span class="actions"></span></div><div class="body"></div>`;
        el2.querySelector('.meta span').textContent = `${t.id} · 删除于 ${String(t.deletedAt).replace('T', ' ').slice(0, 19)}`;
        el2.querySelector('.body').textContent = `${t.title} · ${t.messages} 条消息`;
        const actions = el2.querySelector('.actions');
        const restore = document.createElement('button');
        restore.className = 'mini';
        restore.textContent = '恢复';
        restore.onclick = async () => {
          try {
            await post(`/api/sessions/trash/${encodeURIComponent(t.trashId)}/restore`);
            showToast(`已恢复「${t.title}」`);
            refreshTrash();
            refreshSessions();
          } catch (err) {
            showToast(`恢复失败：${err.message}`);
          }
        };
        const purge = document.createElement('button');
        purge.className = 'mini err';
        purge.textContent = '彻底删除';
        purge.style.marginLeft = '6px';
        purge.onclick = async () => {
          await api(`/api/sessions/trash/${encodeURIComponent(t.trashId)}`, { method: 'DELETE' });
          refreshTrash();
        };
        actions.append(restore, purge);
        box.append(el2);
      }
    } catch (err) {
      box.innerHTML = `<div class="dim">读取失败：${err.message}</div>`;
    }
  }

  async function runWorkflow(name) {
    const input = $('wfInput').value.trim();
    window.Chat?.reset({ keepSession: false });
    setStatus('running');
    // 工作流每一步都是子代理，必须带上当前配置的模型凭证（否则会退回服务端环境变量）
    const payload = window.Chat?.requestPayload?.({ name, input }) || { name, input };
    const res = await fetch('/api/workflows/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok || !res.body) {
      const info = await res.json().catch(() => ({}));
      window.Chat?.addBubble('error', `工作流启动失败：HTTP ${res.status} ${info.error || ''}`);
      return;
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
        try {
          window.Chat?.handleEvent(JSON.parse(line.slice(5).trim()));
        } catch {}
      }
    }
    refreshSessions();
  }

  // ---------- 初始化 ----------
  function init() {
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.onclick = () => {
        document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
        document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('active', p.id === `pane-${tab.dataset.tab}`));
        if (tab.dataset.tab === 'memory') refreshMemory();
        if (tab.dataset.tab === 'tools') refreshTools();
        if (tab.dataset.tab === 'workflows') refreshWorkflows();
        if (tab.dataset.tab === 'trace') window.Trace?.load();
      };
    });
    $('memAdd').onclick = addMemory;
    $('memSearchBtn').onclick = () => refreshMemory($('memSearch').value.trim());
    $('memSearch').onkeydown = (e) => {
      if (e.key === 'Enter') refreshMemory($('memSearch').value.trim());
    };
    $('newSession').onclick = async () => {
      await window.Chat?.newSession();
      refreshSessions();
    };
    $('backupSessions')?.addEventListener('click', backupAll);
    $('purgeTrash')?.addEventListener('click', async () => {
      const { items } = await api('/api/sessions/trash');
      if (!items.length) return showToast('回收站已经是空的');
      await api('/api/sessions/trash', { method: 'DELETE' });
      showToast(`已彻底删除 ${items.length} 个会话`);
      refreshTrash();
    });
    refreshSessions();
    refreshMemory();
    refreshTools();
    refreshWorkflows();
    refreshTrash();
  }

  /** 备份：把全部会话（含 trace）下载成一个 JSON */
  async function backupAll() {
    try {
      const res = await fetch('/api/sessions/export');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const bundle = JSON.parse(text);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      a.download = `harness-sessions-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
      showToast(`已备份 ${bundle.count} 个会话（含 trace）`);
    } catch (err) {
      showToast(`备份失败：${err.message}`);
    }
  }

  window.Panels = {
    init,
    state,
    refreshSessions,
    refreshMemory,
    refreshTools,
    refreshWorkflows,
    refreshTrash,
    showToast,
    renderState,
    renderTodos,
    setStatus,
    setSessionId: (id) => {
      state.sessionId = id;
      refreshSessions();
    },
  };
})();
