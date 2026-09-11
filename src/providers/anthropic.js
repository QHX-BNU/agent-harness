// Anthropic Messages API 适配器。
// 存在的意义：证明「端口」真的与厂商解耦——完全不同的协议（system 顶层字段、
// content block、tool_use/tool_result、input_json_delta）对上层 loop 完全透明。
import { ModelError, postJSON, sseEvents } from './http.js';
import { toAnthropicPayload, toAnthropicTools } from './messages.js';

export function createAnthropicProvider(cfg) {
  const { id, label, baseUrl, apiKey, model, timeoutMs = 120000, retries = 2 } = cfg;
  const root = (baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
  const url = `${root}/v1/messages`;

  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey || '',
    'anthropic-version': '2023-06-01',
  };

  return {
    id,
    label,
    protocol: 'anthropic',
    baseUrl: root,
    model,

    async *stream({ messages, tools, model: modelOverride, signal, temperature, maxTokens, onRetry }) {
      const useModel = modelOverride || model;
      const { system, messages: msgs } = toAnthropicPayload(messages);
      const body = {
        model: useModel,
        max_tokens: maxTokens || 8192, // Anthropic 必填
        messages: msgs,
        stream: true,
      };
      if (system) body.system = system;
      if (temperature !== undefined) body.temperature = temperature;
      if (tools?.length) {
        body.tools = toAnthropicTools(tools);
        body.tool_choice = { type: 'auto' };
      }

      const res = await postJSON(url, { headers, body, signal, timeoutMs, retries, onRetry, provider: id, model: useModel });

      let finishReason = null;
      const usage = {};
      const blocks = new Map(); // index -> {type, id, name, json}

      for await (const { event, data } of sseEvents(res)) {
        if (!data) continue;
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        const type = json.type || event;

        if (type === 'error') {
          throw new ModelError(`${id} 流内报错: ${json.error?.message || 'unknown'}`, { provider: id, model: useModel });
        }

        if (type === 'message_start') {
          Object.assign(usage, {
            prompt_tokens: json.message?.usage?.input_tokens,
            completion_tokens: json.message?.usage?.output_tokens,
          });
        } else if (type === 'content_block_start') {
          const cb = json.content_block || {};
          blocks.set(json.index, { type: cb.type, id: cb.id, name: cb.name, json: '' });
        } else if (type === 'content_block_delta') {
          const d = json.delta || {};
          if (d.type === 'text_delta' && d.text) {
            yield { type: 'text_delta', text: d.text };
          } else if (d.type === 'thinking_delta' && d.thinking) {
            yield { type: 'reasoning_delta', text: d.thinking };
          } else if (d.type === 'input_json_delta') {
            const b = blocks.get(json.index);
            if (b) b.json += d.partial_json || '';
          }
        } else if (type === 'content_block_stop') {
          const b = blocks.get(json.index);
          if (b?.type === 'tool_use') {
            yield { type: 'tool_call', id: b.id, name: b.name, arguments: safeParse(b.json) };
          }
        } else if (type === 'message_delta') {
          if (json.delta?.stop_reason) finishReason = json.delta.stop_reason;
          if (json.usage?.output_tokens !== undefined) usage.completion_tokens = json.usage.output_tokens;
        }
      }

      if (Object.keys(usage).length) yield { type: 'usage', usage };
      // Anthropic 的 stop_reason 名字不同，翻译成内部语义
      yield { type: 'done', finishReason: finishReason === 'tool_use' ? 'tool_calls' : finishReason || 'stop', usage };
    },

    async ping({ signal, withTools = false, model: modelOverride } = {}) {
      const useModel = modelOverride || model;
      const body = {
        model: useModel,
        max_tokens: withTools ? 256 : 16,
        messages: [{ role: 'user', content: withTools ? '请调用 get_time 工具' : '只回复：pong' }],
      };
      if (withTools) {
        body.tools = [
          { name: 'get_time', description: '获取当前时间', input_schema: { type: 'object', properties: {} } },
        ];
      }

      const t0 = Date.now();
      const res = await postJSON(url, { headers, body, signal, timeoutMs, retries: 0, provider: id, model: useModel });
      const json = await res.json();
      const text = (json.content || []).find((b) => b.type === 'text')?.text || '';
      return {
        ok: true,
        provider: id,
        model: json.model || useModel,
        latencyMs: Date.now() - t0,
        text: text.slice(0, 200),
        usage: json.usage
          ? { prompt_tokens: json.usage.input_tokens, completion_tokens: json.usage.output_tokens }
          : null,
        supportsTools: (json.content || []).some((b) => b.type === 'tool_use'),
      };
    },

    async listModels({ signal } = {}) {
      const res = await fetch(`${root}/v1/models`, { headers, signal: signal || AbortSignal.timeout(10000) });
      if (!res.ok) throw new ModelError(`/v1/models 返回 ${res.status}`, { status: res.status, provider: id });
      const json = await res.json();
      return (json.data || []).map((m) => m.id).filter(Boolean);
    },
  };
}

function safeParse(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __raw: String(raw) };
  }
}
