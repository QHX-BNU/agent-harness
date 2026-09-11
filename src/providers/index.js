// 模型接入端口（Model Port）：
//   1. 供应商注册表 —— 预设了 15 家厂商的端点/模型/key 变量名（presets.js）
//   2. 配置解析     —— 预设 + 环境变量 + 请求级覆盖，三者合并
//   3. 协议分发     —— openai / anthropic / mock 三种协议各自适配，上层无感
//
// 上层（loop / server / UI）只依赖 stream()/ping()/listModels() 三个方法，
// 换厂商 = 换一个 provider id，不改任何业务代码。
import { PROVIDERS, GENERIC_KEY_ENVS } from './presets.js';
import { createOpenAIProvider } from './openai.js';
import { createAnthropicProvider } from './anthropic.js';
import { createMockProvider } from './mock.js';
import { ModelError } from './http.js';

export { PROVIDERS, ModelError };
export { toOpenAIMessages, toAnthropicPayload } from './messages.js';

/** 按顺序找 key：显式传入 > 该厂商专属变量 > 通用变量 */
export function resolveKey(id, preset, explicit) {
  if (explicit) return explicit;
  for (const name of [...(preset.envKeys || []), ...GENERIC_KEY_ENVS]) {
    if (process.env[name]) return process.env[name];
  }
  return '';
}

/**
 * 合并「预设 + 覆盖」得到最终连接参数。
 * @param {{provider?:string, model?:string, baseUrl?:string, apiKey?:string, timeoutMs?:number, retries?:number}} input
 */
export function resolveProviderConfig(input = {}) {
  const id = String(input.provider || 'mock').toLowerCase();
  const preset = PROVIDERS[id];
  if (!preset) {
    throw new ModelError(`未知供应商 "${id}"，可选：${Object.keys(PROVIDERS).join(', ')}`, { provider: id });
  }

  const apiKey = resolveKey(id, preset, input.apiKey);
  if (preset.requiresKey !== false && !apiKey) {
    const names = [...(preset.envKeys || []), ...GENERIC_KEY_ENVS].join(' 或 ');
    throw new ModelError(`供应商 ${id} 需要 API key：请设置环境变量 ${names}`, { status: 401, provider: id });
  }

  // 优先级：请求级覆盖 > 环境变量（用户显式配置）> 厂商预设默认值
  const baseUrl = input.baseUrl || process.env.BASE_URL || preset.baseUrl || '';
  const model = input.model || process.env.MODEL || preset.models[0] || '';
  if (!model) {
    throw new ModelError(`供应商 ${id} 需要指定模型名（MODEL=...）`, { provider: id });
  }

  return {
    id,
    label: preset.label,
    protocol: preset.protocol,
    baseUrl,
    apiKey,
    model,
    timeoutMs: input.timeoutMs ?? 120000,
    retries: input.retries ?? 2,
  };
}

/** 创建适配器实例（端口） */
export function createProvider(input = {}) {
  const cfg = resolveProviderConfig(input);
  switch (cfg.protocol) {
    case 'mock':
      return createMockProvider(cfg);
    case 'openai':
      return createOpenAIProvider(cfg);
    case 'anthropic':
      return createAnthropicProvider(cfg);
    default:
      throw new ModelError(`协议 "${cfg.protocol}" 还没有适配器`, { provider: cfg.id });
  }
}

/** 给 /api/providers 和 CLI 用：列出所有供应商及当前可用性 */
export function listProviders(overrides = {}, current = '') {
  return Object.entries(PROVIDERS).map(([id, p]) => {
    const ov = overrides[id] || {};
    const dedicated = (p.envKeys || []).find((name) => process.env[name]);
    const generic = GENERIC_KEY_ENVS.find((name) => process.env[name]);
    const explicit = ov.apiKey;
    // 通用 API_KEY 只算在「当前正在使用的供应商」头上，否则会让所有厂商都显示为就绪
    const keySource = explicit ? 'explicit' : dedicated ? 'dedicated' : generic && id === current ? 'generic' : 'none';
    const requiresKey = p.requiresKey !== false;
    // 环境变量里的 BASE_URL 只作用于当前供应商，不要污染其他厂商的显示
    const baseUrl = ov.baseUrl || (id === current && process.env.BASE_URL) || p.baseUrl;
    return {
      id,
      label: p.label,
      protocol: p.protocol,
      baseUrl,
      models: ov.models || p.models,
      requiresKey,
      hasKey: keySource !== 'none',
      keySource,
      keyEnv: explicit || dedicated || (keySource === 'generic' ? generic : ''),
      ready: !requiresKey || keySource !== 'none',
      note: p.note || '',
    };
  });
}
