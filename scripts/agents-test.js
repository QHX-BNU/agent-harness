// 子代理凭证继承专项测试
//
// 复现并锁死这个 bug：模型凭证（provider/model/baseUrl/apiKey）在 serve 层是「按请求」传入的，
// 但子代理曾经自己从 config（环境变量）重建 provider —— 于是前端设置里填的 key 到子代理就丢了，
// 表现为「主对话正常，一委派就报 供应商 X 需要 API key」。
//
// 用法: node scripts/agents-test.js
import { spawn } from 'node:child_process';
import path from 'node:path';

import { startFakeLLM } from './fake-llm.js';
import { config } from '../src/config.js';
import { SessionStore } from '../src/store.js';
import { MemoryStore } from '../src/memory.js';
import { ApprovalBroker, Policy } from '../src/policy.js';
import { createToolRegistry } from '../src/tools/index.js';
import { createAgentRunner } from '../src/agents.js';
import { createProvider, resolveProviderConfig } from '../src/providers/index.js';
import { createWorkflowEngine } from '../src/workflow.js';
import { runTurn } from '../src/loop.js';

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
const section = (t) => console.log(`\n${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT = path.resolve('.');
const tmpStore = new SessionStore({
  dir: path.join(ROOT, '.sessions-test'),
  artifactsDir: path.join(ROOT, '.artifacts-test'),
});

const fake = await startFakeLLM();
const FAKE_BASE = fake.baseUrl; // http://127.0.0.1:PORT/v1
console.log(`假厂商: ${FAKE_BASE}（不带 key 一律 401）`);

// ================= 1. 模拟「key 只在前端配了」的环境 =================
section('[1] 环境：服务端没有任何 key，凭证只能来自请求');
{
  // 把可能存在的 key 从环境里摘掉，模拟用户「key 配在可视化界面、没配环境变量」
  const saved = {};
  for (const k of Object.keys(process.env)) {
    if (/(API_KEY|API_TOKEN)$/i.test(k)) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  }
  process.env.DEEPSEEK_API_KEY = '';
  delete process.env.DEEPSEEK_API_KEY;

  let err = null;
  try {
    resolveProviderConfig({ provider: 'deepseek' });
  } catch (e) {
    err = e;
  }
  ok('服务端确实拿不到 deepseek 的 key', /需要 API key/.test(err?.message || ''), err?.message?.slice(0, 40));

  // 这个 runner 的 createProvider 会在「没有 key」时抛错 —— 和真实环境一致
  const agents = createAgentRunner({
    config: { ...config, maxAgentDepth: 2, maxConcurrentAgents: 2, maxSteps: 4, modelTimeoutMs: 15000, modelRetries: 0 },
    store: tmpStore,
    tools: createToolRegistry(),
    memory: null,
    createProvider,
    policy: { broker: new ApprovalBroker(5000) },
  });

  // ---- 1a. 不传 modelConfig：复现旧行为（应该失败）----
  const parent = tmpStore.create({ provider: 'deepseek', model: 'deepseek-chat', approvalMode: 'auto' });
  let legacyErr = null;
  try {
    await agents.run({ description: '无凭证', prompt: '读一下 package.json', parent, depth: 1, emit: () => {} });
  } catch (e) {
    legacyErr = e;
  }
  ok('不传凭证时子代理确实建不起连接（旧行为）', /子代理无法建立模型连接/.test(legacyErr?.message || ''), legacyErr?.message?.split('\n')[0]?.slice(0, 60));
  ok('错误里说明了凭证来源与排查方向', /凭证来源：server-env/.test(legacyErr?.message || '') && /\_API_KEY/.test(legacyErr?.message || ''));

  // ---- 1b. 传 modelConfig：修复后应该成功 ----
  const events = [];
  const r = await agents.run({
    description: '带凭证',
    prompt: '读一下 package.json',
    parent,
    depth: 1,
    emit: (ev) => events.push(ev),
    modelConfig: { provider: 'custom', model: 'fake-1', baseUrl: FAKE_BASE, apiKey: 'sk-from-ui' },
  });
  ok('传了 modelConfig 后子代理跑通', typeof r.summary === 'string' && r.summary.length > 0, r.summary.slice(0, 30));
  ok('子代理有工具调用轨迹', r.toolCalls >= 1, `${r.toolCalls} 次`);
  const start = events.find((e) => e.type === 'subagent_start');
  ok('事件里标明凭证来自请求', start?.credentialSource === 'request', start?.credentialSource);
  ok('事件里带上真实 provider', start?.provider === 'custom', start?.provider);
  const child = tmpStore.get(r.sessionId);
  ok('子会话记录的 provider 是请求里的那个', child?.provider === 'custom' && child?.model === 'fake-1', `${child?.provider}/${child?.model}`);

  // ---- 1c. 主循环 → task 工具 → 子代理，全链路 ----
  const parent2 = tmpStore.create({ provider: 'custom', model: 'fake-1', approvalMode: 'auto' });
  const ev2 = [];
  await runTurn({
    session: parent2,
    userText: '帮我委派一个子任务',
    provider: createProvider({ provider: 'custom', model: 'fake-1', baseUrl: FAKE_BASE, apiKey: 'sk-from-ui' }),
    tools: createToolRegistry(),
    policy: new Policy('auto', new ApprovalBroker(5000)),
    store: tmpStore,
    emit: (ev) => ev2.push(ev),
    config: { ...config, maxSteps: 4, maxAgentDepth: 2, maxConcurrentAgents: 2, modelTimeoutMs: 15000, modelRetries: 0 },
    sandbox: null,
    depth: 0,
    memory: null,
    agents,
    workflows: null,
    modelConfig: { provider: 'custom', model: 'fake-1', baseUrl: FAKE_BASE, apiKey: 'sk-from-ui' },
  });
  const types = ev2.map((e) => e.type);
  ok('主对话发起了 task 工具调用', types.includes('tool_call') && ev2.some((e) => e.type === 'tool_call' && e.name === 'task'));
  ok('子代理被真实启动并结束', types.includes('subagent_start') && types.includes('subagent_done'));
  ok('全程没有报错事件', !types.includes('error'), ev2.filter((e) => e.type === 'error').map((e) => e.message).join(' | ') || '无');

  // ---- 1d. 工作流：每一步也是子代理 ----
  const wf = createWorkflowEngine({
    dir: path.resolve('workflows'),
    agents,
    config: { ...config, maxSteps: 3, maxAgentDepth: 2, maxConcurrentAgents: 2, modelTimeoutMs: 15000, modelRetries: 0 },
  });
  const wfSession = tmpStore.create({ provider: 'custom', model: 'fake-1', approvalMode: 'auto' });
  const wfEvents = [];
  const run = await wf.run('research', {
    input: '测试',
    session: wfSession,
    emit: (ev) => wfEvents.push(ev),
    modelConfig: { provider: 'custom', model: 'fake-1', baseUrl: FAKE_BASE, apiKey: 'sk-from-ui' },
  });
  ok('工作流在同样无环境变量 key 的情况下跑通', run.phases.length === 2 && wfEvents.some((e) => e.type === 'workflow_done'));
  ok('工作流各步都用了请求里的凭证', wfEvents.filter((e) => e.type === 'subagent_start').every((e) => e.credentialSource === 'request'));

  // 还原环境变量
  for (const [k, v] of Object.entries(saved)) process.env[k] = v;
}

// ================= 2. HTTP 全链路（真的起一个 server）=================
section('[2] HTTP：前端只填 key、服务端环境没有 key');
{
  const PORT = 5177;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      PROVIDER: 'deepseek', // 故意选一个必须有 key 的厂商
      API_KEY: '',
      DEEPSEEK_API_KEY: '',
      MODEL: 'deepseek-chat',
      SESSIONS_DIR: path.join(ROOT, '.sessions-test'),
      ARTIFACTS_DIR: path.join(ROOT, '.artifacts-test'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let bootLog = '';
  child.stdout.on('data', (d) => (bootLog += d.toString()));
  child.stderr.on('data', (d) => (bootLog += d.toString()));

  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await sleep(250);
      try {
        up = (await fetch(`http://127.0.0.1:${PORT}/api/config`)).ok;
      } catch {}
    }
    ok('服务在无 key 的环境下也能启动', up, bootLog.split('\n').filter(Boolean)[0]);

    const cfg = await (await fetch(`http://127.0.0.1:${PORT}/api/config`)).json();
    ok('默认模型解析为 deepseek/deepseek-chat', cfg.provider === 'deepseek' && cfg.model === 'deepseek-chat');

    // 不带 key 直接请求 → 应该被明确拒绝
    const noKey = await fetch(`http://127.0.0.1:${PORT}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '读一下 package.json' }),
    });
    ok('不带 key 的请求被 400 拒绝并给提示', noKey.status === 400 && /API key/.test((await noKey.json()).error || ''));

    // 带上 key（前端设置里的那个）+ 端点 → 整条链路（含子代理）必须通
    const res = await fetch(`http://127.0.0.1:${PORT}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: '帮我委派一个子任务',
        approvalMode: 'auto',
        provider: 'deepseek',
        model: 'deepseek-chat',
        baseUrl: FAKE_BASE,
        apiKey: 'sk-only-in-ui',
      }),
    });
    const text = await res.text();
    const events = [];
    for (const frame of text.split('\n\n')) {
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      try {
        events.push(JSON.parse(line.slice(5)));
      } catch {}
    }
    const types = events.map((e) => e.type);
    const errs = events.filter((e) => e.type === 'error');
    const subStart = events.find((e) => e.type === 'subagent_start');
    const subDone = events.find((e) => e.type === 'subagent_done');

    ok('主对话跑通', types.includes('assistant_message'));
    ok('模型调用的是 task 工具', events.some((e) => e.type === 'tool_call' && e.name === 'task'));
    ok('子代理启动', Boolean(subStart), subStart ? `${subStart.provider} · ${subStart.model}` : '');
    ok('子代理凭证来自请求而非环境', subStart?.credentialSource === 'request', subStart?.credentialSource);
    ok('子代理正常结束', Boolean(subDone) && subDone.steps >= 2, subDone ? `${subDone.steps} 步 / ${subDone.toolCalls} 次工具` : '');
    ok('全程零错误事件', errs.length === 0, errs.map((e) => e.message).join(' | ') || '无');
    ok('子代理的结论回到了主对话', events.some((e) => e.type === 'tool_result' && e.name === 'task' && e.ok));

    // 子会话也要落盘可查
    if (subStart) {
      const s = await (await fetch(`http://127.0.0.1:${PORT}/api/sessions/${subStart.agentId}`)).json();
      ok('子会话可单独查（kind=subagent）', s.kind === 'subagent' && s.parentId, `${s.kind} parent=${s.parentId}`);
      const tr = await (await fetch(`http://127.0.0.1:${PORT}/api/sessions/${subStart.agentId}/trace?format=jsonl`)).text();
      ok('子代理有独立 trace', tr.trim().split('\n').length > 3, `${tr.trim().split('\n').length} 条事件`);
    }
  } finally {
    child.kill();
    await sleep(300);
  }
}

await fake.close();
console.log(`\n${fail === 0 ? '✓' : '✗'} 子代理凭证继承测试: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
