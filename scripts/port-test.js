// 模型接入端口的自检：起一个假厂商服务，把两条协议 + 重试 + 错误归一化全部真跑一遍。
// 用法: node scripts/port-test.js
import { startFakeLLM } from './fake-llm.js';
import { createProvider, listProviders, ModelError } from '../src/providers/index.js';

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

/** 把 provider.stream() 收集成一份结构化结果 */
async function collect(provider, { messages, tools, model, onRetry }) {
  let text = '';
  let reasoning = '';
  const calls = [];
  let usage = null;
  let finishReason = null;
  for await (const ev of provider.stream({ messages, tools, model, onRetry, signal: new AbortController().signal })) {
    if (ev.type === 'text_delta') text += ev.text;
    else if (ev.type === 'reasoning_delta') reasoning += ev.text;
    else if (ev.type === 'tool_call') calls.push(ev);
    else if (ev.type === 'usage') usage = ev.usage;
    else if (ev.type === 'done') finishReason = ev.finishReason;
  }
  return { text, reasoning, calls, usage, finishReason };
}

const TOOLS = [
  { name: 'list_dir', description: '列出目录', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
];
const MSGS = [{ role: 'system', content: '你是测试助手' }, { role: 'user', content: '看看 src 目录' }];

const fake = await startFakeLLM();
console.log(`假厂商服务: ${fake.root}\n`);

// ---------- 1. OpenAI 协议 ----------
console.log('[1] OpenAI 兼容协议（流式 + 跨 chunk 工具调用）');
{
  const p = createProvider({ provider: 'custom', baseUrl: fake.baseUrl, apiKey: 'test-key', model: 'fake-1', retries: 0 });
  const r = await collect(p, { messages: MSGS, tools: TOOLS });
  ok('适配器 id/协议正确', p.id === 'custom' && p.protocol === 'openai', `${p.protocol}`);
  ok('文本流拼接正确', r.text === '这是一段流式文本。', JSON.stringify(r.text));
  ok('工具调用被解析出来', r.calls.length === 1 && r.calls[0].name === 'list_dir', JSON.stringify(r.calls));
  ok('工具参数跨 chunk 拼装正确', r.calls[0]?.arguments?.path === './src', JSON.stringify(r.calls[0]?.arguments));
  ok('usage 被捕获', r.usage?.prompt_tokens === 7 && r.usage?.completion_tokens === 12, JSON.stringify(r.usage));
  ok('finishReason 正确', r.finishReason === 'tool_calls', r.finishReason);
}

// ---------- 2. reasoning ----------
console.log('\n[2] 思维链（deepseek-reasoner 风格 reasoning_content）');
{
  const p = createProvider({ provider: 'custom', baseUrl: fake.baseUrl, apiKey: 'k', model: 'fake-reasoner', retries: 0 });
  const r = await collect(p, { messages: MSGS, tools: [] });
  ok('reasoning_delta 被识别', r.reasoning === '让我想一下…', JSON.stringify(r.reasoning));
  ok('正文与思考分离', r.text === '这是一段流式文本。');
}

// ---------- 3. Anthropic 协议 ----------
console.log('\n[3] Anthropic Messages 协议（完全不同的 wire format）');
{
  const p = createProvider({ provider: 'anthropic', baseUrl: fake.root, apiKey: 'test-key', model: 'claude-fake', retries: 0 });
  const r = await collect(p, { messages: MSGS, tools: TOOLS });
  ok('走的是 anthropic 协议', p.protocol === 'anthropic');
  ok('文本块拼接正确', r.text === '你好，我是假 Claude。', JSON.stringify(r.text));
  ok('tool_use 被解析成内部 tool_call', r.calls[0]?.name === 'list_dir' && r.calls[0]?.id === 'toolu_1', JSON.stringify(r.calls));
  ok('input_json_delta 拼装正确', r.calls[0]?.arguments?.path === './src', JSON.stringify(r.calls[0]?.arguments));
  ok('Anthropic usage 映射到统一字段', r.usage?.prompt_tokens === 11 && r.usage?.completion_tokens === 23, JSON.stringify(r.usage));
  ok('stop_reason tool_use → tool_calls', r.finishReason === 'tool_calls', r.finishReason);
  // 消息转换：工具结果必须以 tool_result block 出现
  const { toAnthropicPayload } = await import('../src/providers/messages.js');
  const conv = toAnthropicPayload([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'list_dir', arguments: { path: '.' } }] },
    { role: 'tool', toolCallId: 't1', name: 'list_dir', content: '结果A' },
    { role: 'tool', toolCallId: 't2', name: 'read_file', content: '结果B' },
  ]);
  ok('system 提升为顶层字段', conv.system === 'sys');
  ok('连续工具结果合并进同一条 user 消息', conv.messages.at(-1).content.length === 2, JSON.stringify(conv.messages.at(-1).content.map((b) => b.type)));
  ok('assistant 工具调用变成 tool_use block', conv.messages[1].content[0].type === 'tool_use');
}

