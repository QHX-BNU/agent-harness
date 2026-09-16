// harness 全套自检：状态 / 记忆 / 工具 / 策略 / 子代理 / 工作流 / 循环集成。
// 用一个假厂商服务当模型，所有断言都真跑，不需要任何 API key。
// 用法: node scripts/harness-test.js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { startFakeLLM } from './fake-llm.js';
import { config } from '../src/config.js';
import { SessionStore } from '../src/store.js';
import { MemoryStore } from '../src/memory.js';
import { ApprovalBroker, Policy } from '../src/policy.js';
import { createToolRegistry } from '../src/tools/index.js';
import { createAgentRunner } from '../src/agents.js';
import { createWorkflowEngine } from '../src/workflow.js';
import { createProvider } from '../src/providers/index.js';
import { runTurn } from '../src/loop.js';
import { createState, addUsage, setStatus, STATUS, publicSession } from '../src/state.js';
import { buildSystemPrompt, trimHistory, spillToolResult } from '../src/context.js';

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

// ---------- 测试用沙箱目录 ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
const testConfig = {
  ...config,
  workspace: tmp,
  sessionsDir: path.join(tmp, '.sessions'),
  artifactsDir: path.join(tmp, '.artifacts'),
  memoryDir: path.join(tmp, '.memory'),
  workflowsDir: path.resolve('workflows'),
  memoryEnabled: true,
  memoryTopK: 3,
  maxSteps: 6,
  maxAgentDepth: 2,
  maxConcurrentAgents: 2,
  toolResultMaxChars: 200,
};
fs.writeFileSync(path.join(tmp, 'a.js'), 'export const x = 1;\n// TODO: fix me\n');
fs.mkdirSync(path.join(tmp, 'src'));
fs.writeFileSync(path.join(tmp, 'src', 'b.js'), 'function hello() { return "world"; }\n// TODO: 优化\n');
fs.writeFileSync(path.join(tmp, 'notes.md'), '# 笔记\n这个项目不引入第三方依赖。\n');
fs.writeFileSync(path.join(tmp, 'dup.txt'), 'same line\nsame line\n');

const fake = await startFakeLLM();
const store = new SessionStore({ dir: testConfig.sessionsDir, artifactsDir: testConfig.artifactsDir });
const memory = new MemoryStore({ dir: testConfig.memoryDir, workspaceId: tmp });
const broker = new ApprovalBroker(2000);
const tools = createToolRegistry();
const provider = () =>
  createProvider({ provider: 'custom', baseUrl: fake.baseUrl, apiKey: 'k', model: 'fake-1', retries: 0 });
const agents = createAgentRunner({ config: testConfig, store, tools, memory, createProvider: provider, policy: { broker } });
const workflows = createWorkflowEngine({ dir: testConfig.workflowsDir, agents, config: testConfig });

// ================= 1. 状态层 =================
section('[1] 状态层');
{
  const s = createState({ provider: 'deepseek', model: 'deepseek-chat' });
  ok('初始状态是 idle', s.status === STATUS.IDLE);
  setStatus({ state: s }, STATUS.RUNNING);
  ok('可以切到 running', s.status === STATUS.RUNNING && s.startedAt > 0);
  addUsage({ state: s }, { prompt_tokens: 1000, completion_tokens: 2000 }, 'deepseek-chat');
  ok('用量累加', s.usage.prompt_tokens === 1000 && s.usage.completion_tokens === 2000);
  ok('按模型单价估算成本', Math.abs(s.costUsd - (1000 / 1e6) * 0.27 - (2000 / 1e6) * 1.1) < 1e-9, `$${s.costUsd}`);
  setStatus({ state: s }, STATUS.AWAITING_APPROVAL);
  ok('可以切到 awaiting_approval', s.status === STATUS.AWAITING_APPROVAL);
  const view = publicSession({ id: 'x', title: 't', messages: [1, 2], state: s, createdAt: 1, updatedAt: 2 });
  ok('列表视图包含状态与用量', view.status === STATUS.AWAITING_APPROVAL && view.usage.prompt_tokens === 1000);
}

