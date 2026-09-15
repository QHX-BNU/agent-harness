// HTTP 层：把 loop 的事件流翻译成 SSE，把前端点击翻译成审批结果/中止/工具开关。
// 只依赖 node 内置模块，`node server.js` 直接跑。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config, publicConfig } from './src/config.js';
import { SessionStore } from './src/store.js';
import { MemoryStore } from './src/memory.js';
import { ApprovalBroker, Policy } from './src/policy.js';
import { createToolRegistry } from './src/tools/index.js';
import { createAgentRunner } from './src/agents.js';
import { createWorkflowEngine } from './src/workflow.js';
import { WorkspaceStore, DEFAULT_WORKSPACE_ID } from './src/workspaces.js';
import { createFeishuChannel } from './src/channels/feishu.js';
import { createProvider, listProviders, resolveProviderConfig } from './src/providers/index.js';
import { createSandbox, SCOPE_PRESETS, MODES, backendAvailable } from './src/sandbox.js';
import { runTurn } from './src/loop.js';
import { createEmitter } from './src/events.js';
import { eventsToJsonl, sessionToBundle, sessionToMarkdown, summarizeEvent, groupOf } from './src/trace.js';
import { STATUS } from './src/state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- 装配 ----------
const store = new SessionStore({
  dir: config.sessionsDir,
  artifactsDir: config.artifactsDir,
  trashDir: config.trashDir,
});
// 工作区：默认工作区指向服务启动时的 workspace
const workspaces = new WorkspaceStore({
  file: path.join(config.sessionsDir, '..', '.workspaces.json'),
  defaultPath: config.workspace,
});
const memory = new MemoryStore({ dir: config.memoryDir, workspaceId: config.workspace });
const broker = new ApprovalBroker(config.approvalTimeoutMs);
const tools = createToolRegistry();
const agents = createAgentRunner({ config, store, tools, memory, createProvider, policy: { broker } });
const workflows = createWorkflowEngine({ dir: config.workflowsDir, agents, config });

// 飞书通道：把「群里 @ 机器人」接到同一套内核上（工具/沙箱/记忆/trace 全部复用）
const feishu = createFeishuChannel({
  config,
  store,
  workspaces,
  tools,
  memory,
  agents,
  workflows,
  broker,
  stateFile: path.join(config.sessionsDir, '..', '.channels', 'feishu.json'),
});

const running = new Map(); // sessionId -> AbortController

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function readBody(req, limit = 5_000_000) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > limit) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error(`JSON 解析失败: ${e.message}`));
      }
    });
    req.on('error', reject);
  });
}

const json = (res, code, data) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const abs = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!abs.startsWith(PUBLIC_DIR) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('404');
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(abs)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  fs.createReadStream(abs).pipe(res);
}