// ---------- 4. 重试 ----------
console.log('\n[4] 限流重试（前两次 429，第三次成功）');
{
  const p = createProvider({ provider: 'custom', baseUrl: fake.baseUrl, apiKey: 'k', model: 'fail-twice', retries: 3 });
  const retries = [];
  const r = await collect(p, { messages: MSGS, tools: [], onRetry: (info) => retries.push(info) });
  ok('发生了 2 次重试', retries.length === 2, retries.map((x) => `${x.attempt}(${x.reason.slice(0, 20)})`).join(', '));
  ok('重试后最终拿到结果', r.text === '这是一段流式文本。', JSON.stringify(r.text));
}

// ---------- 5. 错误归一化 ----------
console.log('\n[5] 错误归一化与可操作提示');
{
  const p = createProvider({ provider: 'custom', baseUrl: fake.baseUrl, apiKey: '', model: 'fake-1', retries: 0 });
  // 本地 custom 不需要 key，但假服务要求带 key → 触发 401
  try {
    await collect(p, { messages: MSGS, tools: [] });
    ok('401 应抛错', false);
  } catch (err) {
    ok('抛出 ModelError', err instanceof ModelError, err.constructor.name);
    ok('带 HTTP 状态码', err.status === 401, String(err.status));
    ok('给出人话提示', /API key/.test(err.hint), err.hint);
  }
  try {
    createProvider({ provider: 'deepseek', model: 'deepseek-chat' });
    ok('缺 key 时拒绝创建', false);
  } catch (err) {
    ok('缺 key 时拒绝创建并说明变量名', /DEEPSEEK_API_KEY/.test(err.message), err.message);
  }
  try {
    createProvider({ provider: '不存在的厂商' });
    ok('未知厂商应抛错', false);
  } catch (err) {
    ok('未知厂商报错并列出可选值', /可选/.test(err.message));
  }
}

// ---------- 6. ping / listModels ----------
console.log('\n[6] 连通性自检与模型列表');
{
  const p = createProvider({ provider: 'custom', baseUrl: fake.baseUrl, apiKey: 'k', model: 'fake-1', retries: 0 });
  const ping = await p.ping({ withTools: true });
  ok('ping 成功并返回延迟', ping.ok && ping.latencyMs >= 0, `${ping.latencyMs}ms`);
  ok('ping 能判断工具调用支持', ping.supportsTools === true);
  const models = await p.listModels();
  ok('/models 拉到列表', models.length === 3, models.join(', '));
}

// ---------- 7. 注册表 ----------
console.log('\n[7] 供应商注册表');
{
  const list = listProviders();
  ok('预设厂商数量 ≥ 12', list.length >= 12, `${list.length} 家`);
  ok('含 openai / anthropic / mock 三种协议', ['openai', 'anthropic', 'mock'].every((x) => list.some((p) => p.protocol === x)));
  ok('本地厂商标记为无需 key', list.find((p) => p.id === 'ollama')?.ready === true);
  ok('云端厂商在无 key 时标记未就绪', list.find((p) => p.id === 'deepseek')?.ready === false);
  ok('mock 永远可用', list.find((p) => p.id === 'mock')?.ready === true);
}

// ---------- 8. 配置优先级 ----------
console.log('\n[8] 配置优先级：请求级 > 环境变量 > 预设');
{
  const { resolveProviderConfig } = await import('../src/providers/index.js');
  const saved = { BASE_URL: process.env.BASE_URL, MODEL: process.env.MODEL };
  process.env.BASE_URL = 'http://env.example/v1';
  process.env.MODEL = 'env-model';
  const byEnv = resolveProviderConfig({ provider: 'anthropic', apiKey: 'k' });
  ok('BASE_URL 环境变量覆盖预设端点', byEnv.baseUrl === 'http://env.example/v1', byEnv.baseUrl);
  ok('MODEL 环境变量覆盖预设模型', byEnv.model === 'env-model', byEnv.model);
  const byReq = resolveProviderConfig({ provider: 'anthropic', apiKey: 'k', baseUrl: 'http://req.example/v1', model: 'req-model' });
  ok('请求级 baseUrl 优先于环境变量', byReq.baseUrl === 'http://req.example/v1', byReq.baseUrl);
  ok('请求级 model 优先于环境变量', byReq.model === 'req-model', byReq.model);
  if (saved.BASE_URL === undefined) delete process.env.BASE_URL;
  else process.env.BASE_URL = saved.BASE_URL;
  if (saved.MODEL === undefined) delete process.env.MODEL;
  else process.env.MODEL = saved.MODEL;
  const byPreset = resolveProviderConfig({ provider: 'anthropic', apiKey: 'k' });
  ok('无覆盖时回落到预设', byPreset.baseUrl === 'https://api.anthropic.com' && byPreset.model.startsWith('claude'), `${byPreset.model}`);
}

await fake.close();

console.log(`\n${fail === 0 ? '✓' : '✗'} 端口自检: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