// ================= 2. 记忆层 =================
section('[2] 记忆层');
{
  const a = memory.add({ content: '这个项目不引入第三方依赖，只用 Node 原生模块', scope: 'workspace', category: 'structure', importance: 0.9, tags: ['约定'] });
  const b = memory.add({ content: '用户偏好中文回答', scope: 'global', category: 'self', importance: 0.8 });
  const c = memory.add({ content: '当前会话正在测试记忆检索', scope: 'session', category: 'situation', importance: 0.4, sessionId: 'sess-1' });
  ok('写入三条记忆', memory.stats().total === 3, JSON.stringify(memory.stats().byScope));

  const hit = memory.search({ query: '第三方依赖', topK: 3, recordLoad: true });
  ok('检索命中相关记忆', hit[0]?.item.id === a.id, `top=${hit[0]?.item.content.slice(0, 20)}`);

  const visible = memory.visible({ sessionId: 'other-session' });
  ok('会话记忆对其他会话不可见', !visible.some((m) => m.id === c.id));
  ok('全局/工作区记忆始终可见', visible.length === 2, String(visible.length));

  const recalled = memory.recall('依赖', { sessionId: 'sess-1', topK: 3 });
  ok('自动召回产出可注入文本', /#\d+/.test(recalled.text), recalled.text.slice(0, 60));
  ok('召回会记录加载次数', memory.get(a.id).loads >= 1);

  memory.update(b.id, { importance: 0.95, content: '用户偏好：一律用中文回答' });
  ok('可以更新记忆', memory.get(b.id).importance === 0.95);
  ok('可以删除记忆', memory.remove(c.id) && memory.get(c.id) === null);
  ok('非法 scope 被拒绝', (() => { try { memory.add({ content: 'x', scope: 'bogus' }); return false; } catch { return true; } })());
}

// ================= 3. 工具层 =================
section('[3] 工具层');
{
  const session = store.create({ provider: 'custom', model: 'fake-1', approvalMode: 'auto' });
  const ctx = { session, store, memory, config: testConfig, emit: () => {}, depth: 0, agents, workflows };

  const glob = await tools.execute('glob', { pattern: '**/*.js' }, ctx);
  ok('glob 找到 js 文件', glob.ok && glob.content.includes('src/b.js'), glob.content.split('\n')[0]);

  const grep = await tools.execute('grep', { pattern: 'TODO', include: '*.js' }, ctx);
  ok('grep 命中 TODO', grep.ok && grep.content.includes('TODO'), grep.content.split('\n')[0]);

  const read = await tools.execute('read_file', { path: 'a.js' }, ctx);
  ok('read_file 带行号', read.ok && /1\s+export const x/.test(read.content));

  const write = await tools.execute('write_file', { path: 'src/new.js', content: 'let a = 1;\nlet b = 2;\n' }, ctx);
  ok('write_file 新建文件', write.ok && write.content.includes('已创建'));

  const edit = await tools.execute('edit_file', { path: 'src/new.js', old_string: 'let b = 2;', new_string: 'let b = 42;' }, ctx);
  ok('edit_file 精确替换', edit.ok && fs.readFileSync(path.join(tmp, 'src/new.js'), 'utf8').includes('42'));

  const editFail = await tools.execute('edit_file', { path: 'src/new.js', old_string: 'let b = 42;', new_string: 'x' }, ctx);
  ok('edit_file 成功后二次匹配', editFail.ok);

  const dup = await tools.execute('edit_file', { path: 'dup.txt', old_string: 'same', new_string: 'x' }, ctx);
  ok('不唯一匹配时拒绝', !dup.ok && /出现了/.test(dup.content), dup.content.slice(0, 50));

  const todo = await tools.execute('todo_write', { todos: [{ content: '第一步', status: 'completed' }, { content: '第二步', status: 'in_progress' }] }, ctx);
  ok('todo_write 写入会话清单', todo.ok && session.todos.length === 2 && session.todos[1].status === 'in_progress');

  const memAdd = await tools.execute('memory_add', { content: '测试里写入的记忆', scope: 'session', category: 'knowledge' }, ctx);
  ok('memory_add 工具可用', memAdd.ok && /已记住/.test(memAdd.content));
  const memSearch = await tools.execute('memory_search', { query: '测试里写入' }, ctx);
  ok('memory_search 工具可用', memSearch.ok && memSearch.content.includes('测试里写入的记忆'));

  const spill = spillToolResult({ store, sessionId: session.id, toolName: 'grep', content: 'x'.repeat(1000), maxChars: 200 });
  ok('超长结果落盘并给出路径', Boolean(spill.artifact) && spill.content.includes('read_artifact'), path.basename(spill.artifact || ''));
  const art = await tools.execute('read_artifact', { file: spill.artifact, limit: 5 }, ctx);
  ok('read_artifact 读回产物', art.ok && art.content.includes('xxxx'));

  const outside = await tools.execute('read_file', { path: '../../etc/hosts' }, ctx);
  ok('路径越界被拒绝', !outside.ok && /越界/.test(outside.content));

  ok('工具注册表按类别分组', Object.keys(tools.byCategory()).length >= 5, Object.keys(tools.byCategory()).join(','));
  tools.setEnabled('run_shell', false);
  ok('可以禁用工具', !tools.isEnabled('run_shell') && tools.get('run_shell') === null);
  const blocked = await tools.execute('run_shell', { command: 'echo hi' }, ctx);
  ok('禁用后调用被拒', !blocked.ok && /禁用/.test(blocked.content));
  tools.setEnabled('run_shell', true);
}

// ================= 4. 策略层 =================
section('[4] 策略层');
{
  const p = new Policy('ask', broker);
  const t = (name) => tools.get(name);
  ok('只读工具放行', p.decide(t('read_file'), {}).action === 'allow');
  ok('记忆工具放行（记账类）', p.decide(t('memory_add'), {}).action === 'allow');
  ok('清单工具放行', p.decide(t('todo_write'), {}).action === 'allow');
  ok('写文件需要审批', p.decide(t('write_file'), {}).action === 'ask');
  ok('执行命令需要审批', p.decide(t('run_shell'), { command: 'ls' }).action === 'ask');
  ok('委派子代理需要审批', p.decide(t('task'), {}).action === 'ask');
  ok('工作流需要审批', p.decide(t('run_workflow'), {}).action === 'ask');
  ok('危险命令硬拦', p.decide(t('run_shell'), { command: 'rm -rf /' }).action === 'deny');
  const auto = new Policy('auto', broker);
  ok('auto 模式全放行', auto.decide(t('write_file'), {}).action === 'allow');
  const deny = new Policy('deny', broker);
  ok('deny 模式拦写与委派', deny.decide(t('write_file'), {}).action === 'deny' && deny.decide(t('task'), {}).action === 'deny');
  ok('deny 模式仍允许只读', deny.decide(t('read_file'), {}).action === 'allow');
}

// ================= 5. 上下文组装 =================
section('[5] 上下文组装');
{
  const prompt = buildSystemPrompt({
    workspace: tmp,
    tools: tools.enabled,
    approvalMode: 'ask',
    model: 'fake-1',
    memoryText: '- [#1] 项目不引入第三方依赖',
    todos: [{ content: '写测试', status: 'in_progress' }],
  });
  ok('系统提示包含记忆段', prompt.includes('相关长期记忆') && prompt.includes('#1'));
  ok('系统提示包含任务清单', prompt.includes('当前任务清单') && prompt.includes('写测试'));
  ok('系统提示按类别列工具', prompt.includes('- fs: ') && prompt.includes('- memory: '));
  ok('系统提示不重复工具描述（省 token）', !prompt.includes(tools.enabled[0].description.slice(0, 20)));
  ok('系统提示保持精简（<1200 字符）', prompt.length < 1200, `${prompt.length} 字符`);

  const long = [];
  for (let i = 0; i < 40; i++) {
    long.push({ role: 'user', content: `问题${i}`.padEnd(400, 'x') });
    long.push({ role: 'assistant', content: `回答${i}`.padEnd(400, 'y') });
  }
  const trimmed = trimHistory(long, 3000);
  ok('超预算时裁掉最老的 turn', trimmed.length < long.length && trimmed.at(-1).content.startsWith('回答39'), `${trimmed.length}/${long.length}`);
  ok('保留最后一个 turn 完整', trimmed.filter((m) => m.role === 'user').at(-1).content.startsWith('问题39'));
}

// ================= 6. 子代理 =================
section('[6] 子代理');
{
  const parent = store.create({ provider: 'custom', model: 'fake-1', approvalMode: 'auto', title: '父会话' });
  const events = [];
  const r = await agents.run({
    description: '测试子任务',
    prompt: '列一下工作区',
    parent,
    depth: 1,
    emit: (ev) => events.push(ev.type),
  });
  ok('子代理返回结论', typeof r.summary === 'string' && r.summary.length > 0, r.summary.slice(0, 30));
  ok('子代理被持久化为独立会话', store.get(r.sessionId)?.kind === 'subagent');
  ok('子代理挂在父会话下', store.get(r.sessionId)?.parentId === parent.id);
  ok('发出 subagent_start/done 事件', events.includes('subagent_start') && events.includes('subagent_done'));
  ok('子代理有工具调用轨迹', r.toolCalls >= 1, `${r.toolCalls} 次`);
  ok('子会话不出现在主列表', !store.list().some((s) => s.id === r.sessionId));

  let depthErr = null;
  try {
    await agents.run({ description: 'x', prompt: 'y', parent, depth: testConfig.maxAgentDepth + 1, emit: () => {} });
  } catch (err) {
    depthErr = err.message;
  }
  ok('超过深度上限被拒绝', /深度/.test(depthErr || ''), depthErr || '');
}

// ================= 7. 工作流 =================
section('[7] 工作流');
{
  const list = workflows.list();
  ok('内置工作流可加载', list.length >= 2, list.map((w) => w.name).join(', '));
  const def = workflows.get('code-review');
  ok('工作流定义包含阶段', def && def.phases.length === 2);

  const session = store.create({ provider: 'custom', model: 'fake-1', approvalMode: 'auto' });
  const events = [];
  const run = await workflows.run('code-review', { input: 'a.js', session, emit: (ev) => events.push(ev) });
  const types = new Set(events.map((e) => e.type));
  ok('发出完整工作流事件序列', ['workflow_start', 'workflow_phase', 'workflow_step_start', 'workflow_step_done', 'workflow_phase_done', 'workflow_done'].every((t) => types.has(t)), [...types].join(','));
  ok('两个阶段都执行了', run.phases.length === 2, run.phases.map((p) => p.title).join(' → '));
  ok('第一阶段并行跑了 3 步', run.phases[0].steps.length === 3);
  ok('汇总阶段拿到前面结果', run.phases[1].steps[0].ok && run.summary.includes('工作流'));
  ok('阶段标题顺序正确', run.phases[0].title === '并行审查' && run.phases[1].title === '汇总');
}

// ================= 8. 循环集成 =================
section('[8] 控制循环集成');
{
  const session = store.create({ provider: 'custom', model: 'fake-1', approvalMode: 'auto' });
  const events = [];
  const emit = (ev) => events.push(ev);
  const result = await runTurn({
    session,
    userText: '帮我创建 out/hello.txt 写个文件',
    provider: provider(),
    tools,
    policy: new Policy('auto', broker),
    store,
    emit,
    config: { ...testConfig, maxSteps: 4 },
    signal: new AbortController().signal,
    memory,
    agents,
    workflows,
    depth: 0,
  });
  const types = events.map((e) => e.type);
  ok('状态机走到 idle', session.state.status === STATUS.IDLE);
  ok('发出 state 事件', types.filter((t) => t === 'state').length >= 2);
  ok('模型 → 工具 → 模型 两轮', types.filter((t) => t === 'step').length === 2, String(types.filter((t) => t === 'step').length));
  ok('工具被真实执行', types.includes('tool_call') && types.includes('tool_result'));
  ok('文件真的被写出来', fs.existsSync(path.join(tmp, 'out', 'hello.txt')));
  ok('累计用量写入状态', session.state.usage.prompt_tokens > 0, JSON.stringify(session.state.usage));
  ok('轮次与步数被记录', session.state.turns === 1 && session.state.steps === 2);
  ok('事件日志可回放', store.readEvents(session.id).length > 0, `${store.readEvents(session.id).length} 条`);
  ok('会话被持久化', Boolean(store.get(session.id)));

  // 记忆自动召回（会话要落在同一个工作区里，否则 workspace 级记忆不可见）
  const session2 = store.create({ provider: 'custom', model: 'fake-1', approvalMode: 'auto', workspaceId: tmp });
  const events2 = [];
  await runTurn({
    session: session2,
    userText: '这个项目可以用第三方依赖吗？',
    provider: provider(),
    tools,
    policy: new Policy('auto', broker),
    store,
    emit: (ev) => events2.push(ev),
    config: { ...testConfig, maxSteps: 2 },
    signal: new AbortController().signal,
    memory,
    agents,
    workflows,
    depth: 0,
  });
  const recall = events2.find((e) => e.type === 'memory_recall');
  ok('主会话自动召回记忆', Boolean(recall) && recall.hits.length > 0, recall ? recall.hits.map((h) => `#${h.id}`).join(' ') : '');

  // 中止
  const session3 = store.create({ provider: 'custom', model: 'fake-1', approvalMode: 'auto' });
  const ac = new AbortController();
  ac.abort();
  const r3 = await runTurn({
    session: session3,
    userText: '随便',
    provider: provider(),
    tools,
    policy: new Policy('auto', broker),
    store,
    emit: () => {},
    config: testConfig,
    signal: ac.signal,
    memory: null,
    depth: 0,
  });
  ok('已中止的信号让本轮直接结束', r3.reason === 'aborted' && session3.state.status === STATUS.ABORTED);
}

await fake.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${fail === 0 ? '✓' : '✗'} harness 自检: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
