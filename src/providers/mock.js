// mock 适配器：完全离线，用固定脚本走一遍「思考 → 调工具 → 总结」。
// 它的存在保证 harness 在没有 key、没有网络时也能被完整测试。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function* chunk(text, n = 6) {
  for (let i = 0; i < text.length; i += n) yield text.slice(i, i + n);
}

export function createMockProvider(cfg = {}) {
  let seq = 0;
  const model = cfg.model || 'mock-1';

  return {
    id: 'mock',
    label: cfg.label || 'Mock（离线演示）',
    protocol: 'mock',
    baseUrl: '',
    model,

    async *stream({ messages, model: modelOverride }) {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const userText = String(lastUser?.content ?? '');
      const toolResults = messages.filter((m) => m.role === 'tool');

      // ---- 第二轮：已经有工具结果了，给出最终回答 ----
      if (toolResults.length > 0) {
        const last = toolResults[toolResults.length - 1];
        const body =
          `我调用了 \`${last.name}\`，拿到结果：\n\n` +
          '```\n' +
          String(last.content).slice(0, 500) +
          '\n```\n\n' +
          '（以上是 mock 适配器的固定回答；把供应商切到真实模型后，这里就是模型自己的推理。）';
        for (const c of chunk(body)) {
          await sleep(10);
          yield { type: 'text_delta', text: c };
        }
        yield { type: 'done', finishReason: 'stop', usage: { prompt_tokens: 0, completion_tokens: 0 } };
        return;
      }

      // ---- 第一轮：先输出一小段话，再发起一次工具调用 ----
      for (const c of chunk('我先看一眼工作区，再回答你。\n')) {
        await sleep(8);
        yield { type: 'text_delta', text: c };
      }

      const fileMatch = userText.match(/([\w./-]+\.[a-zA-Z0-9]+)/);
      const wantsWrite = /(写|创建|write|新建)/i.test(userText);
      const wantsShell = /(运行|执行|命令|shell|run)/i.test(userText);

      let name = 'list_dir';
      let args = { path: '.' };
      if (wantsShell) {
        name = 'run_shell';
        args = { command: 'node -v' };
      } else if (wantsWrite) {
        name = 'write_file';
        args = {
          path: fileMatch ? fileMatch[1] : 'demo/hello.txt',
          content: `mock 写入于 ${new Date().toISOString()}\n`,
        };
      } else if (fileMatch) {
        name = 'read_file';
        args = { path: fileMatch[1], limit: 40 };
      }

      yield { type: 'tool_call', id: `call_mock_${++seq}`, name, arguments: args };
      yield { type: 'done', finishReason: 'tool_calls', usage: { prompt_tokens: 0, completion_tokens: 0 } };
      void modelOverride;
    },

    async ping() {
      return { ok: true, provider: 'mock', model, latencyMs: 0, text: 'pong (mock)', usage: null, supportsTools: true };
    },

    async listModels() {
      return [model];
    },
  };
}
