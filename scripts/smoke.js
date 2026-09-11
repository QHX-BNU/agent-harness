// 无 UI 冒烟测试：直接驱动 loop，验证「模型 → 工具 → 模型」链路。
// 用法: node scripts/smoke.js  或  npm run smoke
import { config } from '../src/config.js';
import { SessionStore } from '../src/store.js';
import { ApprovalBroker, Policy } from '../src/policy.js';
import { createToolRegistry } from '../src/tools/index.js';
import { createProvider } from '../src/providers/index.js';
import { runTurn } from '../src/loop.js';
import { createEmitter } from '../src/events.js';

const store = new SessionStore({ dir: config.sessionsDir, artifactsDir: config.artifactsDir });
const broker = new ApprovalBroker(3000);
const tools = createToolRegistry();
const provider = createProvider({ ...config, provider: process.env.PROVIDER || 'mock' });

const session = store.create({ provider: config.provider, model: config.model, approvalMode: 'auto' });
const emit = createEmitter(() => {}, { log: false });

// 自动审批：5 秒内自动允许，用来验证 ask 流程
broker.request = async (meta) => {
  console.log(`  (smoke) 自动批准 ${meta.tool}`);
  return true;
};

const started = Date.now();
await runTurn({
  session,
  userText: process.argv[2] || '列一下工作区有什么',
  provider,
  tools,
  policy: new Policy('ask', broker),
  store,
  emit,
  config: { ...config, approvalMode: 'ask' },
  signal: new AbortController().signal,
});

const assistant = session.messages.filter((m) => m.role === 'assistant');
const toolMsgs = session.messages.filter((m) => m.role === 'tool');
console.log('\n=== 结果 ===');
console.log(`耗时        : ${Date.now() - started} ms`);
console.log(`消息条数    : ${session.messages.length}`);
console.log(`工具调用次数: ${toolMsgs.length}`);
console.log(`最终回答    : ${assistant.at(-1)?.content?.slice(0, 300)}`);
console.log(`会话文件    : ${config.sessionsDir}\\${session.id}.json`);
if (toolMsgs.length === 0) {
  console.log('\n⚠ 没有发生工具调用，loop 可能有问题');
  process.exit(1);
}
