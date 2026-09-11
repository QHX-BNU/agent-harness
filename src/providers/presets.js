// 厂商预设表：只要填一个 API key，就能直接接上真实模型。
// 新增厂商 = 在这里加一条；不需要改任何适配代码（只要它兼容 openai 或 anthropic 协议）。
//
// 字段说明：
//   protocol   openai | anthropic | mock —— 决定用哪个适配器
//   baseUrl    默认端点（可用 BASE_URL 覆盖）
//   models     常用模型名（第一个是默认值，可用 MODEL 覆盖）
//   envKeys    从哪些环境变量里找 key（按顺序）
//   requiresKey  false 表示本地服务，不需要 key

export const PROVIDERS = {
  mock: {
    label: 'Mock（离线演示）',
    protocol: 'mock',
    baseUrl: '',
    models: ['mock-1'],
    requiresKey: false,
    note: '不调用任何网络，用固定脚本走一遍工具调用，用于验证 harness 本身。',
  },

  // ---------- 国内常用 ----------
  deepseek: {
    label: 'DeepSeek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    envKeys: ['DEEPSEEK_API_KEY'],
    note: 'deepseek-reasoner 会返回 reasoning_content，前端会单独显示「思考」块。',
  },
  qwen: {
    label: '通义千问（DashScope 兼容模式）',
    protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo'],
    envKeys: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY'],
  },
  moonshot: {
    label: 'Moonshot / Kimi',
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2-0711-preview', 'moonshot-v1-8k'],
    envKeys: ['MOONSHOT_API_KEY'],
  },
  zhipu: {
    label: '智谱 GLM',
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-plus', 'glm-4-flash'],
    envKeys: ['ZHIPU_API_KEY', 'GLM_API_KEY'],
  },
  siliconflow: {
    label: '硅基流动 SiliconFlow',
    protocol: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'],
    envKeys: ['SILICONFLOW_API_KEY'],
  },

  // ---------- 海外 ----------
  openai: {
    label: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o4-mini'],
    envKeys: ['OPENAI_API_KEY'],
  },
  anthropic: {
    label: 'Anthropic Claude',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    models: ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-3-5-haiku-20241022'],
    envKeys: ['ANTHROPIC_API_KEY'],
    note: '走 Messages API（非 OpenAI 协议），用来验证端口抽象是否真的与厂商解耦。',
  },
  openrouter: {
    label: 'OpenRouter（聚合网关）',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['deepseek/deepseek-chat-v3.1', 'anthropic/claude-sonnet-4.5', 'openai/gpt-4o-mini'],
    envKeys: ['OPENROUTER_API_KEY'],
    note: '一个 key 打通多家模型，适合做多模型对比。',
  },
  groq: {
    label: 'Groq',
    protocol: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile', 'qwen/qwen3-32b'],
    envKeys: ['GROQ_API_KEY'],
  },
  mistral: {
    label: 'Mistral',
    protocol: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    models: ['mistral-large-latest', 'mistral-small-latest'],
    envKeys: ['MISTRAL_API_KEY'],
  },

  // ---------- 本地 / 自建 ----------
  ollama: {
    label: 'Ollama（本地）',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    models: ['qwen2.5:7b', 'llama3.1:8b'],
    requiresKey: false,
    note: '先 ollama serve，再 ollama pull 模型。',
  },
  vllm: {
    label: 'vLLM / SGLang（本地）',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:8000/v1',
    models: ['Qwen/Qwen2.5-7B-Instruct'],
    requiresKey: false,
  },
  lmstudio: {
    label: 'LM Studio（本地）',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    models: ['local-model'],
    requiresKey: false,
  },
  custom: {
    label: '自定义（任何 OpenAI 兼容端点）',
    protocol: 'openai',
    baseUrl: '',
    models: [],
    requiresKey: false,
    note: '必须自己提供 BASE_URL 与 MODEL。',
  },
};

/** 全局兜底 key 变量名：任何厂商都可以用这两个 */
export const GENERIC_KEY_ENVS = ['API_KEY', 'LLM_API_KEY'];
