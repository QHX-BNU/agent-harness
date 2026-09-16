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

  const state = { sessionId: null, sessions: [], workspaces: [], activeWorkspace: 'default', collapsed: new Set() };

  const getActiveWorkspace = () =>
    state.workspaces.find((w) => w.id === state.activeWorkspace) || state.workspaces.find((w) => w.id === 'default') || null;

  /** 左下角路径、请求归属和“仅工作区”沙箱预览必须来自同一个 active workspace。 */
  function syncActiveWorkspace() {
    const workspace = getActiveWorkspace();
    const path = document.getElementById('workspace');
    if (path && workspace) {
      path.textContent = workspace.path;
      path.title = `${workspace.name} · ${workspace.path}`;
    }
    window.Chat?.setWorkspace?.(workspace);
  }

  function setActiveWorkspace(id) {
    if (!id) return;
    state.activeWorkspace = id;
    syncActiveWorkspace();
  }

  const relTime = (ts) => {
    const d = Date.now() - (ts || 0);
    if (d < 60000) return '刚刚';
    if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`;
    if (d < 86400000) return `${Math.floor(d / 3600000)} 小时前`;
    return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  };

  // ---------- 左侧：工作区分组 + 会话 ----------
  function sessionItem(s) {
    const item = document.createElement('div');
    item.className = `session-item${s.id === state.sessionId ? ' active' : ''}`;
    item.innerHTML = `
      <span class="dot-status ${s.status}"></span>
      <span class="body"><span class="title"></span><span class="sub"></span></span>
      <span class="del">✕</span>`;
    item.querySelector('.title').textContent = s.title || s.id;
    item.querySelector('.sub').textContent = `${relTime(s.updatedAt)} · ${s.messages} 条`;
    item.title = `${s.id} · ${s.model || ''} · ${s.status} · 工作区 ${s.workspaceId}`;
    item.onclick = async (e) => {
      if (e.target.classList.contains('del')) {
        const r = await api(`/api/sessions/${s.id}`, { method: 'DELETE' });
        if (state.sessionId === s.id) window.Chat?.reset();
        refreshSessions();
        showToast(`「${s.title || s.id}」已移入回收站`, '撤销', async () => {
          if (r?.trashId) await post(`/api/sessions/trash/${encodeURIComponent(r.trashId)}/restore`);
          refreshSessions();
        });
        return;
      }
      setActiveWorkspace(s.workspaceId || 'default');
      await window.Chat?.loadSession(s.id);
      refreshSessions();
    };
    return item;
  }

  async function refreshSessions() {
    try {
      const [sessions, ws] = await Promise.all([api('/api/sessions'), api('/api/workspaces')]);
      state.sessions = sessions;
      state.workspaces = ws.items || [];
    } catch {
      return;
    }
    // 当前会话所属工作区高亮；没有会话时保持原样
    const current = state.sessions.find((s) => s.id === state.sessionId);
    if (current) state.activeWorkspace = current.workspaceId || 'default';
    if (!state.workspaces.some((w) => w.id === state.activeWorkspace)) state.activeWorkspace = 'default';
    syncActiveWorkspace();

    const box = $('sessionList');
    box.innerHTML = '';

    for (const w of state.workspaces) {
      const list = state.sessions.filter((s) => (s.workspaceId || 'default') === w.id);
      const group = document.createElement('div');
      group.className = `ws-group${w.id === state.activeWorkspace ? ' active' : ''}`;

      const head = document.createElement('div');
      head.className = 'ws-head';
      head.innerHTML = `
        <span class="caret">${state.collapsed.has(w.id) ? '▸' : '▾'}</span>
        <span class="ws-name"></span>
        <span class="ws-count">${list.length}</span>
        <span class="ws-actions">
          <button class="ws-btn add" title="在这个工作区新建会话">＋</button>
          ${w.id === 'default' ? '' : '<button class="ws-btn rename" title="重命名">✎</button><button class="ws-btn rm" title="删除工作区">✕</button>'}
        </span>`;
      head.querySelector('.ws-name').textContent = w.name;
      head.title = `${w.path}${w.exists ? '' : '（目录不存在）'}`;
      if (!w.exists) head.querySelector('.ws-name').classList.add('missing');
      head.onclick = (e) => {
        const btn = e.target.closest('.ws-btn');
        if (btn) {
          e.stopPropagation();
          if (btn.classList.contains('add')) return newSessionIn(w.id);
          if (btn.classList.contains('rename')) return renameWorkspace(w);
          if (btn.classList.contains('rm')) return removeWorkspace(w);
          return;
        }
        setActiveWorkspace(w.id);
        state.collapsed.has(w.id) ? state.collapsed.delete(w.id) : state.collapsed.add(w.id);
        refreshSessions();
      };
      group.append(head);

      if (!state.collapsed.has(w.id)) {
        const wrap = document.createElement('div');
        wrap.className = 'ws-sessions';
        if (!list.length) {
          const empty = document.createElement('div');
          empty.className = 'ws-empty dim';
          empty.textContent = '还没有会话，点 ＋ 新建';
          wrap.append(empty);
        }
        for (const s of list) wrap.append(sessionItem(s));
        group.append(wrap);
      }
      box.append(group);
    }
  }

  /** 在当前（或指定）工作区里新建会话 */
  async function newSessionIn(workspaceId) {
    const wid = workspaceId || state.activeWorkspace || 'default';
    const created = await post('/api/sessions', { workspaceId: wid });
    setActiveWorkspace(wid);
    await window.Chat?.loadSession(created.id);
    refreshSessions();
    showToast(`已在「${state.workspaces.find((w) => w.id === wid)?.name || wid}」新建会话`);
    return created;
  }

  function openWsModal() {
    $('wsError').textContent = '';
    $('wsName').value = '';
    $('wsPath').value = '';
    $('wsModal').hidden = false;
    setTimeout(() => $('wsName').focus(), 30);
  }
  const closeWsModal = () => ($('wsModal').hidden = true);

  async function createWorkspace() {
    const name = $('wsName').value.trim();
    const path = $('wsPath').value.trim();
    if (!path) {
      $('wsError').textContent = '目录不能为空';
      return;
    }
    try {
      const w = await post('/api/workspaces', { name, path });
      closeWsModal();
      setActiveWorkspace(w.id);
      await refreshSessions();
      showToast(`已添加工作区「${w.name}」`);
    } catch (err) {
      $('wsError').textContent = err.message;
    }
  }

  async function renameWorkspace(w) {
    const name = prompt(`工作区重命名（当前：${w.name}）`, w.name);
    if (name === null || !name.trim()) return;
    try {
      await api(`/api/workspaces/${encodeURIComponent(w.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      refreshSessions();
    } catch (err) {
      showToast(`重命名失败：${err.message}`);
    }
  }

  async function removeWorkspace(w) {
    if (!confirm(`删除工作区「${w.name}」？\n（只是从列表移除，不会删磁盘上的目录）`)) return;
    try {
      await api(`/api/workspaces/${encodeURIComponent(w.id)}`, { method: 'DELETE' });
      if (state.activeWorkspace === w.id) setActiveWorkspace('default');
      refreshSessions();
    } catch (err) {
      showToast(`删除失败：${err.message}`);
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

  /** 三块画像文件：默认只显示标题 + 条数，点「编辑」才展开 markdown 原文 */
  async function refreshChunks() {
    const box = $('memChunks');
    if (!box) return;
    try {
      const { chunks } = await api('/api/memory/chunks');
      box.innerHTML = '';
      for (const c of chunks) {
        const card = document.createElement('div');
        card.className = 'mem-chunk';
        const head = document.createElement('div');
        head.className = 'mem-chunk-head';
        head.innerHTML = `<b>${c.file}</b><span class="dim">${c.count} 条</span>`;
        const edit = document.createElement('button');
        edit.className = 'mini';
        edit.textContent = '编辑';
        head.append(edit);
        const hint = document.createElement('div');
        hint.className = 'dim';
        hint.textContent = c.hint || '';
        const area = document.createElement('textarea');
        area.rows = 6;
        area.hidden = true;
        area.value = c.text;
        const row = document.createElement('div');
        row.className = 'row';
        row.hidden = true;
        const save = document.createElement('button');
        save.className = 'mini primary';
        save.textContent = '保存';
        const cancel = document.createElement('button');
        cancel.className = 'mini';
        cancel.textContent = '取消';
        row.append(save, cancel);
        edit.onclick = () => {
          area.hidden = !area.hidden;
          row.hidden = area.hidden;
          if (!area.hidden) area.focus();
        };
        cancel.onclick = () => {
          area.value = c.text;
          area.hidden = true;
          row.hidden = true;
        };
        save.onclick = async () => {
          try {
            await api(`/api/memory/chunks/${encodeURIComponent(c.name)}`, {
              method: 'PUT',
              body: JSON.stringify({ text: area.value }),
            });
            const count = area.value.split('\n').filter((l) => /^\s*[-*]\s+\S/.test(l)).length;
            showToast(`${c.file} 已保存（${count} 条）`);
            refreshChunks();
            refreshMemory();
          } catch (err) {
            showToast(`保存失败：${err.message}`);
          }
        };
        card.append(head, hint, area, row);
        box.append(card);
      }
    } catch (err) {
      box.innerHTML = `<div class="dim">画像读取失败：${err.message}</div>`;
    }
  }

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
        const where = m.chunk ? `${m.chunk}.md` : `${m.scope}/${m.category}`;
        el.innerHTML = `<div class="meta"><span>#${m.id} · ${where} · ${m.importance}</span><span class="del">删除</span></div><div class="body"></div>`;
        el.querySelector('.body').textContent = m.content;
        el.querySelector('.del').onclick = async () => {
          await api(`/api/memory/${m.id}`, { method: 'DELETE' });
          refreshMemory();
          refreshChunks();
        };
        box.append(el);
      }
      const foot = document.createElement('div');
      foot.className = 'dim';
      foot.style.marginTop = '8px';
      const chunkLine = Object.entries(stats.byChunk || {})
        .map(([k, v]) => `${k === 'json' ? '结构化' : `${k}.md`}:${v}`)
        .join(' ');
      foot.textContent = `共 ${stats.total} 条 · ${chunkLine} · ${Object.entries(stats.byScope || {}).map(([k, v]) => `${k}:${v}`).join(' ')}`;
      box.append(foot);
    } catch (err) {
      box.innerHTML = `<div class="dim">读取失败：${err.message}</div>`;
    }
  }

  async function addMemory() {
    const content = $('memContent').value.trim();
    if (!content) return;
    try {
      const chunk = $('memChunk')?.value || '';
      await post('/api/memory', {
        content,
        scope: $('memScope').value,
        category: $('memCategory').value,
        importance: Number($('memImportance').value) || 0.6,
        sessionId: state.sessionId,
        ...(chunk ? { chunk: chunk === 'none' ? null : chunk } : {}),
      });
      $('memContent').value = '';
      refreshMemory();
      refreshChunks();
      showToast('已记住');
    } catch (err) {
      showToast(`保存失败：${err.message}`);
    }
  }

  // ---------- 技能 ----------
  async function refreshSkills() {
    const box = $('skillList');
    if (!box) return;
    try {
      const { items, enabled, stats } = await api('/api/skills');
      if (!enabled) {
        box.innerHTML = '<div class="dim">技能功能已关闭（SKILLS_ENABLED=0）</div>';
        return;
      }
      if ($('skillHint')) $('skillHint').textContent = `共 ${stats?.total || 0} 个 · ${Math.round((stats?.bytes || 0) / 1024)}KB`;
      box.innerHTML = '';
      if (!items.length) {
        box.innerHTML = '<div class="dim">还没有技能：可以上传 zip 包，或直接写一个。</div>';
        return;
      }
      for (const s of items) {
        const el = document.createElement('div');
        el.className = 'mem-item';
        const files = (s.files || []).length;
        el.innerHTML =
          `<div class="meta"><span><b>${s.name}</b>${s.version ? `@${s.version}` : ''} · ${s.source || ''} · ${files} 个文件</span>` +
          `<span class="acts"><span class="open">查看</span> <span class="exp">导出</span> <span class="del">删除</span></span></div>` +
          `<div class="body"></div>`;
        el.querySelector('.body').textContent = s.description + (s.when ? `（何时用：${s.when}）` : '');
        el.querySelector('.open').onclick = async () => {
          const detail = await api(`/api/skills/${encodeURIComponent(s.name)}?file=SKILL.md`);
          const view = $('skillView');
          view.hidden = false;
          view.textContent = `# ${s.name}\n\n${detail.content || '(空)'}`;
          view.scrollIntoView({ block: 'nearest' });
        };
        el.querySelector('.exp').onclick = () => {
          window.location.href = `/api/skills/${encodeURIComponent(s.name)}/export`;
        };
        el.querySelector('.del').onclick = async () => {
          if (!confirm(`删除技能「${s.name}」？`)) return;
          await api(`/api/skills/${encodeURIComponent(s.name)}`, { method: 'DELETE' });
          refreshSkills();
          showToast(`已删除 ${s.name}`);
        };
        box.append(el);
      }
    } catch (err) {
      box.innerHTML = `<div class="dim">读取失败：${err.message}</div>`;
    }
  }

  async function installSkillZip() {
    const input = $('skillZip');
    const file = input?.files?.[0];
    if (!file) return showToast('先选一个 .zip 文件');
    if (file.size > 8 * 1024 * 1024) return showToast('压缩包太大（>8MB）');
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let i = 0; i < buf.length; i += 0x8000) binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      const meta = await post('/api/skills/install', { zipBase64: btoa(binary), source: file.name, force: true });
      input.value = '';
      refreshSkills();
      showToast(`已安装 ${meta.name}（${meta.files?.length || 0} 个文件）`);
    } catch (err) {
      showToast(`安装失败：${err.message}`);
    }
  }

  async function createSkill() {
    const name = $('skillName').value.trim();
    const description = $('skillDesc').value.trim();
    const content = $('skillBody').value;
    if (!name || !description || !content.trim()) return showToast('技能名 / 描述 / 正文都要填');
    try {
      const meta = await post('/api/skills', { name, description, content, when: $('skillWhen').value.trim(), force: true });
      $('skillName').value = '';
      $('skillDesc').value = '';
      $('skillWhen').value = '';
      $('skillBody').value = '';
      refreshSkills();
      showToast(`已创建技能 ${meta.name}`);
    } catch (err) {
      showToast(`创建失败：${err.message}`);
    }
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
    $('skillInstall')?.addEventListener('click', installSkillZip);
    $('skillCreate')?.addEventListener('click', createSkill);
    $('skillZip')?.addEventListener('change', () => {
      const f = $('skillZip').files?.[0];
      if ($('skillHint') && f) $('skillHint').textContent = `待安装：${f.name}（${Math.round(f.size / 1024)}KB）`;
    });
    $('memSearch').onkeydown = (e) => {
      if (e.key === 'Enter') refreshMemory($('memSearch').value.trim());
    };
    $('newSession').onclick = async () => {
      // 顶部 ＋ ：在当前工作区里新建会话
      await newSessionIn(state.activeWorkspace);
    };
    $('newWorkspace')?.addEventListener('click', openWsModal);
    $('wsCreate')?.addEventListener('click', createWorkspace);
    $('wsCancel')?.addEventListener('click', closeWsModal);
    $('wsModal')?.addEventListener('click', (e) => {
      if (e.target === $('wsModal')) closeWsModal();
    });
    $('wsPath')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') createWorkspace();
    });
    $('wsName')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('wsPath').focus();
    });
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
    refreshChunks();
    refreshSkills();
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
    refreshChunks,
    refreshSkills,
    refreshTools,
    refreshWorkflows,
    refreshTrash,
    newSessionIn,
    openWsModal,
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
