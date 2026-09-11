// 模型接入自检 CLI：一行命令验证「key + 端点 + 模型名 + 工具调用」是否真的通。
//
// 用法:
//   node scripts/probe.js                      # 探测当前配置的供应商
//   node scripts/probe.js deepseek             # 探测指定供应商（用它的预设端点/默认模型）
//   node scripts/probe.js deepseek deepseek-reasoner
//   node scripts/probe.js custom --base-url http://127.0.0.1:8000/v1 --model Qwen/Qwen2.5-7B
//   node scripts/probe.js --all                # 探测所有「已配置 key 或无需 key」的供应商
import { createProvider, listProviders, resolveProviderConfig, ModelError } from '../src/providers/index.js';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const baseUrl = flag('--base-url') || flag('--base');
const positional = argv.filter((a) => !a.startsWith('--') && a !== baseUrl);

const all = argv.includes('--all');
const ids = all
  ? listProviders({}, positional[0] || '').filter((p) => p.ready).map((p) => p.id)
  : [positional[0] || process.env.PROVIDER || 'mock'];
const model = positional[1] || flag('--model');

const pad = (s, n) => String(s).padEnd(n, ' ').slice(0, n);
const padL = (s, n) => String(s).padStart(n, ' ').slice(0, n);

console.log('模型接入自检 —— 一次真实请求，验证 key / 端点 / 模型名 / function calling\n');
console.log(`${pad('供应商', 14)}${pad('协议', 10)}${pad('模型', 26)}${padL('延迟', 8)}  ${pad('工具', 6)}结果`);
console.log('-'.repeat(96));

let bad = 0;
for (const id of ids) {
  let provider;
  try {
    provider = createProvider({ provider: id, model, baseUrl });
  } catch (err) {
    bad++;
    const hint = err.hint ? ` → ${err.hint}` : '';
    console.log(`${pad(id, 14)}${pad('-', 10)}${pad(model || '-', 26)}${padL('-', 8)}  ${pad('-', 6)}✗ ${err.message}${hint}`);
    continue;
  }

  try {
    const r = await provider.ping({ withTools: true });
    const u = r.usage || {};
    console.log(
      `${pad(provider.id, 14)}${pad(provider.protocol, 10)}${pad(r.model, 26)}${padL(`${r.latencyMs}ms`, 8)}  ` +
        `${pad(r.supportsTools ? '✓' : '✗', 6)}✓ 回复「${String(r.text).slice(0, 24)}」 tokens ${u.prompt_tokens ?? '?'}/${u.completion_tokens ?? '?'}`,
    );
    if (!r.supportsTools) console.log(`${''.padEnd(14)}  ⚠ 模型没有返回 tool_call —— agent 的工具调用会失效，建议换模型`);
  } catch (err) {
    bad++;
    const hint = err.hint ? ` → ${err.hint}` : '';
    const status = err instanceof ModelError && err.status ? `HTTP ${err.status}: ` : '';
    console.log(`${pad(provider.id, 14)}${pad(provider.protocol, 10)}${pad(provider.model, 26)}${padL('-', 8)}  ${pad('-', 6)}✗ ${status}${err.message.slice(0, 80)}${hint}`);
  }
}

// 顺带提示哪些供应商还没配 key
if (all) {
  const missing = listProviders({}, '').filter((p) => !p.ready);
  if (missing.length) {
    console.log(`\n未配置 key 的供应商（${missing.length} 家）: ${missing.map((p) => p.id).join(', ')}`);
  }
}

console.log(bad === 0 ? '\n✓ 全部连通' : `\n✗ ${bad} 个供应商不可用`);
process.exit(bad === 0 ? 0 : 1);
