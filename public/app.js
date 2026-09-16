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
    sbNetwork: $('sbNetwork'),
    sbNetworkList: $('sbNetworkList'),
    sbNetworkListField: $('sbNetworkListField'),
    sbNetProbeInput: $('sbNetProbeInput'),
    sbNetProbe: $('sbNetProbe'),
    sbNetProbeResult: $('sbNetProbeResult'),
    sbIsolation: $('sbIsolation'),
    sbMode: $('sbMode'),
    sbBackend: $('sbBackend'),
    sbStrict: $('sbStrict'),
    sbTest: $('sbTest'),
    sbResult: $('sbResult'),
    sbPreview: $('sbPreview'),
    sbBadge: $('sbBadge'),
    syncModel: $('syncModel'),
    runtimeModel: $('runtimeModel'),
  };

  const STORAGE_KEY = 'mini-harness.settings.v1';
  const DEFAULT_SETTINGS = {
    settingsVersion: 2,
    provider: 'mock',
    approvalMode: 'ask',
    topK: 5,
    profiles: {},
    sandbox: { scope: 'workspace', customRoots: [], mode: 'write', backend: 'local', strict: true, network: 'all', networkList: [] },
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
    activeWorkspace: { id: 'default', path: '' },
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
    const next = status || 'idle';
    els.statusPill.className = `pill ${next}`;
    els.statusText.textContent = next;
    if (state.live?.state) state.live.state.status = next;
    window.Panels?.setStatus(next);
  }

  // ---------- 设置 ----------
  function profileOf(id) {
    if (!state.settings.profiles || typeof state.settings.profiles !== 'object') state.settings.profiles = {};
    state.settings.profiles[id] = state.settings.profiles[id] || {};
    return state.settings.profiles[id];
  }

  /** 首次打开以服务端环境配置为准；localStorage 只代表用户之后的显式覆盖。 */
  function serverDefaultSettings() {
    const provider = state.config?.provider || DEFAULT_SETTINGS.provider;
    const profile = {};
    if (state.config?.model) profile.model = state.config.model;
    if (state.config?.baseUrl) profile.baseUrl = state.config.baseUrl;
    return {
      ...structuredClone(DEFAULT_SETTINGS),
      provider,
      approvalMode: state.config?.approvalMode || DEFAULT_SETTINGS.approvalMode,
      topK: Number.isFinite(Number(state.config?.memoryTopK)) ? Math.max(0, Math.min(20, Number(state.config.memoryTopK))) : DEFAULT_SETTINGS.topK,
      profiles: Object.keys(profile).length ? { [provider]: profile } : {},
      sandbox: {
        ...structuredClone(DEFAULT_SETTINGS.sandbox),
        ...(state.sandboxCatalog?.defaults || state.config?.sandbox || {}),
      },
    };
  }

  function loadSettings() {
    const defaults = serverDefaultSettings();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        state.settings = defaults;
        return false;
      }
      const saved = JSON.parse(raw);
      const savedSandbox = saved?.sandbox && typeof saved.sandbox === 'object' ? { ...saved.sandbox } : {};
      // v1 曾把 local 写成前端默认值，即使用户从未主动选择它。升级时只迁移这一种旧默认，
      // 避免已有用户继续无感运行在可绕过的策略后端；迁移后仍可手动切回 local。
      if ((Number(saved?.settingsVersion) || 1) < 2 && savedSandbox.backend === 'local' && defaults.sandbox.backend === 'windows') {
        savedSandbox.backend = 'windows';
      }
      state.settings = {
        ...defaults,
        ...saved,
        settingsVersion: 2,
        profiles: { ...defaults.profiles, ...(saved?.profiles && typeof saved.profiles === 'object' ? saved.profiles : {}) },
        sandbox: { ...defaults.sandbox, ...savedSandbox },
      };
      return true;
    } catch {
      /* 忽略损坏的本地配置 */
      state.settings = defaults;
      return false;
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
    if (name === 'memory') {
      window.Panels?.refreshChunks?.();
      window.Panels?.refreshMemory();
    }
    if (name === 'skills') window.Panels?.refreshSkills?.();
    if (name === 'tools') window.Panels?.refreshTools();
    if (name === 'workflows') window.Panels?.refreshWorkflows();
    if (name === 'trash') window.Panels?.refreshTrash();
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
    refreshRuntimeModel();
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

  // ---------- 运行时模型（给飞书机器人这类没有浏览器的入口用）----------
  async function refreshRuntimeModel() {
    if (!els.runtimeModel) return;
    try {
      const r = await (await fetch('/api/model/runtime')).json();
      if (!r.set) {
        els.runtimeModel.textContent =
          '服务端当前没有运行时模型：飞书机器人会用环境变量里的模型（没配就是 mock）。填好上面的 key 后点「同步给服务端」。';
        return;
      }
      els.runtimeModel.innerHTML =
        `服务端当前运行时模型：<b>${esc(r.provider || '?')} · ${esc(r.model || '?')}</b>` +
        `${r.hasApiKey ? '（含 key）' : '（无 key）'} · ${new Date(r.updatedAt).toLocaleTimeString('zh-CN')}` +
        '<br>只存在内存里，重启服务就没了，不会落盘。';
    } catch {
      els.runtimeModel.textContent = '';
    }
  }

  async function syncModelToServer() {
    const form = readForm();
    els.syncModel.disabled = true;
    els.syncModel.textContent = '同步中…';
    try {
      const r = await (
        await fetch('/api/model/runtime', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            provider: form.provider,
            model: form.profile.model,
            baseUrl: form.profile.baseUrl,
            apiKey: form.profile.apiKey,
          }),
        })
      ).json();
      els.testResult.style.color = r.ok ? 'var(--ok)' : 'var(--err)';
      els.testResult.textContent = r.ok ? `✓ 已同步：${r.provider} · ${r.model}` : '✗ 同步失败';
      await refreshRuntimeModel();
    } catch (err) {
      els.testResult.style.color = 'var(--err)';
      els.testResult.textContent = `✗ ${err.message}`;
    } finally {
      els.syncModel.disabled = false;
      els.syncModel.textContent = '同步给服务端';
    }
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
    const wantedBackend = sb.backend || cat.defaults?.backend || 'local';
    // 不可用的后端仍保持选中并明确标成「未安装」；绝不能悄悄降级到 local。
    els.sbBackend.value = cat.backends.some((b) => b.id === wantedBackend) ? wantedBackend : 'local';
    els.sbRoots.value = (sb.customRoots || []).join('\n');
    els.sbStrict.checked = sb.strict !== false;

    // 网络访问：模式 + 主机列表
    els.sbNetwork.innerHTML = '';
    for (const m of cat.networkModes || []) {
      const o = el('option', null, m.label);
      o.value = m.id;
      o.title = m.description;
      els.sbNetwork.append(o);
    }
    els.sbNetwork.value = sb.network || 'all';
    els.sbNetworkList.value = (sb.networkList || []).join('\n');
    els.sbNetworkListField.hidden = !['whitelist', 'blacklist'].includes(els.sbNetwork.value);

    els.sbRootsField.hidden = els.sbScope.value !== 'custom';
    renderSandboxPreview(readSandboxForm());
  }

  function readSandboxForm() {
    return {
      scope: els.sbScope.value,
      mode: els.sbMode.value,
      backend: els.sbBackend.value,
      strict: els.sbStrict.checked,
      network: els.sbNetwork.value,
      networkList: els.sbNetworkList.value
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
      customRoots: els.sbRoots.value
        .split(/\n+/)
        .map((s) => s.trim())
        .filter(Boolean),
    };
  }

  /**
   * 表单尚未提交时服务端没有 describe() 可用，因此用 catalog 的真实环境探测加所选后端推导展示。
   * 一旦收到 sandbox SSE 事件，就直接采用服务端返回的 isolation 快照。
   */
  function isolationFor(cfg = {}) {
    if (cfg.isolation?.level) return cfg.isolation;
    const cat = state.sandboxCatalog || {};
    const backend = cfg.backend || cat.defaults?.backend || 'local';
    const option = cat.backends?.find((b) => b.id === backend);
    const base = cat.isolation || {};
    const container = base.containerRuntime;
    const jail = base.runtimeJail;

    if (backend === 'windows') {
      return option?.available
        ? {
            level: 'os',
            label: 'Windows 原生写入沙箱',
            detail: '受限令牌 + Windows ACL 强制写入范围，Job Object 收拢进程树；读取沿用当前用户权限，非 all 网络规则是代理级约束。',
            backend,
          }
        : {
            level: 'policy',
            label: 'Windows 原生沙箱不可用',
            detail: '项目内执行器或 Windows PowerShell 不可用；命令会失败关闭，不会回落到 local。',
            backend,
          };
    }
    if (backend === 'docker') {
      return option?.available
        ? {
            level: 'container',
            label: '命令容器隔离（Docker）',
            detail: 'run_shell 命令在独立 Docker 容器里执行；文件工具仍由 harness 进程按路径策略执行。',
            backend,
          }
        : {
            level: 'policy',
            label: 'Docker 后端不可用',
            detail: '当前没有可用的 Docker 守护进程；配置会保留且请求会失败，不会静默回落到宿主机执行。',
            backend,
          };
    }
    if (container?.active) return { ...base, backend };
    if (backend === 'wsl') {
      return option?.available
        ? {
            level: 'policy',
            label: 'WSL 子系统（非完整隔离）',
            detail: '命令进入 WSL，但 Windows 磁盘挂载和互操作通常仍可访问；它不是完整容器边界。',
            backend,
          }
        : {
            level: 'policy',
            label: 'WSL 后端不可用',
            detail: '当前无法启动 WSL；配置会保留且请求会失败，不会静默回落到本地执行。',
            backend,
          };
    }
    if (jail?.active && !jail.overPermissive) return { ...base, backend };
    return {
      level: 'policy',
      label: '仅策略（不是真沙箱）',
      detail: '路径作用域 + 命令扫描 + 环境变量清洗。可以被脚本内容、编码命令、管道等方式绕过。',
      backend,
    };
  }

  function renderIsolation(cfg) {
    const iso = isolationFor(cfg);
    if (!els.sbIsolation || !iso) return iso;
    els.sbIsolation.className = `isolation-badge level-${iso.level || 'policy'}`;
    const icon = { container: '🛡', os: '🛡', runtime: '🔒', policy: '⚠' }[iso.level] || '•';
    els.sbIsolation.textContent = `${icon} 隔离等级：${iso.label}`;
    els.sbIsolation.title = iso.detail || '';
    return iso;
  }

  /** 用当前表单的规则试一个主机名（不发出任何真实请求） */
  function probeNetwork() {
    const host = els.sbNetProbeInput.value.trim();
    const out = els.sbNetProbeResult;
    if (!host) {
      out.textContent = '先填个主机名';
      return;
    }
    const sb = readSandboxForm();
    // 本地按同一套规则算一遍，避免为了试规则再起一个沙箱
    const rules = sb.networkList.map((r) => r.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, ''));
    const bare = host.toLowerCase().replace(/^[a-z]+:\/\//, '').split('/')[0];
    const [h, port] = bare.split(':');
    const hit = rules.some((r) => {
      const [rh, rp] = r.split(':');
      if (rp && port && rp !== port) return false;
      if (rh === '*') return true;
      if (rh.startsWith('*')) return h === rh.replace(/^\*\.?/, '') || h.endsWith(`.${rh.replace(/^\*\.?/, '')}`);
      return h === rh;
    });
    const verdict =
      sb.network === 'all'
        ? { ok: true, why: '全部放行' }
        : sb.network === 'off'
          ? { ok: false, why: '完全禁网' }
          : sb.network === 'whitelist'
            ? { ok: hit, why: hit ? '在白名单里' : '不在白名单里' }
            : { ok: !hit, why: hit ? '在黑名单里' : '不在黑名单里' };
    out.style.color = verdict.ok ? 'var(--ok)' : 'var(--err)';
    out.textContent = `${verdict.ok ? '✓ 允许' : '✗ 拒绝'} · ${verdict.why}`;
  }

  function renderSandboxPreview(applied = null) {
    const cat = state.sandboxCatalog;
    const cfg = applied || state.settings.sandbox || DEFAULT_SETTINGS.sandbox;
    const scopeLabel = cat?.presets.find((p) => p.id === cfg.scope)?.label || cfg.scope;
    const modeLabel = cat?.modes.find((m) => m.id === cfg.mode)?.label || cfg.mode;
    const roots = applied?.roots || cfg.customRoots || [];
    const activeWorkspacePath = state.activeWorkspace?.path || window.Panels?.getActiveWorkspace?.()?.path || cat?.workspace;
    const rootLine =
      cfg.scope === 'workspace'
        ? applied?.roots?.join(' · ') || activeWorkspacePath || '工作区'
        : cfg.scope === 'home'
          ? cat?.home || '~'
          : roots.join(' · ') || '（未指定）';
    const netMode = cfg.network || 'all';
    const netLabel = cat?.networkModes?.find((m) => m.id === netMode)?.label || netMode;
    const netList = cfg.networkList || [];
    els.sbPreview.innerHTML =
      `<div>作用区域：<b>${esc(scopeLabel)}</b></div>` +
      `<div>实际根目录：${esc(rootLine)}</div>` +
      `<div>权限：<b>${esc(modeLabel)}</b> · 后端：<b>${esc(cfg.backend || 'local')}</b> · 严格模式：${cfg.strict === false ? '关' : '开'}</div>` +
      `<div>网络：<b>${esc(netLabel)}</b>${
        ['whitelist', 'blacklist'].includes(netMode) && netList.length
          ? ` · ${esc(netList.slice(0, 3).join(', '))}${netList.length > 3 ? ` 等 ${netList.length} 条` : ''}`
          : ''
      }</div>` +
      // 可写范围圈进控制器代码目录时，别让界面假装还有隔离
      (applied?.controller?.exposed
        ? `<div style="color:var(--warn)">⚠ 可写范围包含控制器代码目录（${esc(applied.controller.appRoot || '')}）：改这里的代码就是改下次运行，边界保护不了 harness 自身</div>`
        : '');
    const iso = renderIsolation(cfg);
    updateSandboxBadge(cfg, iso);
  }

  function updateSandboxBadge(cfg, iso = isolationFor(cfg)) {
    const cat = state.sandboxCatalog;
    const scopeLabel = cat?.presets.find((p) => p.id === cfg.scope)?.label || cfg.scope;
    const short = { workspace: '工作区', home: '主目录', custom: '自定义', full: '全盘' }[cfg.scope] || cfg.scope;
    const backend = { windows: 'Windows 原生', local: 'local', docker: 'Docker', wsl: 'WSL' }[cfg.backend] || cfg.backend || 'local';
    els.sbBadge.textContent = `🔒 ${short} · ${cfg.mode === 'readonly' ? '只读' : '可写'} · ${backend}`;
    els.sbBadge.title = `沙箱：${scopeLabel} · ${cfg.mode === 'readonly' ? '只读' : '可写'} · 后端 ${backend} · ${iso?.label || ''}`;
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
        if (ev.workspaceId) window.Panels?.setActiveWorkspace?.(ev.workspaceId);
        break;

      case 'model':
        els.meta.textContent = `${ev.provider} · ${ev.model} · ${ev.protocol}`;
        state.live.provider = ev.provider;
        state.live.model = ev.model;
        pushState();
        break;

      case 'state':
        setStatus(ev.status);
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
        // 普通对话已有 assistant_delta，不能重复；工作流只发最终 message，需要在这里补气泡。
        if (!state.streaming && ev.content) addBubble('assistant', ev.content);
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
        ok.onclick = () => settle(ev.approvalId || ev.id, true, row);
        no.onclick = () => settle(ev.approvalId || ev.id, false, row);
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
          `<div class="summary dim"></div>` +
          `<div class="live dim"></div>`;
        card.querySelector('.name').textContent = ev.description;
        const cred = { request: '本次请求', 'request(baseUrl only)': '本次请求(仅端点)', 'server-env': '服务端环境变量' }[ev.credentialSource] || ev.credentialSource || '本次请求';
        // 这行是「这个子代理用的是哪套凭证」的唯一提示，跑完也不能被摘要冲掉
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
          // 摘要单独一行：正文那行（provider/model/凭证）要一直留着
          const summary = card.querySelector('.summary');
          if (summary) summary.textContent = `${ev.steps} 步 · ${ev.toolCalls} 次工具调用 · ${(ev.summary || '').slice(0, 200)}`;
          else card.querySelector('.body').textContent = `${ev.steps} 步 · ${ev.toolCalls} 次工具调用 · ${(ev.summary || '').slice(0, 200)}`;
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
    const buttons = [...row.querySelectorAll('button')];
    buttons.forEach((b) => (b.disabled = true));
    try {
      const response = await fetch('/api/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, approved }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      if (!result.ok) {
        row.replaceChildren(el('span', 'dim', '审批已过期或已被处理'));
        return;
      }
      row.remove();
    } catch (err) {
      buttons.forEach((b) => (b.disabled = false));
      let hint = row.querySelector('.approval-error');
      if (!hint) {
        hint = el('span', 'approval-error');
        row.append(hint);
      }
      hint.textContent = `提交失败：${err.message}`;
    }
  }

  // ---------- 发送一轮 ----------
  /**
   * 组装请求体：模型凭证 + 审批模式 + 沙箱。
   * 子代理和工作流都靠这份凭证，所以任何发起模型调用的入口（对话 / 工作流）都要用它。
   */
  function requestPayload(extra = {}) {
    const providerId = els.provider.value;
    const prof = profileOf(providerId);
    const topK = Math.max(0, Math.min(20, Number(state.settings.topK) || 0));
    return {
      sessionId: state.sessionId,
      workspaceId: state.activeWorkspace?.id || window.Panels?.getActiveWorkspaceId?.() || 'default',
      approvalMode: els.approvalMode.value,
      provider: providerId,
      model: els.model.value.trim() || undefined,
      apiKey: prof.apiKey || undefined,
      baseUrl: prof.baseUrl || undefined,
      topK,
      sandbox: state.settings.sandbox || undefined,
      ...extra,
    };
  }

  /** Panels 切换工作区时同步路径；沙箱“仅工作区”预览必须跟着变。 */
  function setWorkspace(workspace) {
    if (!workspace) return;
    state.activeWorkspace = {
      id: workspace.id || 'default',
      path: workspace.path || state.config?.workspace || '',
      name: workspace.name || '',
    };
    renderSandboxPreview();
  }

  /** 给工作流等非 chat SSE 入口复用同一套忙碌态和停止按钮。 */
  function beginExternalRun() {
    if (state.running) return null;
    const controller = new AbortController();
    state.controller = controller;
    setBusy(true);
    return controller;
  }

  function endExternalRun(controller) {
    if (state.controller !== controller) return;
    state.controller = null;
    setBusy(false);
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
    const response = await fetch(`/api/sessions/${id}`);
    const session = await response.json();
    if (!response.ok || session.error) throw new Error(session.error || `HTTP ${response.status}`);
    state.sessionId = id;
    if (session.workspaceId) window.Panels?.setActiveWorkspace?.(session.workspaceId);
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
  els.syncModel.onclick = syncModelToServer;
  els.saveSettings.onclick = commitSettings;
  els.resetSettings.onclick = () => {
    state.settings = serverDefaultSettings();
    saveSettings();
    applySettings();
    openModal();
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
  els.sbNetwork.onchange = () => {
    els.sbNetworkListField.hidden = !['whitelist', 'blacklist'].includes(els.sbNetwork.value);
    renderSandboxPreview(readSandboxForm());
  };
  els.sbNetworkList.oninput = () => renderSandboxPreview(readSandboxForm());
  els.sbNetProbe.onclick = probeNetwork;
  els.sbNetProbeInput.onkeydown = (e) => {
    if (e.key === 'Enter') probeNetwork();
  };
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

  window.Chat = {
    handleEvent,
    loadSession,
    newSession,
    addBubble,
    reset: newSession,
    requestPayload,
    setWorkspace,
    setStatus,
    beginExternalRun,
    endExternalRun,
    state,
  };

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
      state.activeWorkspace = { id: 'default', path: cfg.workspace || '', name: '默认工作区' };
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
      state.settings.provider = state.settings.provider || cfg.provider;
      if (!providerInfo(state.settings.provider)) state.settings.provider = cfg.provider;
      if (state.settings.provider === cfg.provider && !state.settings.profiles[state.settings.provider]?.model && cfg.model) {
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
