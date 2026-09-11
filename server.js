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
import { createProvider, listProviders } from './src/providers/index.js';
import { createSandbox, SCOPE_PRESETS, MODES, backendAvailable } from './src/sandbox.js';
import { runTurn } from './src/loop.js';
import { createEmitter } from './src/events.js';
import { eventsToJsonl, sessionToBundle, sessionToMarkdown, summarizeEvent, groupOf } from './src/trace.js';
import { STATUS } from './src/state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- 装配 ----------
const store = new SessionStore({ dir: config.sessionsDir, artifactsDir: config.artifactsDir });
const memory = new MemoryStore({ dir: config.memoryDir, workspaceId: config.workspace });
const broker = new ApprovalBroker(config.approvalTimeoutMs);
const tools = createToolRegistry();
const agents = createAgentRunner({ config, store, tools, memory, createProvider, policy: { broker } });
const workflows = createWorkflowEngine({ dir: config.workflowsDir, agents, config });

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
function buildSandbox(session, requested = {}, emit = null) {
  const base = config.sandbox || {};
  const stored = session.sandboxConfig || {};
  const merged = { ...base, ...stored, ...requested };
  const sandbox = createSandbox({
    scope: merged.scope,
    customRoots: merged.customRoots,
    mode: merged.mode,
    backend: merged.backend,
    workspace: config.workspace,
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

  if (!session) session = store.create({ provider: wantProvider, model: wantModel, approvalMode });
  session.approvalMode = approvalMode;

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

  const sandbox = buildSandbox(session, body.sandbox || {}, emit);
  store.save(session);

  emit({ type: 'session', sessionId: session.id, approvalMode, provider: provider.id, model: provider.model });
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
      config,
      signal: controller.signal,
      memory: config.memoryEnabled ? memory : null,
      agents,
      workflows,
      sandbox,
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

  const session = body.sessionId
    ? store.get(body.sessionId)
    : store.create({ provider: config.provider, model: config.model, approvalMode: 'auto', title: `[工作流] ${name}` });
  if (running.has(session.id)) return json(res, 409, { error: `会话 ${session.id} 忙` });

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

  const sandbox = buildSandbox(session, body.sandbox || {}, emit);
  emit({ type: 'sandbox', ...sandbox.describe() });

  try {
    const result = await workflows.run(name, {
      input: body.input || '',
      session,
      emit,
      signal: controller.signal,
      sandbox,
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
    if (req.method === 'GET' && p === '/api/config') return json(res, 200, publicConfig());
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

    // --- 会话 ---
    if (req.method === 'GET' && p === '/api/sessions') {
      return json(res, 200, store.list({ includeChildren: url.searchParams.get('children') === '1' }));
    }
    if (req.method === 'POST' && p === '/api/sessions') {
      const body = await readBody(req);
      const s = store.create({
        provider: body.provider || config.provider,
        model: body.model || config.model,
        approvalMode: body.approvalMode || config.approvalMode,
        title: body.title,
      });
      return json(res, 201, { id: s.id, title: s.title, status: s.state.status });
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
        store.remove(id);
        return json(res, 200, { ok: true });
      }
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

export { server, store, memory, tools, agents, workflows, STATUS };
