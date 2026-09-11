// OpenAI 兼容适配器：覆盖 OpenAI / DeepSeek / Qwen / Kimi / GLM / OpenRouter / Groq /
// Ollama / vLLM / LM Studio / 各种 one-api 网关。
//
// 端口契约（所有适配器都必须满足）：
//   async *stream({ messages, tools, model, signal, temperature, maxTokens, onRetry }) ->
//     yield { type:'text_delta',      text }
//     yield { type:'reasoning_delta', text }            // 思维链（deepseek-reasoner / o 系列）
//     yield { type:'tool_call', id, name, arguments }   // arguments 已是对象
//     yield { type:'usage', usage }
//     yield { type:'done', finishReason, usage }
//   async ping({ signal, withTools, onRetry }) -> { ok, latencyMs, model, text, usage, supportsTools }
//   async listModels({ signal }) -> string[]
import { ModelError, postJSON, sseEvents } from './http.js';
import { toOpenAIMessages } from './messages.js';

export function createOpenAIProvider(cfg) {
  const { id, label, baseUrl, apiKey, model, timeoutMs = 120000, retries = 2, headers: extraHeaders = {} } = cfg;
  const root = (baseUrl || '').replace(/\/$/, '');
  if (!root) throw new ModelError(`供应商 ${id} 缺少 BASE_URL`, { provider: id });
  const url = `${root}/chat/completions`;

  const headers = {
    'content-type': 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...extraHeaders,
  };

  async function request(body, { signal, onRetry }) {
    try {
      return await postJSON(url, { headers, body, signal, timeoutMs, retries, onRetry, provider: id, model: body.model });
    } catch (err) {
      // 少数网关不认 stream_options，降级重试一次
      if (err.status === 400 && /stream_options/i.test(err.body || '')) {
        const { stream_options, ...rest } = body;
        return await postJSON(url, { headers, body: rest, signal, timeoutMs, retries, onRetry, provider: id, model: body.model });
      }
      throw err;
    }
  }

  return {
    id,
    label,
    protocol: 'openai',
    baseUrl: root,
    model,

    async *stream({ messages, tools, model: modelOverride, signal, temperature, maxTokens, onRetry }) {
      const useModel = modelOverride || model;
      const body = {
        model: useModel,
        messages: toOpenAIMessages(messages),
        stream: true,
        stream_options: { include_usage: true },
      };
      if (temperature !== undefined) body.temperature = temperature;
      if (maxTokens) body.max_tokens = maxTokens;
      if (tools?.length) {
        body.tools = tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
        body.tool_choice = 'auto';
      }

      const res = await request(body, { signal, onRetry });
      const ctype = res.headers.get('content-type') || '';

      // 有些网关忽略 stream，直接返回完整 JSON —— 兼容它
      if (ctype.includes('application/json')) {
        const json = await res.json();
        const msg = json.choices?.[0]?.message || {};
        if (msg.reasoning_content) yield { type: 'reasoning_delta', text: msg.reasoning_content };
        if (msg.content) yield { type: 'text_delta', text: msg.content };
        for (const [i, tc] of (msg.tool_calls || []).entries()) {
          yield {
            type: 'tool_call',
            id: tc.id || `call_${i}`,
            name: tc.function?.name,
            arguments: safeParse(tc.function?.arguments),
          };
        }
        yield {
          type: 'done',
          finishReason: json.choices?.[0]?.finish_reason || 'stop',
          usage: json.usage,
        };
        return;
      }

      let finishReason = null;
      let usage = null;
      const toolCalls = new Map(); // index -> {id, name, argsJson}

      for await (const { data } of sseEvents(res)) {
        if (!data || data === '[DONE]') continue;
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          continue; // 心跳或非 JSON 片段
        }

        if (json.error) {
          throw new ModelError(`${id} 流内报错: ${json.error.message || JSON.stringify(json.error)}`, {
            status: json.error.code || 0,
            provider: id,
            model: useModel,
          });
        }
        if (json.usage) usage = json.usage;

        const choice = json.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta || {};
        if (delta.reasoning_content) yield { type: 'reasoning_delta', text: delta.reasoning_content };
        if (delta.reasoning) yield { type: 'reasoning_delta', text: delta.reasoning };
        if (delta.content) yield { type: 'text_delta', text: delta.content };

        for (const tc of delta.tool_calls || []) {
          const idx = tc.index ?? 0;
          const cur = toolCalls.get(idx) || { id: '', name: '', argsJson: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.argsJson += tc.function.arguments;
          toolCalls.set(idx, cur);
        }
      }

      for (const [, tc] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
        yield {
          type: 'tool_call',
          id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
          name: tc.name,
          arguments: safeParse(tc.argsJson),
        };
      }
      if (usage) yield { type: 'usage', usage };
      yield { type: 'done', finishReason: finishReason || 'stop', usage };
    },

    /** 连通性自检：一次极小的真实请求 */
    async ping({ signal, withTools = false, onRetry, model: modelOverride } = {}) {
      const useModel = modelOverride || model;
      const body = {
        model: useModel,
        messages: [{ role: 'user', content: withTools ? '请调用 get_time 工具' : '只回复：pong' }],
        max_tokens: withTools ? 256 : 16,
        stream: false,
      };
      if (withTools) {
        body.tools = [
          {
            type: 'function',
            function: { name: 'get_time', description: '获取当前时间', parameters: { type: 'object', properties: {} } },
          },
        ];
      }

      const t0 = Date.now();
      const res = await postJSON(url, { headers, body, signal, timeoutMs, retries: 0, provider: id, model: useModel });
      const json = await res.json();
      const msg = json.choices?.[0]?.message || {};
      return {
        ok: true,
        provider: id,
        model: json.model || useModel,
        latencyMs: Date.now() - t0,
        text: (msg.content || '').slice(0, 200),
        usage: json.usage || null,
        supportsTools: Boolean(msg.tool_calls?.length),
      };
    },

    /** 拉模型列表（很多网关都实现了 /models，失败就忽略） */
    async listModels({ signal } = {}) {
      const res = await fetch(`${root}/models`, { headers, signal: signal || AbortSignal.timeout(10000) });
      if (!res.ok) throw new ModelError(`/models 返回 ${res.status}`, { status: res.status, provider: id });
      const json = await res.json();
      return (json.data || json.models || [])
        .map((m) => m.id || m.name || m.model)
        .filter(Boolean)
        .sort();
    },
  };
}

function safeParse(raw) {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return { __raw: String(raw) };
  }
}
