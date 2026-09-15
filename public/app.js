// 对话区 + 设置：SSE 流式渲染、模型/审批选择（放在输入框上方）、设置弹窗（API key 存本地浏览器）。
(function () {
  const $ = (id) => document.getElementById(id);
  const els = {
    messages: $('messages'),
    input: $('input'),
    send: $('send'),
    stop: $('stop'),
    approvalMode: $('approvalMode'),
    meta: $('meta'),
    sessionTitle: $('sessionTitle'),
    empty: $('empty'),
    provider: $('provider'),
    model: $('model'),
    modelList: $('modelList'),
    keyBadge: $('keyBadge'),
    statusPill: $('statusPill'),
    statusText: $('statusText'),
    workspace: $('workspace'),
    modal: $('settingsModal'),
    openSettings: $('openSettings'),
    closeSettings: $('closeSettings'),
    setProvider: $('setProvider'),
    setModel: $('setModel'),
    setModelList: $('setModelList'),
    setApiKey: $('setApiKey'),
    setBaseUrl: $('setBaseUrl'),
    setApproval: $('setApproval'),
    setTopK: $('setTopK'),
    toggleKey: $('toggleKey'),
    testConn: $('testConn'),
    testResult: $('testResult'),
    saveSettings: $('saveSettings'),
    resetSettings: $('resetSettings'),
    // 沙箱
    sbScope: $('sbScope'),
    sbRoots: $('sbRoots'),
    sbRootsField: $('sbRootsField'),
    sbMode: $('sbMode'),
    sbBackend: $('sbBackend'),
    sbStrict: $('sbStrict'),
    sbTest: $('sbTest'),
    sbResult: $('sbResult'),
    sbPreview: $('sbPreview'),
    sbBadge: $('sbBadge'),
  };

  const STORAGE_KEY = 'mini-harness.settings.v1';
  const DEFAULT_SETTINGS = {
    provider: 'mock',
    approvalMode: 'ask',
    topK: 5,
    profiles: {},
    sandbox: { scope: 'workspace', customRoots: [], mode: 'write', backend: 'local', strict: true },
  };

  const state = {
    sessionId: null,
    controller: null,
    running: false,
    streaming: null,
    reasoning: null,
    toolCards: new Map(),
    agentStats: new Map(),
    wfCard: null,
    typing: null,
    providers: [],
    config: null,
    sandboxCatalog: null,
    settings: structuredClone(DEFAULT_SETTINGS),
    live: { id: null, provider: '', model: '', messages: [], state: { status: 'idle', usage: {} } },
  };

  // ---------- 基础工具 ----------
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const scrollDown = () => (els.messages.scrollTop = els.messages.scrollHeight);

  /** 渲染 markdown：解析器在 public/markdown.js（零依赖，支持完整常用语法） */
  function renderMarkdown(raw) {
    return window.MD ? window.MD.render(raw) : esc(raw);
  }

  const TOOL_ICON = {
    fs: '📄',
    shell: '⌨',
    memory: '🧠',
    plan: '☑',
    agent: '🤖',
    workflow: '⚙',
    artifact: '📦',
  };
  const toolIcon = (category) => TOOL_ICON[category] || '▪';

  function addBubble(role, text) {
    els.empty?.remove();
    const wrap = el('div', `msg ${role}`);
    if (role === 'assistant') {
      const av = el('div', 'avatar');
      av.textContent = '◈';
      wrap.append(av);
    }
    const body = el('div', 'body');
    const bubble = el('div', role === 'assistant' ? 'bubble md' : 'bubble');
    bubble.innerHTML = renderMarkdown(text ?? '');
    body.append(bubble);
    wrap.append(body);
    els.messages.append(wrap);
    state.live.messages.push(role);
    pushState();
    scrollDown();
    return { wrap, bubble };
  }

  /** 运行中的三点占位，首个 token 到达就撤掉 */
  function showTyping() {
    if (state.typing) return;
    const wrap = el('div', 'msg assistant');
    const av = el('div', 'avatar');
    av.textContent = '◈';
    const body = el('div', 'body');
    const bubble = el('div', 'bubble');
    bubble.innerHTML = '<div class="typing"><i></i><i></i><i></i></div>';
    body.append(bubble);
    wrap.append(av, body);
    els.messages.append(wrap);
    state.typing = wrap;
    scrollDown();
  }
  function hideTyping() {
    state.typing?.remove();
    state.typing = null;
  }

  function setBusy(busy) {
    state.running = busy;
    els.send.disabled = busy;
    els.stop.hidden = !busy;
  }

  function pushState() {
    window.Panels?.renderState(state.live);
  }

  function setStatus(status) {
    els.statusPill.className = `pill ${status || 'idle'}`;
    els.statusText.textContent = status || 'idle';
    window.Panels?.setStatus(status);
  }

  // ---------- 设置 ----------
  function profileOf(id) {
    state.settings.profiles[id] = state.settings.profiles[id] || {};
    return state.settings.profiles[id];
  }
  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) state.settings = { ...structuredClone(DEFAULT_SETTINGS), ...JSON.parse(raw) };
    } catch {
      /* 忽略损坏的本地配置 */
    }
  }
  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
    } catch {
      /* 隐私模式下可能不可写 */
    }
  }
  const providerInfo = (id) => state.providers.find((p) => p.id === id);

  /** 把设置同步到输入框上方的选择器 */
  function applySettings() {
    const id = state.settings.provider || 'mock';
    els.provider.value = state.providers.some((p) => p.id === id) ? id : 'mock';
    els.approvalMode.value = state.settings.approvalMode || 'ask';
    const prof = profileOf(els.provider.value);
    els.model.value = prof.model || providerInfo(els.provider.value)?.models?.[0] || '';
    fillModelList(els.modelList, providerInfo(els.provider.value)?.models || []);
    updateKeyBadge();
  }

  function updateKeyBadge() {
    const info = providerInfo(els.provider.value);
    const localKey = profileOf(els.provider.value).apiKey;
    const need = info && !info.ready && !localKey;
    els.keyBadge.hidden = !need;
    els.keyBadge.textContent = need ? '未配置 key' : '';
  }

  function fillModelList(target, models) {
    target.innerHTML = '';
    for (const m of models || []) {
      const o = el('option');
      o.value = m;
      target.append(o);
    }
  }

  /** 从设置弹窗的表单读回设置对象 */
  function readForm() {
    const id = els.setProvider.value;
    return {
      provider: id,
      approvalMode: els.setApproval.value,
      topK: Number(els.setTopK.value) || 0,
      profile: {
        model: els.setModel.value.trim(),
        apiKey: els.setApiKey.value.trim(),
        baseUrl: els.setBaseUrl.value.trim(),
      },
    };
  }

  /** 设置弹窗内的分区切换（任务 / 记忆 / 工具 / 工作流 都住在这里） */
  function showSection(name) {
    document.querySelectorAll('.snav').forEach((b) => b.classList.toggle('active', b.dataset.sec === name));
    document.querySelectorAll('.spane').forEach((p) => p.classList.toggle('active', p.id === `sec-${name}`));
    if (name === 'memory') window.Panels?.refreshMemory();
    if (name === 'tools') window.Panels?.refreshTools();
    if (name === 'workflows') window.Panels?.refreshWorkflows();
    if (name === 'sandbox') applySandboxForm();
  }

  function openModal() {
    const id = els.provider.value;
    els.setProvider.value = id;
    const prof = profileOf(id);
    els.setModel.value = prof.model || els.model.value || '';
    els.setApiKey.value = prof.apiKey || '';
    els.setBaseUrl.value = prof.baseUrl || '';
    els.setApproval.value = els.approvalMode.value;
    els.setTopK.value = state.settings.topK ?? 5;
    fillModelList(els.setModelList, providerInfo(id)?.models || []);
    applySandboxForm();
    els.testResult.textContent = '';
    els.testResult.style.color = '';
    els.modal.hidden = false;
    const active = document.querySelector('.snav.active')?.dataset.sec || 'model';
    showSection(active);
    setTimeout(() => (active === 'model' ? els.setApiKey : els.setModel).focus(), 30);
  }
  const closeModal = () => (els.modal.hidden = true);

  async function testConnection() {
    const form = readForm();
    els.testConn.disabled = true;
    els.testConn.textContent = '测试中…';
    els.testResult.style.color = '';
    els.testResult.textContent = '';
    try {
      const r = await (
        await fetch('/api/probe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            provider: form.provider,
            model: form.profile.model || undefined,
            apiKey: form.profile.apiKey || undefined,
            baseUrl: form.profile.baseUrl || undefined,
          }),
        })
      ).json();
      if (r.ok) {
        const u = r.usage || {};
        els.testResult.style.color = 'var(--ok)';
        els.testResult.textContent = `✓ ${r.model} · ${r.latencyMs}ms · 工具调用${r.supportsTools ? '支持' : '未返回'} · ${u.prompt_tokens ?? '?'}/${u.completion_tokens ?? '?'} tokens`;
        if (r.models?.length) {
          fillModelList(els.setModelList, r.models);
          fillModelList(els.modelList, r.models);
        }
      } else {
        els.testResult.style.color = 'var(--err)';
        els.testResult.textContent = `✗ ${r.error}${r.hint ? ` — ${r.hint}` : ''}`;
      }
    } catch (err) {
      els.testResult.style.color = 'var(--err)';
      els.testResult.textContent = `✗ ${err.message}`;
    } finally {
      els.testConn.disabled = false;
      els.testConn.textContent = '测试连接';
    }
  }

  function commitSettings() {
    const form = readForm();
    state.settings.provider = form.provider;
    state.settings.approvalMode = form.approvalMode;
    state.settings.topK = form.topK;
    state.settings.profiles[form.provider] = form.profile;
    state.settings.sandbox = readSandboxForm();
    saveSettings();
    applySettings();
    renderSandboxPreview();
    closeModal();
  }

  // ---------- 沙箱 ----------
  function applySandboxForm() {
    const cat = state.sandboxCatalog;
    if (!cat) return;
    const sb = state.settings.sandbox || DEFAULT_SETTINGS.sandbox;

    els.sbScope.innerHTML = '';
    for (const p of cat.presets) {
      const o = el('option', null, p.label);
      o.value = p.id;
      o.title = p.description;
      els.sbScope.append(o);
    }
    els.sbMode.innerHTML = '';
    for (const m of cat.modes) {
      const o = el('option', null, m.label);
      o.value = m.id;
      o.title = m.description;
      els.sbMode.append(o);
    }
    els.sbBackend.innerHTML = '';
    for (const b of cat.backends) {
      const o = el('option', null, b.available ? b.label : `${b.label}（未安装）`);
      o.value = b.id;
      o.title = b.note;
      o.disabled = !b.available;
      els.sbBackend.append(o);
    }

    els.sbScope.value = sb.scope || 'workspace';
    els.sbMode.value = sb.mode || 'write';
    els.sbBackend.value = cat.backends.find((b) => b.id === (sb.backend || 'local') && b.available)?.id || 'local';
    els.sbRoots.value = (sb.customRoots || []).join('\n');
    els.sbStrict.checked = sb.strict !== false;
    els.sbRootsField.hidden = els.sbScope.value !== 'custom';
    renderSandboxPreview();
  }

  function readSandboxForm() {
    return {
      scope: els.sbScope.value,
      mode: els.sbMode.value,
      backend: els.sbBackend.value,
      strict: els.sbStrict.checked,
      customRoots: els.sbRoots.value
        .split(/\n+/)
        .map((s) => s.trim())
        .filter(Boolean),
    };
  }

  function renderSandboxPreview(applied = null) {
    const cat = state.sandboxCatalog;
    const cfg = applied || state.settings.sandbox || DEFAULT_SETTINGS.sandbox;
    const scopeLabel = cat?.presets.find((p) => p.id === cfg.scope)?.label || cfg.scope;
    const modeLabel = cat?.modes.find((m) => m.id === cfg.mode)?.label || cfg.mode;
    const roots = applied?.roots || cfg.customRoots || [];
    const rootLine = cfg.scope === 'workspace' ? (cat?.workspace || '工作区') : cfg.scope === 'home' ? cat?.home || '~' : roots.join(' · ') || '（未指定）';
    els.sbPreview.innerHTML =
      `<div>作用区域：<b>${esc(scopeLabel)}</b></div>` +
      `<div>实际根目录：${esc(rootLine)}</div>` +
      `<div>权限：<b>${esc(modeLabel)}</b> · 后端：<b>${esc(cfg.backend || 'local')}</b> · 严格模式：${cfg.strict === false ? '关' : '开'}</div>`;
    updateSandboxBadge(applied || cfg);
  }

  function updateSandboxBadge(cfg) {
    const cat = state.sandboxCatalog;
    const scopeLabel = cat?.presets.find((p) => p.id === cfg.scope)?.label || cfg.scope;
    const short = { workspace: '工作区', home: '主目录', custom: '自定义', full: '全盘' }[cfg.scope] || cfg.scope;
    els.sbBadge.textContent = `🔒 ${short} · ${cfg.mode === 'readonly' ? '只读' : '可写'}`;
    els.sbBadge.title = `沙箱：${scopeLabel} · ${cfg.mode === 'readonly' ? '只读' : '可写'} · 后端 ${cfg.backend || 'local'}`;
    els.sbBadge.classList.toggle('ro', cfg.mode === 'readonly');
  }

  async function testSandbox() {
    els.sbTest.disabled = true;
    els.sbTest.textContent = '测试中…';
    try {
      const r = await (
        await fetch('/api/sandbox/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(readSandboxForm()),
        })
      ).json();
      const rows = r.results
        .map((x) => `<div class="${x.verdict === 'deny' ? 'deny' : 'ok'}">${x.verdict === 'deny' ? '⛔ 拒绝' : '✓ 放行'} ${esc(x.case)}${x.detail ? ` — ${esc(x.detail)}` : ''}</div>`)
        .join('');
      els.sbPreview.innerHTML = rows;
      els.sbResult.textContent = `${r.results.filter((x) => x.verdict === 'deny').length}/${r.results.length} 条被拒绝`;
      els.sbResult.style.color = 'var(--dim)';
    } catch (err) {
      els.sbResult.textContent = `测试失败：${err.message}`;
      els.sbResult.style.color = 'var(--err)';
    } finally {
      els.sbTest.disabled = false;
      els.sbTest.textContent = '自测规则';
    }
  }

  // ---------- 事件处理 ----------
  function handleEvent(ev) {
    window.Trace?.push(ev); // trace 面板 / 弹窗实时追加
    switch (ev.type) {
      case 'session':
        if (ev.sessionId) {
          state.sessionId = ev.sessionId;
          state.live.id = ev.sessionId;
          window.Panels?.setSessionId(ev.sessionId);
          window.Trace?.setSession(ev.sessionId);
        }
        break;

      case 'model':
        els.meta.textContent = `${ev.provider} · ${ev.model} · ${ev.protocol}`;
        state.live.provider = ev.provider;
        state.live.model = ev.model;
        pushState();
        break;

      case 'state':
        setStatus(ev.status);
        state.live.state.status = ev.status;
        if (ev.usage) state.live.state.usage = ev.usage;
        if (ev.costUsd !== undefined) state.live.state.costUsd = ev.costUsd;
        if (ev.lastError !== undefined) state.live.state.lastError = ev.lastError;
        if (ev.status === 'awaiting_approval') addBubble('notice', '⏸ 等待你批准工具调用…');
        pushState();
        break;

      case 'step':
        state.reasoning = null;
        state.live.state.steps = ev.step;
        if (ev.step === 1) state.live.state.turns = (state.live.state.turns || 0) + 1;
        pushState();
        break;

      case 'reasoning_delta':
        if (!state.reasoning) {
          const details = el('details', 'reasoning');
          const summary = el('summary', null, '思考中…');
          const pre = el('pre');
          details.append(summary, pre);
          els.messages.append(details);
          state.reasoning = { summary, pre, raw: '' };
        }
        state.reasoning.raw += ev.text;
        state.reasoning.pre.textContent = state.reasoning.raw;
        scrollDown();
        break;

      case 'assistant_delta':
        hideTyping();
        if (state.reasoning) state.reasoning.summary.textContent = `思考过程（${state.reasoning.raw.length} 字符）`;
        if (!state.streaming) state.streaming = { ...addBubble('assistant', ''), raw: '' };
        state.streaming.raw += ev.text;
        state.streaming.bubble.innerHTML = renderMarkdown(state.streaming.raw);
        scrollDown();
        break;

      case 'assistant_message':
        state.streaming = null;
        break;

      case 'retry':
        addBubble('notice', `⟳ 模型接口失败，${ev.waitMs}ms 后第 ${ev.attempt} 次重试：${ev.reason}`);
        break;

      case 'memory_recall':
        if (ev.hits?.length) {
          addBubble('notice', `🧠 自动召回 ${ev.hits.length} 条记忆：${ev.hits.map((h) => `#${h.id}`).join(' ')}`);
        }
        break;

      case 'memory':
        addBubble('notice', `🧠 已写入记忆 #${ev.item?.id}（${ev.item?.scope}）`);
        window.Panels?.refreshMemory();
        break;

      case 'todos':
        window.Panels?.renderTodos(ev.todos);
        state.live.todos = ev.todos;
        break;

      case 'tool_call': {
        const card = el('div', 'tool');
        const head = el('div', 'tool-head');
        head.append(el('span', 'tool-icon', toolIcon(ev.category)));
        head.append(el('span', 'tool-name', ev.name));
        head.append(el('span', `badge ${ev.decision}`, ev.decision));
        if (ev.readOnly) head.append(el('span', 'badge', '只读'));
        const args = JSON.stringify(ev.args);
        const argsEl = el('span', 'tool-args', args);
        argsEl.title = args;
        head.append(argsEl);
        card.append(head);
        els.messages.append(card);
        state.toolCards.set(ev.id, card);
        scrollDown();
        break;
      }

      case 'approval_request': {
        const card = state.toolCards.get(ev.id);
        if (!card) break;
        const row = el('div', 'approval');
        const ok = el('button', 'ok mini', '允许执行');
        const no = el('button', 'err mini', '拒绝');
        ok.onclick = () => settle(ev.id, true, row);
        no.onclick = () => settle(ev.id, false, row);
        row.append(ok, no);
        card.append(row);
        scrollDown();
        break;
      }

      case 'approval_result':
        state.toolCards.get(ev.id)?.querySelector('.approval')?.remove();
        break;

      case 'tool_result': {
        const card = state.toolCards.get(ev.id);
        if (!card) break;
        card.classList.add(ev.ok ? 'ok' : 'err');
        card.querySelector('.tool-name')?.classList.add(ev.ok ? 'ok' : 'err');
        card.querySelector('.badge')?.remove();
        const details = el('details');
        details.append(
          el('summary', null, `${ev.ok ? '结果' : '失败'} · ${ev.ms}ms · ${String(ev.content).length} 字符${ev.artifact ? ' · 已落盘' : ''}`),
        );
        details.append(el('pre', null, String(ev.content).slice(0, 4000)));
        card.append(details);
        if (!ev.ok) details.open = true;
        scrollDown();
        break;
      }

      case 'subagent_start': {
        const card = el('div', 'agent-card');
        card.innerHTML =
          `<div class="head">⇢ 子代理 · <span class="name"></span></div>` +
          `<div class="body"></div>` +
          `<div class="live dim"></div>`;
        card.querySelector('.name').textContent = ev.description;
        const cred = { request: '本次请求', 'request(baseUrl only)': '本次请求(仅端点)', 'server-env': '服务端环境变量' }[ev.credentialSource] || ev.credentialSource || '本次请求';
        card.querySelector('.body').textContent = `${ev.provider ? `${ev.provider} · ` : ''}${ev.model} · 深度 ${ev.depth} · 凭证 ${cred}`;
        const btn = el('button', 'mini open-agent', '查看执行过程 →');
        btn.onclick = () =>
          window.AgentView?.open(ev.agentId, {
            description: ev.description,
            depth: ev.depth,
            provider: ev.provider,
            model: ev.model,
            credentialSource: ev.credentialSource,
          });
        card.append(btn);
        els.messages.append(card);
        state.toolCards.set(`agent:${ev.agentId}`, card);
        state.agentStats.set(ev.agentId, { steps: 0, tools: 0, last: '' });
        scrollDown();
        break;
      }

      case 'subagent_event': {
        // 子代理的内部事件不铺在对话流里（它们嵌在 Trace 中），这里只更新卡片上的实时进度
        const card = state.toolCards.get(`agent:${ev.agentId}`);
        if (!card) break;
        const stat = state.agentStats.get(ev.agentId) || { steps: 0, tools: 0, last: '' };
        const inner = ev.event || {};
        if (inner.type === 'step') stat.steps = inner.step;
        if (inner.type === 'tool_call') {
          stat.tools += 1;
          stat.last = `${inner.name}(${JSON.stringify(inner.args ?? {}).slice(0, 40)})`;
        }
        if (inner.type === 'assistant_delta' && inner.text) stat.last = inner.text.replace(/\s+/g, ' ').slice(0, 60);
        state.agentStats.set(ev.agentId, stat);
        const live = card.querySelector('.live');
        if (live) {
          live.textContent = `运行中 · 第 ${stat.steps || 1} 步 · ${stat.tools} 次工具调用${stat.last ? ` · ${stat.last}` : ''}`;
        }
        break;
      }

      case 'subagent_done': {
        const card = state.toolCards.get(`agent:${ev.agentId}`);
        if (card) {
          card.querySelector('.head').textContent = `⇠ 子代理 ${ev.description} 结束`;
          card.querySelector('.body').textContent = `${ev.steps} 步 · ${ev.toolCalls} 次工具调用 · ${(ev.summary || '').slice(0, 200)}`;
          const live = card.querySelector('.live');
          if (live) live.textContent = '';
          const btn = card.querySelector('.open-agent');
          if (btn) btn.textContent = '查看执行过程 →';
        }
        scrollDown();
        break;
      }

      case 'workflow_start': {
        const card = el('div', 'wf-card');
        card.innerHTML = `<div class="head">▶ 工作流 · <span class="name"></span></div><ul class="wf-steps"></ul>`;
        card.querySelector('.name').textContent = ev.name;
        els.messages.append(card);
        state.wfCard = card;
        scrollDown();
        break;
      }

      case 'workflow_phase':
        state.wfCard?.querySelector('.wf-steps').append(el('li', 'phase', `阶段 ${ev.index}/${ev.total}：${ev.phase}`));
        scrollDown();
        break;

      case 'workflow_step_start':
        state.wfCard?.querySelector('.wf-steps').append(el('li', 'step', `· ${ev.label} 运行中…`));
        scrollDown();
        break;

      case 'workflow_step_done': {
        if (!state.wfCard) break;
        const items = [...state.wfCard.querySelectorAll('.step')];
        const target = items.reverse().find((n) => n.textContent.includes(ev.label) && n.textContent.includes('运行中'));
        if (target) target.textContent = `· ${ev.label} ${ev.ok === false ? '失败' : `${ev.steps} 步完成`}`;
        scrollDown();
        break;
      }

      case 'workflow_done':
        addBubble('notice', `◀ 工作流「${ev.name}」完成：${ev.ok}/${ev.steps} 步，${ev.ms}ms`);
        break;

      case 'sandbox':
        state.live.sandbox = ev;
        updateSandboxBadge(ev);
        renderSandboxPreview(ev);
        break;

      case 'sandbox_denied':
        addBubble('error', `⛔ 沙箱拒绝：${ev.reason}`);
        break;

      case 'usage':
        if (ev.total) {
          state.live.state.usage = ev.total;
          state.live.state.requests = (state.live.state.requests || 0) + 1;
          if (ev.costUsd !== undefined) state.live.state.costUsd = ev.costUsd;
          pushState();
          els.meta.textContent = `${els.meta.textContent.replace(/ · \d+↑\d+↓$/, '')} · ${ev.total.prompt_tokens}↑${ev.total.completion_tokens}↓`;
        }
        break;

      case 'error':
        hideTyping();
        addBubble('error', `错误：${ev.message}${ev.hint ? `\n提示：${ev.hint}` : ''}`);
        break;

      case 'done':
        hideTyping();
        state.streaming = null;
        state.reasoning = null;
        if (ev.reason === 'max_steps') addBubble('error', '达到最大步数，已强制结束');
        if (ev.reason === 'aborted') addBubble('notice', '已中止本轮');
        break;
    }
  }

  async function settle(id, approved, row) {
    row.remove();
    await fetch('/api/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, approved }),
    });
  }

  // ---------- 发送一轮 ----------
  /**
   * 组装请求体：模型凭证 + 审批模式 + 沙箱。
   * 子代理和工作流都靠这份凭证，所以任何发起模型调用的入口（对话 / 工作流）都要用它。
   */
  function requestPayload(extra = {}) {
    const providerId = els.provider.value;
    const prof = profileOf(providerId);
    return {
      sessionId: state.sessionId,
      approvalMode: els.approvalMode.value,
      provider: providerId,
      model: els.model.value.trim() || undefined,
      apiKey: prof.apiKey || undefined,
      baseUrl: prof.baseUrl || undefined,
      sandbox: state.settings.sandbox || undefined,
      ...extra,
    };
  }

  async function send(text) {
    if (state.running || !String(text).trim()) return;
    const providerId = els.provider.value;
    const prof = profileOf(providerId);
    const model = els.model.value.trim() || undefined;

    if (els.sessionTitle.textContent === '新会话') {
      els.sessionTitle.textContent = String(text).replace(/\s+/g, ' ').slice(0, 32);
    }
    addBubble('user', text);
    state.streaming = null;
    state.reasoning = null;
    setBusy(true);
    state.controller = new AbortController();
    showTyping();

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestPayload({ message: text })),
        signal: state.controller.signal,
      });
      if (!res.ok || !res.body) {
        const info = await res.json().catch(() => ({}));
        addBubble('error', `请求失败：HTTP ${res.status} ${info.error || ''}${info.hint ? `\n提示：${info.hint}` : ''}`);
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
            handleEvent(JSON.parse(line.slice(5).trim()));
          } catch {}
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') addBubble('error', `连接中断：${err.message}`);
    } finally {
      hideTyping();
      setBusy(false);
      state.controller = null;
      window.Panels?.refreshSessions();
      els.input.focus();
    }
  }

  // ---------- 会话 ----------
  function resetDom() {
    state.toolCards.clear();
    state.streaming = null;
    state.reasoning = null;
    state.typing = null;
    state.wfCard = null;
    els.messages.innerHTML = '';
    els.messages.append(els.empty ?? el('div', 'empty', '新会话'));
  }

  async function loadSession(id) {
    const session = await (await fetch(`/api/sessions/${id}`)).json();
    state.sessionId = id;
    els.messages.innerHTML = '';
    const cards = new Map();
    for (const m of session.messages) {
      if (m.role === 'user') addBubble('user', m.content);
      else if (m.role === 'assistant') {
        if (m.content) addBubble('assistant', m.content);
        for (const tc of m.toolCalls || []) {
          const card = el('div', 'tool');
          const head = el('div', 'tool-head');
          head.append(el('span', 'tool-name', tc.name), el('span', 'tool-args', JSON.stringify(tc.arguments)));
          card.append(head);
          els.messages.append(card);
          cards.set(tc.id, card);
        }
      } else if (m.role === 'tool') {
        const card = cards.get(m.toolCallId);
        if (!card) continue;
        card.classList.add('ok');
        card.querySelector('.tool-name')?.classList.add('ok');
        const details = el('details');
        details.append(el('summary', null, `结果 · ${String(m.content).length} 字符`));
        details.append(el('pre', null, String(m.content).slice(0, 3000)));
        card.append(details);
      }
    }
    window.Panels?.renderTodos(session.todos);
    els.sessionTitle.textContent = session.title || '未命名会话';
    state.live = {
      id: session.id,
      provider: session.provider,
      model: session.model,
      messages: session.messages,
      state: session.state || {},
      todos: session.todos,
    };
    pushState();
    setStatus(session.state?.status);
    els.meta.textContent = `${session.provider} · ${session.model}`;
    window.Trace?.setSession(id);
    window.Trace?.load(id);
    scrollDown();
  }

  async function newSession() {
    state.controller?.abort();
    state.sessionId = null;
    resetDom();
    els.sessionTitle.textContent = '新会话';
    state.live = { id: null, provider: '', model: '', messages: [], state: { status: 'idle', usage: {}, steps: 0, turns: 0, requests: 0 } };
    window.Panels?.setSessionId(null);
    window.Trace?.setSession(null);
    pushState();
    els.input.focus();
  }

  // ---------- 绑定 ----------
  els.send.onclick = () => {
    const text = els.input.value;
    els.input.value = '';
    els.input.style.height = 'auto';
    send(text);
  };
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      els.send.click();
    }
  });
  els.input.addEventListener('input', () => {
    els.input.style.height = 'auto';
    els.input.style.height = `${Math.min(els.input.scrollHeight, 180)}px`;
  });
  els.stop.onclick = () => {
    state.controller?.abort();
    if (state.sessionId) fetch(`/api/sessions/${state.sessionId}/abort`, { method: 'POST' }).catch(() => {});
  };

  els.provider.onchange = () => {
    const p = providerInfo(els.provider.value);
    const prof = profileOf(els.provider.value);
    els.model.value = prof.model || p?.models?.[0] || '';
    fillModelList(els.modelList, p?.models || []);
    state.settings.provider = els.provider.value;
    saveSettings();
    updateKeyBadge();
  };
  els.model.onchange = () => {
    profileOf(els.provider.value).model = els.model.value.trim();
    saveSettings();
  };
  els.approvalMode.onchange = () => {
    state.settings.approvalMode = els.approvalMode.value;
    saveSettings();
  };
  els.keyBadge.onclick = openModal;

  els.openSettings.onclick = openModal;
  els.closeSettings.onclick = closeModal;
  document.querySelectorAll('.snav').forEach((btn) => {
    btn.onclick = () => showSection(btn.dataset.sec);
  });
  els.modal.onclick = (e) => {
    if (e.target === els.modal) closeModal();
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.modal.hidden) closeModal();
  });
  els.setProvider.onchange = () => {
    const id = els.setProvider.value;
    const prof = profileOf(id);
    els.setModel.value = prof.model || providerInfo(id)?.models?.[0] || '';
    els.setApiKey.value = prof.apiKey || '';
    els.setBaseUrl.value = prof.baseUrl || '';
    fillModelList(els.setModelList, providerInfo(id)?.models || []);
    els.testResult.textContent = '';
  };
  els.toggleKey.onclick = () => {
    const showing = els.setApiKey.type === 'text';
    els.setApiKey.type = showing ? 'password' : 'text';
    els.toggleKey.textContent = showing ? '显示' : '隐藏';
  };
  els.testConn.onclick = testConnection;
  els.saveSettings.onclick = commitSettings;
  els.resetSettings.onclick = () => {
    state.settings = structuredClone(DEFAULT_SETTINGS);
    saveSettings();
    openModal();
    applySettings();
    els.testResult.textContent = '';
  };
  els.sbScope.onchange = () => {
    els.sbRootsField.hidden = els.sbScope.value !== 'custom';
    renderSandboxPreview(readSandboxForm());
  };
  els.sbMode.onchange = () => renderSandboxPreview(readSandboxForm());
  els.sbBackend.onchange = () => renderSandboxPreview(readSandboxForm());
  els.sbStrict.onchange = () => renderSandboxPreview(readSandboxForm());
  els.sbRoots.oninput = () => renderSandboxPreview(readSandboxForm());
  els.sbTest.onclick = testSandbox;
  els.sbBadge.onclick = () => {
    openModal();
    showSection('sandbox');
  };
  document.querySelectorAll('.chip').forEach((c) => {
    c.onclick = () => send(c.dataset.say);
  });

  // 代码块复制（事件委托，覆盖所有流式渲染出来的代码块）
  els.messages.addEventListener('click', (e) => {
    const btn = e.target.closest('.copy');
    if (!btn) return;
    const code = btn.parentElement?.querySelector('pre')?.textContent ?? '';
    navigator.clipboard?.writeText(code).then(
      () => {
        btn.textContent = '已复制';
        setTimeout(() => (btn.textContent = '复制'), 1200);
      },
      () => (btn.textContent = '复制失败'),
    );
  });

  window.Chat = { handleEvent, loadSession, newSession, addBubble, reset: newSession, requestPayload, state };

  // ---------- 启动 ----------
  (async () => {
    try {
      const [cfg, providers, sandbox] = await Promise.all([
        (await fetch('/api/config')).json(),
        (await fetch('/api/providers')).json(),
        (await fetch('/api/sandbox')).json(),
      ]);
      state.config = cfg;
      state.providers = providers;
      state.sandboxCatalog = sandbox;
      els.workspace.textContent = cfg.workspace;

      els.provider.innerHTML = '';
      els.setProvider.innerHTML = '';
      for (const p of providers) {
        const label = p.ready ? p.label : `${p.label} · 无 key`;
        const o1 = el('option', null, label);
        o1.value = p.id;
        o1.title = `${p.protocol} · ${p.baseUrl || 'local'}`;
        els.provider.append(o1);
        const o2 = el('option', null, `${p.label}（${p.protocol}）`);
        o2.value = p.id;
        els.setProvider.append(o2);
      }

      loadSettings();
      if (!state.settings.profiles[cfg.provider] && !providerInfo(cfg.provider)?.ready) {
        // 环境变量里配了默认供应商但没有 key 记录时，仍然跟随服务端默认
      }
      state.settings.provider = state.settings.provider || cfg.provider;
      if (!providerInfo(state.settings.provider)) state.settings.provider = cfg.provider;
      if (!state.settings.profiles[state.settings.provider]?.model && cfg.model) {
        profileOf(state.settings.provider).model = cfg.model;
      }
      applySettings();
      applySandboxForm();

      setStatus('idle');
      pushState();
      els.meta.textContent = `${els.provider.value} · ${els.model.value || '默认模型'}`;
      window.Trace?.init();
      window.AgentView?.init();
      window.Panels?.init();
    } catch (err) {
      els.meta.textContent = `初始化失败：${err.message}`;
    }
    document.body.dataset.ready = '1'; // 给自动化测试一个就绪信号
    els.input.focus();

    const say = new URLSearchParams(location.search).get('say');
    if (say) send(say);
  })();
})();