/** 开一条 SSE 通道，返回 {emit, close, signal} */
function openSSE(req, res, sessionId) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const controller = new AbortController();
  req.on('close', () => controller.abort());
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  const emit = createEmitter((ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`), {
    log: true,
    prefix: sessionId ? `[${sessionId}] ` : '',
  });
  return {
    emit,
    signal: controller.signal,
    close: () => {
      clearInterval(ping);
      res.end();
    },
  };
}

// ---------- 沙箱 ----------
/** 沙箱可用性（UI 里用来禁用没装的后端） */
function sandboxAvailability() {
  return [
    { id: 'local', label: '本地策略沙箱', available: true, note: '路径作用域 + 命令扫描 + 环境变量清洗；不是内核隔离' },
    {
      id: 'docker',
      label: 'Docker 容器',
      available: backendAvailable.docker(),
      note: '真正的文件系统/进程隔离，需要 docker 且守护进程在跑',
    },
    { id: 'wsl', label: 'WSL', available: backendAvailable.wsl(), note: 'Linux 用户态隔离，但 /mnt/c 仍映射到 Windows 磁盘' },
  ];
}

function sandboxCatalog() {
  return {
    defaults: config.sandbox,
    presets: Object.entries(SCOPE_PRESETS).map(([id, p]) => ({ id, ...p })),
    modes: Object.entries(MODES).map(([id, m]) => ({ id, ...m })),
    backends: sandboxAvailability(),
    workspace: config.workspace,
    home: os.homedir(),
  };
}

/** 合并「请求 > 会话 > 服务端默认」得到本次生效的沙箱 */
function buildSandbox(session, requested = {}, emit = null, workspacePath = null) {
  const base = config.sandbox || {};
  const stored = session.sandboxConfig || {};
  const merged = { ...base, ...stored, ...requested };
  const sandbox = createSandbox({
    scope: merged.scope,
    customRoots: merged.customRoots,
    mode: merged.mode,
    backend: merged.backend,
    // 「仅工作区」的作用范围 = 这个会话所属工作区的目录
    workspace: workspacePath || config.workspace,
    strict: merged.strict !== false,
    image: merged.image,
    network: merged.network,
    tempDir: path.join(config.sessionsDir, '..', '.sandbox-tmp'),
    sessionId: session.id,
    emit: (ev) => {
      // 拒绝记录挂到会话上，界面和导出都能看到
      if (ev.type === 'sandbox_denied') {
        session.sandboxDenials = [...(session.sandboxDenials || []), ev].slice(-50);
      }
      emit?.(ev);
    },
  });
  session.sandboxConfig = {
    scope: sandbox.scope,
    mode: sandbox.mode,
    backend: sandbox.backend,
    customRoots: sandbox.roots,
    strict: sandbox.strict,
    image: sandbox.image,
    network: sandbox.network,
  };
  return sandbox;
}

// ---------- Trace 导出 ----------
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function download(res, filename, contentType, body) {
  res.writeHead(200, {
    'content-type': `${contentType}; charset=utf-8`,
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * 导出会话 trace。
 * @param {'jsonl'|'json'|'md'} format
 */
function exportTrace(res, session, format = 'jsonl') {
  const events = store.readEvents(session.id, 20000);
  const base = `harness-${session.id}-${stamp()}`;
  if (format === 'json') {
    return download(res, `${base}.json`, 'application/json', JSON.stringify(sessionToBundle(session, events), null, 2));
  }
  if (format === 'md' || format === 'markdown') {
    return download(res, `${base}.md`, 'text/markdown', sessionToMarkdown(session, events));
  }
  return download(res, `${base}.jsonl`, 'application/x-ndjson', eventsToJsonl(events));
}

// ---------- 对话 ----------
async function handleChat(req, res) {
  const body = await readBody(req);
  const userText = String(body.message ?? '').trim();
  if (!userText) return json(res, 400, { error: 'message 不能为空' });

  let session = body.sessionId ? store.get(body.sessionId) : null;
  const approvalMode = body.approvalMode || config.approvalMode;
  const wantProvider = body.provider || config.provider;
  const wantModel = body.model || (wantProvider === config.provider ? config.model : '') || undefined;

  // 工作区：会话属于哪个工作区，决定了文件工具的根目录 / 沙箱范围 / workspace 级记忆
  const ws = workspaces.get(body.workspaceId || session?.workspaceId || 'default') || workspaces.get('default');
  if (ws) workspaces.touch(ws.id);

  if (!session) {
    session = store.create({
      provider: wantProvider,
      model: wantModel,
      approvalMode,
      workspaceId: ws?.id || 'default',
      workspacePath: ws?.path || config.workspace,
    });
  }
  session.approvalMode = approvalMode;
  if (ws) {
    session.workspaceId = ws.id;
    session.workspacePath = ws.path;
  }
  // 本轮生效的配置：工作区路径覆盖全局默认
  const turnConfig = { ...config, workspace: ws?.path || config.workspace, workspaceName: ws?.name || '' };

  if (running.has(session.id)) {
    return json(res, 409, { error: `会话 ${session.id} 正在处理上一轮请求，先中止或开新会话` });
  }

  let provider;
  try {
    provider = createProvider({
      provider: wantProvider,
      model: wantModel,
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
      timeoutMs: config.modelTimeoutMs,
      retries: config.modelRetries,
    });
    session.model = provider.model;
  } catch (err) {
    return json(res, 400, { error: err.message, hint: err.hint || '' });
  }

  const { emit: rawEmit, signal, close } = openSSE(req, res, session.id);
  const controller = new AbortController();
  signal.addEventListener('abort', () => controller.abort(), { once: true });
  running.set(session.id, controller);

  // runTurn 内部的事件由 loop 自己落盘；这里只补 loop 之外发出的几条
  const emit = (ev) => {
    store.appendEvent(session.id, ev);
    rawEmit(ev);
  };

  const sandbox = buildSandbox(session, body.sandbox || {}, emit, ws?.path);
  store.save(session);

  emit({ type: 'session', sessionId: session.id, approvalMode, provider: provider.id, model: provider.model, workspaceId: session.workspaceId });
  emit({ type: 'model', provider: provider.id, model: provider.model, protocol: provider.protocol, baseUrl: provider.baseUrl });
  emit({ type: 'sandbox', ...sandbox.describe() });
  if (session.todos?.length) emit({ type: 'todos', todos: session.todos });

  try {
    await runTurn({
      session,
      userText,
      provider,
      tools,
      policy: new Policy(approvalMode, broker),
      store,
      emit: rawEmit,
      config: turnConfig,
      signal: controller.signal,
      memory: config.memoryEnabled ? memory : null,
      agents,
      workflows,
      sandbox,
      // 本次请求实际用的凭证，子代理/工作流必须继承（否则会退回服务端环境变量）
      modelConfig: {
        provider: provider.id,
        model: provider.model,
        baseUrl: body.baseUrl || config.baseUrl || undefined,
        apiKey: body.apiKey || config.apiKey || undefined,
      },
      depth: 0,
    });
  } catch (err) {
    emit({ type: 'error', message: err.message, hint: err.hint || '' });
  } finally {
    running.delete(session.id);
    close();
  }
}

// ---------- 工作流 ----------
async function handleWorkflowRun(req, res) {
  const body = await readBody(req);
  const name = String(body.name || '').trim();
  if (!name) return json(res, 400, { error: 'name 不能为空' });

  const wfWs = workspaces.get(body.workspaceId || store.get(body.sessionId)?.workspaceId || 'default') || workspaces.get('default');
  const session = body.sessionId
    ? store.get(body.sessionId)
    : store.create({
        provider: body.provider || config.provider,
        model: body.model || config.model,
        approvalMode: 'auto',
        title: `[工作流] ${name}`,
        workspaceId: wfWs?.id || 'default',
        workspacePath: wfWs?.path || config.workspace,
      });
  if (running.has(session.id)) return json(res, 409, { error: `会话 ${session.id} 忙` });
  if (wfWs) workspaces.touch(wfWs.id);

  const { emit: rawEmit, signal, close } = openSSE(req, res, session.id);
  const controller = new AbortController();
  signal.addEventListener('abort', () => controller.abort(), { once: true });
  running.set(session.id, controller);

  // 工作流事件不经过 loop，所以这里统一落盘
  const emit = (ev) => {
    store.appendEvent(session.id, ev);
    rawEmit(ev);
  };

  emit({ type: 'session', sessionId: session.id, kind: 'workflow', name });

  const sandbox = buildSandbox(session, body.sandbox || {}, emit, wfWs?.path);
  emit({ type: 'sandbox', ...sandbox.describe() });

  try {
    const result = await workflows.run(name, {
      input: body.input || '',
      session,
      emit,
      signal: controller.signal,
      sandbox,
      // 工作流的每一步都是子代理，同样要继承本次请求的凭证
      modelConfig: {
        provider: body.provider || session.provider || config.provider,
        model: body.model || session.model || config.model,
        baseUrl: body.baseUrl || config.baseUrl || undefined,
        apiKey: body.apiKey || config.apiKey || undefined,
      },
    });
    store.append(session, { role: 'assistant', content: result.summary });
    emit({ type: 'assistant_message', content: result.summary });
    emit({ type: 'done', steps: 0, reason: 'workflow_done' });
  } catch (err) {
    emit({ type: 'error', message: err.message });
    emit({ type: 'done', steps: 0, reason: 'error' });
  } finally {
    running.delete(session.id);
    close();
  }
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const seg = p.split('/').filter(Boolean); // ['api','sessions','abc','abort']

  try {
    // --- 基础信息 ---
    if (req.method === 'GET' && p === '/api/config') {
      const cfg = publicConfig();
      // 把默认模型解析成实际会用的那个（MODEL 留空时用厂商预设的第一个）
      try {
        const resolved = resolveProviderConfig({
          provider: cfg.provider,
          model: cfg.model,
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
        });
        cfg.model = resolved.model;
        cfg.baseUrl = resolved.baseUrl;
        cfg.protocol = resolved.protocol;
        cfg.providerLabel = resolved.label;
      } catch (err) {
        cfg.modelError = err.message;
      }
      return json(res, 200, cfg);
    }
    if (req.method === 'GET' && p === '/api/providers') return json(res, 200, listProviders({}, config.provider));
    if (req.method === 'POST' && p === '/api/probe') return await handleProbe(req, res);

    // --- 沙箱 ---
    if (req.method === 'GET' && p === '/api/sandbox') return json(res, 200, sandboxCatalog());
    if (req.method === 'POST' && p === '/api/sandbox/test') {
      const body = await readBody(req);
      const s = createSandbox({
        ...(config.sandbox || {}),
        ...body,
        workspace: config.workspace,
        tempDir: path.join(config.sessionsDir, '..', '.sandbox-tmp'),
      });
      const results = [];
      const cases = [
        { name: '工作区内读', run: () => s.resolve('package.json') },
        { name: '工作区外读', run: () => s.resolve(path.join(os.homedir(), '.ssh', 'id_rsa')) },
        { name: '工作区内写', run: () => s.resolve('tmp-x.txt', { forWrite: true }) },
        { name: '命令：区域内', run: () => s.checkCommand('node -v') },
        { name: '命令：越界路径', run: () => s.checkCommand('type C:\\Windows\\win.ini') },
        { name: '命令：父目录穿越', run: () => s.checkCommand('cd .. && ls') },
        { name: '命令：危险命令', run: () => s.checkCommand('rm -rf /') },
        { name: '命令：只读写操作', run: () => s.checkCommand('echo hi > a.txt') },
      ];
      for (const c of cases) {
        try {
          const r = c.run();
          results.push({ case: c.name, verdict: r && r.ok === false ? 'deny' : 'allow', detail: r?.reason || '' });
        } catch (err) {
          results.push({ case: c.name, verdict: 'deny', detail: err.message });
        }
      }
      return json(res, 200, { config: s.describe(), results });
    }
    if (req.method === 'GET' && p === '/api/tools') {
      return json(res, 200, { tools: tools.describe(), byCategory: tools.byCategory() });
    }
    if (req.method === 'POST' && seg[1] === 'tools' && seg[3] === 'toggle') {
      const body = await readBody(req);
      const enabled = tools.setEnabled(decodeURIComponent(seg[2]), body.enabled !== false);
      return json(res, 200, { ok: true, name: decodeURIComponent(seg[2]), enabled });
    }

    // --- 工作区 ---
    if (req.method === 'GET' && p === '/api/workspaces') {
      return json(res, 200, { items: workspaces.describe(store.countByWorkspace()), defaultPath: config.workspace });
    }
    if (req.method === 'POST' && p === '/api/workspaces') {
      const body = await readBody(req);
      try {
        return json(res, 201, workspaces.create({ name: body.name, path: body.path }));
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    if (seg[1] === 'workspaces' && seg[2] && (req.method === 'PATCH' || req.method === 'DELETE')) {
      const wid = decodeURIComponent(seg[2]);
      try {
        if (req.method === 'PATCH') return json(res, 200, { ok: true, workspace: workspaces.update(wid, await readBody(req)) });
        // 删工作区不删会话：如果它下面还有会话，先拦下来（避免会话变成孤儿）
        const count = store.list({ includeChildren: true, workspaceId: wid }).length;
        if (count > 0) {
          return json(res, 400, { error: `这个工作区下还有 ${count} 个会话，先删掉或移走再删工作区` });
        }
        return json(res, 200, { ok: true, workspace: workspaces.remove(wid) });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    // --- 会话 ---
    if (req.method === 'GET' && p === '/api/sessions') {
      return json(res, 200, store.list({
        includeChildren: url.searchParams.get('children') === '1',
        workspaceId: url.searchParams.get('workspaceId') || null,
      }));
    }
    // 备份：把所有会话（含事件）打包成一个 JSON 下载
    if (req.method === 'GET' && p === '/api/sessions/export') {
      const bundle = store.exportAll();
      return download(res, `harness-sessions-${stamp()}.json`, 'application/json', JSON.stringify(bundle, null, 2));
    }
    // 回收站
    if (req.method === 'GET' && p === '/api/sessions/trash') {
      return json(res, 200, { items: store.listTrash(), dir: config.trashDir });
    }
    if (req.method === 'POST' && seg[1] === 'sessions' && seg[2] === 'trash' && seg[4] === 'restore') {
      try {
        const restored = store.restore(decodeURIComponent(seg[3]));
        return json(res, 200, { ok: true, id: restored?.id, title: restored?.title });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    if (req.method === 'DELETE' && seg[1] === 'sessions' && seg[2] === 'trash') {
      const n = store.purge(seg[3] ? decodeURIComponent(seg[3]) : undefined);
      return json(res, 200, { ok: true, purged: n });
    }
    if (req.method === 'POST' && p === '/api/sessions') {
      const body = await readBody(req);
      const ws = workspaces.get(body.workspaceId || DEFAULT_WORKSPACE_ID) || workspaces.get(DEFAULT_WORKSPACE_ID);
      const s = store.create({
        provider: body.provider || config.provider,
        model: body.model || config.model,
        approvalMode: body.approvalMode || config.approvalMode,
        title: body.title,
        workspaceId: ws?.id || 'default',
        workspacePath: ws?.path || config.workspace,
      });
      if (ws) workspaces.touch(ws.id);
      return json(res, 201, { id: s.id, title: s.title, status: s.state.status, workspaceId: s.workspaceId });
    }
    if (seg[1] === 'sessions' && seg[2]) {
      const id = seg[2];
      const session = store.get(id);
      if (!session) return json(res, 404, { error: '会话不存在' });
      if (req.method === 'GET' && !seg[3]) return json(res, 200, session);
      if (req.method === 'GET' && seg[3] === 'events') {
        const limit = Number(url.searchParams.get('limit')) || 500;
        const events = store.readEvents(id, limit);
        return json(res, 200, {
          count: events.length,
          events: events.map((e, i) => ({ i, group: groupOf(e.type), summary: summarizeEvent(e), ...e })),
        });
      }
      if (req.method === 'GET' && seg[3] === 'trace') return exportTrace(res, session, url.searchParams.get('format') || 'jsonl');
      if (req.method === 'GET' && seg[3] === 'sandbox') {
        return json(res, 200, {
          config: session.sandboxConfig || config.sandbox,
          denials: session.sandboxDenials || [],
          catalog: sandboxCatalog(),
        });
      }
      if (req.method === 'GET' && seg[3] === 'export') return exportTrace(res, session, url.searchParams.get('format') || 'md');
      if (req.method === 'GET' && seg[3] === 'artifacts') return json(res, 200, store.listArtifacts(id));
      if (req.method === 'POST' && seg[3] === 'abort') {
        const c = running.get(id);
        if (c) c.abort();
        return json(res, 200, { ok: Boolean(c) });
      }
      if (req.method === 'DELETE' && !seg[3]) {
        running.get(id)?.abort();
        // 默认软删除 → 回收站（可恢复）；?hard=1 才是真删
        const hard = url.searchParams.get('hard') === '1';
        const r = store.remove(id, { hard });
        return json(res, 200, { ok: r.ok, soft: !hard, trashId: r.trashId, trashDir: hard ? null : config.trashDir });
      }
    }

    // --- 通道（飞书机器人）---
    if (req.method === 'GET' && p === '/api/channels') {
      return json(res, 200, {
        feishu: {
          ...feishu.status(),
          enabled: config.feishu.enabled,
          botName: config.feishu.botName,
          requireMention: config.feishu.requireMention,
          workspaceId: config.feishu.workspaceId,
          approvalMode: config.feishu.approvalMode,
        },
      });
    }
    if (req.method === 'POST' && p === '/api/channels/feishu/start') {
      return json(res, 200, feishu.start());
    }
    if (req.method === 'POST' && p === '/api/channels/feishu/stop') {
      return json(res, 200, feishu.stop());
    }

    // --- 审批 ---
    if (req.method === 'GET' && p === '/api/approvals') return json(res, 200, broker.pendingList());
    if (req.method === 'POST' && p === '/api/approve') {
      const { id, approved } = await readBody(req);
      return json(res, 200, { ok: broker.settle(id, approved) });
    }

    // --- 记忆 ---
    if (req.method === 'GET' && p === '/api/memory') {
      return json(res, 200, {
        items: memory.list({
          sessionId: url.searchParams.get('sessionId'),
          workspaceId: url.searchParams.get('workspaceId') || undefined,
          includeSession: url.searchParams.get('includeSession') !== '0',
          scope: url.searchParams.get('scope') || undefined,
          category: url.searchParams.get('category') || undefined,
          tag: url.searchParams.get('tag') || undefined,
          keyword: url.searchParams.get('keyword') || undefined,
          limit: Number(url.searchParams.get('limit')) || 50,
        }),
        stats: memory.stats(),
      });
    }
    if (req.method === 'GET' && p === '/api/memory/stats') return json(res, 200, memory.stats());
    if (req.method === 'POST' && p === '/api/memory/search') {
      const body = await readBody(req);
      return json(res, 200, memory.search({
        query: body.query || '',
        topK: body.topK || 8,
        sessionId: body.sessionId,
        workspaceId: body.workspaceId,
        includeSession: body.includeSession !== false,
        recordLoad: Boolean(body.recordLoad),
      }));
    }
    if (req.method === 'POST' && p === '/api/memory') {
      const body = await readBody(req);
      return json(res, 201, memory.add(body));
    }
    if (seg[1] === 'memory' && seg[2]) {
      const id = Number(seg[2]);
      if (req.method === 'PATCH') return json(res, 200, memory.update(id, await readBody(req)) || { error: '不存在' });
      if (req.method === 'DELETE') return json(res, 200, { ok: memory.remove(id) });
      if (req.method === 'GET') {
        const item = memory.get(id);
        return item ? json(res, 200, item) : json(res, 404, { error: '不存在' });
      }
    }

    // --- 工作流 ---
    if (req.method === 'GET' && p === '/api/workflows') return json(res, 200, workflows.list());
    if (req.method === 'POST' && p === '/api/workflows/run') return await handleWorkflowRun(req, res);

    // --- 对话 ---
    if (req.method === 'POST' && p === '/api/chat') return await handleChat(req, res);

    if (req.method === 'GET') return serveStatic(req, res, p);
    return json(res, 405, { error: 'method not allowed' });
  } catch (err) {
    if (!res.headersSent) json(res, 500, { error: err.message });
    else res.end();
  }
});

/** 连通性自检 */
async function handleProbe(req, res) {
  const body = await readBody(req);
  const t0 = Date.now();
  try {
    const provider = createProvider({
      provider: body.provider || config.provider,
      model: body.model,
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
      timeoutMs: Math.min(config.modelTimeoutMs, 30000),
      retries: 0,
    });
    const result = await provider.ping({ withTools: body.withTools !== false });
    let models = null;
    try {
      models = await provider.listModels();
    } catch {
      /* 不是所有网关都实现 /models */
    }
    return json(res, 200, {
      ...result,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      models: models ? models.slice(0, 200) : null,
      totalMs: Date.now() - t0,
    });
  } catch (err) {
    return json(res, 200, {
      ok: false,
      provider: body.provider || config.provider,
      error: err.message,
      hint: err.hint || '',
      status: err.status || 0,
      totalMs: Date.now() - t0,
    });
  }
}

server.listen(config.port, config.host, () => {
  console.log(`mini-harness 已启动: http://${config.host}:${config.port}`);
  console.log(`  workspace = ${config.workspace}`);
  console.log(`  工具 = ${tools.enabled.length}/${tools.all.length} 启用 · 工作流 = ${workflows.list().length} 个 · 记忆 = ${memory.stats().total} 条`);
  console.log(`  approvalMode = ${config.approvalMode}  maxSteps = ${config.maxSteps}  子代理深度 = ${config.maxAgentDepth}`);
  // 会话存在磁盘上，重启不会丢；这里把计数和路径打出来，便于确认
  const sessions = store.list({ includeChildren: true });
  const trash = store.listTrash();
  console.log(`  会话 = ${sessions.length} 个（${config.sessionsDir}）· 回收站 = ${trash.length} 个（${config.trashDir}）`);
  if (sessions.length) console.log(`  最近会话 = ${sessions.slice(0, 3).map((s) => `${s.id}/${s.title || '未命名'}`).join(' · ')}`);
  if (config.feishu.enabled) {
    feishu.start();
    console.log(`  飞书通道 = 已启动（@${config.feishu.botName || '机器人'} 触发，工作区 ${config.feishu.workspaceId}）`);
  } else {
    console.log('  飞书通道 = 未启用（设 FEISHU_ENABLED=1 打开；也可用 POST /api/channels/feishu/start 临时启动）');
  }
  try {
    const p = createProvider({ provider: config.provider, model: config.model, baseUrl: config.baseUrl, apiKey: config.apiKey });
    console.log(`  默认模型 = ${p.id} · ${p.model}  (${p.protocol}, ${p.baseUrl || 'local'})`);
    if (p.id === 'mock') {
      console.log('  提示: 当前是离线 mock；接真实模型请设 PROVIDER=deepseek 和 DEEPSEEK_API_KEY（或 API_KEY）');
    }
  } catch (err) {
    console.log(`  ⚠ 默认模型不可用: ${err.message}`);
  }
});

export { server, store, memory, tools, agents, workflows, workspaces, feishu, STATUS };
